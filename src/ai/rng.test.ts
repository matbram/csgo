/** Determinism + basic-shape tests for the seeded AI RNG. The replay
 *  story for the AI redesign hinges on every bot routing its random
 *  draws through this stream, so we lock the contract here:
 *    - same seed → identical sequence
 *    - different seeds → diverging sequences
 *    - forkRng(seed, key) is stable across calls and varies by key
 *    - gaussian/range/pick all draw from the same underlying stream
 */

import { describe, it, expect } from 'vitest';
import { makeRng, forkRng, setMatchSeed, getMatchSeed } from './rng';

describe('seeded RNG', () => {
  it('produces identical sequences for the same seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('diverges across different seeds', () => {
    const a = makeRng(12345);
    const b = makeRng(12346);
    let differed = false;
    for (let i = 0; i < 20; i++) {
      if (a.next() !== b.next()) { differed = true; break; }
    }
    expect(differed).toBe(true);
  });

  it('returns values in [0, 1)', () => {
    const r = makeRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('range returns integers in [lo, hi)', () => {
    const r = makeRng(7);
    for (let i = 0; i < 200; i++) {
      const v = r.range(3, 10);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(10);
    }
  });

  it('pick returns undefined for empty arrays and a member otherwise', () => {
    const r = makeRng(2);
    expect(r.pick([] as readonly number[])).toBeUndefined();
    const arr = [10, 20, 30] as const;
    for (let i = 0; i < 50; i++) {
      const v = r.pick(arr);
      expect(arr).toContain(v);
    }
  });

  it('chance respects probability extremes', () => {
    const r = makeRng(42);
    for (let i = 0; i < 50; i++) {
      expect(r.chance(0)).toBe(false);
      expect(r.chance(1)).toBe(true);
    }
  });

  it('gaussian returns finite numbers and rough zero mean', () => {
    const r = makeRng(101);
    let sum = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const g = r.gaussian();
      expect(Number.isFinite(g)).toBe(true);
      sum += g;
    }
    expect(Math.abs(sum / N)).toBeLessThan(0.05);
  });

  it('forkRng is stable for the same (seed, key) and diverges by key', () => {
    const a1 = forkRng(1, 'brain:t-bot-1');
    const a2 = forkRng(1, 'brain:t-bot-1');
    const b = forkRng(1, 'brain:t-bot-2');
    for (let i = 0; i < 20; i++) {
      expect(a1.next()).toBe(a2.next());
    }
    let differed = false;
    for (let i = 0; i < 20; i++) {
      if (forkRng(1, 'brain:t-bot-1').next() !== b.next()) { differed = true; break; }
    }
    expect(differed).toBe(true);
  });

  it('setMatchSeed / getMatchSeed round-trip', () => {
    setMatchSeed(7777);
    expect(getMatchSeed()).toBe(7777);
    setMatchSeed(0);             // 0 falls back to default; non-zero
    expect(getMatchSeed()).toBeGreaterThan(0);
  });
});
