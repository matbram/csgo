/** Per-tick inaccuracy calculation. Inaccuracy is the half-angle (degrees)
 *  of the cone the bullet randomly samples. Fire-time inaccuracy = base +
 *  movement penalty + spray decay state.
 *
 *  The spray pattern itself is *deterministic* (lookup table); on top of
 *  that we add a random scatter scaled by inaccuracy so the bullet still
 *  has variance even at the bottom of the spray pattern. */

import type { WeaponDef } from '../weapons/definitions';
import { debugLog } from '../engine/debugLog';

export interface ShooterMotion {
  /** Horizontal speed in m/s. */
  speed: number;
  /** True if currently airborne. */
  inAir: boolean;
  crouching: boolean;
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
  const stationary = motion.speed < 1.0 && !motion.inAir;
  if (stationary) {
    if (debugLog.isEnabled('shooting')) {
      debugLog.shooting('inaccuracy.stationary', {
        weapon: def.id, speed: motion.speed, inAir: motion.inAir,
        crouching: motion.crouching, returned: 0,
      });
    }
    return 0;
  }

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

  if (debugLog.isEnabled('shooting')) {
    debugLog.shooting('inaccuracy.moving', {
      weapon: def.id, speed: motion.speed, inAir: motion.inAir,
      crouching: motion.crouching, returned: acc,
    });
  }
  return acc;
}
