/** Per-segment hitbox model. The character's body is divided into 14
 *  primitives matching the multi-part humanoid mesh:
 *
 *    head        sphere at currentEye + 0.06
 *    chest       AABB on the torso (chest band of the torso box)
 *    stomach     AABB on the pelvis
 *    upperArm    cylinder y=[1.09, 1.45]   (shoulder → elbow)    × 2 sides
 *    forearm     cylinder y=[0.82, 1.09]   (elbow → wrist)       × 2 sides
 *    hand        cylinder y=[0.62, 0.82]   (wrist → fingertips)  × 2 sides
 *    thigh       cylinder y=[0.48, 0.89]   (hip → knee)          × 2 sides
 *    shin        cylinder y=[0.06, 0.48]   (knee → ankle)        × 2 sides
 *    foot        OBB y=[0.00, 0.10]        (toe-forward box)     × 2 sides
 *
 *  The raycaster returns BOTH a coarse `kind` (drives damage multiplier
 *  in the CS:GO formula: head/chest/stomach/arm/leg) and a precise
 *  `segment` (drives dismemberment routing). All limb cylinders also
 *  return their `side` so torn-off pieces leave the right side of the
 *  body.
 *
 *  Crouching shrinks vertically: every limb's height collapses by the
 *  same height/1.80 ratio.
 */

import type { HitboxKind } from './damage';
import type { LimbSegmentKind, LimbSide } from '../entities/character';

/** Anatomical piece struck by a ray. Includes the centre-mass kinds
 *  (head/chest/stomach) plus the six per-arm/per-leg segments. */
export type HitboxSegment =
  | 'head' | 'chest' | 'stomach'
  | LimbSegmentKind;

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
  /** Coarse damage class (head/chest/stomach/arm/leg). Drives the CS:GO
   *  damage multiplier — hand and foot inherit arm/leg respectively. */
  kind: HitboxKind;
  /** Precise anatomical segment — used by the dismemberment system to
   *  pick which mesh tears off the corpse. */
  segment: HitboxSegment;
  /** Side that took the hit. Null for centre-line hits (head /
   *  chest / stomach). 'left' or 'right' for arms and legs. */
  side: LimbSide | null;
  /** Distance from ray origin to first intersection. */
  t: number;
  /** World-space hit point. */
  hitX: number;
  hitY: number;
  hitZ: number;
}

const HEAD_RADIUS = 0.13;
/** Per-segment cylinder radii. Hand/foot are smaller targets — fitting
 *  for the anatomy and for the gameplay (a hand shot is harder to land
 *  than a thigh shot). */
const UPPER_ARM_RADIUS = 0.10;
const FOREARM_RADIUS = 0.09;
const HAND_RADIUS = 0.08;
const THIGH_RADIUS = 0.13;
const SHIN_RADIUS = 0.11;
/** Local (yaw=0, pre-rotation) X offsets for limb cylinders, matching
 *  the humanoid mesh build. */
const ARM_X = 0.31;
const LEG_X = 0.11;
/** Foot is a forward-projecting box (toe ahead of the ankle) — a
 *  vertical cylinder is a poor shape, so we use an OBB matching the
 *  mesh: width 0.20 × depth 0.30, centred at z=+0.04 in body-local. */
const FOOT_HALF_X = 0.10;
const FOOT_HALF_Z = 0.15;
const FOOT_LOCAL_Z = 0.04;

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
  let bestSegment: HitboxSegment | null = null;
  let bestSide: LimbSide | null = null;
  let bestT = Infinity;
  let bestY = 0;

  const considerHit = (
    t: number,
    kind: HitboxKind,
    segment: HitboxSegment,
    side: LimbSide | null,
  ): void => {
    if (t <= 0 || t >= maxT || t >= bestT) return;
    bestT = t;
    bestKind = kind;
    bestSegment = segment;
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
  if (headT !== null) considerHit(headT, 'head', 'head', null);

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
  if (torsoT !== null) considerHit(torsoT, 'chest', 'chest', null);

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
  if (pelvisT !== null) considerHit(pelvisT, 'stomach', 'stomach', null);

  // ---- Arms: three stacked cylinders per side ----
  // Y bands match the mesh: upperArm 1.09–1.45, forearm 0.82–1.09,
  // hand 0.62–0.82. Shrink with the same crouch ratio so the limbs
  // fold with the body.
  for (const side of ['left', 'right'] as const) {
    const lx = side === 'left' ? -ARM_X : ARM_X;
    const { wx, wz } = worldOffset(lx, 0);

    // Upper arm.
    {
      const yBot = pose.baseY + 1.09 * crouch;
      const yTop = pose.baseY + 1.45 * crouch;
      const t = rayVerticalCylinder(
        ox, oy, oz, dx, dy, dz,
        wx, wz, UPPER_ARM_RADIUS,
        yBot, yTop, maxT,
      );
      if (t !== null) considerHit(t, 'arm', 'upperArm', side);
    }
    // Forearm.
    {
      const yBot = pose.baseY + 0.82 * crouch;
      const yTop = pose.baseY + 1.09 * crouch;
      const t = rayVerticalCylinder(
        ox, oy, oz, dx, dy, dz,
        wx, wz, FOREARM_RADIUS,
        yBot, yTop, maxT,
      );
      if (t !== null) considerHit(t, 'arm', 'forearm', side);
    }
    // Hand.
    {
      const yBot = pose.baseY + 0.62 * crouch;
      const yTop = pose.baseY + 0.82 * crouch;
      const t = rayVerticalCylinder(
        ox, oy, oz, dx, dy, dz,
        wx, wz, HAND_RADIUS,
        yBot, yTop, maxT,
      );
      if (t !== null) considerHit(t, 'arm', 'hand', side);
    }
  }

  // ---- Legs: thigh / shin cylinders + foot OBB per side ----
  for (const side of ['left', 'right'] as const) {
    const lx = side === 'left' ? -LEG_X : LEG_X;
    const { wx, wz } = worldOffset(lx, 0);

    // Thigh.
    {
      const yBot = pose.baseY + 0.48 * crouch;
      const yTop = pose.baseY + 0.89 * crouch;
      const t = rayVerticalCylinder(
        ox, oy, oz, dx, dy, dz,
        wx, wz, THIGH_RADIUS,
        yBot, yTop, maxT,
      );
      if (t !== null) considerHit(t, 'leg', 'thigh', side);
    }
    // Shin.
    {
      const yBot = pose.baseY + 0.06 * crouch;
      const yTop = pose.baseY + 0.48 * crouch;
      const t = rayVerticalCylinder(
        ox, oy, oz, dx, dy, dz,
        wx, wz, SHIN_RADIUS,
        yBot, yTop, maxT,
      );
      if (t !== null) considerHit(t, 'leg', 'shin', side);
    }
    // Foot — toe-forward OBB. Centred in world at the leg's X with a
    // forward Z offset matching the mesh. Foot doesn't crouch-shrink
    // (the mesh stays full size at floor level).
    {
      const footFootprint = worldOffset(lx, FOOT_LOCAL_Z);
      const t = rayObbXZ(
        ox, oy, oz, dx, dy, dz,
        footFootprint.wx, footFootprint.wz, cy, sy,
        FOOT_HALF_X, FOOT_HALF_Z,
        pose.baseY + 0.00, pose.baseY + 0.10,
        maxT,
      );
      if (t !== null) considerHit(t, 'leg', 'foot', side);
    }
  }

  if (bestKind === null || bestSegment === null) return null;
  return {
    kind: bestKind,
    segment: bestSegment,
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
