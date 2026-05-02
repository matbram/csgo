/** Phase 3 — planner recipe tests. We pin the goal-selection logic
 *  + recipe expansions for each goal kind on synthetic state, so
 *  changing cost weights or adding alternative recipes later doesn't
 *  silently regress the basic intent shape. */

import { describe, it, expect } from 'vitest';
import { planFor } from './planner';
import type { PlanInputs } from './types';
import type { PersonalityProfile } from '../personality';

const NEUTRAL: PersonalityProfile = {
  aggression: 0.5, patience: 0.5, teamwork: 0.5,
  utilityIQ: 0.5, riskAversion: 0.5, adaptability: 0.5,
};

function baseInput(over: Partial<PlanInputs> = {}): PlanInputs {
  return {
    selfId: 'me', side: 'T',
    pos: { x: 0, y: 0, z: 0 },
    hp: 100, hasC4: false, ammoFraction: 0.8,
    bomb: { phase: 'carried', site: null, pos: null },
    visibleEnemyId: null, visibleEnemyPos: null,
    recentEnemyId: null, recentEnemyPos: null,
    objective: null,
    teammatesAlive: 5, enemiesAlive: 5,
    ...over,
  };
}

describe('GOAP planner (recipe v1)', () => {
  it('returns null when nothing applies', () => {
    expect(planFor(baseInput(), NEUTRAL)).toBeNull();
  });

  it('eliminate visible enemy → single engage action', () => {
    const r = planFor(baseInput({
      visibleEnemyId: 'e1',
      visibleEnemyPos: { x: 5, y: 0, z: 5 },
    }), NEUTRAL);
    expect(r).not.toBeNull();
    expect(r!.goal.kind).toBe('eliminate');
    expect(r!.plan).toHaveLength(1);
    expect(r!.plan[0]!.kind).toBe('engage');
    expect(r!.plan[0]!.targetId).toBe('e1');
  });

  it('eliminate recent enemy → chase then engage', () => {
    const r = planFor(baseInput({
      recentEnemyId: 'e1',
      recentEnemyPos: { x: 10, y: 0, z: 10 },
    }), NEUTRAL);
    expect(r).not.toBeNull();
    expect(r!.plan.map(a => a.kind)).toEqual(['moveToCallout', 'engage']);
  });

  it('plant goal beats reachCallout when carrier on objective', () => {
    const r = planFor(baseInput({
      hasC4: true,
      bomb: { phase: 'carried', site: null, pos: null },
      objective: { callout: 'A_SITE', x: 0, z: 0 },
    }), NEUTRAL);
    expect(r).not.toBeNull();
    expect(r!.goal.kind).toBe('plant');
    // On the objective (planning xz match starting pos): just plant.
    expect(r!.plan.map(a => a.kind)).toContain('plant');
  });

  it('defuse: when far from bomb, recipe queues a move first', () => {
    const r = planFor(baseInput({
      side: 'CT',
      bomb: { phase: 'planted', site: 'A', pos: { x: 10, y: 0, z: 10 } },
    }), NEUTRAL);
    expect(r).not.toBeNull();
    expect(r!.goal.kind).toBe('defuse');
    expect(r!.plan.map(a => a.kind)).toEqual(['moveToCallout', 'defuse']);
  });

  it('defuse: when within 1.4m of bomb, recipe is just defuse', () => {
    const r = planFor(baseInput({
      side: 'CT',
      pos: { x: 0.5, y: 0, z: 0.5 },
      bomb: { phase: 'planted', site: 'A', pos: { x: 0.6, y: 0, z: 0.6 } },
    }), NEUTRAL);
    expect(r!.plan.map(a => a.kind)).toEqual(['defuse']);
  });

  it('reachCallout recipe queues move → hold; pre-stages reload when low ammo', () => {
    const r = planFor(baseInput({
      ammoFraction: 0.20,
      objective: { callout: 'A_LONG', x: 5, z: -10, facingYaw: 0.5 },
    }), NEUTRAL);
    expect(r!.plan.map(a => a.kind)).toEqual(['reload', 'moveToCallout', 'holdAngle']);
  });

  it('reachCallout omits reload when ammo is fine', () => {
    const r = planFor(baseInput({
      ammoFraction: 0.85,
      objective: { callout: 'A_LONG', x: 5, z: -10 },
    }), NEUTRAL);
    expect(r!.plan.map(a => a.kind)).toEqual(['moveToCallout', 'holdAngle']);
  });

  it('aggressive personality lifts eliminate above reachCallout', () => {
    const aggro: PersonalityProfile = { ...NEUTRAL, aggression: 1, patience: 0 };
    const r = planFor(baseInput({
      visibleEnemyId: 'e1',
      visibleEnemyPos: { x: 5, y: 0, z: 5 },
      objective: { callout: 'A_SITE', x: 100, z: 100 },
    }), aggro);
    expect(r!.goal.kind).toBe('eliminate');
  });

  it('survive triggers when low HP + outnumbered, retreats to objective', () => {
    const cautious: PersonalityProfile = { ...NEUTRAL, riskAversion: 0.9 };
    const r = planFor(baseInput({
      hp: 25,
      teammatesAlive: 1,
      enemiesAlive: 3,
      objective: { callout: 'T_SPAWN', x: 0, z: -38 },
      // No enemy visible, so eliminate doesn't outweigh survive.
    }), cautious);
    expect(r).not.toBeNull();
    expect(r!.goal.kind).toBe('survive');
    expect(r!.plan[0]!.kind).toBe('moveToCallout');
  });

  it('survive does not trigger at full HP', () => {
    const r = planFor(baseInput({
      hp: 100,
      enemiesAlive: 5, teammatesAlive: 1,
      objective: { callout: 'T_SPAWN', x: 0, z: 0 },
    }), NEUTRAL);
    // Goal is reachCallout (objective), not survive.
    expect(r!.goal.kind).toBe('reachCallout');
  });
});
