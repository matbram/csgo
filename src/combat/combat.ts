/** Hitscan combat — the system that converts a fire intent into a damage
 *  resolution. Pure dependencies: world ray query, hitbox raycast, damage
 *  formula. Side effects (decals, audio, kill feed) are emitted as events
 *  for other systems to consume. */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { WorldQuery } from '../player/physics';
import type { Character } from '../entities/character';
import type { WeaponDef } from '../weapons/definitions';
import { computeDamage, type HitboxKind } from './damage';
import { raycastHitbox } from './hitbox';
import { hitboxPose } from '../entities/character';
import { events } from '../engine/events';
import { computeInaccuracy } from './inaccuracy';
import { time } from '../engine/time';
import type { SmokeField } from '../grenades/smokeField';
import { debugLog } from '../engine/debugLog';

const MAX_RANGE_M = 120;

export interface FireOptions {
  /** Origin of the bullet (eye position). */
  ox: number;
  oy: number;
  oz: number;
  /** Forward direction of the *aim* (normalized). Spray and inaccuracy
   *  are applied internally. */
  fwdX: number;
  fwdY: number;
  fwdZ: number;
  shooter: Character;
  weapon: WeaponDef;
  /** Spray index (0-based). */
  sprayIndex: number;
  /** Inaccuracy in degrees (precomputed from motion). */
  inaccuracyDeg: number;
  /** Per-shot damage multiplier on top of the weapon's base damage.
   *  Used by alternate-fire modes (e.g. knife stab) to deal more damage
   *  without forking the WeaponDef. Defaults to 1. */
  damageMul?: number;
}

export interface FireResult {
  /** Where the bullet ended up — wall hit, character hit, or end of range. */
  endX: number;
  endY: number;
  endZ: number;
  /** What was struck. */
  kind: 'world' | 'character' | 'miss';
  surface?: string;
  /** Distance traveled. */
  distance: number;
  /** If a character was hit. */
  victim?: Character;
  hitbox?: HitboxKind;
  damage?: number;
  killing?: boolean;
}

import { computeShotDir, computeRight, computeUp } from './shotDir';

export class CombatSystem {
  constructor(
    private readonly world: WorldQuery,
    private readonly characters: () => Character[],
    /** Optional smoke field — when present, character hits behind a
     *  thick smoke chord are dropped (we leave bullet-through-smoke
     *  damage falloff for a future pass). */
    private readonly smokeField: SmokeField | null = null,
  ) {}

  fire(opts: FireOptions): FireResult {
    const { weapon } = opts;

    // Compose direction: aim + spray pattern + inaccuracy scatter.
    const right = computeRight(opts.fwdX, opts.fwdY, opts.fwdZ);
    const up = computeUp(opts.fwdX, opts.fwdY, opts.fwdZ, right);
    const sprayEntry =
      weapon.sprayPattern[Math.min(opts.sprayIndex, weapon.sprayPattern.length - 1)] ??
      [0, 0] as const;
    const sprayX = sprayEntry[0];
    const sprayY = sprayEntry[1];
    // Past the pattern length, add scatter that grows with extra shots.
    const overshoot = Math.max(0, opts.sprayIndex - (weapon.sprayPattern.length - 1));
    const scatterDeg = overshoot * 0.4 + opts.inaccuracyDeg;

    const finalDir = computeShotDir(
      opts.fwdX, opts.fwdY, opts.fwdZ,
      right, up,
      sprayX, sprayY,
      scatterDeg,
    );

    // We log one terse line per shot (only for the local player — bot
    // gunfire would dwarf the buffer in seconds). The interesting
    // numbers for "is the bullet going where I aim" are sprayIndex,
    // inaccuracyDeg, and aimDriftDeg (angle between view ray and the
    // resolved bullet direction). Stationary first shot should have
    // aimDrift=0.
    let aimDriftDeg = 0;
    if (debugLog.isEnabled('shooting') && opts.shooter.id === 'local') {
      aimDriftDeg =
        Math.acos(Math.max(-1, Math.min(1,
          opts.fwdX * finalDir.x + opts.fwdY * finalDir.y + opts.fwdZ * finalDir.z,
        ))) * 180 / Math.PI;
    }

    // Melee weapons are short-range — anything past the falloff envelope
    // is wasted compute and would emit a kill-from-the-void event.
    const maxRange = weapon.fireMode === 'melee'
      ? Math.max(0.5, weapon.falloffStartM + weapon.falloffRangeM)
      : MAX_RANGE_M;

    // Raycast world.
    const worldHit = this.world.rayWorld(
      opts.ox, opts.oy, opts.oz,
      finalDir.x, finalDir.y, finalDir.z,
      maxRange,
    );
    const worldT = worldHit?.t ?? Infinity;
    // Smoke chord: a thick smoke pass blocks visual confirmation of
    // hits. We treat it as a soft wall — bullets still travel (CS:GO
    // can spray through smoke), but for hit registration any character
    // beyond the smoke threshold is considered occluded.
    const smokeBlockT = this.smokeField?.blockingT(
      opts.ox, opts.oy, opts.oz,
      finalDir.x, finalDir.y, finalDir.z,
      Math.min(worldT, maxRange),
    ) ?? null;
    const visT = smokeBlockT !== null ? Math.min(worldT, smokeBlockT) : worldT;

    // Raycast each character (skip shooter and dead). We clamp on
    // visT (which folds smoke into the wall ray) so a character behind
    // smoke isn't reported as a hit.
    let closestT = visT;
    let bestVictim: Character | null = null;
    let bestKind: HitboxKind = 'chest';
    let bestPoint = { x: 0, y: 0, z: 0 };
    for (const c of this.characters()) {
      if (!c.alive) continue;
      if (c.id === opts.shooter.id) continue;
      const pose = hitboxPose(c);
      const hit = raycastHitbox(
        opts.ox, opts.oy, opts.oz,
        finalDir.x, finalDir.y, finalDir.z,
        pose, closestT,
      );
      if (hit && hit.t < closestT) {
        closestT = hit.t;
        bestVictim = c;
        bestKind = hit.kind;
        bestPoint = { x: hit.hitX, y: hit.hitY, z: hit.hitZ };
      }
    }

    // Resolve.
    if (bestVictim) {
      const damageMul = opts.damageMul ?? 1;
      const dmg = computeDamage({
        weapon,
        hitbox: bestKind,
        distance: closestT,
        victim: { hp: bestVictim.hp, armor: bestVictim.armor, helmet: bestVictim.helmet },
        damageMul,
      });

      // Apply damage (integer in CS:GO; we use floor for HP, floor for armor).
      const hpDelta = Math.floor(dmg.hpDamage);
      bestVictim.hp = Math.max(0, bestVictim.hp - hpDelta);
      bestVictim.armor = Math.max(0, bestVictim.armor - dmg.armorDamage);
      if (dmg.helmetDestroyed) bestVictim.helmet = false;
      const killing = bestVictim.hp <= 0;
      if (killing) bestVictim.alive = false;

      events.emit('combat:hit', {
        attackerId: opts.shooter.id,
        victimId: bestVictim.id,
        weapon: weapon.id,
        hitbox: bestKind,
        damage: hpDelta,
        headshot: bestKind === 'head',
        killing,
        hitX: bestPoint.x, hitY: bestPoint.y, hitZ: bestPoint.z,
        victimFootY: bestVictim.pos.y,
        dirX: finalDir.x, dirY: finalDir.y, dirZ: finalDir.z,
        distance: closestT,
        tMs: time.simMs,
      });
      if (killing) {
        events.emit('combat:kill', {
          attackerId: opts.shooter.id,
          victimId: bestVictim.id,
          weapon: weapon.id,
          headshot: bestKind === 'head',
          tMs: time.simMs,
        });
      }
      if (debugLog.isEnabled('shooting') && opts.shooter.id === 'local') {
        debugLog.shooting('shot', {
          weapon: weapon.id,
          spray: opts.sprayIndex,
          inacc: opts.inaccuracyDeg,
          drift: aimDriftDeg,
          hit: `${bestVictim.id}/${bestKind}`,
          dmg: hpDelta,
          kill: killing,
          dist: closestT,
        });
      }
      return {
        endX: bestPoint.x, endY: bestPoint.y, endZ: bestPoint.z,
        kind: 'character',
        distance: closestT,
        victim: bestVictim,
        hitbox: bestKind,
        damage: hpDelta,
        killing,
      };
    }

    if (worldHit) {
      const ex = opts.ox + finalDir.x * worldT;
      const ey = oyEnd(opts.oy, finalDir.y, worldT);
      const ez = opts.oz + finalDir.z * worldT;
      events.emit('combat:bulletImpact', {
        x: ex, y: ey, z: ez,
        nx: 0, ny: 0, nz: 0,         // M2: skip computing exact normal
        surface: worldHit.surface,
        distance: worldT,
        tMs: time.simMs,
      });
      if (debugLog.isEnabled('shooting') && opts.shooter.id === 'local') {
        debugLog.shooting('shot', {
          weapon: weapon.id,
          spray: opts.sprayIndex,
          inacc: opts.inaccuracyDeg,
          drift: aimDriftDeg,
          hit: `wall/${worldHit.surface}`,
          dist: worldT,
          end: { x: ex, y: ey, z: ez },
        });
      }
      return {
        endX: ex, endY: ey, endZ: ez,
        kind: 'world',
        surface: worldHit.surface,
        distance: worldT,
      };
    }

    if (debugLog.isEnabled('shooting') && opts.shooter.id === 'local') {
      debugLog.shooting('shot', {
        weapon: weapon.id,
        spray: opts.sprayIndex,
        inacc: opts.inaccuracyDeg,
        drift: aimDriftDeg,
        hit: 'miss',
        dist: maxRange,
      });
    }
    // Miss into the void.
    return {
      endX: opts.ox + finalDir.x * maxRange,
      endY: opts.oy + finalDir.y * maxRange,
      endZ: opts.oz + finalDir.z * maxRange,
      kind: 'miss',
      distance: maxRange,
    };
  }
}

function oyEnd(oy: number, dy: number, t: number): number {
  return oy + dy * t;
}

/** Convenience export so consumers don't need to import inaccuracy + def. */
export { computeInaccuracy };
export const _Vector3 = Vector3;
