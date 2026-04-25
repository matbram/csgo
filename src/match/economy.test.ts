import { describe, it, expect } from 'vitest';
import {
  applyRoundEnd, computeKillReward, lossBonusFor, resetMoneyForHalftime,
  STARTING_MONEY, MAX_MONEY,
  type PerPlayerMoney, type LossStreaks, type RoundOutcome,
} from './economy';

function mkPlayer(id: string, side: 'T' | 'CT', money: number, opts?: Partial<PerPlayerMoney>): PerPlayerMoney {
  return {
    id, side, money,
    aliveAtEnd: true,
    planted: false,
    defused: false,
    killWeapons: [],
    ...opts,
  };
}

describe('lossBonusFor', () => {
  it('returns 0 for streak 0', () => {
    expect(lossBonusFor(0)).toBe(0);
  });
  it('matches the table', () => {
    expect(lossBonusFor(1)).toBe(1400);
    expect(lossBonusFor(2)).toBe(1900);
    expect(lossBonusFor(3)).toBe(2400);
    expect(lossBonusFor(4)).toBe(2900);
    expect(lossBonusFor(5)).toBe(3400);
  });
  it('caps at the highest tier', () => {
    expect(lossBonusFor(7)).toBe(3400);
    expect(lossBonusFor(99)).toBe(3400);
  });
});

describe('computeKillReward', () => {
  it('rifles give 300', () => {
    expect(computeKillReward('ak47')).toBe(300);
    expect(computeKillReward('m4a4')).toBe(300);
  });
  it('AWP gives 100', () => {
    expect(computeKillReward('awp')).toBe(100);
  });
  it('knife gives 1500', () => {
    expect(computeKillReward('knife')).toBe(1500);
  });
});

describe('applyRoundEnd — base rewards', () => {
  const streaks: LossStreaks = { T: 0, CT: 0 };

  it('T wins via elimination → 3250 each', () => {
    const players = [
      mkPlayer('t1', 'T', 1000),
      mkPlayer('ct1', 'CT', 1000),
    ];
    const r = applyRoundEnd(players, streaks, {
      winner: 'T', reason: 't_eliminate', bombPlanted: false,
    });
    expect(r.rewards.get('t1')!.base).toBe(3250);
    expect(r.rewards.get('ct1')!.base).toBe(0);
    expect(r.players.find(p => p.id === 't1')!.money).toBe(1000 + 3250);
  });

  it('T wins via bomb explosion → 3500 each', () => {
    const players = [mkPlayer('t1', 'T', 0)];
    const r = applyRoundEnd(players, streaks, {
      winner: 'T', reason: 't_explode', bombPlanted: true,
    });
    expect(r.rewards.get('t1')!.base).toBe(3500);
  });

  it('CT wins via defuse → 3500 each + 300 to defuser', () => {
    const players = [
      mkPlayer('ct1', 'CT', 0, { defused: true }),
      mkPlayer('ct2', 'CT', 0),
    ];
    const r = applyRoundEnd(players, streaks, {
      winner: 'CT', reason: 'ct_defuse', bombPlanted: true,
    });
    expect(r.rewards.get('ct1')!.base).toBe(3500);
    expect(r.rewards.get('ct1')!.defuseBonus).toBe(300);
    expect(r.rewards.get('ct2')!.defuseBonus).toBe(0);
  });

  it('plant bonus +300 to planter regardless of outcome', () => {
    const players = [mkPlayer('t1', 'T', 0, { planted: true })];
    const r = applyRoundEnd(players, streaks, {
      winner: 'CT', reason: 'ct_eliminate', bombPlanted: true,
    });
    expect(r.rewards.get('t1')!.plantBonus).toBe(300);
  });
});

describe('applyRoundEnd — loss streak escalation', () => {
  it('streak escalates 1400 → 1900 → ... → 3400', () => {
    const players = [mkPlayer('ct1', 'CT', 0)];
    let streaks: LossStreaks = { T: 0, CT: 0 };
    const expected = [1400, 1900, 2400, 2900, 3400, 3400];
    for (const exp of expected) {
      const r = applyRoundEnd(players, streaks, {
        winner: 'T', reason: 't_eliminate', bombPlanted: false,
      });
      expect(r.rewards.get('ct1')!.lossBonus).toBe(exp);
      streaks = r.newStreaks;
    }
  });

  it('streak resets after a win', () => {
    let streaks: LossStreaks = { T: 0, CT: 3 };
    const r = applyRoundEnd([mkPlayer('ct1', 'CT', 0)], streaks, {
      winner: 'CT', reason: 'ct_eliminate', bombPlanted: false,
    });
    expect(r.newStreaks.CT).toBe(0);
  });
});

describe('applyRoundEnd — bomb-planted T loss bonus', () => {
  it('T side bomb-planted loss adds +800', () => {
    const players = [mkPlayer('t1', 'T', 0)];
    const r = applyRoundEnd(players, { T: 0, CT: 0 }, {
      winner: 'CT', reason: 'ct_defuse', bombPlanted: true,
    });
    expect(r.rewards.get('t1')!.bombLossBonus).toBe(800);
    // Total = 1400 (loss bonus) + 800 (planted) = 2200
    expect(r.rewards.get('t1')!.total).toBe(1400 + 800);
  });

  it('T side bomb-NOT-planted loss does not get the +800', () => {
    const players = [mkPlayer('t1', 'T', 0)];
    const r = applyRoundEnd(players, { T: 0, CT: 0 }, {
      winner: 'CT', reason: 'ct_eliminate', bombPlanted: false,
    });
    expect(r.rewards.get('t1')!.bombLossBonus).toBe(0);
  });
});

describe('applyRoundEnd — kill rewards stack', () => {
  it('multi-kill stacks per-weapon rewards', () => {
    const players = [mkPlayer('t1', 'T', 0, { killWeapons: ['ak47', 'ak47', 'awp'] })];
    const r = applyRoundEnd(players, { T: 0, CT: 0 }, {
      winner: 'T', reason: 't_eliminate', bombPlanted: false,
    });
    expect(r.rewards.get('t1')!.killReward).toBe(300 + 300 + 100);
  });
});

describe('applyRoundEnd — money cap', () => {
  it('money is clamped to 16000', () => {
    const players = [mkPlayer('t1', 'T', MAX_MONEY - 100, {
      killWeapons: ['ak47', 'ak47'],  // +600
    })];
    const r = applyRoundEnd(players, { T: 0, CT: 0 }, {
      winner: 'T', reason: 't_eliminate', bombPlanted: false,
    });
    expect(r.players.find(p => p.id === 't1')!.money).toBe(MAX_MONEY);
  });
});

describe('resetMoneyForHalftime', () => {
  it('resets every player to starting money', () => {
    const players = [
      mkPlayer('t1', 'T', 12_000, { killWeapons: ['ak47'] }),
      mkPlayer('ct1', 'CT', 5000),
    ];
    const r = resetMoneyForHalftime(players);
    for (const p of r) {
      expect(p.money).toBe(STARTING_MONEY);
      expect(p.killWeapons).toEqual([]);
    }
  });
});
