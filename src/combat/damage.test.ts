/** Vitest suite for damage formulas. Numbers are calibrated approximations
 *  to CS:GO; we test bounds and key cases, not exact equality. */

import { describe, it, expect } from 'vitest';
import { getWeapon } from '../weapons/definitions';
import { computeDamage, falloff } from './damage';

describe('falloff', () => {
  it('is 1 at point blank', () => {
    expect(falloff(getWeapon('ak47'), 0)).toBe(1);
  });
  it('is 1 within falloffStartM', () => {
    expect(falloff(getWeapon('ak47'), 20)).toBe(1);
  });
  it('decays past falloffStart', () => {
    const ak = getWeapon('ak47');
    const halfway = ak.falloffStartM + ak.falloffRangeM * 0.5;
    expect(falloff(ak, halfway)).toBeLessThan(1);
    expect(falloff(ak, halfway)).toBeGreaterThan(0.5);
  });
  it('caps at 0.10 at long range', () => {
    expect(falloff(getWeapon('ak47'), 200)).toBeCloseTo(0.1, 3);
  });
});

describe('AK-47 damage', () => {
  const ak = getWeapon('ak47');

  it('one-shot kills with headshot, no helmet', () => {
    const r = computeDamage({
      weapon: ak,
      hitbox: 'head',
      distance: 10,
      victim: { hp: 100, armor: 0, helmet: false },
    });
    expect(r.killing).toBe(true);
    expect(r.headshot).toBe(true);
  });

  it('one-shot kills with headshot, helmet (AK is strong enough)', () => {
    const r = computeDamage({
      weapon: ak,
      hitbox: 'head',
      distance: 10,
      victim: { hp: 100, armor: 100, helmet: true },
    });
    expect(r.killing).toBe(true);
    expect(r.helmetDestroyed).toBe(true);
  });

  it('chest no armor: 36 damage point blank', () => {
    const r = computeDamage({
      weapon: ak,
      hitbox: 'chest',
      distance: 0,
      victim: { hp: 100, armor: 0, helmet: false },
    });
    expect(r.hpDamage).toBeCloseTo(36, 1);
  });

  it('chest with armor: reduced damage', () => {
    const r = computeDamage({
      weapon: ak,
      hitbox: 'chest',
      distance: 0,
      victim: { hp: 100, armor: 100, helmet: false },
    });
    // armorPenetration=0.775, so ~36 * 0.775 = 27.9 hp damage.
    expect(r.hpDamage).toBeCloseTo(27.9, 1);
    expect(r.armorDamage).toBeGreaterThan(0);
  });

  it('leg deals less damage than chest', () => {
    const chest = computeDamage({
      weapon: ak, hitbox: 'chest', distance: 0,
      victim: { hp: 100, armor: 0, helmet: false },
    });
    const leg = computeDamage({
      weapon: ak, hitbox: 'leg', distance: 0,
      victim: { hp: 100, armor: 0, helmet: false },
    });
    expect(leg.hpDamage).toBeLessThan(chest.hpDamage);
  });
});

describe('AWP damage', () => {
  const awp = getWeapon('awp');
  it('one-shot body kill with armor', () => {
    const r = computeDamage({
      weapon: awp,
      hitbox: 'chest',
      distance: 30,
      victim: { hp: 100, armor: 100, helmet: true },
    });
    expect(r.killing).toBe(true);
  });
  it('one-shot leg kill (115 * 0.75 = 86 base, *0.975 pen ≈ 84 → not 100)', () => {
    const r = computeDamage({
      weapon: awp,
      hitbox: 'leg',
      distance: 0,
      victim: { hp: 100, armor: 0, helmet: false },
    });
    // 115 * 0.75 = 86.25 — not a leg kill on full HP. CS:GO behavior matches.
    expect(r.killing).toBe(false);
    expect(r.hpDamage).toBeCloseTo(86.25, 1);
  });
});

describe('Pistol vs armor', () => {
  it('Glock chest with armor is much weaker', () => {
    const noArmor = computeDamage({
      weapon: getWeapon('glock18'), hitbox: 'chest', distance: 0,
      victim: { hp: 100, armor: 0, helmet: false },
    });
    const withArmor = computeDamage({
      weapon: getWeapon('glock18'), hitbox: 'chest', distance: 0,
      victim: { hp: 100, armor: 100, helmet: false },
    });
    expect(withArmor.hpDamage).toBeLessThan(noArmor.hpDamage * 0.6);
  });
});

describe('Knife alt-fire damageMul', () => {
  const knife = getWeapon('knife');

  it('default mul=1 reproduces baseDamage at chest no-armor', () => {
    const r = computeDamage({
      weapon: knife, hitbox: 'chest', distance: 0,
      victim: { hp: 100, armor: 0, helmet: false },
    });
    expect(r.hpDamage).toBeCloseTo(knife.baseDamage, 1);
  });

  it('stab multiplier scales pre-armor damage proportionally', () => {
    const stab = knife.secondaryAttack;
    expect(stab).toBeDefined();
    const r = computeDamage({
      weapon: knife, hitbox: 'chest', distance: 0,
      victim: { hp: 200, armor: 0, helmet: false },
      damageMul: stab!.damageMul,
    });
    expect(r.hpDamage).toBeCloseTo(knife.baseDamage * stab!.damageMul, 1);
  });

  it('stab kills a 100hp unarmored victim in one hit', () => {
    const r = computeDamage({
      weapon: knife, hitbox: 'chest', distance: 0,
      victim: { hp: 100, armor: 0, helmet: false },
      damageMul: knife.secondaryAttack!.damageMul,
    });
    expect(r.killing).toBe(true);
  });
});

describe('Damage clamping', () => {
  it('does not deal more HP than victim has', () => {
    const r = computeDamage({
      weapon: getWeapon('awp'), hitbox: 'head', distance: 0,
      victim: { hp: 35, armor: 0, helmet: false },
    });
    expect(r.hpDamage).toBe(35);
    expect(r.killing).toBe(true);
  });
});
