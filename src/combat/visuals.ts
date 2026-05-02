/** Visual feedback for combat events: bullet impact sparks, muzzle flashes,
 *  brief tracers, and gore (blood splatter / wall-spray decals / dismembered
 *  body parts). All pooled so a long burst doesn't allocate.
 *
 *  This module subscribes to combat events emitted by combat/firing/combat
 *  and creates Babylon objects as needed. Heavier visuals — wall splatter
 *  via raycast, gib physics — need a `WorldQuery` and a way to look up
 *  the victim's `HumanoidParts`, so `installCombatVisuals` takes those
 *  as args. Skip them and you get the lighter pre-gore behaviour. */

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
import type { WorldQuery } from '../player/physics';
import type { HumanoidParts, DetachKind } from '../entities/humanoid';
import { detachBodyPart } from '../entities/humanoid';

/** How hard each anatomical piece kicks when it tears off. Tuned so
 *  the head and a torn-off thigh feel chunky, while a hand or foot
 *  is a lighter flick — matches the relative mass of the parts. */
const LAUNCH_PROFILE: Record<DetachKind, { speed: number; up: number }> = {
  head: { speed: 6.5, up: 4.5 },
  chest: { speed: 4.0, up: 3.0 },
  stomach: { speed: 3.5, up: 2.5 },
  upperArm: { speed: 5.0, up: 3.5 },
  forearm: { speed: 4.0, up: 3.0 },
  hand: { speed: 3.0, up: 2.5 },
  thigh: { speed: 5.5, up: 3.5 },
  shin: { speed: 4.5, up: 3.0 },
  foot: { speed: 3.5, up: 2.5 },
};

const TRACER_DURATION_MS = 70;
const IMPACT_DURATION_MS = 350;
const MAX_TRACERS = 32;
const MAX_IMPACTS = 64;
/** Maximum blood pool decals on surfaces at once. When the pool fills
 *  the oldest entry is reused — caps the visual cost while keeping
 *  recent splatters visible across the round. */
const MAX_BLOOD_DECALS = 256;
/** Detached body parts simulated at any one time — gibs settle on the
 *  ground and stay there, but the live-physics list is bounded. */
const MAX_GIBS = 64;
/** How long gibs simulate gravity before they're forced to settle (ms).
 *  Stops a lost gib from spinning in mid-air forever if the ground probe
 *  ever fails. */
const GIB_MAX_FLIGHT_MS = 4000;

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

interface Gib {
  mesh: Mesh;
  vx: number; vy: number; vz: number;
  spinX: number; spinY: number; spinZ: number;
  /** When the gib stops simulating (sits still on the ground). */
  settled: boolean;
  spawnedAtMs: number;
  /** Sub-stepping accumulator (ms). */
  accumMs: number;
}

let tracerPool: Tracer[] = [];
let impactPool: Impact[] = [];
let bloodPool: BloodDecal[] = [];
let gibList: Gib[] = [];
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
  // Plane lies flat; orientation is set per-placement (ground vs wall).
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

/** Place a flat-on-the-ground blood pool. */
function spawnGroundBlood(x: number, y: number, z: number, sizeM: number): void {
  const d = getBloodDecal();
  d.active = true;
  d.placedAtMs = performance.now();
  d.mesh.scaling.set(sizeM, sizeM, sizeM);
  d.mesh.position.set(x, y + 0.012, z);
  d.mesh.rotation.x = Math.PI / 2;
  d.mesh.rotation.y = Math.random() * Math.PI * 2;
  d.mesh.rotation.z = 0;
  d.mesh.setEnabled(true);
}

/** Place a wall-aligned blood splatter at a hit point. The decal's
 *  normal points along `-dir` (back at the shooter), tilted with a tiny
 *  random roll so consecutive sprays don't repeat. */
function spawnWallBlood(
  x: number, y: number, z: number,
  dirX: number, dirY: number, dirZ: number,
  sizeM: number,
): void {
  const d = getBloodDecal();
  d.active = true;
  d.placedAtMs = performance.now();
  d.mesh.scaling.set(sizeM, sizeM, sizeM);
  // Pull the decal a hair off the wall so it doesn't z-fight.
  const off = 0.015;
  d.mesh.position.set(x - dirX * off, y - dirY * off, z - dirZ * off);
  // Plane default normal is +Z. We want it to point along -dir (back at
  // the shooter). Compute Euler angles that align +Z with -dir.
  const nx = -dirX, ny = -dirY, nz = -dirZ;
  d.mesh.rotation.x = -Math.atan2(ny, Math.hypot(nx, nz));
  d.mesh.rotation.y = Math.atan2(nx, nz);
  d.mesh.rotation.z = (Math.random() - 0.5) * 0.6;
  d.mesh.setEnabled(true);
}

/** Cast a few rays in a cone along the bullet direction and place a
 *  splatter where each one hits a wall / floor. The ray needs the
 *  WorldQuery, so this is a no-op when visuals were installed without
 *  it. */
function sprayWallBlood(
  worldQuery: WorldQuery,
  ox: number, oy: number, oz: number,
  dirX: number, dirY: number, dirZ: number,
  spreadDeg: number,
  rayCount: number,
  sizeM: number,
  maxDist = 8,
): void {
  for (let i = 0; i < rayCount; i++) {
    // Random unit perturbation in a small cone around the bullet
    // direction. We bias the spray slightly downward so the larger
    // pools land on the floor when the wall is far away.
    const spread = (spreadDeg * Math.PI) / 180;
    const theta = (Math.random() - 0.5) * spread;
    const phi = (Math.random() - 0.5) * spread + spread * 0.15;
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    const cosP = Math.cos(phi), sinP = Math.sin(phi);
    // Build a frame (right, up) around dir, then perturb.
    const ax = Math.abs(dirY) > 0.95 ? 1 : 0;
    const ay = Math.abs(dirY) > 0.95 ? 0 : 1;
    let rx = ay * dirZ - 0;
    let ry = 0;
    let rz = 0 - ay * dirX - ax * dirZ;
    // Cross(up-ish, dir) → right. Renormalise.
    rx = ay * dirZ - 0 * dirY;
    ry = 0 * dirX - ax * dirZ;
    rz = ax * dirY - ay * dirX;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const ux = ry * dirZ - rz * dirY;
    const uy = rz * dirX - rx * dirZ;
    const uz = rx * dirY - ry * dirX;
    const ndx = dirX * cosT * cosP + rx * sinT * cosP + ux * sinP;
    const ndy = dirY * cosT * cosP + ry * sinT * cosP + uy * sinP;
    const ndz = dirZ * cosT * cosP + rz * sinT * cosP + uz * sinP;
    const len = Math.hypot(ndx, ndy, ndz) || 1;
    const fx = ndx / len, fy = ndy / len, fz = ndz / len;
    const hit = worldQuery.rayWorld(ox, oy, oz, fx, fy, fz, maxDist);
    if (!hit) continue;
    const t = hit.t;
    const wx = ox + fx * t;
    const wy = oy + fy * t;
    const wz = oz + fz * t;
    spawnWallBlood(wx, wy, wz, fx, fy, fz, sizeM * (0.6 + Math.random() * 0.7));
  }
}

/** Add a body-part gib to the live-physics list. The mesh is already
 *  positioned at world coordinates (parent === null). */
function pushGib(mesh: Mesh, vx: number, vy: number, vz: number, spinScale: number): void {
  if (gibList.length >= MAX_GIBS) {
    // Settle the oldest still-flying gib so it stays as a corpse piece
    // on the ground; the new one takes its physics slot.
    const idx = gibList.findIndex(g => !g.settled);
    if (idx >= 0) {
      const dropped = gibList[idx]!;
      dropped.settled = true;
      // Don't dispose — the user wanted gore to stay on surfaces.
      gibList.splice(idx, 1);
    } else {
      // All settled — drop the very oldest mesh from the scene.
      const dead = gibList.shift()!;
      dead.mesh.dispose();
    }
  }
  gibList.push({
    mesh,
    vx, vy, vz,
    spinX: (Math.random() - 0.5) * spinScale,
    spinY: (Math.random() - 0.5) * spinScale,
    spinZ: (Math.random() - 0.5) * spinScale,
    settled: false,
    spawnedAtMs: performance.now(),
    accumMs: 0,
  });
}

function stepGibs(worldQuery: WorldQuery, renderDtMs: number): void {
  if (gibList.length === 0) return;
  const dtMs = Math.min(renderDtMs, 60);    // clamp huge frames so a stalled tab doesn't yeet gibs to space
  const dt = dtMs / 1000;
  const gravity = 18;
  const drag = Math.exp(-dt * 1.8);         // air drag — slows tumble after a beat
  const probeAbove = 1.0;
  // Probe drop matches the navmesh upper bound: gibs in tall map need
  // to find the floor below them.
  const probeDrop = 30;
  for (const g of gibList) {
    if (g.settled) continue;
    g.vy -= gravity * dt;
    g.vx *= drag; g.vz *= drag;
    g.mesh.position.x += g.vx * dt;
    g.mesh.position.y += g.vy * dt;
    g.mesh.position.z += g.vz * dt;
    g.mesh.rotation.x += g.spinX * dt;
    g.mesh.rotation.y += g.spinY * dt;
    g.mesh.rotation.z += g.spinZ * dt;

    const px = g.mesh.position.x;
    const pz = g.mesh.position.z;
    const ground = worldQuery.groundProbe(px, pz, g.mesh.position.y + probeAbove, probeDrop);
    if (ground && g.mesh.position.y - ground.y <= 0.05 && g.vy <= 0) {
      g.mesh.position.y = ground.y + 0.05;
      g.vy = 0; g.vx = 0; g.vz = 0;
      g.spinX = g.spinY = g.spinZ = 0;
      g.settled = true;
      // Drop a final pool of blood under the gib so it rests in a
      // visible mess.
      spawnGroundBlood(px, ground.y, pz, 0.55 + Math.random() * 0.5);
    }
    // Force-settle if we've been flying too long (probably stuck above
    // some weird geometry).
    if (!g.settled && performance.now() - g.spawnedAtMs > GIB_MAX_FLIGHT_MS) {
      g.settled = true;
      g.vy = g.vx = g.vz = 0;
    }
  }
}

export interface CombatVisualOptions {
  /** Optional world ray query — needed for wall-blood splatter. When
   *  omitted, blood only stains the ground at the victim's feet. */
  worldQuery?: WorldQuery;
  /** Look up the victim's humanoid parts so we can detach a body chunk
   *  on a killing hit. When omitted, dismemberment is skipped but the
   *  rest of the gore (particles + decals) still fires. */
  partsForId?: (id: string) => HumanoidParts | null;
}

export function installCombatVisuals(opts: CombatVisualOptions = {}): void {
  if (installed) return;
  installed = true;
  const scene = getScene();
  const { worldQuery, partsForId } = opts;

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
    t.mesh.rotation.x = Math.atan2(-dy, Math.hypot(dx, dz));
    t.mesh.rotation.y = Math.atan2(dx, dz);
    t.mesh.rotation.z = 0;
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

  events.on('combat:fire', ({ shooterId, ox, oy, oz, weapon }) => {
    if (!muzzleParticles) return;
    // No muzzle flash for melee — there's no muzzle.
    if (weapon === 'knife') return;
    // For bots we have a real weapon mesh attached to the humanoid.
    // Reading its muzzle anchor's absolute position puts the flash on
    // the actual gun, not at the bot's eye. Local player keeps eye-
    // space — the player view-model already lines its muzzle up with
    // the camera.
    let mx = ox, my = oy, mz = oz;
    if (shooterId !== 'local' && partsForId) {
      const parts = partsForId(shooterId);
      if (parts) {
        const mp = parts.weaponMuzzle.getAbsolutePosition();
        mx = mp.x; my = mp.y; mz = mp.z;
      }
    }
    muzzleParticles.emitter = new Vector3(mx, my, mz);
    muzzleParticles.manualEmitCount = 6;
  });

  // Blood splatter particle system — repositioned per character hit.
  // Heavy emit count + long-ish lifetime to read as a real spurt.
  const bloodTexHandle = makeBloodTexture();
  bloodParticles = new ParticleSystem('blood', 512, scene);
  bloodParticles.particleTexture = bloodTexHandle;
  bloodParticles.color1 = new Color3(0.65, 0.04, 0.04).toColor4(1);
  bloodParticles.color2 = new Color3(0.30, 0.02, 0.02).toColor4(1);
  bloodParticles.colorDead = new Color3(0.10, 0.0, 0.0).toColor4(0);
  bloodParticles.minSize = 0.06;
  bloodParticles.maxSize = 0.32;
  bloodParticles.minLifeTime = 0.30;
  bloodParticles.maxLifeTime = 0.85;
  bloodParticles.emitRate = 0;
  bloodParticles.minEmitPower = 3.0;
  bloodParticles.maxEmitPower = 9.0;
  bloodParticles.gravity = new Vector3(0, -16, 0);
  bloodParticles.minAngularSpeed = 0;
  bloodParticles.maxAngularSpeed = Math.PI * 4;
  bloodParticles.start();

  // Character hit → gore stack:
  //   1. Heavy blood-particle spurt (sized by hit kind).
  //   2. Multiple ground decals scattered around the foot.
  //   3. A spread of wall-aligned splatters along the bullet's path
  //      (only when worldQuery is available).
  //   4. On a killing hit, detach the matching body part and spawn
  //      extra gibs that fly outward and settle on the ground.
  events.on('combat:hit', ({
    hitX, hitY, hitZ, victimFootY,
    dirX, dirY, dirZ,
    headshot, killing, corpseHit, limbsDetached, segment, side, victimId,
  }) => {
    if (!bloodParticles) return;
    // Treat corpse hits and in-flight limb detachments the same as
    // killing hits for visuals: heavy blood, multiple ground decals,
    // wall splatter, and pieces torn off.
    const dismember = killing || corpseHit || limbsDetached.length > 0;

    // 1) Particle spurt. Heavy on headshots / killing / corpse hits.
    bloodParticles.emitter = new Vector3(hitX, hitY, hitZ);
    bloodParticles.direction1 = new Vector3(dirX - 0.9, dirY + 0.5, dirZ - 0.9);
    bloodParticles.direction2 = new Vector3(dirX + 0.9, dirY + 1.4, dirZ + 0.9);
    let count = 60;
    if (headshot) count = 180;
    else if (dismember) count = 130;
    bloodParticles.manualEmitCount = count;

    // 2) Ground splatter — 3–6 pools around the foot. Each tile is a
    //    short walk apart so the ground reads as a real mess instead
    //    of one neat circle.
    const groundPools = headshot ? 5 : dismember ? 4 : 2;
    for (let i = 0; i < groundPools; i++) {
      const r = Math.random() * (headshot ? 0.7 : 0.45);
      const ang = Math.random() * Math.PI * 2;
      const px = hitX + Math.cos(ang) * r;
      const pz = hitZ + Math.sin(ang) * r;
      const sizeM = 0.30 + Math.random() * 0.50 + (headshot ? 0.30 : 0);
      spawnGroundBlood(px, victimFootY, pz, sizeM);
    }

    // 3) Wall splatter — fan a few rays in the bullet's direction so
    //    the back wall (or floor, if there's nothing nearby) gets a
    //    streak. Only runs when we have a world query installed.
    if (worldQuery) {
      const rays = headshot ? 6 : dismember ? 5 : 3;
      const sizeM = headshot ? 0.55 : dismember ? 0.45 : 0.32;
      // Start the rays a hair past the body so they don't immediately
      // hit the geometry the bullet was already inside.
      sprayWallBlood(
        worldQuery,
        hitX + dirX * 0.05, hitY + dirY * 0.05, hitZ + dirZ * 0.05,
        dirX, dirY, dirZ,
        18, rays, sizeM, 10,
      );
    }

    // 4) Dismemberment — runs on killing hits, corpse hits, and any
    //    severance the simulation reports. The `limbsDetached` array
    //    is the authoritative signal from the simulation; for killing
    //    or corpse hits where nothing was explicitly severed we fall
    //    back to detaching the precise segment the bullet found.
    //    detachBodyPart silently no-ops if the piece is already
    //    missing, so a body eventually runs out of pieces to lose.
    if (dismember && partsForId) {
      const parts = partsForId(victimId);
      if (parts) {
        type DetachReq = { kind: DetachKind; side?: 'left' | 'right' };
        const requests: DetachReq[] = [];
        if (limbsDetached.length > 0) {
          for (const ld of limbsDetached) {
            requests.push({ kind: ld.segment, side: ld.side });
          }
        } else {
          // Killing or corpse hit with no explicit severance: detach
          // the segment the bullet hit (head on a head kill, thigh
          // on a leg kill, etc.). Side is null for centre-line hits.
          requests.push({ kind: segment, side: side ?? undefined });
        }
        for (const req of requests) {
          const detached = detachBodyPart(parts, req.kind, req.side);
          if (!detached) continue;
          const launchProfile = LAUNCH_PROFILE[req.kind];
          const splay = 1.5;
          const launch = (m: Mesh, scale: number, spinScale: number): void => {
            pushGib(
              m,
              dirX * launchProfile.speed * scale + (Math.random() - 0.5) * splay,
              launchProfile.up + Math.random() * 1.5,
              dirZ * launchProfile.speed * scale + (Math.random() - 0.5) * splay,
              spinScale,
            );
          };
          launch(detached.primary, 1.0, 14);
          for (const e of detached.extras) launch(e, 0.85, 10);
        }
      }
    }
  });

  // Per-frame: expire short-lived visuals + step gib physics.
  events.on('engine:beforeRender', ({ dtMs }) => {
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
    if (worldQuery) stepGibs(worldQuery, dtMs);
  });
}
