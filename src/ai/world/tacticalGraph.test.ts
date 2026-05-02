/** Auto-derivation tests for the tactical map graph. We build a tiny
 *  synthetic World + NavGrid + WorldQuery so each test pins one piece
 *  of the derivation in isolation:
 *    - cover detection vs. eye-height obstruction
 *    - per-callout clustering
 *    - peek-node generation behind a wall
 *    - hold-angle yaw points at the right callout
 *    - pre-aim spots come out of callout adjacency
 *    - hand-tune overlay tags head-glitches and adds hold angles
 */

import { describe, it, expect } from 'vitest';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { NavGrid } from '../../nav/grid';
import { World } from '../../map/world';
import {
  buildTacticalGraph, preAimFor, type TacticalOverlay,
} from './tacticalGraph';
import type { WorldQuery } from '../../player/physics';
import type { CalloutId } from '../../map/types';

/** Build a NavGrid from a walkability mask. Mirrors the helper used in
 *  astar.test — the cell size of 1 m keeps the math simple. */
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (NavGrid as any)(cellSize, 0, 0, cellsX, cellsZ, walkable, groundY);
}

/** Synthetic World query that returns a hit if the ray crosses any of
 *  the supplied AABBs. Cheap enough to express "wall here, opening
 *  there" in a couple of lines per test. */
function makeQuery(walls: Array<{ minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }>): WorldQuery {
  return {
    rayWorld(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number) {
      let bestT = maxT;
      let any = false;
      for (const b of walls) {
        // Slab intersection.
        let tmin = -Infinity, tmax = Infinity;
        const test = (o: number, d: number, lo: number, hi: number): boolean => {
          if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
          const t1 = (lo - o) / d;
          const t2 = (hi - o) / d;
          const lo2 = Math.min(t1, t2);
          const hi2 = Math.max(t1, t2);
          if (lo2 > tmin) tmin = lo2;
          if (hi2 < tmax) tmax = hi2;
          return tmax >= Math.max(0, tmin);
        };
        if (!test(ox, dx, b.minX, b.maxX)) continue;
        if (!test(oy, dy, b.minY, b.maxY)) continue;
        if (!test(oz, dz, b.minZ, b.maxZ)) continue;
        const t = Math.max(0, tmin);
        if (t < bestT) { bestT = t; any = true; }
      }
      return any ? { t: bestT, surface: 'concrete' as const } : null;
    },
    // Unused by the tactical graph builder but required by the type.
    groundProbe() { return null; },
    capsuleClear() { return true; },
  } as unknown as WorldQuery;
}

/** Add a callout zone to a synthetic world. Centroid is the average
 *  of the polygon corners. */
function addCallout(world: World, id: CalloutId, polygon: Array<[number, number]>, adjacent: CalloutId[] = [], facing?: CalloutId): void {
  let cx = 0, cz = 0;
  for (const [x, z] of polygon) { cx += x; cz += z; }
  cx /= polygon.length; cz /= polygon.length;
  world.callouts.set(id, {
    id, polygon, yMin: -1, yMax: 8,
    centroid: [cx, cz], adjacent, facing,
  });
}

describe('buildTacticalGraph', () => {
  it('detects cover next to an eye-height wall', () => {
    // 5x3 walkable strip; a wall AABB covers cell (2,1) at full height.
    const grid = gridFromMask([
      [1, 1, 1, 1, 1],
      [1, 1, 0, 1, 1],
      [1, 1, 1, 1, 1],
    ]);
    const query = makeQuery([
      // Wall sits exactly over cell (2,1) which has center (2.5, 0, 1.5).
      { minX: 2.0, maxX: 3.0, minY: 0, maxY: 2.5, minZ: 1.0, maxZ: 2.0 },
    ]);
    const world = new World();
    addCallout(world, 'A_SITE', [[0, 0], [5, 0], [5, 3], [0, 3]]);

    const g = buildTacticalGraph(world, grid, query, {}, {
      eyeHeight: 1.55, crouchEye: 1.05,
      clusterRadius: 0.0,                  // disable clustering for this test
      peekRangeM: 5, exposureSamplesPerSite: 1,
    });
    // Cells (1,1) and (3,1) sit immediately west/east of the wall —
    // both should produce CoverNodes with horizontal normals.
    const adjacentCovers = g.cover.filter(c =>
      Math.abs(c.z - 1.5) < 0.01 &&
      (Math.abs(c.x - 1.5) < 0.01 || Math.abs(c.x - 3.5) < 0.01),
    );
    expect(adjacentCovers.length).toBe(2);
    for (const c of adjacentCovers) {
      // Normal points away from the wall — expect +X for the west neighbour
      // (x=1.5; wall to the east) and -X for the east neighbour (x=3.5).
      const sign = c.x < 2.5 ? -1 : 1;
      expect(Math.sign(c.normalX)).toBe(sign);
      expect(c.height).toBe('full');
      expect(c.callout).toBe('A_SITE');
    }
  });

  it('clusters cover cells into a single representative within cluster radius', () => {
    // A row of cover cells next to a long wall — clustering should
    // collapse them by clusterRadius.
    const grid = gridFromMask([
      [1, 1, 1, 1, 1],
      [0, 0, 0, 0, 0],          // long wall row (un-walkable)
      [1, 1, 1, 1, 1],
    ]);
    const wall: Array<{ minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }> = [
      { minX: 0, maxX: 5, minY: 0, maxY: 2.5, minZ: 1.0, maxZ: 2.0 },
    ];
    const query = makeQuery(wall);
    const world = new World();
    addCallout(world, 'B_SITE', [[0, 2], [5, 2], [5, 3], [0, 3]]);

    const tight = buildTacticalGraph(world, grid, query, {}, {
      eyeHeight: 1.55, crouchEye: 1.05,
      clusterRadius: 0.0, peekRangeM: 5, exposureSamplesPerSite: 1,
    });
    const loose = buildTacticalGraph(world, grid, query, {}, {
      eyeHeight: 1.55, crouchEye: 1.05,
      clusterRadius: 3.0, peekRangeM: 5, exposureSamplesPerSite: 1,
    });
    // With no clustering: at least one cover per south-row cell (5 cells).
    expect(tight.cover.length).toBeGreaterThanOrEqual(5);
    // With wide clustering: collapses to fewer reps.
    expect(loose.cover.length).toBeLessThan(tight.cover.length);
  });

  it('produces pre-aim spots from callout adjacency', () => {
    const grid = gridFromMask([[1, 1, 1]]);
    const query = makeQuery([]);
    const world = new World();
    addCallout(world, 'A_LONG', [[0, 0], [3, 0], [3, 1], [0, 1]], ['A_SITE']);
    addCallout(world, 'A_SITE', [[0, 5], [3, 5], [3, 6], [0, 6]], ['A_LONG']);
    const g = buildTacticalGraph(world, grid, query);
    expect(preAimFor(g, 'A_LONG', 'A_SITE')).not.toBeNull();
    expect(preAimFor(g, 'A_SITE', 'A_LONG')).not.toBeNull();
    expect(preAimFor(g, 'A_LONG', 'B_SITE')).toBeNull();
    // A_LONG → A_SITE: the spots are along +Z, so yaw ≈ 0.
    const spot = preAimFor(g, 'A_LONG', 'A_SITE')!;
    expect(Math.abs(spot.yaw)).toBeLessThan(0.1);
  });

  it('hand-tune overlay marks head-glitch spots and adds hold angles', () => {
    const grid = gridFromMask([
      [1, 1, 1, 1, 1],
      [1, 1, 0, 1, 1],
      [1, 1, 1, 1, 1],
    ]);
    const query = makeQuery([
      { minX: 2.0, maxX: 3.0, minY: 0, maxY: 2.5, minZ: 1.0, maxZ: 2.0 },
    ]);
    const world = new World();
    addCallout(world, 'A_SITE', [[0, 0], [5, 0], [5, 3], [0, 3]]);
    const overlay: TacticalOverlay = {
      headGlitchAt: [{ x: 1.5, z: 1.5, callout: 'A_SITE' }],
      extraHoldAngles: [{
        callout: 'A_SITE',
        fromX: 1.5, fromZ: 1.5,
        yawDeg: 90,
        exposes: 'A_SITE',
        headGlitch: true,
      }],
    };
    const g = buildTacticalGraph(world, grid, query, overlay);
    const tagged = g.cover.find(c => c.headGlitch);
    expect(tagged).toBeDefined();
    // The extra hold angle (yaw 90deg → +X) should appear.
    const extra = g.holdAngles.find(h => Math.abs(h.yaw - Math.PI / 2) < 0.01);
    expect(extra).toBeDefined();
    expect(extra!.headGlitch).toBe(true);
  });

  it('builds an exposure map of the right size', () => {
    const grid = gridFromMask([
      [1, 1, 1],
      [1, 1, 1],
    ]);
    const query = makeQuery([]);
    const world = new World();
    // Synthetic bombsite covering everything.
    world.bombSites.push({ site: 'A', polygon: [[0, 0], [3, 0], [3, 2], [0, 2]], yMin: 0, yMax: 4 });
    const g = buildTacticalGraph(world, grid, query, {}, {
      eyeHeight: 1.55, crouchEye: 1.05, clusterRadius: 0.5,
      peekRangeM: 5, exposureSamplesPerSite: 2,
    });
    expect(g.exposure.length).toBe(grid.cellsX * grid.cellsZ);
    // With no walls, every walkable cell should be fully exposed.
    let sumExposure = 0;
    let count = 0;
    for (let i = 0; i < g.exposure.length; i++) {
      if (g.exposure[i]! > 0) { sumExposure += g.exposure[i]!; count += 1; }
    }
    expect(count).toBeGreaterThan(0);
    expect(sumExposure / count).toBeGreaterThan(0.5);
  });

  // Side reference for unused import suppression in the wall-record type.
  void Vector3;
});
