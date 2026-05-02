/** Phase 0 — verify the WorldStateView projects the same data the legacy
 *  BrainContext / blackboard expose. We're not asserting AI behaviour
 *  here (that doesn't change in phase 0), only the projection. */

import { describe, it, expect } from 'vitest';
import { buildWorldStateView } from './state';
import { makeBlackboard } from '../blackboard';
import type { Bot } from '../../entities/bot';
import type { Character } from '../../entities/character';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';

function fakeBot(id: string, team: 'T' | 'CT', alive = true): Bot {
  const character = {
    id, team,
    isLocal: false,
    pos: new Vector3(1, 0, 2),
    currentHeight: 1.7,
    currentEye: 1.6,
    yaw: 0.5, pitch: -0.1,
    hp: alive ? 100 : 0,
    armor: 50, helmet: true, hasKit: false,
    alive,
    inventory: null,
    speed: 0, inAir: false, crouching: false,
    limbs: undefined as never,
  } as unknown as Character;
  // Minimal Brain + Perception stubs — only properties read by the
  // builder need to be present. We don't import the real classes
  // because they pull Babylon controller deps that aren't relevant
  // to the projection test.
  const perception = { known: new Map() } as unknown as Bot['perception'];
  const brain = { state: 'idle' } as unknown as Bot['brain'];
  return {
    id, character,
    controller: undefined as never,
    parts: undefined as never,
    path: null,
    pathIdx: 0,
    objective: null,
    nextPlanAfterMs: 0,
    perception,
    brain,
    aiDisabled: false,
    commsLatencyMs: 0,
    identity: {
      name: id,
      archetype: 'support',
      personality: {
        aggression: 0.5, patience: 0.5, teamwork: 0.5,
        utilityIQ: 0.5, riskAversion: 0.5, adaptability: 0.5,
      },
    },
  };
}

describe('buildWorldStateView (phase 0 projection)', () => {
  it('partitions bots by team and alive state', () => {
    const bots = [
      fakeBot('t1', 'T', true),
      fakeBot('t2', 'T', false),
      fakeBot('ct1', 'CT', true),
    ];
    const tBoard = makeBlackboard('T');
    const ctBoard = makeBlackboard('CT');
    const v = buildWorldStateView({
      simMs: 1000,
      liveSinceMs: 0,
      phase: 'live',
      bomb: { phase: 'carried', carrierId: null, site: null, pos: null },
      bots,
      tBoard, ctBoard,
      localAlive: { T: 1, CT: 0 },
    });
    expect(v.teams.T.aliveIds).toEqual(['t1']);
    expect(v.teams.T.deadIds).toEqual(['t2']);
    expect(v.teams.CT.aliveIds).toEqual(['ct1']);
    // T side counts: 1 alive bot + 1 local = 2; CT enemiesAlive sees that.
    expect(v.teams.T.aliveCount).toBe(2);
    expect(v.teams.CT.aliveCount).toBe(1);
    expect(v.teams.T.enemiesAlive).toBe(1);
    expect(v.teams.CT.enemiesAlive).toBe(2);
  });

  it('mirrors strategy and known-enemy counts from blackboards', () => {
    const tBoard = makeBlackboard('T');
    const ctBoard = makeBlackboard('CT');
    tBoard.strategy = 't_rush_a';
    ctBoard.knownEnemies.set('foo', {
      id: 'foo', x: 0, y: 0, z: 0, lastSeenMs: 100, confidence: 'recent',
    });
    const v = buildWorldStateView({
      simMs: 0, liveSinceMs: 0, phase: 'freeze',
      bomb: { phase: 'carried', carrierId: null, site: null, pos: null },
      bots: [], tBoard, ctBoard, localAlive: { T: 0, CT: 0 },
    });
    expect(v.teams.T.strategy).toBe('t_rush_a');
    expect(v.teams.CT.knownEnemyCount).toBe(1);
  });

  it('populates per-bot defaults for GOAP-future fields', () => {
    const bots = [fakeBot('t1', 'T', true)];
    const tBoard = makeBlackboard('T');
    const ctBoard = makeBlackboard('CT');
    const v = buildWorldStateView({
      simMs: 0, liveSinceMs: 0, phase: 'live',
      bomb: { phase: 'carried', carrierId: null, site: null, pos: null },
      bots, tBoard, ctBoard, localAlive: { T: 0, CT: 0 },
    });
    const view = v.bots.get('t1')!;
    expect(view.goalStack).toEqual([]);
    expect(view.currentAction).toBeNull();
    expect(view.plannedActions).toEqual([]);
    expect(view.threatLevel).toBe(0);
    expect(view.brainState).toBe('idle');
  });
});
