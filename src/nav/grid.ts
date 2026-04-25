/** Uniform XZ grid over the map. Each cell stores whether a player capsule
 *  fits at the cell center and, if so, the floor height there. The grid is
 *  the substrate the A* pathfinder runs on.
 *
 *  We deliberately avoid RecastJS for now — Dust 2 is hand-authored, almost
 *  flat, and the player capsule is small. A grid is roughly 200 lines, has
 *  no native dependency, and produces paths that are good enough through
 *  M5. When grenades land on weird ledges in M6 we'll revisit. */

import type { World } from '../map/world';
import type { WorldQuery } from '../player/physics';

export interface BuildOptions {
  cellSize: number;
  /** Capsule radius used for the walkable check. Slightly larger than the
   *  actual player radius (0.36 m) so paths don't graze walls. */
  agentRadius: number;
  /** Capsule height for the walkable check (standing height). */
  agentHeight: number;
  /** When probing for the floor at a cell center, start the ray this high
   *  above the map's max Y. */
  probeAbove: number;
  /** Max vertical drop from probe origin we'll accept as a valid floor. */
  probeDrop: number;
  /** Pad the bounds by this many meters on each XZ side. */
  padding: number;
}

export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  cellSize: 0.6,
  agentRadius: 0.40,
  agentHeight: 1.80,
  probeAbove: 1.0,
  probeDrop: 12.0,
  padding: 1.0,
};

/** Sentinel for "this cell has no floor" / "unwalkable". */
export const NO_GROUND = -10_000;

export class NavGrid {
  readonly cellSize: number;
  readonly minX: number;
  readonly minZ: number;
  readonly cellsX: number;
  readonly cellsZ: number;
  /** 1 = walkable, 0 = blocked. Indexed by `j * cellsX + i`. */
  private readonly walkable: Uint8Array;
  /** Floor height at the cell center (or NO_GROUND if no floor). */
  private readonly groundY: Float32Array;

  private constructor(
    cellSize: number, minX: number, minZ: number,
    cellsX: number, cellsZ: number,
    walkable: Uint8Array, groundY: Float32Array,
  ) {
    this.cellSize = cellSize;
    this.minX = minX;
    this.minZ = minZ;
    this.cellsX = cellsX;
    this.cellsZ = cellsZ;
    this.walkable = walkable;
    this.groundY = groundY;
  }

  static build(world: World, query: WorldQuery, opts: BuildOptions = DEFAULT_BUILD_OPTIONS): NavGrid {
    const { cellSize, agentRadius, agentHeight, probeAbove, probeDrop, padding } = opts;
    const minX = world.bounds.minX - padding;
    const maxX = world.bounds.maxX + padding;
    const minZ = world.bounds.minZ - padding;
    const maxZ = world.bounds.maxZ + padding;
    const cellsX = Math.max(1, Math.ceil((maxX - minX) / cellSize));
    const cellsZ = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
    const total = cellsX * cellsZ;
    const walkable = new Uint8Array(total);
    const groundY = new Float32Array(total);

    const probeY = world.bounds.maxY + probeAbove;
    for (let j = 0; j < cellsZ; j++) {
      for (let i = 0; i < cellsX; i++) {
        const x = minX + (i + 0.5) * cellSize;
        const z = minZ + (j + 0.5) * cellSize;
        const idx = j * cellsX + i;

        const ground = query.groundProbe(x, z, probeY, probeDrop);
        if (!ground) {
          groundY[idx] = NO_GROUND;
          walkable[idx] = 0;
          continue;
        }
        groundY[idx] = ground.y;
        // Capsule must fit standing at this cell center (no overlapping
        // walls or low ceilings).
        const clear = query.capsuleClear(x, ground.y + 0.02, z, agentRadius, agentHeight);
        walkable[idx] = clear ? 1 : 0;
      }
    }

    return new NavGrid(cellSize, minX, minZ, cellsX, cellsZ, walkable, groundY);
  }

  /** Map a world XZ to its cell coords. Returns null if outside the grid. */
  worldToCell(x: number, z: number): { i: number; j: number } | null {
    const i = Math.floor((x - this.minX) / this.cellSize);
    const j = Math.floor((z - this.minZ) / this.cellSize);
    if (i < 0 || i >= this.cellsX || j < 0 || j >= this.cellsZ) return null;
    return { i, j };
  }

  cellCenterWorld(i: number, j: number): { x: number; z: number } {
    return {
      x: this.minX + (i + 0.5) * this.cellSize,
      z: this.minZ + (j + 0.5) * this.cellSize,
    };
  }

  inBounds(i: number, j: number): boolean {
    return i >= 0 && i < this.cellsX && j >= 0 && j < this.cellsZ;
  }

  isWalkable(i: number, j: number): boolean {
    if (!this.inBounds(i, j)) return false;
    return this.walkable[j * this.cellsX + i] === 1;
  }

  groundYAt(i: number, j: number): number {
    if (!this.inBounds(i, j)) return NO_GROUND;
    return this.groundY[j * this.cellsX + i]!;
  }

  /** Total cell count (handy for sizing A* working buffers). */
  get total(): number {
    return this.cellsX * this.cellsZ;
  }

  /** Find the nearest walkable cell to (x, z) within `maxRadiusCells` rings.
   *  Used to snap a possibly-blocked start/goal onto the navmesh. */
  nearestWalkable(x: number, z: number, maxRadiusCells = 6): { i: number; j: number } | null {
    const home = this.worldToCell(x, z);
    if (!home) return null;
    if (this.isWalkable(home.i, home.j)) return home;
    for (let r = 1; r <= maxRadiusCells; r++) {
      // Walk the ring of side 2r+1.
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const ni = home.i + di;
          const nj = home.j + dj;
          if (this.isWalkable(ni, nj)) return { i: ni, j: nj };
        }
      }
    }
    return null;
  }
}
