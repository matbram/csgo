/** Capsule-vs-world collision queries used by the character controller.
 *
 *  We treat the world as:
 *   - a set of OBBs (oriented around y) — `World.boxes`
 *   - a set of triangular ramps                  — `World.ramps`
 *
 *  We support two queries:
 *   - `groundProbe(x,z, fromY, maxDrop) → ground hit (y, normal, surface)`
 *   - `resolveHorizontal(x,y,z, dx,dz, radius, height) → corrected (dx,dz)
 *      after resolving wall penetration and sliding along contact normals`
 *
 *  The capsule is treated as a vertical cylinder for horizontal collision —
 *  cheaper, and accurate enough for a flat-floored map. Ground probing is
 *  separate from horizontal resolution, so we can step up small ledges
 *  without having walls block us.
 */

import { World, type BoxCollider, type RampCollider } from '../map/world';

export interface GroundHit {
  y: number;
  normalY: number; // y component of surface normal (1 = flat floor)
  surface: BoxCollider['surface'];
}

const SLOPE_LIMIT_NORMAL_Y = 0.65; // ~50° max slope walkable

export class WorldQuery {
  constructor(private readonly world: World) {}

  /** Probe downward for ground beneath (x,z). Returns the highest walkable
   *  surface whose top is within [fromY - maxDrop, fromY + tinyEps]. */
  groundProbe(x: number, z: number, fromY: number, maxDrop: number): GroundHit | null {
    let bestY = -Infinity;
    let bestNormalY = 0;
    let bestSurface: BoxCollider['surface'] = 'sand';

    // Boxes: top face at centerY + halfY (when walkable).
    for (const b of this.world.boxes) {
      if (!b.walkable) continue;
      const top = b.centerY + b.halfY;
      if (top > fromY + 0.01) continue;
      if (top < fromY - maxDrop) continue;
      if (!pointInsideBoxXZ(x, z, b)) continue;
      if (top > bestY) {
        bestY = top;
        bestNormalY = 1;
        bestSurface = b.surface;
      }
    }

    // Ramps: y at (x,z) varies linearly along local x.
    for (const r of this.world.ramps) {
      const ry = rampHeightAt(x, z, r);
      if (ry === null) continue;
      if (ry > fromY + 0.01) continue;
      if (ry < fromY - maxDrop) continue;
      const ny = rampNormalY(r);
      if (ny < SLOPE_LIMIT_NORMAL_Y) continue;
      if (ry > bestY) {
        bestY = ry;
        bestNormalY = ny;
        bestSurface = r.surface;
      }
    }

    if (!isFinite(bestY)) return null;
    return { y: bestY, normalY: bestNormalY, surface: bestSurface };
  }

  /** Resolve horizontal movement: cylinder radius `radius`, vertical extent
   *  [yBottom, yBottom+height]. Returns the corrected delta after up to
   *  `maxPasses` push-out iterations. */
  resolveHorizontal(
    posX: number, yBottom: number, posZ: number,
    dx: number, dz: number,
    radius: number, height: number,
  ): { dx: number; dz: number; hitNormalX: number; hitNormalZ: number } {
    const yTop = yBottom + height;
    let outDx = dx, outDz = dz;
    let hitNX = 0, hitNZ = 0;

    const MAX_PASSES = 4;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const tx = posX + outDx;
      const tz = posZ + outDz;
      let resolvedAny = false;

      // Find deepest penetration this pass; resolve it; loop. This avoids
      // overshooting when multiple walls overlap at corners.
      let bestDepth = 0;
      let bestPushX = 0, bestPushZ = 0;

      for (const b of this.world.boxes) {
        // Vertical overlap test (wall must be at our height to block us).
        if (yTop < b.aabbMinY) continue;
        if (yBottom > b.aabbMaxY) continue;
        // Walkable surfaces lower than our feet are floors, not walls.
        if (b.walkable && b.aabbMaxY <= yBottom + 0.05) continue;
        // Broad-phase AABB
        if (tx + radius < b.aabbMinX) continue;
        if (tx - radius > b.aabbMaxX) continue;
        if (tz + radius < b.aabbMinZ) continue;
        if (tz - radius > b.aabbMaxZ) continue;

        // Transform target into box local frame (R^T).
        const wx = tx - b.centerX;
        const wz = tz - b.centerZ;
        const lx = wx * b.cosYaw - wz * b.sinYaw;
        const lz = wx * b.sinYaw + wz * b.cosYaw;

        // Closest point on the OBB (in xz):
        const cxx = clampN(lx, -b.halfX, b.halfX);
        const czz = clampN(lz, -b.halfZ, b.halfZ);
        const ddx = lx - cxx;
        const ddz = lz - czz;
        const dist2 = ddx * ddx + ddz * ddz;

        let pushLx: number, pushLz: number, depth: number;

        if (dist2 > 1e-10) {
          // Center is outside the box; check if within radius.
          if (dist2 >= radius * radius) continue;
          const dist = Math.sqrt(dist2);
          pushLx = ddx / dist;
          pushLz = ddz / dist;
          depth = radius - dist;
        } else {
          // Center is inside the box. Push out along the shallowest axis.
          const xOut = b.halfX - Math.abs(lx); // distance to nearest x face
          const zOut = b.halfZ - Math.abs(lz); // distance to nearest z face
          if (xOut < zOut) {
            pushLx = lx >= 0 ? 1 : -1;
            pushLz = 0;
            depth = xOut + radius;
          } else {
            pushLx = 0;
            pushLz = lz >= 0 ? 1 : -1;
            depth = zOut + radius;
          }
        }

        if (depth > bestDepth) {
          bestDepth = depth;
          // Local push -> world push (R)
          bestPushX = pushLx * b.cosYaw + pushLz * b.sinYaw;
          bestPushZ = -pushLx * b.sinYaw + pushLz * b.cosYaw;
        }
      }

      if (bestDepth > 1e-7) {
        // Move the target out of the wall by bestDepth along push.
        outDx += bestPushX * bestDepth;
        outDz += bestPushZ * bestDepth;
        // Track latest contact normal (used by caller for kill-velocity-into-wall).
        hitNX = bestPushX;
        hitNZ = bestPushZ;
        resolvedAny = true;
      }

      if (!resolvedAny) break;
    }

    return { dx: outDx, dz: outDz, hitNormalX: hitNX, hitNormalZ: hitNZ };
  }

  /** Ray vs the world's OBBs and ramps. Returns the nearest hit within
   *  `maxT` (in the direction-vector's units), or null. We do NOT hit the
   *  sky or invisible blockers. The ray should be normalized for `maxT`
   *  to mean meters. */
  rayWorld(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxT: number,
  ): { t: number; surface: BoxCollider['surface'] } | null {
    let bestT = maxT;
    let bestSurface: BoxCollider['surface'] = 'sand';
    let any = false;

    for (const b of this.world.boxes) {
      const t = rayObb(ox, oy, oz, dx, dy, dz, b, bestT);
      if (t !== null && t < bestT) {
        bestT = t;
        bestSurface = b.surface;
        any = true;
      }
    }
    for (const r of this.world.ramps) {
      const t = rayRamp(ox, oy, oz, dx, dy, dz, r, bestT);
      if (t !== null && t < bestT) {
        bestT = t;
        bestSurface = r.surface;
        any = true;
      }
    }

    if (!any) return null;
    return { t: bestT, surface: bestSurface };
  }

  /** Returns true if a vertical capsule at (x, yBottom, z) would intersect
   *  any non-walkable box (or a walkable box that goes through us). Used to
   *  block crouch-uncrouch when there's a low ceiling. */
  capsuleClear(x: number, yBottom: number, z: number, radius: number, height: number): boolean {
    const yTop = yBottom + height;
    const eps = 0.001;
    for (const b of this.world.boxes) {
      if (yTop < b.aabbMinY) continue;
      // Skip boxes whose top is at or below our feet — they can't be a ceiling.
      // This handles the floor we're standing on (where yBottom == aabbMaxY).
      if (yBottom >= b.aabbMaxY - eps) continue;
      if (x + radius < b.aabbMinX) continue;
      if (x - radius > b.aabbMaxX) continue;
      if (z + radius < b.aabbMinZ) continue;
      if (z - radius > b.aabbMaxZ) continue;
      const wx = x - b.centerX;
      const wz = z - b.centerZ;
      const lx = wx * b.cosYaw - wz * b.sinYaw;
      const lz = wx * b.sinYaw + wz * b.cosYaw;
      const cxx = clampN(lx, -b.halfX, b.halfX);
      const czz = clampN(lz, -b.halfZ, b.halfZ);
      const ddx = lx - cxx;
      const ddz = lz - czz;
      if (ddx * ddx + ddz * ddz < radius * radius) return false;
    }
    return true;
  }
}

function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function pointInsideBoxXZ(x: number, z: number, b: BoxCollider): boolean {
  const wx = x - b.centerX;
  const wz = z - b.centerZ;
  const lx = wx * b.cosYaw - wz * b.sinYaw;
  const lz = wx * b.sinYaw + wz * b.cosYaw;
  return lx >= -b.halfX && lx <= b.halfX && lz >= -b.halfZ && lz <= b.halfZ;
}

/** Ramp height at world (x,z), or null if outside the ramp's footprint. */
function rampHeightAt(x: number, z: number, r: RampCollider): number | null {
  const wx = x - r.originX;
  const wz = z - r.originZ;
  const lx = wx * r.cosYaw - wz * r.sinYaw;
  const lz = wx * r.sinYaw + wz * r.cosYaw;
  if (lx < 0 || lx > r.length) return null;
  const hw = r.width / 2;
  if (lz < -hw || lz > hw) return null;
  const t = lx / r.length;
  return r.originY + r.height * t;
}

function rampNormalY(r: RampCollider): number {
  const ln = Math.hypot(r.length, r.height);
  return r.length / ln;
}

/** Slab-test ray vs OBB (yaw-rotated). Returns t at first entry, or null. */
function rayObb(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  b: BoxCollider,
  maxT: number,
): number | null {
  // Transform ray origin and direction into the box's local frame.
  const rx = ox - b.centerX;
  const ry = oy - b.centerY;
  const rz = oz - b.centerZ;
  const lox = rx * b.cosYaw - rz * b.sinYaw;
  const loy = ry;
  const loz = rx * b.sinYaw + rz * b.cosYaw;
  const ldx = dx * b.cosYaw - dz * b.sinYaw;
  const ldy = dy;
  const ldz = dx * b.sinYaw + dz * b.cosYaw;

  // Slab test in local space.
  let tMin = -Infinity;
  let tMax = Infinity;
  const slab = (lo: number, ld: number, half: number): boolean => {
    if (Math.abs(ld) < 1e-9) {
      return lo >= -half && lo <= half;
    }
    const t1 = (-half - lo) / ld;
    const t2 = ( half - lo) / ld;
    const tNear = Math.min(t1, t2);
    const tFar = Math.max(t1, t2);
    if (tNear > tMin) tMin = tNear;
    if (tFar < tMax) tMax = tFar;
    return tMin <= tMax;
  };
  if (!slab(lox, ldx, b.halfX)) return null;
  if (!slab(loy, ldy, b.halfY)) return null;
  if (!slab(loz, ldz, b.halfZ)) return null;

  // Pick the nearest non-negative t.
  let t: number;
  if (tMin >= 0) t = tMin;
  else if (tMax >= 0) t = tMax;
  else return null;
  if (t > maxT) return null;
  return t;
}

/** Ray vs the slanted top of a ramp triangle prism. Approximated with
 *  an AABB intersection then a plane test on the slope. Sufficient for
 *  bullet-vs-ramp at our resolution. */
function rayRamp(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  r: RampCollider,
  maxT: number,
): number | null {
  // First, AABB cull.
  if (!rayAabb(ox, oy, oz, dx, dy, dz, r.aabbMinX, r.aabbMinY, r.aabbMinZ, r.aabbMaxX, r.aabbMaxY, r.aabbMaxZ, maxT)) {
    return null;
  }
  // Test against the slanted plane: y = originY + (height/length) * lx,
  // where lx = (worldX - originX) * cosYaw - (worldZ - originZ) * sinYaw
  // Equivalently: ax + cz + by = d, where
  //   a = -(height/length) * cosYaw
  //   c =  (height/length) * sinYaw
  //   b = 1
  //   d = originY - (height/length) * (originX * (-cosYaw) + originZ * sinYaw)
  // Easier to plug in directly:
  const slope = r.height / r.length;
  // Walk t along the ray in 0..maxT and check at intersection.
  const denom = dy - slope * (dx * r.cosYaw - dz * r.sinYaw);
  if (Math.abs(denom) < 1e-9) return null;
  const lxOrigin = (ox - r.originX) * r.cosYaw - (oz - r.originZ) * r.sinYaw;
  const tNum = (r.originY + slope * lxOrigin) - oy;
  const t = tNum / denom;
  if (t < 0 || t > maxT) return null;
  // Verify hit point lies inside the ramp footprint.
  const hx = ox + dx * t;
  const hz = oz + dz * t;
  const wx = hx - r.originX;
  const wz = hz - r.originZ;
  const lx = wx * r.cosYaw - wz * r.sinYaw;
  const lz = wx * r.sinYaw + wz * r.cosYaw;
  if (lx < 0 || lx > r.length) return null;
  const hw = r.width / 2;
  if (lz < -hw || lz > hw) return null;
  return t;
}

function rayAabb(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
  maxT: number,
): boolean {
  let tMin = -Infinity;
  let tMax = Infinity;
  const tx1 = Math.abs(dx) < 1e-9 ? (ox >= minX && ox <= maxX ? -Infinity : Infinity) : (minX - ox) / dx;
  const tx2 = Math.abs(dx) < 1e-9 ? (ox >= minX && ox <= maxX ? Infinity : -Infinity) : (maxX - ox) / dx;
  const ty1 = Math.abs(dy) < 1e-9 ? (oy >= minY && oy <= maxY ? -Infinity : Infinity) : (minY - oy) / dy;
  const ty2 = Math.abs(dy) < 1e-9 ? (oy >= minY && oy <= maxY ? Infinity : -Infinity) : (maxY - oy) / dy;
  const tz1 = Math.abs(dz) < 1e-9 ? (oz >= minZ && oz <= maxZ ? -Infinity : Infinity) : (minZ - oz) / dz;
  const tz2 = Math.abs(dz) < 1e-9 ? (oz >= minZ && oz <= maxZ ? Infinity : -Infinity) : (maxZ - oz) / dz;
  tMin = Math.max(tMin, Math.min(tx1, tx2), Math.min(ty1, ty2), Math.min(tz1, tz2));
  tMax = Math.min(tMax, Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2));
  return tMax >= Math.max(0, tMin) && tMin <= maxT;
}
