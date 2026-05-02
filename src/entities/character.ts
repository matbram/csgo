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
/** Per-segment severance state. A bullet that fails to sever still
 *  contributes `trauma`; once trauma exceeds the segment's traumaHP
 *  cap the segment is `compromised` — the next hit of any size will
 *  finish it. Single-shot severance (a single hit delivering enough
 *  HP damage past `severeHP`) bypasses trauma and detaches outright,
 *  matching how real-world traumatic amputation actually works. */
export interface SegmentState {
  trauma: number;
  compromised: boolean;
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

/** Build a fresh limb state record — all segments healthy. Used by
 *  character constructors and round reset. */
export function makeFreshLimbs(): CharacterLimbs {
  const fresh = (): SegmentState => ({ trauma: 0, compromised: false, detached: false });
  return {
    leftUpperArm: fresh(), leftForearm: fresh(), leftHand: fresh(),
    rightUpperArm: fresh(), rightForearm: fresh(), rightHand: fresh(),
    leftThigh: fresh(), leftShin: fresh(), leftFoot: fresh(),
    rightThigh: fresh(), rightShin: fresh(), rightFoot: fresh(),
  };
}

/** Reset all segment state in place. Called from resetCharacterForRound
 *  so we don't reallocate the limbs object. */
export function resetLimbs(l: CharacterLimbs): void {
  for (const key of Object.keys(l) as LimbStorageKey[]) {
    const seg = l[key];
    seg.trauma = 0;
    seg.compromised = false;
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

/** Severance physics per segment.
 *
 *  - `severeHP` — hpDelta in a single hit needed to amputate immediately.
 *    Mirrors real-world traumatic amputation: a single high-energy event
 *    severs (large caliber, point-blank shotgun, explosive proximity);
 *    small-arms hits do not on their own.
 *  - `traumaHP` — cumulative non-severing damage cap. Once exceeded the
 *    segment is "structurally compromised" — the next hit of any size
 *    finishes it. Models a limb so mangled it's hanging by a thread.
 *  - `explosiveSever` — denominator for explosive severance probability:
 *    p = min(0.95, blastDamage / explosiveSever). Distal pieces have
 *    smaller bones and pop off more readily near a blast.
 *
 *  Calibrated against the post-multiplier, post-armor `hpDelta` that
 *  combat.ts actually emits (see plan file). Examples:
 *    AWP point-blank thigh (115 × 0.75 = 86) ≥ 80 → one-shot
 *    AK thigh (27)         → trauma (8 hits to compromise; victim dead first)
 *    Knife slash hand (65) → severs in one slash
 *    Knife slash thigh(49) → trauma only (matches real-world plausibility) */
export interface SeveranceProfile {
  severeHP: number;
  traumaHP: number;
  explosiveSever: number;
}

/** Severance profiles by segment. Head is included so non-killing
 *  headshots (rare — long-range AWP through helmet) don't pop heads
 *  off; killing headshots still detach the head via the existing
 *  kill-detach path in visuals. */
export const SEVERANCE_PROFILE: Record<LimbSegmentKind | 'head', SeveranceProfile> = {
  head:     { severeHP: 110, traumaHP: 200, explosiveSever: 150 },
  thigh:    { severeHP:  80, traumaHP: 200, explosiveSever: 130 },
  shin:     { severeHP:  65, traumaHP: 150, explosiveSever: 100 },
  foot:     { severeHP:  40, traumaHP:  80, explosiveSever:  60 },
  upperArm: { severeHP:  75, traumaHP: 180, explosiveSever: 120 },
  forearm:  { severeHP:  55, traumaHP: 120, explosiveSever:  90 },
  hand:     { severeHP:  45, traumaHP:  70, explosiveSever:  55 },
};

/** Bullet severance evaluation — single-shot trauma physics. Mutates
 *  the segment state: increments trauma when the hit doesn't sever,
 *  and flips `compromised` when the trauma cap is crossed. Returns
 *  true iff the segment should detach right now (caller cascades
 *  distal pieces).
 *
 *  Melee weapons are restricted to severing distal extremities only:
 *  a knife can take fingers, a hand, or a foot off, but it doesn't
 *  realistically sever a thigh or shin even on a stab. Blocked melee
 *  hits still feed the trauma counter. */
export function evaluateBulletSeverance(
  state: SegmentState,
  segment: LimbSegmentKind,
  hpDelta: number,
  isMelee: boolean,
): boolean {
  if (state.detached) return false;
  const profile = SEVERANCE_PROFILE[segment];
  const meleeAllowed = !isMelee || segment === 'hand' || segment === 'foot';
  // Compromised segment: any further hit (within melee scope rules)
  // finishes the job.
  if (state.compromised && meleeAllowed) return true;
  // Single-shot severance from a high-energy hit.
  if (meleeAllowed && hpDelta >= profile.severeHP) return true;
  // Trauma accumulation — one day this hit's contribution will tip
  // the segment past its cap and the next bullet will sever it.
  state.trauma += hpDelta;
  if (state.trauma >= profile.traumaHP) state.compromised = true;
  return false;
}

/** Explosive severance roll for one segment. Probability scales with
 *  the blast's effective damage on the victim, capped at 0.95 so even
 *  a point-blank grenade leaves *some* limbs attached for variety.
 *  Failed rolls still feed the trauma counter at a reduced rate so a
 *  near-miss can leave a limb compromised for a follow-up shot. */
export function rollExplosiveSeverance(
  state: SegmentState,
  segment: LimbSegmentKind,
  blastDamage: number,
): boolean {
  if (state.detached) return false;
  const profile = SEVERANCE_PROFILE[segment];
  const p = Math.min(0.95, blastDamage / profile.explosiveSever);
  if (Math.random() < p) return true;
  state.trauma += blastDamage * 0.4;
  if (state.trauma >= profile.traumaHP) state.compromised = true;
  return false;
}

/** Helper for callers that need to enumerate limb segments by side. */
export const LIMB_SEGMENT_KINDS: readonly LimbSegmentKind[] = [
  'upperArm', 'forearm', 'hand',
  'thigh', 'shin', 'foot',
];

/** Apply explosive severance to every limb segment of a victim and
 *  return the deduplicated list of proximal break points to feed into
 *  the visuals layer. Distal cascade is handled here: if a thigh
 *  severs we mark its shin and foot detached and skip rolling for
 *  them (and we omit them from the returned list because
 *  detachBodyPart cascades when given the proximal segment). The
 *  iteration order is proximal-first so a thigh sever short-circuits
 *  the shin/foot rolls on the same side. */
export function rollSegmentSeverance(
  victim: Character,
  blastDamage: number,
): Array<{ segment: LimbSegmentKind; side: LimbSide }> {
  const out: Array<{ segment: LimbSegmentKind; side: LimbSide }> = [];
  const sides: LimbSide[] = ['left', 'right'];
  const proximalToDistal: LimbSegmentKind[] = [
    'thigh', 'shin', 'foot',
    'upperArm', 'forearm', 'hand',
  ];
  for (const side of sides) {
    for (const seg of proximalToDistal) {
      const state = victim.limbs[limbKey(seg, side)];
      if (state.detached) continue;
      const severed = rollExplosiveSeverance(state, seg, blastDamage);
      if (severed) {
        state.detached = true;
        for (const distal of distalSegments(seg)) {
          victim.limbs[limbKey(distal, side)].detached = true;
        }
        out.push({ segment: seg, side });
      }
    }
  }
  return out;
}

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
