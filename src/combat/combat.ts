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

    // Raycast world.
    const worldHit = this.world.rayWorld(
      opts.ox, opts.oy, opts.oz,
      finalDir.x, finalDir.y, finalDir.z,
      MAX_RANGE_M,
    );
    const worldT = worldHit?.t ?? Infinity;

    // Raycast each character (skip shooter and dead).
    let closestT = worldT;
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
      const dmg = computeDamage({
        weapon,
        hitbox: bestKind,
        distance: closestT,
        victim: { hp: bestVictim.hp, armor: bestVictim.armor, helmet: bestVictim.helmet },
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
      return {
        endX: ex, endY: ey, endZ: ez,
        kind: 'world',
        surface: worldHit.surface,
        distance: worldT,
      };
    }

    // Miss into the void.
    return {
      endX: opts.ox + finalDir.x * MAX_RANGE_M,
      endY: opts.oy + finalDir.y * MAX_RANGE_M,
      endZ: opts.oz + finalDir.z * MAX_RANGE_M,
      kind: 'miss',
      distance: MAX_RANGE_M,
    };
  }
}

function oyEnd(oy: number, dy: number, t: number): number {
  return oy + dy * t;
}

/** Convenience export so consumers don't need to import inaccuracy + def. */
export { computeInaccuracy };
export const _Vector3 = Vector3;
