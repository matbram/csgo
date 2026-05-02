/** Phase 5 — squad coordinator tests. We test `tickSquadCoordinator`
 *  in isolation by injecting a fake context and synthetic blackboards
 *  with hand-crafted comms log entries. The combat:kill path is
 *  exercised via `reapplyCurrentStrategy` directly, since the bus
 *  install path is harness-shaped and not under test here. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  installSquadCoordinator, tickSquadCoordinator, _resetSquadCoordinator,
} from './coordinator';
import { makeBlackboard } from '../blackboard';
import { reapplyCurrentStrategy } from '../strategist';
import { tryEmit } from '../comms/callouts';
import { World } from '../../map/world';
import { NavGrid } from '../../nav/grid';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Bot } from '../../entities/bot';
import type { Character } from '../../entities/character';
import type { CalloutId } from '../../map/types';

function gridFromMask(mask: number[][], cellSize = 1): NavGrid {
  const cellsZ = mask.length;
  const cellsX = mask[0]!.length;
  const walkable = new Uint8Array(cellsX * cellsZ);
  const groundY = new Float32Array(cellsX * cellsZ);
  for (let j = 0; j < cellsZ; j++) {
    for (let i = 0; i < cellsX; i++) {
      walkable[j * cellsX + i] = mask[j]![i]!;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (NavGrid as any)(cellSize, 0, 0, cellsX, cellsZ, walkable, groundY);
}

function fakeBot(id: string, team: 'T' | 'CT', x: number, z: number, alive = true): Bot {
  const character = {
    id, team,
    isLocal: false,
    pos: new Vector3(x, 0, z),
    currentHeight: 1.7, currentEye: 1.6,
    yaw: 0, pitch: 0,
    hp: alive ? 100 : 0,
    armor: 0, helmet: false, hasKit: false,
    alive,
    inventory: null, speed: 0, inAir: false, crouching: false,
    limbs: undefined as never,
  } as unknown as Character;
  return {
    id, character,
    controller: undefined as never,
    parts: undefined as never,
    path: [], pathIdx: 0,
    objective: null,
    nextPlanAfterMs: 0,
    perception: { known: new Map() } as unknown as Bot['perception'],
    brain: { state: 'idle', pendingLineup: null } as unknown as Bot['brain'],
    aiDisabled: false,
    commsLatencyMs: 0,
    identity: {
      name: id, archetype: 'support',
      personality: { aggression: 0.5, patience: 0.5, teamwork: 0.5, utilityIQ: 0.5, riskAversion: 0.5, adaptability: 0.5 },
    },
    usePlanner: false,
  };
}

function makeFakeWorld(): World {
  const w = new World();
  // Two bombsites at (5, 1) and (5, 5) — close enough that a 10×10
  // grid contains both with walkable area between.
  w.bombSites.push({ site: 'A', polygon: [[3, 0], [7, 0], [7, 2], [3, 2]], yMin: 0, yMax: 4 });
  w.bombSites.push({ site: 'B', polygon: [[3, 4], [7, 4], [7, 6], [3, 6]], yMin: 0, yMax: 4 });
  // Two callouts that look like A_SITE and B_SITE so the coordinator's
  // startsWith('A_') / startsWith('B_') tokens fire correctly.
  w.callouts.set('A_SITE', { id: 'A_SITE', polygon: [[3, 0], [7, 0], [7, 2], [3, 2]], yMin: 0, yMax: 4, centroid: [5, 1], adjacent: [] });
  w.callouts.set('B_SITE', { id: 'B_SITE', polygon: [[3, 4], [7, 4], [7, 6], [3, 6]], yMin: 0, yMax: 4, centroid: [5, 5], adjacent: [] });
  return w;
}

beforeEach(() => {
  _resetSquadCoordinator();
});

describe('squad coordinator: siteClear rotation', () => {
  it('redirects an alive bot from the cleared site to the other site', () => {
    const world = makeFakeWorld();
    const grid = gridFromMask([
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    ]);
    const tBoard = makeBlackboard('T');
    const ctBoard = makeBlackboard('CT');

    const ctOnA = fakeBot('ct-1', 'CT', 5, 1);
    const ctOnB = fakeBot('ct-2', 'CT', 5, 5);
    ctBoard.objectiveByBot.set(ctOnA.id, { x: 5, z: 1, callout: 'A_SITE' as CalloutId, role: 'ct_anchor_a' });
    ctBoard.objectiveByBot.set(ctOnB.id, { x: 5, z: 5, callout: 'B_SITE' as CalloutId, role: 'ct_anchor_b' });
    const bots = [ctOnA, ctOnB];
    const botById = new Map(bots.map(b => [b.id, b]));

    let now = 1000;
    installSquadCoordinator({
      botById, bots: () => bots,
      tBoard, ctBoard, world, navGrid: grid,
      simMs: () => now,
    });

    // CT calls "B clear" — the A bot stays put; the B bot rotates to A.
    tryEmit({
      state: ctBoard.comms, bb: ctBoard,
      emitterId: ctOnB.id, side: 'CT',
      kind: 'siteClear', site: 'B',
      nowMs: now, pos: { x: 5, y: 0, z: 5 },
    });
    tickSquadCoordinator();

    const newObj = ctBoard.objectiveByBot.get(ctOnB.id)!;
    expect(newObj.callout).toBe('A_SITE');
    expect(Math.hypot(newObj.x - 5, newObj.z - 1)).toBeLessThan(1.2);
    // The A bot stays anchored.
    const aObj = ctBoard.objectiveByBot.get(ctOnA.id)!;
    expect(aObj.callout).toBe('A_SITE');
  });

  it('does nothing when no bot is on the cleared site', () => {
    const world = makeFakeWorld();
    const grid = gridFromMask([[1, 1, 1, 1, 1, 1, 1, 1, 1, 1]]);
    const tBoard = makeBlackboard('T');
    const ctBoard = makeBlackboard('CT');
    const ctElsewhere = fakeBot('ct-1', 'CT', 0, 0);
    ctBoard.objectiveByBot.set(ctElsewhere.id, { x: 0, z: 0, callout: 'CT_SPAWN' as CalloutId, role: 'ct_anchor_a' });
    const bots = [ctElsewhere];
    const botById = new Map(bots.map(b => [b.id, b]));

    installSquadCoordinator({
      botById, bots: () => bots,
      tBoard, ctBoard, world, navGrid: grid,
      simMs: () => 1000,
    });

    tryEmit({
      state: ctBoard.comms, bb: ctBoard,
      emitterId: ctElsewhere.id, side: 'CT',
      kind: 'siteClear', site: 'B',
      nowMs: 1000, pos: { x: 0, y: 0, z: 0 },
    });
    tickSquadCoordinator();
    // Objective unchanged.
    expect(ctBoard.objectiveByBot.get(ctElsewhere.id)?.callout).toBe('CT_SPAWN');
  });
});

describe('reapplyCurrentStrategy: role re-fit on teammate death', () => {
  it('compacts surviving bots into the lower plan slots', () => {
    const world = makeFakeWorld();
    const grid = gridFromMask([
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    ]);
    // Use the real ct_default plan (5 slots). We need callouts the
    // strategist looks up — add the few it references.
    for (const id of ['A_SITE', 'A_CROSS', 'B_SITE', 'B_DOORS', 'CT_MID', 'A_LONG', 'B_TUNNELS_UPPER', 'MID']) {
      world.callouts.set(id as CalloutId, {
        id: id as CalloutId,
        polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
        yMin: 0, yMax: 4,
        centroid: [(id.charCodeAt(0) % 7) + 1, (id.charCodeAt(1) % 5) + 1],
        adjacent: [],
      });
    }
    const ctBoard = makeBlackboard('CT');
    ctBoard.strategy = 'ct_default';
    const aliveCt = [
      fakeBot('ct-bot-1', 'CT', 0, 0, true),
      fakeBot('ct-bot-2', 'CT', 0, 0, true),
      fakeBot('ct-bot-3', 'CT', 0, 0, true),
      fakeBot('ct-bot-4', 'CT', 0, 0, true),
    ];
    const dead = fakeBot('ct-bot-5', 'CT', 0, 0, false);
    const bots = [...aliveCt, dead];

    reapplyCurrentStrategy(ctBoard, bots, world, grid, 100);

    // Dead bot should NOT have an objective.
    expect(ctBoard.objectiveByBot.has(dead.id)).toBe(false);
    // All four alive bots should.
    for (const b of aliveCt) {
      expect(ctBoard.objectiveByBot.has(b.id)).toBe(true);
      expect(ctBoard.roleByBot.has(b.id)).toBe(true);
    }
    // 4 entries total in objectiveByBot (no leftover from the dead bot).
    expect(ctBoard.objectiveByBot.size).toBe(4);
  });
});
