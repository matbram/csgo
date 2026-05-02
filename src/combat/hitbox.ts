/** Per-limb hitbox model. The character's body is divided into seven
 *  primitives that match the multi-part humanoid mesh:
 *
 *    head        sphere at currentEye + 0.06
 *    chest       AABB on the torso (chest band of the torso box)
 *    stomach     AABB on the pelvis
 *    leftArm     vertical cylinder on the left side
 *    rightArm    vertical cylinder on the right side
 *    leftLeg     vertical cylinder on the left side
 *    rightLeg    vertical cylinder on the right side
 *
 *  Returning `side` along with `kind` lets the combat system route a
 *  hit to the correct per-side damage counter so a leg/arm blown off
 *  comes off the right side of the body. Yaw is included on the pose
 *  so left/right are computed in the character's local frame — when
 *  the bot turns, their left arm tracks with them.
 *
 *  Crouching shrinks vertically: every limb's height collapses by the
 *  same height/1.80 ratio.
 */

import type { HitboxKind } from './damage';

export interface HitboxPose {
  /** Capsule base position (world). */
  baseX: number;
  baseY: number;
  baseZ: number;
  /** Body yaw (radians) — needed to position left/right limbs in
   *  world space. */
  yaw: number;
  /** Current eye height (m above base). */
  eye: number;
  /** Current capsule height (m). */
  height: number;
}

export interface HitboxRayHit {
  kind: HitboxKind;
  /** Side that took the hit. Null for centre-line hits (head /
   *  chest / stomach). 'left' or 'right' for arms and legs. */
  side: 'left' | 'right' | null;
  /** Distance from ray origin to first intersection. */
  t: number;
  /** World-space hit point. */
  hitX: number;
  hitY: number;
  hitZ: number;
}

const HEAD_RADIUS = 0.13;
/** Radius of an arm cylinder. The mesh forearm is ~0.11 wide; we use
 *  a slightly fatter cylinder so an aimed shot doesn't slip past. */
const ARM_RADIUS = 0.10;
/** Radius of a leg cylinder. */
const LEG_RADIUS = 0.13;
/** Local (yaw=0, pre-rotation) X offsets for limb cylinders, matching
 *  the humanoid mesh build. */
const ARM_X = 0.31;
const LEG_X = 0.11;

export function raycastHitbox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  pose: HitboxPose,
  maxT: number,
): HitboxRayHit | null {
  const cy = Math.cos(pose.yaw);
  const sy = Math.sin(pose.yaw);
  // Helper to convert a body-local (x, z) offset to world space.
  // Forward in our convention is (sin yaw, 0, cos yaw); right is
  // (cos yaw, 0, -sin yaw). So world = base + right * localX +
  // forward * localZ. Limbs are offset in localX only.
  const worldOffset = (lx: number, lz: number): { wx: number; wz: number } => ({
    wx: pose.baseX + cy * lx + sy * lz,
    wz: pose.baseZ - sy * lx + cy * lz,
  });

  // Crouch ratio: limbs and torso scale Y the same way the humanoid does.
  const crouch = Math.max(0.55, pose.height / 1.80);

  let bestKind: HitboxKind | null = null;
  let bestSide: 'left' | 'right' | null = null;
  let bestT = Infinity;
  let bestY = 0;

  const considerHit = (
    t: number,
    kind: HitboxKind,
    side: 'left' | 'right' | null,
  ): void => {
    if (t <= 0 || t >= maxT || t >= bestT) return;
    bestT = t;
    bestKind = kind;
    bestSide = side;
    bestY = oy + dy * t;
  };

  // ---- Head (sphere at eye + 0.06) ----
  const headY = pose.baseY + pose.eye + 0.06;
  const headT = raySphere(
    ox - pose.baseX, oy - headY, oz - pose.baseZ,
    dx, dy, dz,
    HEAD_RADIUS, maxT,
  );
  if (headT !== null) considerHit(headT, 'head', null);

  // ---- Torso AABB (chest) ----
  // Centered at body-local (0, 1.32 * crouch, 0), size 0.46 × 0.50 × 0.28.
  const torsoCY = pose.baseY + 1.32 * crouch;
  const torsoH = 0.50 * crouch;
  const torsoT = rayObbXZ(
    ox, oy, oz, dx, dy, dz,
    pose.baseX, pose.baseZ, cy, sy,
    0.23, 0.14,                 // half-width / half-depth
    torsoCY - torsoH / 2, torsoCY + torsoH / 2,
    maxT,
  );
  if (torsoT !== null) considerHit(torsoT, 'chest', null);

  // ---- Pelvis AABB (stomach) ----
  const pelvisCY = pose.baseY + 0.99 * crouch;
  const pelvisH = 0.18 * crouch;
  const pelvisT = rayObbXZ(
    ox, oy, oz, dx, dy, dz,
    pose.baseX, pose.baseZ, cy, sy,
    0.21, 0.14,
    pelvisCY - pelvisH / 2, pelvisCY + pelvisH / 2,
    maxT,
  );
  if (pelvisT !== null) considerHit(pelvisT, 'stomach', null);

  // ---- Arms ----
  // Cylinders span body-local y from upper-arm top to forearm bottom.
  // Upper arm centre y=1.27, height 0.36 → top 1.45. Forearm centre
  // y=0.85, height 0.42 → bottom 0.64. So one cylinder y=[0.64, 1.45]
  // (scaled by crouch).
  const armBottom = pose.baseY + 0.64 * crouch;
  const armTop = pose.baseY + 1.45 * crouch;
  for (const side of ['left', 'right'] as const) {
    const lx = side === 'left' ? -ARM_X : ARM_X;
    const { wx, wz } = worldOffset(lx, 0);
    const t = rayVerticalCylinder(
      ox, oy, oz, dx, dy, dz,
      wx, wz, ARM_RADIUS,
      armBottom, armTop, maxT,
    );
    if (t !== null) considerHit(t, 'arm', side);
  }

  // ---- Legs ----
  // Thigh centre y=0.69 height 0.40 → top 0.89. Foot top y≈0.08. So
  // one cylinder y=[0.05, 0.89] (scaled).
  const legBottom = pose.baseY + 0.05 * crouch;
  const legTop = pose.baseY + 0.89 * crouch;
  for (const side of ['left', 'right'] as const) {
    const lx = side === 'left' ? -LEG_X : LEG_X;
    const { wx, wz } = worldOffset(lx, 0);
    const t = rayVerticalCylinder(
      ox, oy, oz, dx, dy, dz,
      wx, wz, LEG_RADIUS,
      legBottom, legTop, maxT,
    );
    if (t !== null) considerHit(t, 'leg', side);
  }

  if (bestKind === null) return null;
  return {
    kind: bestKind,
    side: bestSide,
    t: bestT,
    hitX: ox + dx * bestT,
    hitY: bestY,
    hitZ: oz + dz * bestT,
  };
}

function raySphere(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  r: number,
  maxT: number,
): number | null {
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  if (t1 > 0 && t1 <= maxT) return t1;
  const t2 = (-b + sq) / (2 * a);
  if (t2 > 0 && t2 <= maxT) return t2;
  return null;
}

function rayVerticalCylinder(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cz: number, r: number,
  yMin: number, yMax: number,
  maxT: number,
): number | null {
  const ddx = ox - cx;
  const ddz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return null;
  const b = 2 * (ddx * dx + ddz * dz);
  const c = ddx * ddx + ddz * ddz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0 || t > maxT) {
    t = (-b + sq) / (2 * a);
    if (t < 0 || t > maxT) return null;
  }
  const y = oy + dy * t;
  if (y >= yMin && y <= yMax) return t;
  // Try cap intersections (top/bottom disks)
  if (Math.abs(dy) < 1e-9) return null;
  const tTop = (yMax - oy) / dy;
  if (tTop > 0 && tTop < maxT) {
    const x = ox + dx * tTop - cx;
    const z = oz + dz * tTop - cz;
    if (x * x + z * z <= r * r) return tTop;
  }
  const tBot = (yMin - oy) / dy;
  if (tBot > 0 && tBot < maxT) {
    const x = ox + dx * tBot - cx;
    const z = oz + dz * tBot - cz;
    if (x * x + z * z <= r * r) return tBot;
  }
  return null;
}

/** Ray vs an OBB built from a yaw-rotated rectangle in XZ (the body's
 *  XZ footprint) and a vertical [yMin, yMax] band. We test against the
 *  rotated rectangle in the body's local XZ frame and clip on Y. */
function rayObbXZ(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cz: number, cosYaw: number, sinYaw: number,
  halfX: number, halfZ: number,
  yMin: number, yMax: number,
  maxT: number,
): number | null {
  // Transform ray into the body's local frame so the box is axis-aligned.
  // World forward = (sin yaw, 0, cos yaw); right = (cos yaw, 0, -sin yaw).
  // We use right = +X local, forward = +Z local, so the inverse rotation
  // maps world (Δx, Δz) into local (lx, lz) via:
  //   lx =  cosYaw * Δx - sinYaw * Δz
  //   lz =  sinYaw * Δx + cosYaw * Δz
  const odx = ox - cx;
  const odz = oz - cz;
  const lox = cosYaw * odx - sinYaw * odz;
  const loz = sinYaw * odx + cosYaw * odz;
  const ldx = cosYaw * dx - sinYaw * dz;
  const ldz = sinYaw * dx + cosYaw * dz;

  // Slab test on local X / Y / Z.
  let tMin = 0, tMax = maxT;
  const slab = (origin: number, dir: number, lo: number, hi: number): boolean => {
    if (Math.abs(dir) < 1e-9) {
      return origin >= lo && origin <= hi;
    }
    let t1 = (lo - origin) / dir;
    let t2 = (hi - origin) / dir;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    return tMin <= tMax;
  };

  if (!slab(lox, ldx, -halfX, halfX)) return null;
  if (!slab(oy, dy, yMin, yMax)) return null;
  if (!slab(loz, ldz, -halfZ, halfZ)) return null;
  if (tMin > 0) return tMin;
  return null;
}
