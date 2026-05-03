/** Compiled, queryable representation of the map. The builder fills this
 *  in when traversing the authoring tree. The character controller and
 *  raycasts query through this — never directly through Babylon meshes. */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { CalloutId, Vec2, Team } from './types';

/** Axis-aligned-after-rotation collider. Boxes are stored as oriented
 *  boxes (yaw around Y) since the map authoring allows any yaw. We treat
 *  this as the OBB form. */
export interface BoxCollider {
  /** Center in world space (xz center, y bottom + halfY). */
  centerX: number;
  centerY: number;
  centerZ: number;
  halfX: number;
  halfY: number;
  halfZ: number;
  /** Yaw rotation in radians around Y. */
  yaw: number;
  cosYaw: number;
  sinYaw: number;
  walkable: boolean;
  surface: 'sand' | 'wood' | 'metal' | 'concrete' | 'stone';
  /** AABB for broad-phase culling. */
  aabbMinX: number; aabbMaxX: number;
  aabbMinY: number; aabbMaxY: number;
  aabbMinZ: number; aabbMaxZ: number;
}

export interface RampCollider {
  /** Origin on the lower edge (center of low edge). */
  originX: number;
  originY: number;
  originZ: number;
  /** Length along ramp's local +x (pre-rotation). */
  length: number;
  /** Vertical rise from low to high. */
  height: number;
  width: number;
  yaw: number;
  cosYaw: number;
  sinYaw: number;
  surface: BoxCollider['surface'];
  aabbMinX: number; aabbMaxX: number;
  aabbMinY: number; aabbMaxY: number;
  aabbMinZ: number; aabbMaxZ: number;
}

export interface CalloutZone {
  id: CalloutId;
  polygon: Vec2[]; // world XZ
  yMin: number;
  yMax: number;
  centroid: Vec2;
  adjacent: CalloutId[];
  facing?: CalloutId;
}

export interface Spawn {
  team: Team;
  pos: Vector3;
  yaw: number;
}

export interface BombSiteRegion {
  site: 'A' | 'B';
  polygon: Vec2[];
  yMin: number;
  yMax: number;
}

export interface BuyZoneRegion {
  team: Team;
  polygon: Vec2[];
  yMin: number;
  yMax: number;
}

export class World {
  readonly boxes: BoxCollider[] = [];
  readonly ramps: RampCollider[] = [];
  readonly callouts: Map<CalloutId, CalloutZone> = new Map();
  readonly spawns: Spawn[] = [];
  readonly bombSites: BombSiteRegion[] = [];
  readonly buyZones: BuyZoneRegion[] = [];

  /** Combined AABB of the entire map. Used for the navmesh bounds and
   *  for fog/distance calculations. */
  bounds = {
    minX: Infinity, maxX: -Infinity,
    minY: Infinity, maxY: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
  };

  expandBounds(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
    if (minX < this.bounds.minX) this.bounds.minX = minX;
    if (minY < this.bounds.minY) this.bounds.minY = minY;
    if (minZ < this.bounds.minZ) this.bounds.minZ = minZ;
    if (maxX > this.bounds.maxX) this.bounds.maxX = maxX;
    if (maxY > this.bounds.maxY) this.bounds.maxY = maxY;
    if (maxZ > this.bounds.maxZ) this.bounds.maxZ = maxZ;
  }

  /** Find which callout (if any) contains the given XZ point at the given Y. */
  calloutAt(x: number, y: number, z: number): CalloutId | null {
    for (const c of this.callouts.values()) {
      if (y < c.yMin - 0.1 || y > c.yMax + 0.1) continue;
      if (pointInPolygon2D(x, z, c.polygon)) return c.id;
    }
    return null;
  }

  /** Containing callout if any, else the nearest by centroid distance.
   *  Used by the comms layer so a bot caught between callout polygons
   *  ("on the corner of A_LONG and PIT") still produces a usable
   *  "two a long" callout instead of "one spotted". Cheap — ~25
   *  callouts per call on Dust 2. */
  nearestCallout(x: number, y: number, z: number): CalloutId | null {
    const inside = this.calloutAt(x, y, z);
    if (inside) return inside;
    let best: CalloutId | null = null;
    let bestSq = Infinity;
    for (const c of this.callouts.values()) {
      const dx = c.centroid[0] - x;
      const dz = c.centroid[1] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestSq) { bestSq = d2; best = c.id; }
    }
    return best;
  }

  spawnsForTeam(team: Team): Spawn[] {
    return this.spawns.filter(s => s.team === team);
  }
}

export function pointInPolygon2D(x: number, z: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    const xi = pi[0], zi = pi[1];
    const xj = pj[0], zj = pj[1];
    const intersect = ((zi > z) !== (zj > z)) &&
      (x < ((xj - xi) * (z - zi)) / ((zj - zi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let cx = 0, cz = 0;
  for (const p of poly) { cx += p[0]; cz += p[1]; }
  const n = Math.max(1, poly.length);
  return [cx / n, cz / n];
}
