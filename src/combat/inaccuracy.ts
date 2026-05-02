/** Per-tick inaccuracy calculation. Inaccuracy is the half-angle (degrees)
 *  of the cone the bullet randomly samples. Fire-time inaccuracy = base +
 *  movement penalty + spray decay state.
 *
 *  The spray pattern itself is *deterministic* (lookup table); on top of
 *  that we add a random scatter scaled by inaccuracy so the bullet still
 *  has variance even at the bottom of the spray pattern. */

import type { WeaponDef } from '../weapons/definitions';

export interface ShooterMotion {
  /** Horizontal speed in m/s. */
  speed: number;
  /** True if currently airborne. */
  inAir: boolean;
  crouching: boolean;
  /** Number of arms blown off (0..2). Adds a flat cone so even a
   *  stationary one-armed shooter can't tap-hold a tight aim, and a
   *  no-armed shooter is essentially shot-gunning. */
  armsGone?: number;
}

/** Inaccuracy in degrees (half-angle of error cone).
 *
 *  Stationary, grounded shooters are treated as pin-point accurate — the
 *  bullet flies exactly along the aim vector plus the deterministic spray
 *  pattern. This matches the player expectation that "if I'm standing still
 *  and aiming at a spot, I should hit it." Movement, jumping, and the
 *  spray pattern's per-shot offset still cause shots to drift; what's
 *  removed is the gun's random base-cone wiggle while perfectly still. */
export function computeInaccuracy(def: WeaponDef, motion: ShooterMotion): number {
  // One-armed: +2.5° cone. Both arms gone: stacked penalty (+6°)
  // — the gun is somehow still firing but accuracy is a memory.
  const arms = motion.armsGone ?? 0;
  const armPenaltyDeg = arms === 0 ? 0 : arms === 1 ? 2.5 : 6.0;
  const stationary = motion.speed < 1.0 && !motion.inAir;
  if (stationary) return armPenaltyDeg;

  // Base inaccuracy (also affected by crouch). Only contributes when
  // moving or airborne — see the early return above.
  let acc = def.baseInaccuracyDeg;
  if (motion.crouching) {
    acc *= def.crouchInaccuracyMul;
  }

  // Movement penalty: scales linearly with speed, capped at 1.5x walk speed.
  // Speed below 1 m/s contributes ~zero penalty so counter-strafing pays off.
  const moveTerm = Math.max(0, motion.speed - 1.0) / 6.5; // normalized to run speed
  acc += moveTerm * def.movingInaccuracyMul * 0.05; // tuned multiplier

  // Air penalty — large.
  if (motion.inAir) {
    acc += def.jumpingInaccuracyMul * 0.05;
  }

  return acc + armPenaltyDeg;
}
