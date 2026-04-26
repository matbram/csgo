/** Babylon visuals for the grenade system. Pooled meshes for in-flight
 *  grenades; pooled ParticleSystems for smoke clouds and fire patches.
 *  Side effects come from the grenade events emitted by GrenadeSystem.
 *
 *  We size the pools at the practical concurrency cap: ~24 grenade
 *  meshes (10 players × 2 nades) and 6 simultaneous smoke / fire
 *  systems (a busy round). Effects are stopped after their canonical
 *  duration so we never leak emitters across rounds. */

import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Constants } from '@babylonjs/core/Engines/constants';
import { getScene } from '../engine/scene';
import { events } from '../engine/events';
import { settings } from '../engine/settings';
import type { GrenadeSystem } from './system';

const MAX_GRENADE_MESHES = 24;
const MAX_SMOKE_PS = 6;
const MAX_FIRE_PS = 6;
const SMOKE_DURATION_MS = 18_000;
const FIRE_DURATION_MS = 7_000;

/** Scale particle capacity / emit-rate by quality tier. The capacity
 *  is fixed at PS construction time, but emit rate is read live so
 *  toggling quality mid-round visibly thins fresh clouds. */
function emitRateScale(): number {
  switch (settings.get().quality) {
    case 'low':    return 0.40;
    case 'medium': return 0.70;
    case 'high':   return 1.0;
  }
}

interface PooledMesh { mesh: Mesh; }
interface PooledPs { particles: ParticleSystem; inUse: boolean; }

const KIND_COLOR: Record<string, Color3> = {
  he:        new Color3(0.18, 0.18, 0.20),
  flashbang: new Color3(0.25, 0.25, 0.30),
  smoke:     new Color3(0.30, 0.30, 0.35),
  molotov:   new Color3(0.45, 0.30, 0.18),
  decoy:     new Color3(0.55, 0.45, 0.20),
};

let particleTex: Texture | null = null;
function ensureParticleTex(): Texture {
  if (particleTex) return particleTex;
  const scene = getScene();
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2;
      const dy = y - size / 2;
      const r = Math.hypot(dx, dy) / (size / 2);
      const a = Math.max(0, 1 - r);
      const i = (y * size + x) * 4;
      data[i] = 220; data[i + 1] = 220; data[i + 2] = 220;
      data[i + 3] = Math.round(a * 255);
    }
  }
  particleTex = RawTexture.CreateRGBATexture(
    data, size, size, scene, false, false,
    Engine.TEXTURE_TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
  );
  particleTex.hasAlpha = true;
  particleTex.name = 'grenade-particle';
  return particleTex;
}

let installed = false;

export function installGrenadeVisuals(system: GrenadeSystem): void {
  if (installed) return;
  installed = true;
  const scene = getScene();

  // ----- In-flight grenade meshes (pooled) ------------------------
  const meshPool: PooledMesh[] = [];
  for (let i = 0; i < MAX_GRENADE_MESHES; i++) {
    const m = MeshBuilder.CreateSphere(`grenade-${i}`, { diameter: 0.12, segments: 6 }, scene);
    const mat = new StandardMaterial(`grenade-mat-${i}`, scene);
    mat.diffuseColor = KIND_COLOR.he!;
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    m.material = mat;
    m.isPickable = false;
    m.setEnabled(false);
    meshPool.push({ mesh: m });
  }

  // ----- Smoke + fire particle systems ----------------------------
  const tex = ensureParticleTex();
  const smokePool: PooledPs[] = [];
  const firePool: PooledPs[] = [];

  const acquire = (pool: PooledPs[], cap: number, build: () => ParticleSystem): PooledPs | null => {
    for (const e of pool) if (!e.inUse) return e;
    if (pool.length >= cap) return null;
    const entry: PooledPs = { particles: build(), inUse: false };
    pool.push(entry);
    return entry;
  };

  const buildSmokePs = (): ParticleSystem => {
    const ps = new ParticleSystem(`smoke-${smokePool.length}`, 600, scene);
    ps.particleTexture = tex;
    ps.color1 = new Color3(0.85, 0.85, 0.85).toColor4(0.9);
    ps.color2 = new Color3(0.55, 0.55, 0.60).toColor4(0.9);
    ps.colorDead = new Color3(0.2, 0.2, 0.2).toColor4(0);
    ps.minSize = 1.0; ps.maxSize = 2.4;
    ps.minLifeTime = 4; ps.maxLifeTime = 8;
    ps.emitRate = 200 * emitRateScale();
    ps.minEmitPower = 0.05; ps.maxEmitPower = 0.4;
    ps.gravity = new Vector3(0, 0.2, 0);
    ps.minAngularSpeed = 0; ps.maxAngularSpeed = Math.PI / 4;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    return ps;
  };

  const buildFirePs = (): ParticleSystem => {
    const ps = new ParticleSystem(`fire-${firePool.length}`, 400, scene);
    ps.particleTexture = tex;
    ps.color1 = new Color3(1.0, 0.6, 0.10).toColor4(1);
    ps.color2 = new Color3(1.0, 0.3, 0.05).toColor4(1);
    ps.colorDead = new Color3(0.1, 0.05, 0.0).toColor4(0);
    ps.minSize = 0.4; ps.maxSize = 1.0;
    ps.minLifeTime = 0.6; ps.maxLifeTime = 1.4;
    ps.emitRate = 220 * emitRateScale();
    ps.minEmitPower = 0.6; ps.maxEmitPower = 1.6;
    ps.gravity = new Vector3(0, 4, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    return ps;
  };

  const startEffect = (entry: PooledPs, x: number, y: number, z: number, durationMs: number, halfBoxXZ: number, boxYMin: number, boxYMax: number): void => {
    entry.inUse = true;
    const ps = entry.particles;
    ps.emitter = new Vector3(x, y, z);
    ps.minEmitBox = new Vector3(-halfBoxXZ, boxYMin, -halfBoxXZ);
    ps.maxEmitBox = new Vector3(halfBoxXZ, boxYMax, halfBoxXZ);
    ps.start();
    // Stop emitting after the canonical duration; the in-flight
    // particles will fade naturally over their lifetime.
    setTimeout(() => { ps.stop(); entry.inUse = false; }, durationMs);
  };

  events.on('grenade:detonated', ({ kind, x, y, z }) => {
    if (kind === 'smoke') {
      const slot = acquire(smokePool, MAX_SMOKE_PS, buildSmokePs);
      if (slot) startEffect(slot, x, y + 0.5, z, SMOKE_DURATION_MS, 1.5, -0.5, 1.5);
    } else if (kind === 'molotov') {
      const slot = acquire(firePool, MAX_FIRE_PS, buildFirePs);
      if (slot) startEffect(slot, x, y + 0.05, z, FIRE_DURATION_MS, 1.5, 0, 0.4);
    }
    // HE & flash flashes are handled by the muzzle/impact visuals
    // module — they're glow-only and don't need a pool here.
  });

  // ----- Per-render: position grenade meshes ----------------------
  // Mark every slot disabled, then re-enable for active grenades. The
  // pool size cap means a many-grenade round just ignores the tail.
  events.on('engine:beforeRender', () => {
    for (const slot of meshPool) slot.mesh.setEnabled(false);
    let i = 0;
    for (const g of system.list()) {
      if (i >= meshPool.length) break;
      const slot = meshPool[i++]!;
      const m = slot.mesh;
      const mat = m.material as StandardMaterial;
      mat.diffuseColor = KIND_COLOR[g.kind] ?? KIND_COLOR.he!;
      m.position.set(g.pos.x, g.pos.y, g.pos.z);
      m.setEnabled(true);
    }
  });
}
