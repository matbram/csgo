/** Visual feedback for combat events: bullet impact sparks, muzzle flashes,
 *  brief tracers. All pooled so a long burst doesn't allocate.
 *
 *  This module subscribes to combat events emitted by combat/firing/combat
 *  and creates Babylon objects as needed. */

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Constants } from '@babylonjs/core/Engines/constants';
import { getScene } from '../engine/scene';
import { events } from '../engine/events';
import { time } from '../engine/time';

const TRACER_DURATION_MS = 70;
const IMPACT_DURATION_MS = 350;
const MAX_TRACERS = 32;
const MAX_IMPACTS = 64;

interface Tracer {
  mesh: Mesh;
  expiresMs: number;
  active: boolean;
}

interface Impact {
  mesh: Mesh;
  expiresMs: number;
  active: boolean;
}

let tracerPool: Tracer[] = [];
let impactPool: Impact[] = [];
let particleTex: Texture | null = null;
let muzzleParticles: ParticleSystem | null = null;
let installed = false;

function makeParticleTexture(): Texture {
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
      data[i] = 255;
      data[i + 1] = 240;
      data[i + 2] = 200;
      data[i + 3] = Math.round(a * 255);
    }
  }
  particleTex = RawTexture.CreateRGBATexture(
    data, size, size, scene, false, false,
    Engine.TEXTURE_TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
  );
  particleTex.hasAlpha = true;
  particleTex.name = 'particle-spark';
  return particleTex;
}

function makeTracer(): Tracer {
  const scene = getScene();
  const mesh = MeshBuilder.CreateCylinder('tracer', { height: 1, diameterTop: 0.012, diameterBottom: 0.012, tessellation: 6 }, scene);
  const mat = new StandardMaterial('tracer-mat', scene);
  mat.emissiveColor = new Color3(1.0, 0.85, 0.35);
  mat.specularColor = new Color3(0, 0, 0);
  mat.disableLighting = true;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.alphaIndex = 1000;
  mesh.setEnabled(false);
  return { mesh, expiresMs: 0, active: false };
}

function makeImpact(): Impact {
  const scene = getScene();
  const mesh = MeshBuilder.CreatePlane('impact', { size: 0.15 }, scene);
  const mat = new StandardMaterial('impact-mat', scene);
  mat.emissiveColor = new Color3(0.30, 0.25, 0.20);
  mat.diffuseColor = new Color3(0.05, 0.05, 0.05);
  mat.specularColor = new Color3(0, 0, 0);
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.setEnabled(false);
  return { mesh, expiresMs: 0, active: false };
}

function getTracer(): Tracer {
  for (const t of tracerPool) {
    if (!t.active) return t;
  }
  if (tracerPool.length < MAX_TRACERS) {
    const t = makeTracer();
    tracerPool.push(t);
    return t;
  }
  // Steal the oldest
  let oldest = tracerPool[0]!;
  for (const t of tracerPool) if (t.expiresMs < oldest.expiresMs) oldest = t;
  return oldest;
}

function getImpact(): Impact {
  for (const i of impactPool) if (!i.active) return i;
  if (impactPool.length < MAX_IMPACTS) {
    const i = makeImpact();
    impactPool.push(i);
    return i;
  }
  let oldest = impactPool[0]!;
  for (const i of impactPool) if (i.expiresMs < oldest.expiresMs) oldest = i;
  return oldest;
}

export function installCombatVisuals(): void {
  if (installed) return;
  installed = true;
  const scene = getScene();

  // Tracer
  events.on('combat:tracer', ({ sx, sy, sz, ex, ey, ez, tMs }) => {
    const dx = ex - sx, dy = ey - sy, dz = ez - sz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return;
    const t = getTracer();
    t.active = true;
    t.expiresMs = tMs + TRACER_DURATION_MS;
    t.mesh.scaling.set(1, len, 1);
    // Place midpoint
    t.mesh.position.set(sx + dx / 2, sy + dy / 2, sz + dz / 2);
    // Orient: cylinder default axis is +Y; rotate so it points along (dx,dy,dz).
    const dir = new Vector3(dx, dy, dz).normalize();
    const axis = Vector3.Cross(Vector3.Up(), dir);
    const angle = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(Vector3.Up(), dir))));
    if (axis.lengthSquared() < 1e-6) {
      t.mesh.rotation.set(dir.y < 0 ? Math.PI : 0, 0, 0);
    } else {
      const ax = axis.normalize();
      // Quaternion from axis-angle
      const half = angle / 2;
      const s = Math.sin(half);
      t.mesh.rotationQuaternion = null;
      // Use Euler approximation: rotate around X & Z to align Y with dir.
      // Simpler: use lookAt along dir as a fallback.
      t.mesh.rotation.x = Math.atan2(-dy, Math.hypot(dx, dz));
      t.mesh.rotation.y = Math.atan2(dx, dz);
      t.mesh.rotation.z = 0;
      void ax; void s; void angle;
    }
    t.mesh.setEnabled(true);
  });

  // Impact decal
  events.on('combat:bulletImpact', ({ x, y, z, tMs }) => {
    const i = getImpact();
    i.active = true;
    i.expiresMs = tMs + IMPACT_DURATION_MS;
    i.mesh.position.set(x, y, z);
    // Face the camera approximately (we don't have surface normal in M2).
    const cam = scene.activeCamera;
    if (cam) {
      const cp = cam.position;
      const dx = cp.x - x, dy = cp.y - y, dz = cp.z - z;
      i.mesh.rotation.x = Math.atan2(-dy, Math.hypot(dx, dz));
      i.mesh.rotation.y = Math.atan2(dx, dz);
    }
    i.mesh.setEnabled(true);
  });

  // Muzzle flash particle system (single shared system, repositioned per shot).
  const tex = makeParticleTexture();
  muzzleParticles = new ParticleSystem('muzzle', 32, scene);
  muzzleParticles.particleTexture = tex;
  muzzleParticles.color1 = new Color3(1.0, 0.9, 0.4).toColor4(1);
  muzzleParticles.color2 = new Color3(1.0, 0.5, 0.1).toColor4(1);
  muzzleParticles.colorDead = new Color3(0.2, 0.05, 0.0).toColor4(0);
  muzzleParticles.minSize = 0.05;
  muzzleParticles.maxSize = 0.16;
  muzzleParticles.minLifeTime = 0.04;
  muzzleParticles.maxLifeTime = 0.08;
  muzzleParticles.emitRate = 0;
  muzzleParticles.minEmitPower = 0;
  muzzleParticles.maxEmitPower = 0.5;
  muzzleParticles.gravity = new Vector3(0, 0, 0);
  muzzleParticles.minAngularSpeed = 0;
  muzzleParticles.maxAngularSpeed = Math.PI;
  muzzleParticles.start();

  events.on('combat:fire', ({ ox, oy, oz }) => {
    if (!muzzleParticles) return;
    muzzleParticles.emitter = new Vector3(ox, oy, oz);
    muzzleParticles.manualEmitCount = 6;
  });

  // Despawn pooled visuals after expiry.
  events.on('engine:beforeRender', () => {
    const now = time.simMs;
    for (const t of tracerPool) {
      if (t.active && now > t.expiresMs) {
        t.active = false;
        t.mesh.setEnabled(false);
      }
    }
    for (const i of impactPool) {
      if (i.active && now > i.expiresMs) {
        i.active = false;
        i.mesh.setEnabled(false);
      }
    }
  });
}
