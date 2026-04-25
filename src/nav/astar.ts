/** 8-connected A* over a NavGrid.
 *
 *  The grid is small enough (~20k cells for Dust 2 at 0.6 m) that a
 *  binary-heap open set + Float32Array g-scores fits in a few KB of
 *  working memory and runs comfortably under a millisecond per query
 *  for typical bot path lengths.
 *
 *  Output is a list of world-space waypoints. Collinear / nearly-collinear
 *  waypoints are pruned so path followers don't zigzag through cell centers
 *  on a straight corridor. */

import { NavGrid } from './grid';

const SQRT2 = Math.SQRT2;

/** Octile distance — exact distance between two cells under 8-way moves
 *  with cost 1 for cardinal and √2 for diagonal. */
function octile(di: number, dj: number): number {
  const ax = Math.abs(di);
  const az = Math.abs(dj);
  return Math.max(ax, az) + (SQRT2 - 1) * Math.min(ax, az);
}

export interface PathPoint {
  x: number;
  y: number;
  z: number;
}

interface OpenEntry {
  idx: number;
  f: number;
}

/** Tiny binary min-heap keyed by f-score. */
class Heap {
  private readonly arr: OpenEntry[] = [];
  get size(): number { return this.arr.length; }
  push(e: OpenEntry): void {
    this.arr.push(e);
    let i = this.arr.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.arr[p]!.f <= this.arr[i]!.f) break;
      [this.arr[p], this.arr[i]] = [this.arr[i]!, this.arr[p]!];
      i = p;
    }
  }
  pop(): OpenEntry | undefined {
    if (this.arr.length === 0) return undefined;
    const top = this.arr[0]!;
    const last = this.arr.pop()!;
    if (this.arr.length > 0) {
      this.arr[0] = last;
      let i = 0;
      const n = this.arr.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let best = i;
        if (l < n && this.arr[l]!.f < this.arr[best]!.f) best = l;
        if (r < n && this.arr[r]!.f < this.arr[best]!.f) best = r;
        if (best === i) break;
        [this.arr[best], this.arr[i]] = [this.arr[i]!, this.arr[best]!];
        i = best;
      }
    }
    return top;
  }
}

/** Find a path from `startWorld` to `goalWorld` over `grid`. Returns null
 *  if either endpoint can't be snapped to the navmesh, or no path exists.
 *
 *  The returned path includes a waypoint for the goal cell center but does
 *  NOT include the start (the bot is already there). */
export function findPath(
  grid: NavGrid,
  startWorld: { x: number; z: number },
  goalWorld: { x: number; z: number },
): PathPoint[] | null {
  const start = grid.nearestWalkable(startWorld.x, startWorld.z);
  const goal = grid.nearestWalkable(goalWorld.x, goalWorld.z);
  if (!start || !goal) return null;
  if (start.i === goal.i && start.j === goal.j) {
    return [worldPoint(grid, goal.i, goal.j)];
  }

  const total = grid.total;
  const cellsX = grid.cellsX;
  const cellsZ = grid.cellsZ;

  const gScore = new Float32Array(total);
  gScore.fill(Infinity);
  // 0xFFFFFFFF acts as "no parent".
  const cameFrom = new Int32Array(total);
  cameFrom.fill(-1);
  const closed = new Uint8Array(total);

  const startIdx = start.j * cellsX + start.i;
  const goalIdx = goal.j * cellsX + goal.i;

  gScore[startIdx] = 0;
  const open = new Heap();
  open.push({ idx: startIdx, f: octile(goal.i - start.i, goal.j - start.j) });

  // Eight neighbour offsets.
  const NEI = [
    [ 1, 0, 1], [-1, 0, 1], [0,  1, 1], [0, -1, 1],
    [ 1, 1, SQRT2], [ 1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
  ] as const;

  while (open.size > 0) {
    const cur = open.pop()!;
    if (cur.idx === goalIdx) break;
    if (closed[cur.idx]) continue;
    closed[cur.idx] = 1;

    const ci = cur.idx % cellsX;
    const cj = (cur.idx - ci) / cellsX;
    const cg = gScore[cur.idx]!;

    for (const [di, dj, baseCost] of NEI) {
      const ni = ci + di;
      const nj = cj + dj;
      if (ni < 0 || ni >= cellsX || nj < 0 || nj >= cellsZ) continue;
      if (!grid.isWalkable(ni, nj)) continue;
      // Disallow diagonal cuts through corners — both adjacent cardinals
      // must be walkable too. Without this bots can squeeze through walls
      // at exact corners.
      if (di !== 0 && dj !== 0) {
        if (!grid.isWalkable(ci + di, cj)) continue;
        if (!grid.isWalkable(ci, cj + dj)) continue;
      }
      const nIdx = nj * cellsX + ni;
      if (closed[nIdx]) continue;
      // Penalize big vertical jumps so paths prefer flat connections.
      const dy = Math.abs(grid.groundYAt(ni, nj) - grid.groundYAt(ci, cj));
      const stepCost = baseCost * (1 + Math.min(2, dy));
      const tentative = cg + stepCost;
      if (tentative < gScore[nIdx]!) {
        gScore[nIdx] = tentative;
        cameFrom[nIdx] = cur.idx;
        const f = tentative + octile(goal.i - ni, goal.j - nj);
        open.push({ idx: nIdx, f });
      }
    }
  }

  if (gScore[goalIdx] === Infinity) return null;

  // Reconstruct in reverse, then reverse and prune collinear waypoints.
  const cells: number[] = [];
  let cursor = goalIdx;
  while (cursor !== -1) {
    cells.push(cursor);
    if (cursor === startIdx) break;
    cursor = cameFrom[cursor]!;
  }
  cells.reverse();
  // Drop the first cell (where the bot already is).
  cells.shift();

  const points: PathPoint[] = [];
  for (const idx of cells) {
    const i = idx % cellsX;
    const j = (idx - i) / cellsX;
    points.push(worldPoint(grid, i, j));
  }
  return prune(points);
}

function worldPoint(grid: NavGrid, i: number, j: number): PathPoint {
  const c = grid.cellCenterWorld(i, j);
  return { x: c.x, y: grid.groundYAt(i, j), z: c.z };
}

/** Drop nearly-collinear waypoints. Two segments are collapsed when the
 *  cross product of their direction vectors is small AND their vertical
 *  step is small, so straight corridors become a single segment. */
function prune(pts: PathPoint[]): PathPoint[] {
  if (pts.length < 3) return pts;
  const out: PathPoint[] = [pts[0]!];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = out[out.length - 1]!;
    const b = pts[k]!;
    const c = pts[k + 1]!;
    const ax = b.x - a.x, az = b.z - a.z;
    const bx = c.x - b.x, bz = c.z - b.z;
    const cross = ax * bz - az * bx;
    const dy1 = Math.abs(b.y - a.y);
    const dy2 = Math.abs(c.y - b.y);
    if (Math.abs(cross) < 0.04 && dy1 < 0.2 && dy2 < 0.2) {
      // Collinear in XZ and small Y change — drop b.
      continue;
    }
    out.push(b);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}
