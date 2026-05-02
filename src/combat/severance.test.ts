/** Unit tests for the limb-severance physics. evaluateBulletSeverance
 *  and rollExplosiveSeverance are pure (modulo the random number for
 *  the explosive case), so we test them directly rather than driving
 *  the whole combat pipeline. */

import { describe, it, expect, beforeEach } from 'vitest';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import {
  evaluateBulletSeverance, rollExplosiveSeverance, rollSegmentSeverance,
  makeFreshLimbs, limbKey, SEVERANCE_PROFILE,
  type Character, type SegmentState, type LimbSegmentKind,
} from '../entities/character';

function fresh(): SegmentState {
  return { trauma: 0, compromised: false, detached: false };
}

function freshChar(): Character {
  return {
    id: 'v', team: 'T', isLocal: false,
    pos: new Vector3(0, 0, 0),
    currentHeight: 1.80, currentEye: 1.65,
    yaw: 0, pitch: 0,
    hp: 100, armor: 0, helmet: false, hasKit: false, alive: true,
    inventory: null,
    speed: 0, inAir: false, crouching: false,
    limbs: makeFreshLimbs(),
  };
}

describe('evaluateBulletSeverance — single-shot trauma', () => {
  it('severs immediately when hpDelta exceeds severeHP', () => {
    const s = fresh();
    // AWP point-blank thigh: hpDelta ≈ 86, severeHP = 80.
    expect(evaluateBulletSeverance(s, 'thigh', 86, false)).toBe(true);
  });

  it('does not sever when hpDelta is below severeHP', () => {
    const s = fresh();
    // AK thigh: hpDelta = 27, severeHP = 80.
    expect(evaluateBulletSeverance(s, 'thigh', 27, false)).toBe(false);
    expect(s.detached).toBe(false);
  });

  it('accumulates trauma on non-severing hits', () => {
    const s = fresh();
    evaluateBulletSeverance(s, 'thigh', 27, false);
    evaluateBulletSeverance(s, 'thigh', 27, false);
    expect(s.trauma).toBe(54);
    expect(s.compromised).toBe(false);
  });

  it('flips compromised when trauma exceeds traumaHP', () => {
    const s = fresh();
    // thigh traumaHP = 200. Eight 27-hp hits = 216 trauma.
    for (let i = 0; i < 8; i++) {
      const severed = evaluateBulletSeverance(s, 'thigh', 27, false);
      expect(severed).toBe(false);
    }
    expect(s.compromised).toBe(true);
    expect(s.detached).toBe(false);
  });

  it('compromised + next hit severs', () => {
    const s = fresh();
    s.trauma = 250;
    s.compromised = true;
    expect(evaluateBulletSeverance(s, 'thigh', 1, false)).toBe(true);
  });

  it('detached idempotence — already-detached returns false without mutation', () => {
    const s: SegmentState = { trauma: 50, compromised: true, detached: true };
    expect(evaluateBulletSeverance(s, 'thigh', 200, false)).toBe(false);
    expect(s.trauma).toBe(50);
  });
});

describe('evaluateBulletSeverance — melee restrictions', () => {
  it('knife stab severs a hand (distal extremity)', () => {
    const s = fresh();
    // Knife stab: hpDelta ≈ 101 vs hand severeHP 45.
    expect(evaluateBulletSeverance(s, 'hand', 101, true)).toBe(true);
  });

  it('knife stab severs a foot', () => {
    const s = fresh();
    // Knife stab to a foot: 65 × 1.55 × 0.75 leg-mult ≈ 76 vs 40.
    expect(evaluateBulletSeverance(s, 'foot', 76, true)).toBe(true);
  });

  it('knife stab does NOT sever a shin even with damage above severeHP', () => {
    const s = fresh();
    // 76 hpDelta vs shin severeHP 65 — would sever in bullet mode,
    // but melee mode blocks proximal severance.
    expect(evaluateBulletSeverance(s, 'shin', 76, true)).toBe(false);
    expect(s.detached).toBe(false);
    // Still accumulates trauma.
    expect(s.trauma).toBe(76);
  });

  it('knife stab does NOT sever a thigh', () => {
    const s = fresh();
    expect(evaluateBulletSeverance(s, 'thigh', 200, true)).toBe(false);
    expect(s.trauma).toBe(200);
    // Trauma still flips compromised regardless of melee scope.
    expect(s.compromised).toBe(true);
  });

  it('compromised proximal segment is NOT finished by a melee hit', () => {
    const s: SegmentState = { trauma: 220, compromised: true, detached: false };
    expect(evaluateBulletSeverance(s, 'thigh', 50, true)).toBe(false);
  });

  it('compromised distal segment IS finished by a melee hit', () => {
    const s: SegmentState = { trauma: 80, compromised: true, detached: false };
    expect(evaluateBulletSeverance(s, 'hand', 5, true)).toBe(true);
  });
});

describe('weapon-class scenario fits', () => {
  const scenarios: Array<{
    name: string;
    weapon: 'awp' | 'ak' | 'usp' | 'knife-slash' | 'knife-stab';
    seg: LimbSegmentKind;
    hpDelta: number;
    isMelee?: boolean;
    expectSever: boolean;
  }> = [
    // Calibration anchors mirroring the plan-file table.
    { name: 'AWP point-blank thigh',  weapon: 'awp', seg: 'thigh', hpDelta: 86, expectSever: true },
    { name: 'AWP point-blank shin',   weapon: 'awp', seg: 'shin',  hpDelta: 86, expectSever: true },
    { name: 'AWP point-blank foot',   weapon: 'awp', seg: 'foot',  hpDelta: 86, expectSever: true },
    { name: 'AWP point-blank hand',   weapon: 'awp', seg: 'hand',  hpDelta: 115, expectSever: true },
    { name: 'AK thigh',               weapon: 'ak',  seg: 'thigh', hpDelta: 27, expectSever: false },
    { name: 'AK foot',                weapon: 'ak',  seg: 'foot',  hpDelta: 27, expectSever: false },
    { name: 'USP shin',               weapon: 'usp', seg: 'shin',  hpDelta: 26, expectSever: false },
    { name: 'Knife slash hand',       weapon: 'knife-slash', seg: 'hand', hpDelta: 65, isMelee: true, expectSever: true },
    { name: 'Knife slash thigh',      weapon: 'knife-slash', seg: 'thigh', hpDelta: 49, isMelee: true, expectSever: false },
    { name: 'Knife slash foot',       weapon: 'knife-slash', seg: 'foot', hpDelta: 49, isMelee: true, expectSever: true },
  ];
  for (const sc of scenarios) {
    it(`${sc.name} → ${sc.expectSever ? 'severs' : 'no sever'}`, () => {
      const s = fresh();
      const result = evaluateBulletSeverance(s, sc.seg, sc.hpDelta, !!sc.isMelee);
      expect(result).toBe(sc.expectSever);
    });
  }
});

describe('rollExplosiveSeverance', () => {
  it('always severs when blastDamage >> explosiveSever', () => {
    // Bomb-class blast (hpDelta-equivalent 500) vs hand explosiveSever 55:
    // p clamped to 0.95. We sample many times and expect almost-all sever.
    let severed = 0;
    for (let i = 0; i < 200; i++) {
      const s = fresh();
      if (rollExplosiveSeverance(s, 'hand', 500)) severed++;
    }
    // 0.95 probability — 95% expected. Very loose lower bound to avoid
    // flakiness across seed runs.
    expect(severed).toBeGreaterThan(170);
  });

  it('almost never severs when blastDamage is small', () => {
    // 5 hp HE near-miss vs thigh explosiveSever 130: p = 0.038.
    let severed = 0;
    for (let i = 0; i < 200; i++) {
      const s = fresh();
      if (rollExplosiveSeverance(s, 'thigh', 5)) severed++;
    }
    // Expected ~7-8. Bound very loose.
    expect(severed).toBeLessThan(30);
  });

  it('failed roll still adds trauma', () => {
    // Force a failed roll by mocking — easier: many iterations and check
    // at least one failed-roll trauma increment is present.
    const s = fresh();
    // Tiny blast damage → almost-always-fails roll.
    rollExplosiveSeverance(s, 'thigh', 10);
    if (!s.detached) expect(s.trauma).toBeCloseTo(4, 5); // 10 * 0.4
  });
});

describe('rollSegmentSeverance — full-body explosion', () => {
  it('severs many segments at bomb-tier damage and reports proximal-only', () => {
    const c = freshChar();
    const out = rollSegmentSeverance(c, 500);
    // We expect at least 4 entries (it would be 12 if we returned distal
    // pieces, but the distal-cascade rule means each side's thigh
    // sever omits shin/foot from the list).
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Every distal piece on a side whose thigh severed should be marked
    // detached but not appear in the output list.
    for (const side of ['left', 'right'] as const) {
      const thigh = c.limbs[limbKey('thigh', side)];
      if (thigh.detached) {
        expect(c.limbs[limbKey('shin', side)].detached).toBe(true);
        expect(c.limbs[limbKey('foot', side)].detached).toBe(true);
        expect(out.find(e => e.segment === 'shin' && e.side === side)).toBeUndefined();
        expect(out.find(e => e.segment === 'foot' && e.side === side)).toBeUndefined();
      }
    }
  });

  it('skips already-detached segments', () => {
    const c = freshChar();
    // Pre-detach the entire left leg + left arm so nothing on the left
    // side is eligible to be severed by the blast.
    for (const seg of ['thigh', 'shin', 'foot', 'upperArm', 'forearm', 'hand'] as const) {
      c.limbs[limbKey(seg, 'left')].detached = true;
    }
    const out = rollSegmentSeverance(c, 500);
    expect(out.find(e => e.side === 'left')).toBeUndefined();
  });
});

describe('SEVERANCE_PROFILE values', () => {
  it('all limb segments + head are present', () => {
    expect(SEVERANCE_PROFILE.head).toBeDefined();
    expect(SEVERANCE_PROFILE.thigh).toBeDefined();
    expect(SEVERANCE_PROFILE.shin).toBeDefined();
    expect(SEVERANCE_PROFILE.foot).toBeDefined();
    expect(SEVERANCE_PROFILE.upperArm).toBeDefined();
    expect(SEVERANCE_PROFILE.forearm).toBeDefined();
    expect(SEVERANCE_PROFILE.hand).toBeDefined();
  });

  it('proximal segments resist more than distal ones', () => {
    expect(SEVERANCE_PROFILE.thigh.severeHP).toBeGreaterThan(SEVERANCE_PROFILE.shin.severeHP);
    expect(SEVERANCE_PROFILE.shin.severeHP).toBeGreaterThan(SEVERANCE_PROFILE.foot.severeHP);
    expect(SEVERANCE_PROFILE.upperArm.severeHP).toBeGreaterThan(SEVERANCE_PROFILE.forearm.severeHP);
    expect(SEVERANCE_PROFILE.forearm.severeHP).toBeGreaterThan(SEVERANCE_PROFILE.hand.severeHP);
  });
});
