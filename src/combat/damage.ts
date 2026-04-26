/** Pure damage math. Given a weapon, hit context, and victim armor state,
 *  returns the damage applied to HP and to armor.
 *
 *  This module has no side effects and no Babylon dependencies — it's
 *  fully unit-testable, and tests live next to it as `damage.test.ts`. */

import type { WeaponDef } from '../weapons/definitions';

export type HitboxKind = 'head' | 'chest' | 'stomach' | 'arm' | 'leg';

const HITBOX_MULT: Record<HitboxKind, number> = {
  head: 4.0,
  chest: 1.0,
  stomach: 1.25,
  arm: 1.0,
  leg: 0.75,
};

export interface VictimArmor {
  /** 0..100 — Kevlar amount. */
  armor: number;
  /** Helmet present (only matters for head shots). */
  helmet: boolean;
}

export interface DamageInput {
  weapon: WeaponDef;
  hitbox: HitboxKind;
  /** Distance from shooter to hit point in meters. */
  distance: number;
  /** Victim HP/armor going in. */
  victim: { hp: number; armor: number; helmet: boolean };
  /** Per-shot damage multiplier on the pre-armor damage. Used by alt-fire
   *  modes like the knife stab. Defaults to 1. */
  damageMul?: number;
}

export interface DamageOutput {
  /** Damage applied to HP. */
  hpDamage: number;
  /** Damage applied to armor. */
  armorDamage: number;
  /** True when the hit removes the victim's helmet. */
  helmetDestroyed: boolean;
  /** True when this hit reduces HP to 0. */
  killing: boolean;
  /** Whether the hit is a headshot. Mirrored from input but exposed for callers. */
  headshot: boolean;
}

/** Distance falloff: 1.0 at point blank, decaying past `falloffStartM`,
 *  reaching ~0.10 at `falloffStartM + falloffRangeM`, then capped at 0.10. */
export function falloff(def: WeaponDef, distance: number): number {
  if (distance <= def.falloffStartM) return 1;
  const t = (distance - def.falloffStartM) / def.falloffRangeM;
  if (t >= 1) return 0.1;
  return 1 - 0.9 * t;
}

/** CS:GO armor formula approximation. The bullet's pre-armor damage is
 *  reduced via `armorPenetration`, and a portion is dealt to armor. */
export function applyArmor(
  hpBeforeArmor: number,
  armor: number,
  armorPen: number,
  hitsArmor: boolean,
): { hpDamage: number; armorDamage: number } {
  if (!hitsArmor || armor <= 0) {
    return { hpDamage: hpBeforeArmor, armorDamage: 0 };
  }
  // hp damage scales by armor penetration.
  const hpDamage = hpBeforeArmor * armorPen;
  // armor damage = (full damage - hp damage) * armorScale
  // We use 0.5 as the armor consumption fraction — close to CS:GO behavior.
  const armorDamage = Math.min(armor, Math.floor((hpBeforeArmor - hpDamage) * 0.5));
  return { hpDamage, armorDamage };
}

export function computeDamage(input: DamageInput): DamageOutput {
  const { weapon, hitbox, distance, victim } = input;
  const isHead = hitbox === 'head';
  const mul = input.damageMul ?? 1;

  // Base × hitbox × falloff × per-shot multiplier (alt-fire).
  let pre = weapon.baseDamage * HITBOX_MULT[hitbox] * falloff(weapon, distance) * mul;

  // Helmet absorbs head shots (one shot allowed through then helmet gone).
  let helmetDestroyed = false;
  let armorAtStart = victim.armor;
  if (isHead && victim.helmet) {
    // Apply armor formula treating armor pen against helmet.
    const r = applyArmor(pre, armorAtStart, weapon.armorPenetration, true);
    helmetDestroyed = true;
    return {
      hpDamage: clampDamage(r.hpDamage, victim.hp),
      armorDamage: r.armorDamage,
      helmetDestroyed,
      killing: clampDamage(r.hpDamage, victim.hp) >= victim.hp,
      headshot: true,
    };
  }

  // Body shot with armor.
  if (!isHead && armorAtStart > 0) {
    const r = applyArmor(pre, armorAtStart, weapon.armorPenetration, true);
    return {
      hpDamage: clampDamage(r.hpDamage, victim.hp),
      armorDamage: r.armorDamage,
      helmetDestroyed: false,
      killing: clampDamage(r.hpDamage, victim.hp) >= victim.hp,
      headshot: false,
    };
  }

  // No armor or unhelmeted head shot.
  const hpDamage = clampDamage(pre, victim.hp);
  return {
    hpDamage,
    armorDamage: 0,
    helmetDestroyed: false,
    killing: hpDamage >= victim.hp,
    headshot: isHead,
  };
}

function clampDamage(d: number, hp: number): number {
  if (d < 0) return 0;
  if (d > hp) return hp;
  return d;
}
