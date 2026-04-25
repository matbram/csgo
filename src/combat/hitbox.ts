/** Multi-segment hitbox model attached to a character capsule. The hitbox
 *  is recomputed each tick from the character's pose (position + currentEye
 *  + crouching state). Hitboxes are axis-aligned cylinders/spheres in
 *  world space — cheaper than OBBs and good enough for our scope.
 *
 *  Geometry (numbers in meters, relative to capsule base):
 *
 *    head    sphere centered at currentEye + 0.10
 *    chest   AABB: [base+0.95, base+1.45], radius ≈ 0.30
 *    stomach AABB: [base+0.55, base+0.95], radius ≈ 0.32
 *    legs    AABB: [base+0.05, base+0.55], radius ≈ 0.28
 *    arms    fold into chest/stomach for now (collapsed for simplicity)
 *
 *  When crouched, currentHeight ≈ 1.30, so chest/stomach/legs scale down.
 *  For a robust feel we scale heights proportionally.
 */

import type { HitboxKind } from './damage';

export interface HitboxPose {
  /** Capsule base position (world). */
  baseX: number;
  baseY: number;
  baseZ: number;
  /** Current eye height (m above base). */
  eye: number;
  /** Current capsule height (m). */
  height: number;
}

export interface HitboxRayHit {
  kind: HitboxKind;
  /** Distance from ray origin to first intersection. */
  t: number;
  /** World-space hit point. */
  hitX: number;
  hitY: number;
  hitZ: number;
}

/** Capsule radius for the chest/stomach/legs hitboxes (we use one radius). */
const BODY_RADIUS = 0.30;
const HEAD_RADIUS = 0.13;

/** Ray vs vertical cylinder + sphere head. The cylinder is segmented into
 *  three height bands (chest/stomach/legs) returning the band that was hit
 *  first. */
export function raycastHitbox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  pose: HitboxPose,
  maxT: number,
): HitboxRayHit | null {
  // Head: small sphere at base + (eye + 0.10).
  const headY = pose.baseY + pose.eye + 0.10;
  const headHit = raySphere(
    ox - pose.baseX, oy - headY, oz - pose.baseZ,
    dx, dy, dz,
    HEAD_RADIUS,
    maxT,
  );

  // Body: vertical cylinder from base+0.05 to base+(eye - 0.10).
  // Split into three bands by y range.
  const legTop = pose.baseY + Math.min(0.55, pose.height * 0.35);
  const stomachTop = pose.baseY + Math.min(0.95, pose.height * 0.55);
  const chestTop = pose.baseY + Math.max(stomachTop - pose.baseY, pose.eye - 0.05);
  const cylBottom = pose.baseY + 0.05;

  const bodyHit = rayVerticalCylinder(
    ox, oy, oz, dx, dy, dz,
    pose.baseX, pose.baseZ, BODY_RADIUS,
    cylBottom, chestTop,
    maxT,
  );

  // Pick the closer hit. Note we use a wider type for `best` and explicit
  // narrowing instead of inline OR to keep TypeScript's flow analysis happy.
  let bestKind: HitboxKind | null = null;
  let bestT = Infinity;
  let bestY = 0;

  if (headHit !== null && headHit < maxT && headHit < bestT) {
    bestKind = 'head';
    bestT = headHit;
    bestY = oy + dy * headHit;
  }

  if (bodyHit !== null && bodyHit < maxT && bodyHit < bestT) {
    bestT = bodyHit;
    bestY = oy + dy * bodyHit;
    if (bestY < legTop) bestKind = 'leg';
    else if (bestY < stomachTop) bestKind = 'stomach';
    else bestKind = 'chest';
  }

  if (bestKind === null) return null;
  return {
    kind: bestKind,
    t: bestT,
    hitX: ox + dx * bestT,
    hitY: bestY,
    hitZ: oz + dz * bestT,
  };
}

/** Returns t at first hit, or null. Sphere centered at origin (caller offsets). */
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

/** Vertical cylinder centered at (cx, cz), spanning [yMin, yMax], radius r. */
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
