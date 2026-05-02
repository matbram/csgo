/** Targeted tests for the bot buy decision tree. We don't bring up the
 *  full match — just synthesize a MatchPlayerSlot and a Character with
 *  an inventory and assert the buy outcome. */

import { describe, it, expect, beforeEach } from 'vitest';
import { runBotBuy } from './buy';
import type { MatchPlayerSlot } from '../match/match';
import type { Character } from '../entities/character';
import { defaultInventory } from '../weapons/inventory';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';

function makeSlot(id: string, side: 'T' | 'CT', money: number): MatchPlayerSlot {
  return {
    id, startingSide: side, currentSide: side,
    money, kills: 0, deaths: 0, assists: 0,
    planted: false, defused: false, killWeapons: [],
  };
}

function makeChar(side: 'T' | 'CT'): Character {
  return {
    id: 'b', team: side, isLocal: false,
    pos: new Vector3(0, 0, 0),
    currentHeight: 1.80, currentEye: 1.65,
    yaw: 0, pitch: 0,
    hp: 100, armor: 0, helmet: false, hasKit: false, alive: true,
    inventory: defaultInventory(side),
    speed: 0, inAir: false, crouching: false,
    legDamage: 0, armDamage: 0, legDetached: false, armDetached: false,
  };
}

describe('runBotBuy', () => {
  let slot: MatchPlayerSlot;
  let c: Character;

  beforeEach(() => {
    slot = makeSlot('b', 'T', 0);
    c = makeChar('T');
  });

  it('full buy gives a primary + helmet + grenades', () => {
    slot.money = 5000;
    runBotBuy(slot, c);
    expect(c.inventory!.primary?.def.id).toBe('ak47');
    expect(c.helmet).toBe(true);
    // AK 2700 + helmet 1000 + flash 200 + smoke 300 + HE 300 + molly
    // 400 = 4900 spent → $100 remaining.
    expect(slot.money).toBe(100);
    expect(c.inventory!.grenades.length).toBeGreaterThanOrEqual(3);
  });

  it('CT full buy includes a defuse kit + grenades', () => {
    slot = makeSlot('b', 'CT', 5500);
    c = makeChar('CT');
    runBotBuy(slot, c);
    expect(c.inventory!.primary?.def.id).toBe('m4a4');
    expect(c.helmet).toBe(true);
    expect(c.hasKit).toBe(true);
    // Bots that buy a primary on a $5500 wallet end up with at least
    // a flashbang (200) — anything cheaper than the kit gets squeezed
    // in.
    expect(c.inventory!.grenades.length).toBeGreaterThan(0);
  });

  it('force buy at $3500 picks rifle and skips armor', () => {
    slot.money = 3500;
    runBotBuy(slot, c);
    expect(c.inventory!.primary?.def.id).toBe('ak47');
    expect(c.helmet).toBe(false);
    expect(slot.money).toBe(800);
  });

  it('save mode at $1200 only tops up half-armor', () => {
    slot.money = 1200;
    runBotBuy(slot, c);
    expect(c.inventory!.primary).toBeUndefined();
    expect(c.armor).toBe(100);
    expect(c.helmet).toBe(false);
    expect(slot.money).toBe(550);
  });

  it('eco at $300 buys nothing', () => {
    slot.money = 300;
    runBotBuy(slot, c);
    expect(c.inventory!.primary).toBeUndefined();
    expect(c.armor).toBe(0);
    expect(slot.money).toBe(300);
  });

  it('does not double-buy primary on a survived loadout', () => {
    slot.money = 5000;
    runBotBuy(slot, c);
    const before = slot.money;
    runBotBuy(slot, c);
    // Helmet/primary already present; second run should be a no-op modulo
    // any kit on CT side. T side has nothing else to spend on.
    expect(slot.money).toBe(before);
    expect(c.inventory!.primary?.def.id).toBe('ak47');
  });
});
