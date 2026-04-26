/** Targeted tests for A* over a hand-rolled grid. We don't pull the real
 *  map here — we just construct a NavGrid in-memory by patching its
 *  internal state after a tiny `World`-driven build to keep this test
 *  hermetic and fast. */

import { describe, it, expect } from 'vitest';
import { NavGrid } from './grid';
import { findPath } from './astar';

/** Build a NavGrid directly from a walkability mask. Useful for tests so
 *  we don't have to spin up a fake World + WorldQuery. */
function gridFromMask(mask: number[][], cellSize = 1): NavGrid {
  const cellsZ = mask.length;
  const cellsX = mask[0]!.length;
  const walkable = new Uint8Array(cellsX * cellsZ);
  const groundY = new Float32Array(cellsX * cellsZ);
  for (let j = 0; j < cellsZ; j++) {
    for (let i = 0; i < cellsX; i++) {
      const idx = j * cellsX + i;
      walkable[idx] = mask[j]![i]!;
      groundY[idx] = 0;
    }
  }
  // Bypass the public builder — instantiate via the private ctor through
  // a small cast. This keeps tests independent of map physics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (NavGrid as any)(cellSize, 0, 0, cellsX, cellsZ, walkable, groundY);
}

describe('A* findPath', () => {
  it('finds a straight path on an empty grid', () => {
    const g = gridFromMask([
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
    ]);
    const p = findPath(g, { x: 0.5, z: 0.5 }, { x: 4.5, z: 1.5 });
    expect(p).not.toBeNull();
    expect(p!.length).toBeGreaterThan(0);
    // Last waypoint is at the goal cell center.
    const last = p![p!.length - 1]!;
    expect(last.x).toBeCloseTo(4.5, 1);
    expect(last.z).toBeCloseTo(1.5, 1);
  });

  it('routes around a wall', () => {
    // 0 = wall. The middle column is blocked except at the bottom row.
    const g = gridFromMask([
      [1, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
    ]);
    const p = findPath(g, { x: 0.5, z: 0.5 }, { x: 2.5, z: 0.5 });
    expect(p).not.toBeNull();
    // Path must touch row 2 (the only walkable row through the wall).
    expect(p!.some((pt) => Math.round(pt.z - 0.5) === 2)).toBe(true);
  });

  it('returns null when goal is unreachable', () => {
    const g = gridFromMask([
      [1, 0, 1],
      [1, 0, 1],
      [1, 0, 1],
    ]);
    const p = findPath(g, { x: 0.5, z: 0.5 }, { x: 2.5, z: 0.5 });
    expect(p).toBeNull();
  });

  it('refuses to cut diagonally through a corner', () => {
    // The bot stands at (1,1). The cell directly NE is walkable but both
    // cardinal neighbours (E and N) are walls. A diagonal move into NE
    // would clip the corner.
    const g = gridFromMask([
      [1, 0, 1],
      [0, 1, 0],
      [1, 0, 1],
    ]);
    const p = findPath(g, { x: 1.5, z: 1.5 }, { x: 2.5, z: 0.5 });
    expect(p).toBeNull();
  });

  it('prunes collinear waypoints on a straight corridor', () => {
    // 1×10 corridor — pruning should collapse the run into start+goal.
    const row = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const g = gridFromMask([row]);
    const p = findPath(g, { x: 0.5, z: 0.5 }, { x: 9.5, z: 0.5 });
    expect(p).not.toBeNull();
    expect(p!.length).toBeLessThanOrEqual(2);
  });
});
