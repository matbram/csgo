/** Common character data. The local player and bots both wrap this; dummy
 *  targets in M2 also use it. */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Inventory } from '../weapons/inventory';
import type { HitboxPose } from '../combat/hitbox';

export type CharacterTeam = 'T' | 'CT';

/** Anatomical pieces tracked for per-segment damage and dismemberment.
 *  An arm has three: upperArm, forearm, hand (proximal → distal). A leg
 *  has three: thigh, shin, foot. The torso/head are tracked as overall
 *  HP only — they don't dismember independently. */
export type LimbSegmentKind =
  | 'upperArm' | 'forearm' | 'hand'
  | 'thigh'    | 'shin'    | 'foot';
export type LimbSide = 'left' | 'right';

/** Per-segment cumulative damage + detached flag. The damage counter
 *  accumulates HP damage taken on that specific segment; once it crosses
 *  the segment's detach threshold the piece tears off and all distal
 *  segments cascade off with it (e.g. losing the thigh tears the shin
 *  and foot off too). */
export interface SegmentState {
  damage: number;
  detached: boolean;
}

export interface CharacterLimbs {
  leftUpperArm: SegmentState;
  leftForearm:  SegmentState;
  leftHand:     SegmentState;
  rightUpperArm: SegmentState;
  rightForearm:  SegmentState;
  rightHand:     SegmentState;
  leftThigh: SegmentState;
  leftShin:  SegmentState;
  leftFoot:  SegmentState;
  rightThigh: SegmentState;
  rightShin:  SegmentState;
  rightFoot:  SegmentState;
}

export type LimbStorageKey = keyof CharacterLimbs;

export interface Character {
  id: string;
  team: CharacterTeam;
  /** True if this is the human-controlled player. */
  isLocal: boolean;
  /** Capsule base position. */
  pos: Vector3;
  /** Capsule current height (interpolated when crouching). */
  currentHeight: number;
  /** Eye height above base. */
  currentEye: number;
  yaw: number;
  pitch: number;

  hp: number;
  armor: number;
  helmet: boolean;
  /** CT defuse kit. */
  hasKit: boolean;
  alive: boolean;
  inventory: Inventory | null;

  /** True for moving entities — matters for inaccuracy. */
  speed: number;
  inAir: boolean;
  crouching: boolean;
  /** Sim ms at which this character's flash blindness clears. Past
   *  values mean "not flashed". Both the local player overlay and the
   *  bot perception flash-degrade hook off this. */
  flashedUntilMs?: number;

  /** Per-anatomical-segment damage + detached state. Twelve slots:
   *  three per arm × two arms + three per leg × two legs. Reset by
   *  resetCharacterForRound. Drives both dismemberment visuals and
   *  the speed/aim impairment helpers below. */
  limbs: CharacterLimbs;
}

export function hitboxPose(c: Character): HitboxPose {
  return {
    baseX: c.pos.x,
    baseY: c.pos.y,
    baseZ: c.pos.z,
    yaw: c.yaw,
    eye: c.currentEye,
    height: c.currentHeight,
  };
}

/** Build a fresh limb state record — all segments at zero damage,
 *  none detached. Used by character constructors and round reset. */
export function makeFreshLimbs(): CharacterLimbs {
  const fresh = (): SegmentState => ({ damage: 0, detached: false });
  return {
    leftUpperArm: fresh(), leftForearm: fresh(), leftHand: fresh(),
    rightUpperArm: fresh(), rightForearm: fresh(), rightHand: fresh(),
    leftThigh: fresh(), leftShin: fresh(), leftFoot: fresh(),
    rightThigh: fresh(), rightShin: fresh(), rightFoot: fresh(),
  };
}

/** Reset all segment counters and detached flags in place. Called from
 *  resetCharacterForRound so we don't reallocate the limbs object. */
export function resetLimbs(l: CharacterLimbs): void {
  for (const key of Object.keys(l) as LimbStorageKey[]) {
    const seg = l[key];
    seg.damage = 0;
    seg.detached = false;
  }
}

export function limbKey(segment: LimbSegmentKind, side: LimbSide): LimbStorageKey {
  const cap = segment.charAt(0).toUpperCase() + segment.slice(1);
  return `${side}${cap}` as LimbStorageKey;
}

/** Distal segments that fall off when a given segment is detached.
 *  Returns the segments that should cascade *in addition to* the
 *  proximal break point. Listed proximal-to-distal so callers can
 *  iterate them in flight order. */
export function distalSegments(segment: LimbSegmentKind): LimbSegmentKind[] {
  switch (segment) {
    case 'upperArm': return ['forearm', 'hand'];
    case 'forearm':  return ['hand'];
    case 'thigh':    return ['shin', 'foot'];
    case 'shin':     return ['foot'];
    case 'hand':
    case 'foot':
      return [];
  }
}

/** Per-segment cumulative HP damage threshold for the segment to tear
 *  off the body. Tuned by anatomical mass: a thigh shrugs off pistol
 *  spam, a hand pops off after a couple of shots. Calibrated so an
 *  AWP body shot (~86 hp pre-armour to a leg) one-shots any leg
 *  segment, an AK takes 2-4 shots depending on segment, and a pistol
 *  needs sustained fire. */
export const SEGMENT_DETACH_HP: Record<LimbSegmentKind, number> = {
  thigh: 70,
  shin: 45,
  foot: 25,
  upperArm: 60,
  forearm: 40,
  hand: 20,
};

/** Movement speed scale from leg damage. Each side contributes its own
 *  factor; we multiply the two so losing one foot is mild and losing
 *  both whole legs is a crawl. Realistic-ish: missing a foot is a
 *  noticeable limp, missing the lower leg is much worse, missing the
 *  whole leg from the hip leaves you dragging yourself. */
export function legSpeedScale(c: Character): number {
  const sideFactor = (side: LimbSide): number => {
    const thigh = c.limbs[limbKey('thigh', side)];
    const shin  = c.limbs[limbKey('shin',  side)];
    const foot  = c.limbs[limbKey('foot',  side)];
    if (thigh.detached) return 0.40;
    if (shin.detached)  return 0.55;
    if (foot.detached)  return 0.85;
    return 1.0;
  };
  const scale = sideFactor('left') * sideFactor('right');
  // Floor: even with both legs amputated, a crawling crab-shuffle is
  // possible. Anything below this and the character feels frozen.
  return Math.max(0.10, scale);
}

/** Inaccuracy cone (degrees) added to a shooter's gun by missing arm
 *  segments. A lost hand wobbles the grip; a lost forearm means you're
 *  one-handed; a lost upper arm means the gun is being held by stumps. */
export function armInaccuracyDeg(c: Character): number {
  const sideCone = (side: LimbSide): number => {
    const upper   = c.limbs[limbKey('upperArm', side)];
    const forearm = c.limbs[limbKey('forearm',  side)];
    const hand    = c.limbs[limbKey('hand',     side)];
    if (upper.detached)   return 4.0;
    if (forearm.detached) return 2.5;
    if (hand.detached)    return 1.0;
    return 0;
  };
  return sideCone('left') + sideCone('right');
}

/** Whole-leg amputation count (0..2) — used by the bot tip-over /
 *  crawl visual and the lean tilt. A leg counts as "whole-gone" only
 *  when the thigh itself has detached, which (via cascade) means the
 *  shin and foot are gone too. */
export function wholeLegsLost(c: Character): number {
  return (c.limbs.leftThigh.detached ? 1 : 0)
    + (c.limbs.rightThigh.detached ? 1 : 0);
}
