/** Phase 4 — personality persistence + generation tests. The persisted
 *  roster is the user-visible piece (named bots that survive a reload),
 *  so we pin its contract here and keep the seed-determinism guarantee
 *  end-to-end with the seeded RNG. */

import { describe, it, expect, beforeEach } from 'vitest';
import { getOrCreateIdentity, _resetRoster, type Archetype } from './personality';
import { setMatchSeed } from './rng';

beforeEach(() => {
  _resetRoster();
  setMatchSeed(424242);
});

describe('personality / persistent identity', () => {
  it('returns the same identity for the same bot id', () => {
    const a = getOrCreateIdentity('t-bot-1');
    const b = getOrCreateIdentity('t-bot-1');
    expect(b).toEqual(a);
  });

  it('produces different names for different bot ids', () => {
    const ids = ['t-bot-1', 't-bot-2', 't-bot-3', 'ct-bot-1', 'ct-bot-2'];
    const names = new Set(ids.map(id => getOrCreateIdentity(id).name));
    expect(names.size).toBe(ids.length);
  });

  it('archetype is one of the five canonical templates', () => {
    const valid: Archetype[] = ['entry_fragger', 'lurker', 'awper', 'support', 'igl'];
    for (let i = 0; i < 20; i++) {
      const id = `t-bot-${i}`;
      const idy = getOrCreateIdentity(id);
      expect(valid).toContain(idy.archetype);
    }
  });

  it('personality scalars are in [0, 1]', () => {
    for (let i = 0; i < 20; i++) {
      const p = getOrCreateIdentity(`t-bot-${i}`).personality;
      for (const v of Object.values(p)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('seed-stable: same matchSeed produces the same first-roll identity', () => {
    setMatchSeed(7);
    _resetRoster();
    const first = getOrCreateIdentity('t-bot-x');
    setMatchSeed(7);
    _resetRoster();
    const second = getOrCreateIdentity('t-bot-x');
    expect(second).toEqual(first);
  });

  it('seed-divergent: different matchSeed produces different identities', () => {
    setMatchSeed(11);
    _resetRoster();
    const a = getOrCreateIdentity('t-bot-x');
    setMatchSeed(13);
    _resetRoster();
    const b = getOrCreateIdentity('t-bot-x');
    // Either name or archetype must differ — both being equal would be
    // a crypto-unlikely collision; if it happens, re-seed the test.
    const equal = a.name === b.name && a.archetype === b.archetype;
    expect(equal).toBe(false);
  });

  it('archetype baselines bias scalars toward expected values', () => {
    // Generate a population and check that for each archetype, the
    // population's mean for the *defining* scalar is on the expected
    // side of 0.5. We bypass localStorage by resetting between rolls.
    const sums: Record<Archetype, { agg: number; pat: number; team: number; n: number }> = {
      entry_fragger: { agg: 0, pat: 0, team: 0, n: 0 },
      lurker:        { agg: 0, pat: 0, team: 0, n: 0 },
      awper:         { agg: 0, pat: 0, team: 0, n: 0 },
      support:       { agg: 0, pat: 0, team: 0, n: 0 },
      igl:           { agg: 0, pat: 0, team: 0, n: 0 },
    };
    for (let i = 0; i < 200; i++) {
      setMatchSeed(i + 1);
      _resetRoster();
      const idy = getOrCreateIdentity(`bot-${i}`);
      const s = sums[idy.archetype];
      s.agg  += idy.personality.aggression;
      s.pat  += idy.personality.patience;
      s.team += idy.personality.teamwork;
      s.n    += 1;
    }
    // entry_fragger should average high aggression (>0.5) and low patience.
    if (sums.entry_fragger.n > 0) {
      expect(sums.entry_fragger.agg / sums.entry_fragger.n).toBeGreaterThan(0.5);
      expect(sums.entry_fragger.pat / sums.entry_fragger.n).toBeLessThan(0.5);
    }
    // lurker should average high patience.
    if (sums.lurker.n > 0) {
      expect(sums.lurker.pat / sums.lurker.n).toBeGreaterThan(0.5);
    }
    // support should average high teamwork.
    if (sums.support.n > 0) {
      expect(sums.support.team / sums.support.n).toBeGreaterThan(0.5);
    }
  });
});
