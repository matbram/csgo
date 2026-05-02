/** Round-level state machine.
 *
 *    freeze   — players are frozen at spawn; buy menu open
 *    live     — players move and shoot
 *    end      — round resolved; brief delay before next
 *
 *  The bomb has its own FSM that runs alongside `live`. When the bomb is
 *  planted the live timer is hidden in favor of the bomb timer, but our
 *  state stays in `live` (no separate `planted` round phase needed).
 *
 *  Win conditions checked once per sim tick during `live`:
 *    1. Round time expired AND bomb not planted → CT win (time)
 *    2. Bomb defused → CT win
 *    3. Bomb exploded → T win
 *    4. All Ts dead AND bomb not planted → CT win (eliminate)
 *    5. All CTs dead → T win (eliminate)
 *    6. All Ts dead AND bomb planted → no win yet, bomb still ticks
 */

import type { World } from '../map/world';
import type { Character } from '../entities/character';
import { rollSegmentSeverance } from '../entities/character';
import { events } from '../engine/events';
import { time } from '../engine/time';
import type { Side, RoundReason, RoundOutcome } from './economy';
import {
  type BombState, makeBombState, stepBomb,
  type PlanterIntent, type DefuserIntent,
  BOMB_DAMAGE_RADIUS_M, BOMB_MAX_DAMAGE,
} from './bomb';

export type RoundPhase = 'freeze' | 'live' | 'end';

// Per-round freeze before the live phase begins. The bots are pinned at
// spawn for this duration so the strategist's plan and buy logic can land
// before anyone moves. Kept short (~6 s) so it's obvious the round has
// started and teammates are heading out — long freezes felt like the bots
// were stuck.
export const FREEZE_TIME_MS = 6_000;
export const ROUND_TIME_MS = 115_000;       // 1:55
export const ROUND_END_DELAY_MS = 5000;
export const BUY_TIME_AFTER_FREEZE_MS = 20_000; // first 20s of live still allow buying

export interface RoundState {
  number: number;        // 1..30
  phase: RoundPhase;
  /** Sim ms when the current phase ends. */
  phaseEndMs: number;
  bomb: BombState | null;
  bombEverPlanted: boolean;
  /** True once explosion damage has been applied (so we don't reapply). */
  bombDamageApplied: boolean;
  outcome: RoundOutcome | null;
  /** Sim ms when buy phase ends (freeze + 20s). */
  buyEndMs: number;
  /** Sim ms when freeze ends, used to expose buy gating. */
  freezeEndMs: number;
}

export function makeRound(number: number, nowMs: number, bombCarrierId: string | null): RoundState {
  return {
    number,
    phase: 'freeze',
    phaseEndMs: nowMs + FREEZE_TIME_MS,
    bomb: bombCarrierId ? makeBombState(bombCarrierId) : null,
    bombEverPlanted: false,
    bombDamageApplied: false,
    outcome: null,
    buyEndMs: nowMs + FREEZE_TIME_MS + BUY_TIME_AFTER_FREEZE_MS,
    freezeEndMs: nowMs + FREEZE_TIME_MS,
  };
}

export function isBuyPhase(round: RoundState | null, nowMs: number): boolean {
  if (!round) return false;
  return round.phase === 'freeze' || (round.phase === 'live' && nowMs < round.buyEndMs);
}

export function isMovementLocked(round: RoundState | null): boolean {
  // No active round → match has ended (or has yet to begin). Lock movement
  // so the local player can't sprint around between matches.
  if (!round) return true;
  return round.phase === 'freeze' || round.phase === 'end';
}

export interface StepInputs {
  world: World;
  characters: Character[];
  /** Per-character intent for the current tick. */
  planter: PlanterIntent | null;
  defusers: DefuserIntent[];
  nowMs: number;
  dtMs: number;
}

/** One sim step. Returns the new round state. Mutates `bomb` in-place
 *  via assignment, but does not mutate inputs. */
export function stepRound(round: RoundState, inputs: StepInputs): RoundState {
  const { nowMs, dtMs, world, characters, planter, defusers } = inputs;
  const next: RoundState = { ...round, bomb: round.bomb };

  // Phase transition by time.
  if (next.phase === 'freeze' && nowMs >= next.phaseEndMs) {
    next.phase = 'live';
    next.phaseEndMs = nowMs + ROUND_TIME_MS;
  }

  // Step bomb (only meaningful in live).
  if (next.bomb && next.phase === 'live') {
    next.bomb = stepBomb(next.bomb, dtMs, nowMs, world, planter, defusers);
    if (next.bomb.phase === 'planted' && !next.bombEverPlanted) {
      next.bombEverPlanted = true;
    }
  }

  // While bomb is carried, mirror its position to the carrier's pos.
  if (next.bomb && (next.bomb.phase === 'carried' || next.bomb.phase === 'planting')) {
    const carrier = characters.find(c => c.id === next.bomb!.carrierId && c.alive);
    if (carrier) {
      next.bomb = {
        ...next.bomb,
        pos: { x: carrier.pos.x, y: carrier.pos.y, z: carrier.pos.z },
      };
    } else if (next.bomb.phase === 'carried' && next.bomb.carrierId !== null) {
      // Carrier died with the bomb. Drop it at their last position (best effort:
      // we keep the previous pos until match logic reassigns the carrier).
      next.bomb = { ...next.bomb, carrierId: null };
    }
  }

  // Win conditions during live.
  if (next.phase === 'live' && !next.outcome) {
    const tsAlive = countAlive(characters, 'T');
    const ctsAlive = countAlive(characters, 'CT');
    const bombPhase = next.bomb?.phase ?? null;

    if (bombPhase === 'finished' && next.bomb?.outcome === 'exploded') {
      next.outcome = makeOutcome('T', 't_explode', next.bombEverPlanted);
    } else if (bombPhase === 'finished' && next.bomb?.outcome === 'defused') {
      next.outcome = makeOutcome('CT', 'ct_defuse', next.bombEverPlanted);
    } else if (ctsAlive === 0) {
      next.outcome = makeOutcome('T', 't_eliminate', next.bombEverPlanted);
    } else if (tsAlive === 0 && bombPhase !== 'planted' && bombPhase !== 'defusing') {
      next.outcome = makeOutcome('CT', 'ct_eliminate', next.bombEverPlanted);
    } else if (nowMs >= next.phaseEndMs && bombPhase !== 'planted' && bombPhase !== 'defusing') {
      next.outcome = makeOutcome('CT', 'ct_time', next.bombEverPlanted);
    }

    if (next.outcome) {
      next.phase = 'end';
      next.phaseEndMs = nowMs + ROUND_END_DELAY_MS;
    }
  }

  return next;
}

function makeOutcome(winner: Side, reason: RoundReason, bombPlanted: boolean): RoundOutcome {
  return { winner, reason, bombPlanted };
}

function countAlive(chars: Character[], side: Side): number {
  let n = 0;
  for (const c of chars) if (c.team === side && c.alive) n++;
  return n;
}

/** Apply bomb-explosion damage to nearby characters. Should be called
 *  exactly once when the bomb transitions to 'finished:exploded'.
 *  Beyond raw HP damage we run per-segment explosive severance — at
 *  the bomb's max damage (500 hp at centre) every limb on a victim
 *  near the blast pops off, reading as a body torn apart by the
 *  explosion. Visuals subscribe to combat:hit and handle the gibs. */
export function applyBombExplosionDamage(
  bombPos: { x: number; y: number; z: number },
  chars: Character[],
): void {
  for (const c of chars) {
    if (!c.alive) continue;
    const dx = c.pos.x - bombPos.x;
    const dy = (c.pos.y + c.currentEye * 0.5) - bombPos.y;
    const dz = c.pos.z - bombPos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > BOMB_DAMAGE_RADIUS_M) continue;
    const t = 1 - dist / BOMB_DAMAGE_RADIUS_M;
    const damage = BOMB_MAX_DAMAGE * t * t;
    const takeFromArmor = Math.min(c.armor, Math.floor(damage * 0.5));
    const hpDamage = Math.max(0, Math.floor(damage * (c.armor > 0 ? 0.5 : 1)));
    c.armor = Math.max(0, c.armor - takeFromArmor);
    c.hp = Math.max(0, c.hp - hpDamage);
    const killing = c.hp <= 0;
    if (killing) c.alive = false;

    // Per-segment severance from the blast. Use raw blast damage (not
    // hpDamage) — armour doesn't really protect a limb from a bomb
    // going off next to it, and the explosive thresholds are tuned
    // against pre-armour intensity.
    const limbsDetached = rollSegmentSeverance(c, damage);

    const inv = dist > 1e-3 ? 1 / dist : 0;
    events.emit('combat:hit', {
      attackerId: 'bomb', victimId: c.id, weapon: 'c4',
      hitbox: 'chest', segment: 'chest', side: null,
      damage: hpDamage, headshot: false, killing,
      corpseHit: false,
      limbsDetached,
      hitX: bombPos.x, hitY: bombPos.y, hitZ: bombPos.z,
      victimFootY: c.pos.y,
      dirX: dx * inv, dirY: dy * inv, dirZ: dz * inv,
      distance: dist, tMs: time.simMs,
    });
    if (killing) {
      events.emit('combat:kill', {
        attackerId: 'bomb', victimId: c.id, weapon: 'c4',
        headshot: false, tMs: time.simMs,
      });
    }
  }
}
