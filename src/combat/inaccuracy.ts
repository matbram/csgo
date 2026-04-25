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
  /** True when a sniper rifle is fully scoped. */
  scoped?: boolean;
}

/** Inaccuracy in degrees (half-angle of error cone). */
export function computeInaccuracy(def: WeaponDef, motion: ShooterMotion): number {
  // Base inaccuracy (also affected by crouch).
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

  // Scoped sniper rifles are essentially pin-point when not moving. We
  // multiply by 0.05 so the first scoped shot from a stationary AWP is
  // basically dead-on.
  if (motion.scoped) {
    acc *= 0.05;
  }

  return acc;
}
