/** Phase 2 — comms layer unit tests. We pin the cooldown contract,
 *  the rate cap, the once-per-round dedupe for `bombPlantedCall`, the
 *  per-receiver delivery latency model, and the formatter. */

import { describe, it, expect } from 'vitest';
import {
  makeCommsState, tryEmit, isDelivered, deliveredTo, formatCallout,
  resetComms, CALLOUT_LOG_SIZE,
} from './callouts';
import { makeBlackboard } from '../blackboard';

function pos(x = 0, y = 0, z = 0) { return { x, y, z }; }

describe('comms layer (phase 2)', () => {
  it('emits a callout and stores it newest-first on the log', () => {
    const bb = makeBlackboard('T');
    const c1 = tryEmit({
      state: bb.comms, bb, emitterId: 't1', side: 'T',
      kind: 'spottedEnemy', nowMs: 1000, pos: pos(), where: 'A_LONG', count: 2,
    });
    const c2 = tryEmit({
      state: bb.comms, bb, emitterId: 't2', side: 'T',
      kind: 'enemyDown', nowMs: 1100, pos: pos(), where: 'A_SITE',
    });
    expect(c1).not.toBeNull();
    expect(c2).not.toBeNull();
    expect(bb.comms.log[0]?.kind).toBe('enemyDown');
    expect(bb.comms.log[1]?.kind).toBe('spottedEnemy');
  });

  it('respects per-bot per-kind cooldown', () => {
    const bb = makeBlackboard('T');
    const a = tryEmit({
      state: bb.comms, bb, emitterId: 't1', side: 'T',
      kind: 'spottedEnemy', nowMs: 1000, pos: pos(),
    });
    // Within the cooldown window — same bot, same kind → dropped.
    const b = tryEmit({
      state: bb.comms, bb, emitterId: 't1', side: 'T',
      kind: 'spottedEnemy', nowMs: 1500, pos: pos(),
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    // Past the cooldown — accepted again.
    const c = tryEmit({
      state: bb.comms, bb, emitterId: 't1', side: 'T',
      kind: 'spottedEnemy', nowMs: 1000 + 2_000 + 1, pos: pos(),
    });
    expect(c).not.toBeNull();
  });

  it('lets different bots emit the same kind concurrently', () => {
    const bb = makeBlackboard('T');
    const a = tryEmit({
      state: bb.comms, bb, emitterId: 't1', side: 'T',
      kind: 'spottedEnemy', nowMs: 1000, pos: pos(),
    });
    const b = tryEmit({
      state: bb.comms, bb, emitterId: 't2', side: 'T',
      kind: 'spottedEnemy', nowMs: 1100, pos: pos(),
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('enforces team rate cap within the rolling window', () => {
    const bb = makeBlackboard('T');
    // 5 distinct bots emit 5 distinct kinds in a single second — all OK.
    const kinds = ['spottedEnemy', 'enemyDown', 'lowHp', 'pushing', 'siteClear'] as const;
    for (let i = 0; i < kinds.length; i++) {
      const c = tryEmit({
        state: bb.comms, bb, emitterId: `t${i}`, side: 'T',
        kind: kinds[i]!, nowMs: 1000 + i * 50, pos: pos(),
      });
      expect(c).not.toBeNull();
    }
    // 6th in the same window — rate cap kicks in.
    const dropped = tryEmit({
      state: bb.comms, bb, emitterId: 't9', side: 'T',
      kind: 'rotateRequest', nowMs: 1000 + 250, pos: pos(),
    });
    expect(dropped).toBeNull();
    // Past the window — accepted again.
    const ok = tryEmit({
      state: bb.comms, bb, emitterId: 't9', side: 'T',
      kind: 'rotateRequest', nowMs: 1000 + 1100, pos: pos(),
    });
    expect(ok).not.toBeNull();
  });

  it('bombPlantedCall is once per round per team', () => {
    const bb = makeBlackboard('T');
    const a = tryEmit({
      state: bb.comms, bb, emitterId: 't1', side: 'T',
      kind: 'bombPlantedCall', nowMs: 1000, pos: pos(), site: 'A',
    });
    const b = tryEmit({
      state: bb.comms, bb, emitterId: 't2', side: 'T',
      kind: 'bombPlantedCall', nowMs: 5000, pos: pos(), site: 'A',
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    // After resetComms (round transition) it should fire again.
    resetComms(bb.comms);
    const c = tryEmit({
      state: bb.comms, bb, emitterId: 't1', side: 'T',
      kind: 'bombPlantedCall', nowMs: 9999, pos: pos(), site: 'A',
    });
    expect(c).not.toBeNull();
  });

  it('caps log size at CALLOUT_LOG_SIZE and evicts the oldest', () => {
    const bb = makeBlackboard('T');
    // Different (bot, kind) per emit so cooldown never fires; bumps
    // through the rate cap by spacing across windows.
    for (let i = 0; i < CALLOUT_LOG_SIZE + 5; i++) {
      tryEmit({
        state: bb.comms, bb, emitterId: `t${i}`, side: 'T',
        kind: 'spottedEnemy', nowMs: 1000 + i * 1500, pos: pos(),
      });
    }
    expect(bb.comms.log.length).toBe(CALLOUT_LOG_SIZE);
    // Newest still on top.
    expect(bb.comms.log[0]?.emitterId).toBe(`t${CALLOUT_LOG_SIZE + 4}`);
  });

  it('isDelivered respects emitter (instant) and per-receiver latency', () => {
    const bb = makeBlackboard('T');
    const c = tryEmit({
      state: bb.comms, bb, emitterId: 't1', side: 'T',
      kind: 'spottedEnemy', nowMs: 1000, pos: pos(),
    })!;
    // Emitter hears themself instantly.
    expect(isDelivered(c, 't1', 800, 1000)).toBe(true);
    // Teammate at 800 ms latency: nothing yet at 1500, in by 1800.
    expect(isDelivered(c, 't2', 800, 1500)).toBe(false);
    expect(isDelivered(c, 't2', 800, 1800)).toBe(true);
  });

  it('deliveredTo filters and orders newest-first', () => {
    const bb = makeBlackboard('T');
    tryEmit({ state: bb.comms, bb, emitterId: 't1', side: 'T',
      kind: 'spottedEnemy', nowMs: 1000, pos: pos() });
    tryEmit({ state: bb.comms, bb, emitterId: 't2', side: 'T',
      kind: 'enemyDown', nowMs: 2000, pos: pos() });
    // t3 with 200 ms latency at sim 2300: t2 (delivered 2200) yes,
    // t1 (delivered 1200) yes.
    const got = deliveredTo(bb.comms, 't3', 200, 2300);
    expect(got.map(c => c.kind)).toEqual(['enemyDown', 'spottedEnemy']);
    // t3 with 200 ms latency at sim 1100: neither delivered yet.
    const none = deliveredTo(bb.comms, 't3', 200, 1100);
    expect(none).toEqual([]);
  });

  it('formatCallout produces sensible English for each kind', () => {
    const base = {
      id: 1, emitterId: 't1', side: 'T' as const, tEmitMs: 0,
      pos: pos(),
    };
    expect(formatCallout({ ...base, kind: 'spottedEnemy', where: 'A_LONG', count: 2 }))
      .toBe('two a long');
    expect(formatCallout({ ...base, kind: 'enemyDown', where: 'B_SITE' }))
      .toBe('one down b site');
    expect(formatCallout({ ...base, kind: 'lowHp' }))
      .toBe(`I'm low`);
    expect(formatCallout({ ...base, kind: 'reloading' }))
      .toBe('reloading');
    expect(formatCallout({ ...base, kind: 'bombPlantedCall', site: 'A' }))
      .toBe('bomb planted A');
    expect(formatCallout({ ...base, kind: 'flashed' }))
      .toBe(`I'm flashed`);
  });
});
