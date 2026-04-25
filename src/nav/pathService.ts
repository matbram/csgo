/** Path service — wraps `findPath` with a per-frame budget so a horde of
 *  bots replanning at the same moment can't blow the sim tick budget,
 *  plus a small LRU cache keyed by (start cell, goal cell) since bots in
 *  the same group often head toward the same callout from similar
 *  positions.
 *
 *  Pass 1 is synchronous: callers ask for a path now and either get one
 *  back or get null (rate-limited or unreachable). The async/queued
 *  version comes when bots start replanning mid-fight in Pass 2. */

import type { NavGrid } from './grid';
import { findPath, type PathPoint } from './astar';

interface CacheEntry {
  startKey: number;
  goalKey: number;
  path: PathPoint[];
  hitMs: number;
}

export interface PathServiceOptions {
  /** Hard cap on `findPath` calls per `beginFrame()` window. */
  maxRequestsPerFrame: number;
  /** Cache size. The cache is small and approximate — paths between
   *  nearby cells are good enough, even if not optimal. */
  cacheSize: number;
}

const DEFAULTS: PathServiceOptions = { maxRequestsPerFrame: 2, cacheSize: 32 };

export class PathService {
  private readonly grid: NavGrid;
  private readonly opts: PathServiceOptions;
  private remaining: number;
  private readonly cache: CacheEntry[] = [];
  private clock = 0;

  constructor(grid: NavGrid, opts: Partial<PathServiceOptions> = {}) {
    this.grid = grid;
    this.opts = { ...DEFAULTS, ...opts };
    this.remaining = this.opts.maxRequestsPerFrame;
  }

  /** Reset the per-frame budget. Call once per sim tick. */
  beginFrame(): void {
    this.remaining = this.opts.maxRequestsPerFrame;
    this.clock += 1;
  }

  /** Try to compute a path from `start` to `goal`. Returns null when:
   *   - the per-frame budget is exhausted (caller should try again later)
   *   - either endpoint can't be snapped to the navmesh
   *   - no path exists. */
  request(start: { x: number; z: number }, goal: { x: number; z: number }): PathPoint[] | null {
    const startCell = this.grid.nearestWalkable(start.x, start.z);
    const goalCell = this.grid.nearestWalkable(goal.x, goal.z);
    if (!startCell || !goalCell) return null;
    const startKey = startCell.j * this.grid.cellsX + startCell.i;
    const goalKey = goalCell.j * this.grid.cellsX + goalCell.i;
    // Cache hit?
    for (const entry of this.cache) {
      if (entry.startKey === startKey && entry.goalKey === goalKey) {
        entry.hitMs = this.clock;
        return clonePath(entry.path);
      }
    }
    if (this.remaining <= 0) return null;
    this.remaining -= 1;
    const path = findPath(this.grid, start, goal);
    if (path) this.insert(startKey, goalKey, path);
    return path ? clonePath(path) : null;
  }

  /** Number of paths that can still be computed this frame. */
  get budgetRemaining(): number {
    return this.remaining;
  }

  private insert(startKey: number, goalKey: number, path: PathPoint[]): void {
    if (this.cache.length >= this.opts.cacheSize) {
      // Evict oldest (smallest hitMs).
      let oldestIdx = 0;
      let oldestMs = this.cache[0]!.hitMs;
      for (let i = 1; i < this.cache.length; i++) {
        if (this.cache[i]!.hitMs < oldestMs) {
          oldestMs = this.cache[i]!.hitMs;
          oldestIdx = i;
        }
      }
      this.cache.splice(oldestIdx, 1);
    }
    this.cache.push({ startKey, goalKey, path: clonePath(path), hitMs: this.clock });
  }
}

function clonePath(p: PathPoint[]): PathPoint[] {
  // Bots may mutate path entries (e.g. Y snapping); give each caller their
  // own copy so cache entries stay clean.
  return p.map(pt => ({ x: pt.x, y: pt.y, z: pt.z }));
}
