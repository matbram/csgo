/** Hitscan combat — the system that converts a fire intent into a damage
 *  resolution. Pure dependencies: world ray query, hitbox raycast, damage
 *  formula. Side effects (decals, audio, kill feed) are emitted as events
 *  for other systems to consume. */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { WorldQuery } from '../player/physics';
import type { Character, LimbSegmentKind, LimbSide } from '../entities/character';
import type { WeaponDef } from '../weapons/definitions';
import { computeDamage, type HitboxKind } from './damage';
import { raycastHitbox, type HitboxSegment } from './hitbox';
import {
  hitboxPose, limbKey, distalSegments, SEGMENT_DETACH_HP,
} from '../entities/character';
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

    // Raycast each character. Alive characters use the full multi-band
    // hitbox; corpses get a fat sphere around the lying body so the
    // player can keep firing into a kill and watch limbs come off.
    // We clamp on visT (which folds smoke into the wall ray) so a
    // character behind smoke isn't reported as a hit.
    let closestT = visT;
    let bestVictim: Character | null = null;
    let bestVictimWasAlive = true;
    let bestKind: HitboxKind = 'chest';
    let bestSegment: HitboxSegment = 'chest';
    let bestSide: LimbSide | null = null;
    let bestPoint = { x: 0, y: 0, z: 0 };
    for (const c of this.characters()) {
      if (c.id === opts.shooter.id) continue;
      if (c.alive) {
        const pose = hitboxPose(c);
        const hit = raycastHitbox(
          opts.ox, opts.oy, opts.oz,
          finalDir.x, finalDir.y, finalDir.z,
          pose, closestT,
        );
        if (hit && hit.t < closestT) {
          closestT = hit.t;
          bestVictim = c;
          bestVictimWasAlive = true;
          bestKind = hit.kind;
          bestSegment = hit.segment;
          bestSide = hit.side;
          bestPoint = { x: hit.hitX, y: hit.hitY, z: hit.hitZ };
        }
      } else {
        // Corpse — sphere around the centre of the lying body. The
        // tipped-over mesh hangs around `pos.y + 0.2`; a 0.55 m sphere
        // covers torso + nearby limbs without being so big that
        // players feel like they're shooting through the air.
        const cx = c.pos.x;
        const cy = c.pos.y + 0.30;
        const cz = c.pos.z;
        const t = raySphereWorld(opts.ox, opts.oy, opts.oz,
          finalDir.x, finalDir.y, finalDir.z,
          cx, cy, cz, 0.55, closestT);
        if (t !== null && t < closestT) {
          closestT = t;
          bestVictim = c;
          bestVictimWasAlive = false;
          // Pick a random surviving segment as the "hit" location so
          // the dismemberment routine peels something off instead of
          // the same limb every shot.
          const pick = pickRandomCorpseSegment(c);
          bestKind = pick.kind;
          bestSegment = pick.segment;
          bestSide = pick.side;
          bestPoint = {
            x: opts.ox + finalDir.x * t,
            y: opts.oy + finalDir.y * t,
            z: opts.oz + finalDir.z * t,
          };
        }
      }
    }

    // Resolve.
    if (bestVictim) {
      const corpseHit = !bestVictimWasAlive;
      let hpDelta = 0;
      let killing = false;
      let limbDetached: { segment: LimbSegmentKind; side: LimbSide } | null = null;
      if (!corpseHit) {
        const damageMul = opts.damageMul ?? 1;
        const dmg = computeDamage({
          weapon,
          hitbox: bestKind,
          distance: closestT,
          victim: { hp: bestVictim.hp, armor: bestVictim.armor, helmet: bestVictim.helmet },
          damageMul,
        });
        hpDelta = Math.floor(dmg.hpDamage);
        bestVictim.hp = Math.max(0, bestVictim.hp - hpDelta);
        bestVictim.armor = Math.max(0, bestVictim.armor - dmg.armorDamage);
        if (dmg.helmetDestroyed) bestVictim.helmet = false;
        killing = bestVictim.hp <= 0;

        // Per-segment damage. Each anatomical piece has its own counter,
        // so two shots to the same shin detach the lower leg without
        // affecting the thigh or the other side. Only ACTUAL hp damage
        // counts (hpDelta) so armour absorption applies to limbs too.
        // When a segment crosses its threshold we cascade the detached
        // flag to all distal segments on the same side — a thigh that
        // tears off takes the shin and foot with it.
        if (isLimbSegment(bestSegment) && bestSide !== null) {
          const seg = bestSegment;
          const side = bestSide;
          const state = bestVictim.limbs[limbKey(seg, side)];
          if (!state.detached) {
            state.damage += hpDelta;
            if (state.damage >= SEGMENT_DETACH_HP[seg]) {
              state.detached = true;
              for (const distal of distalSegments(seg)) {
                bestVictim.limbs[limbKey(distal, side)].detached = true;
              }
              limbDetached = { segment: seg, side };
            }
          }
        }

        if (killing) bestVictim.alive = false;
      }

      events.emit('combat:hit', {
        attackerId: opts.shooter.id,
        victimId: bestVictim.id,
        weapon: weapon.id,
        hitbox: bestKind,
        segment: bestSegment,
        side: bestSide,
        damage: hpDelta,
        headshot: bestKind === 'head',
        killing,
        corpseHit,
        limbDetached,
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
          hit: `${corpseHit ? 'corpse:' : ''}${bestVictim.id}/${bestKind}`,
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

/** Ray vs sphere in world space. Returns the nearest forward intersection
 *  ≤ `maxT`, or null. Used for the broad-phase corpse hit check. */
function raySphereWorld(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number,
  radius: number,
  maxT: number,
): number | null {
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (lx * dx + ly * dy + lz * dz);
  const c = lx * lx + ly * ly + lz * lz - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  // Pick the nearest forward hit (eye is usually outside the sphere; use
  // the entry point. If we're inside, t1 < 0 and t2 > 0 — use t2.)
  const t = t1 > 0 ? t1 : t2;
  if (t <= 0 || t > maxT) return null;
  return t;
}

function isLimbSegment(s: HitboxSegment): s is LimbSegmentKind {
  return s !== 'head' && s !== 'chest' && s !== 'stomach';
}

/** Random surviving-segment pick for a corpse hit. Weighted toward
 *  arms/legs so centre-mass spam shreds limbs first; head and chest
 *  still come up so a sustained burst eventually hollows the body
 *  out completely. For limb hits we prefer the most-distal segment
 *  that's still attached on a randomly chosen side, so a corpse loses
 *  fingers before forearms before whole arms. Side is random for
 *  limbs, null for head/chest. */
function pickRandomCorpseSegment(
  victim: Character,
): { kind: HitboxKind; segment: HitboxSegment; side: LimbSide | null } {
  const r = Math.random();
  const side: LimbSide = Math.random() < 0.5 ? 'left' : 'right';
  if (r < 0.40) {
    const seg = pickAttachedDistalFirst(victim, ['foot', 'shin', 'thigh'], side);
    return { kind: 'leg', segment: seg ?? 'thigh', side };
  }
  if (r < 0.70) {
    const seg = pickAttachedDistalFirst(victim, ['hand', 'forearm', 'upperArm'], side);
    return { kind: 'arm', segment: seg ?? 'upperArm', side };
  }
  if (r < 0.90) return { kind: 'chest', segment: 'chest', side: null };
  return { kind: 'head', segment: 'head', side: null };
}

/** Walk segments distal-first and return the first one still attached
 *  on the given side, or null if every segment in the list is gone. */
function pickAttachedDistalFirst(
  victim: Character,
  order: LimbSegmentKind[],
  side: LimbSide,
): LimbSegmentKind | null {
  for (const seg of order) {
    if (!victim.limbs[limbKey(seg, side)].detached) return seg;
  }
  return null;
}

/** Convenience export so consumers don't need to import inaccuracy + def. */
export { computeInaccuracy };
export const _Vector3 = Vector3;
