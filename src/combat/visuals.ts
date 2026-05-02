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
/** Maximum number of blood pool decals on the ground at once. When the
 *  pool is exhausted the oldest entry is reused — this caps the
 *  visual cost while keeping recent splatters visible. */
const MAX_BLOOD_DECALS = 96;

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

interface BloodDecal {
  mesh: Mesh;
  /** Wall time (ms) when this decal was placed — used as the
   *  recency key for round-robin reuse when the pool is full. */
  placedAtMs: number;
  active: boolean;
}

let tracerPool: Tracer[] = [];
let impactPool: Impact[] = [];
let bloodPool: BloodDecal[] = [];
let bloodTex: Texture | null = null;
let bloodParticles: ParticleSystem | null = null;
let particleTex: Texture | null = null;
let muzzleParticles: ParticleSystem | null = null;
let installed = false;

/** Soft red disc with darker centre — used as the blood-pool decal. */
function makeBloodTexture(): Texture {
  if (bloodTex) return bloodTex;
  const scene = getScene();
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - size / 2) / (size / 2);
      const dy = (y - size / 2) / (size / 2);
      // Irregular splatter: jitter the radius with cheap pseudo-noise so
      // the disc doesn't read as a perfect circle.
      const noise = (Math.sin(x * 0.9) + Math.cos(y * 1.3)) * 0.06;
      const r = Math.hypot(dx, dy) + noise;
      const i = (y * size + x) * 4;
      if (r >= 1.0) {
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0;
        continue;
      }
      const t = 1 - r;
      const dark = Math.pow(t, 2.2);
      // Centre is deep maroon; rim fades to almost-black with alpha.
      const red = Math.round(80 + dark * 70);
      const green = Math.round(8 + dark * 12);
      const blue = Math.round(4 + dark * 8);
      const alpha = Math.round(Math.min(1, t * 1.6) * 230);
      data[i] = red;
      data[i + 1] = green;
      data[i + 2] = blue;
      data[i + 3] = alpha;
    }
  }
  bloodTex = RawTexture.CreateRGBATexture(
    data, size, size, scene, false, false,
    Engine.TEXTURE_TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
  );
  bloodTex.hasAlpha = true;
  bloodTex.name = 'blood-splatter';
  return bloodTex;
}

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

function makeBloodDecal(): BloodDecal {
  const scene = getScene();
  // Plane lies flat on the ground (rotated +X 90°). Two-sided so it
  // reads correctly even if the camera dips below y=0 briefly.
  const mesh = MeshBuilder.CreatePlane('blood', { size: 1, sideOrientation: Mesh.DOUBLESIDE }, scene);
  const mat = new StandardMaterial('blood-mat', scene);
  mat.diffuseTexture = makeBloodTexture();
  mat.opacityTexture = makeBloodTexture();
  mat.useAlphaFromDiffuseTexture = true;
  mat.specularColor = new Color3(0, 0, 0);
  mat.disableLighting = false;
  mat.backFaceCulling = false;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  // Lay the plane flat on the floor.
  mesh.rotation.x = Math.PI / 2;
  mesh.setEnabled(false);
  return { mesh, placedAtMs: 0, active: false };
}

function getBloodDecal(): BloodDecal {
  for (const b of bloodPool) if (!b.active) return b;
  if (bloodPool.length < MAX_BLOOD_DECALS) {
    const b = makeBloodDecal();
    bloodPool.push(b);
    return b;
  }
  // Pool full — reuse the oldest (FIFO). Recent splatters stay; one
  // off-screen old pool fades out of existence.
  let oldest = bloodPool[0]!;
  for (const b of bloodPool) if (b.placedAtMs < oldest.placedAtMs) oldest = b;
  oldest.active = false;
  oldest.mesh.setEnabled(false);
  return oldest;
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

  events.on('combat:fire', ({ ox, oy, oz, weapon }) => {
    if (!muzzleParticles) return;
    // No muzzle flash for melee — there's no muzzle.
    if (weapon === 'knife') return;
    muzzleParticles.emitter = new Vector3(ox, oy, oz);
    muzzleParticles.manualEmitCount = 6;
  });

  // Blood splatter particle system — repositioned per character hit.
  // Shared between all hits; the particles' short lifetime keeps
  // overlapping bursts cheap.
  const bloodTexHandle = makeBloodTexture();
  bloodParticles = new ParticleSystem('blood', 64, scene);
  bloodParticles.particleTexture = bloodTexHandle;
  bloodParticles.color1 = new Color3(0.55, 0.05, 0.05).toColor4(1);
  bloodParticles.color2 = new Color3(0.30, 0.02, 0.02).toColor4(1);
  bloodParticles.colorDead = new Color3(0.10, 0.0, 0.0).toColor4(0);
  bloodParticles.minSize = 0.05;
  bloodParticles.maxSize = 0.18;
  bloodParticles.minLifeTime = 0.18;
  bloodParticles.maxLifeTime = 0.40;
  bloodParticles.emitRate = 0;
  bloodParticles.minEmitPower = 1.5;
  bloodParticles.maxEmitPower = 4.0;
  bloodParticles.gravity = new Vector3(0, -8, 0);
  bloodParticles.minAngularSpeed = 0;
  bloodParticles.maxAngularSpeed = Math.PI * 2;
  bloodParticles.start();

  // Character hit → spurt a few blood particles at the hit point and
  // drop a ground-pool decal at the victim's feet so the surface
  // shows a permanent stain. The decal stays for the rest of the
  // round (only swept when the pool fills past MAX_BLOOD_DECALS).
  events.on('combat:hit', ({ hitX, hitY, hitZ, victimFootY, dirX, dirY, dirZ, headshot }) => {
    if (!bloodParticles) return;
    bloodParticles.emitter = new Vector3(hitX, hitY, hitZ);
    // Direction-of-travel cone: blood sprays in the direction the
    // bullet was going (away from the shooter). Headshots produce a
    // bigger burst.
    bloodParticles.direction1 = new Vector3(dirX - 0.6, dirY + 0.4, dirZ - 0.6);
    bloodParticles.direction2 = new Vector3(dirX + 0.6, dirY + 0.9, dirZ + 0.6);
    bloodParticles.manualEmitCount = headshot ? 30 : 16;

    // Drop a flat decal on the floor under the victim. The decal Y
    // sits a hair above the footYO so it doesn't z-fight with the
    // floor mesh. Random rotation + size keep repeated splatters from
    // looking identical.
    const d = getBloodDecal();
    d.active = true;
    d.placedAtMs = performance.now();
    const sizeM = 0.35 + Math.random() * 0.35 + (headshot ? 0.25 : 0);
    d.mesh.scaling.set(sizeM, sizeM, sizeM);
    d.mesh.position.set(hitX, victimFootY + 0.012, hitZ);
    d.mesh.rotation.x = Math.PI / 2;
    d.mesh.rotation.y = Math.random() * Math.PI * 2;
    d.mesh.setEnabled(true);
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
