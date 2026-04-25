/** Targeted tests for the strategist's plan picker. We don't bring up
 *  the world or any bots — just the pure decision functions. The
 *  blackboard/objective-apply integration is exercised by the build,
 *  type-checker, and the running game. */

import { describe, it, expect } from 'vitest';
import { PLANS } from './plans';
import { pickPreplanPlan, pickPostPlantPlan, teamEcoTier } from './strategist';
import type { MatchPlayerSlot } from '../match/match';

function slot(id: string, side: 'T' | 'CT', money: number): MatchPlayerSlot {
  return {
    id, startingSide: side, currentSide: side,
    money, kills: 0, deaths: 0, assists: 0,
    planted: false, defused: false, killWeapons: [],
  };
}

describe('teamEcoTier', () => {
  it('classifies a full-buy mean as normal', () => {
    const m = new Map([
      ['a', slot('a', 'T', 5000)],
      ['b', slot('b', 'T', 5000)],
    ]);
    expect(teamEcoTier('T', m)).toBe('normal');
  });

  it('classifies a save-tier mean as eco', () => {
    const m = new Map([
      ['a', slot('a', 'T', 800)],
      ['b', slot('b', 'T', 1200)],
    ]);
    expect(teamEcoTier('T', m)).toBe('eco');
  });

  it('classifies a force-buy mean as normal (force shares plans)', () => {
    const m = new Map([
      ['a', slot('a', 'T', 3000)],
      ['b', slot('b', 'T', 2800)],
    ]);
    expect(teamEcoTier('T', m)).toBe('normal');
  });

  it('only counts the requested side', () => {
    const m = new Map([
      ['a', slot('a', 'T', 200)],
      ['b', slot('b', 'CT', 5000)],
    ]);
    expect(teamEcoTier('T', m)).toBe('eco');
    expect(teamEcoTier('CT', m)).toBe('normal');
  });
});

describe('pickPreplanPlan', () => {
  it('eco tier always returns an eco plan', () => {
    const plan = pickPreplanPlan('T', 'eco', 1);
    expect(plan.ecoTier).toBe('eco');
    expect(plan.side).toBe('T');
    expect(plan.phase).toBe('pre_plant');
  });

  it('normal tier never returns an eco plan when normals exist', () => {
    for (let r = 1; r <= 30; r++) {
      const plan = pickPreplanPlan('CT', 'normal', r);
      expect(plan.ecoTier).toBe('normal');
      expect(plan.side).toBe('CT');
      expect(plan.phase).toBe('pre_plant');
    }
  });

  it('rotates plans across rounds (variety)', () => {
    const seen = new Set<string>();
    for (let r = 1; r <= 8; r++) {
      seen.add(pickPreplanPlan('T', 'normal', r).id);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('is deterministic for the same (side, eco, round)', () => {
    const a = pickPreplanPlan('CT', 'normal', 7);
    const b = pickPreplanPlan('CT', 'normal', 7);
    expect(a.id).toBe(b.id);
  });
});

describe('pickPostPlantPlan', () => {
  it('returns the matching post-plant plan for each side+site', () => {
    expect(pickPostPlantPlan('T', 'A')).toBe(PLANS.t_post_plant_a);
    expect(pickPostPlantPlan('T', 'B')).toBe(PLANS.t_post_plant_b);
    expect(pickPostPlantPlan('CT', 'A')).toBe(PLANS.ct_retake_a);
    expect(pickPostPlantPlan('CT', 'B')).toBe(PLANS.ct_retake_b);
  });

  it('every post-plant plan has phase post_plant + 5 slots', () => {
    for (const id of ['t_post_plant_a', 't_post_plant_b', 'ct_retake_a', 'ct_retake_b'] as const) {
      const p = PLANS[id];
      expect(p.phase).toBe('post_plant');
      expect(p.slots).toHaveLength(5);
    }
  });
});
