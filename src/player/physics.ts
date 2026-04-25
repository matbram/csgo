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

  /** Returns true if a vertical capsule at (x, yBottom, z) would intersect
   *  any non-walkable box (or a walkable box that goes through us). Used to
   *  block crouch-uncrouch when there's a low ceiling. */
  capsuleClear(x: number, yBottom: number, z: number, radius: number, height: number): boolean {
    const yTop = yBottom + height;
    for (const b of this.world.boxes) {
      if (yTop < b.aabbMinY) continue;
      if (yBottom > b.aabbMaxY) continue;
      // For ceilings, walkable doesn't matter — if our head is inside the box, blocked.
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
