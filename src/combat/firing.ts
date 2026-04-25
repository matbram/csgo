/** Firing logic — given input + active weapon instance, decide whether to
 *  fire this tick and update the weapon's spray/timing state. Pure-ish:
 *  emits 'combat:fire' / 'combat:tracer' events but does not own any
 *  Babylon visuals.
 *
 *  Callers feed in:
 *    - the active weapon instance
 *    - eye position + aim forward
 *    - shooter motion (for inaccuracy)
 *    - input flags (triggerHeld, triggerEdge, reloadPressed)
 *
 *  Per simulation tick, this module:
 *    1. Advances time-based state transitions (deploy → ready, reload → ready).
 *    2. Decays spray index when (now - lastFire) > recoilDecayMs.
 *    3. If allowed and triggered, fires a shot and emits events.
 */

import type { Character } from '../entities/character';
import type { WeaponInstance } from '../weapons/inventory';
import type { CombatSystem } from './combat';
import { computeInaccuracy } from './inaccuracy';
import { events } from '../engine/events';

export interface FiringInput {
  /** Mouse 1 (left) is held this tick. */
  triggerHeld: boolean;
  /** Mouse 1 was pressed THIS tick (edge). */
  triggerEdge: boolean;
  /** Reload key pressed this tick. */
  reloadEdge: boolean;
}

export interface FireRequest {
  ox: number; oy: number; oz: number;
  fwdX: number; fwdY: number; fwdZ: number;
}

export class FiringController {
  constructor(
    private readonly combat: CombatSystem,
  ) {}

  /** Advance state and possibly fire. Returns true if a shot was fired. */
  step(
    nowMs: number,
    shooter: Character,
    inst: WeaponInstance,
    aim: FireRequest,
    input: FiringInput,
  ): boolean {
    // 1) Advance state transitions.
    if ((inst.state === 'deploying' || inst.state === 'reloading') && nowMs >= inst.stateUntilMs) {
      if (inst.state === 'reloading') {
        // Move ammo from reserve to magazine.
        const need = inst.def.magazine - inst.ammoMag;
        const take = Math.min(need, inst.ammoReserve);
        inst.ammoMag += take;
        inst.ammoReserve -= take;
      }
      inst.state = inst.ammoMag > 0 ? 'ready' : 'empty';
    }

    // 2) Decay spray.
    if (nowMs - inst.lastFireMs > inst.def.recoilDecayMs) {
      inst.sprayIndex = 0;
    }

    // 3) Reload request. Allowed from 'ready' or 'empty' — i.e. anytime the
    //    weapon isn't currently deploying or already reloading.
    const canReload = (inst.state === 'ready' || inst.state === 'empty');
    if (input.reloadEdge && canReload && inst.def.magazine > 0) {
      if (inst.ammoMag < inst.def.magazine && inst.ammoReserve > 0) {
        inst.state = 'reloading';
        inst.stateUntilMs = nowMs + inst.def.reloadMs;
        events.emit('combat:reload', { shooterId: shooter.id, weapon: inst.def.id, tMs: nowMs });
        return false;
      }
    }

    // 4) Fire if allowed.
    // Knives and other melee weapons have magazine=0; they don't consume
    // ammo. For everything else we require ammoMag > 0.
    const isMelee = inst.def.fireMode === 'melee' || inst.def.magazine === 0;
    const canFire = inst.state === 'ready' && (isMelee || inst.ammoMag > 0);
    if (!canFire) return false;

    const fireIntervalMs = 60_000 / inst.def.rpm;
    if (nowMs - inst.lastFireMs < fireIntervalMs) return false;

    const fireMode = inst.def.fireMode;
    let shouldFire = false;
    if (fireMode === 'auto') shouldFire = input.triggerHeld;
    else if (fireMode === 'semi') shouldFire = input.triggerEdge;
    else if (fireMode === 'bolt') shouldFire = input.triggerEdge;
    else if (fireMode === 'burst') shouldFire = input.triggerEdge;
    else if (fireMode === 'melee') shouldFire = input.triggerEdge; // simplified

    if (!shouldFire) return false;

    // Compute inaccuracy at fire time.
    const inacc = computeInaccuracy(inst.def, {
      speed: shooter.speed,
      inAir: shooter.inAir,
      crouching: shooter.crouching,
      scoped: shooter.scoped,
    });

    const result = this.combat.fire({
      ox: aim.ox, oy: aim.oy, oz: aim.oz,
      fwdX: aim.fwdX, fwdY: aim.fwdY, fwdZ: aim.fwdZ,
      shooter,
      weapon: inst.def,
      sprayIndex: inst.sprayIndex,
      inaccuracyDeg: inacc,
    });
    void result; // visuals consume events

    events.emit('combat:fire', {
      shooterId: shooter.id, weapon: inst.def.id,
      ox: aim.ox, oy: aim.oy, oz: aim.oz,
      dx: aim.fwdX, dy: aim.fwdY, dz: aim.fwdZ,
      sprayIndex: inst.sprayIndex,
      tMs: nowMs,
    });
    events.emit('combat:tracer', {
      sx: aim.ox, sy: aim.oy, sz: aim.oz,
      ex: result.endX, ey: result.endY, ez: result.endZ,
      tMs: nowMs,
    });

    // Update state.
    if (!isMelee) {
      inst.ammoMag -= 1;
      if (inst.ammoMag <= 0) {
        inst.state = 'empty';
      }
    }
    inst.lastFireMs = nowMs;
    inst.sprayIndex += 1;
    return true;
  }
}
