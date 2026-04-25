/** Match-level state machine. Owns the round counter, score, side
 *  assignment per player, money state, and the active round.
 *
 *  Match flow:
 *    Round 1..15  → halftime → Round 16..30 → MatchEnd
 *
 *  Halftime: sides swap, money resets to STARTING_MONEY, loss streaks
 *  reset, and per-player kill/round flags reset.
 *
 *  Match ends when a side reaches 16 round wins. (Overtime is out of
 *  scope per the design doc.) */

import type { Character } from '../entities/character';
import type { World } from '../map/world';
import {
  applyRoundEnd, resetMoneyForHalftime,
  STARTING_MONEY, type LossStreaks, type PerPlayerMoney, type Side,
} from './economy';
import { makeRound, stepRound, type RoundState, type StepInputs, FREEZE_TIME_MS } from './round';
import { applyBombExplosionDamage } from './round';

export const ROUNDS_PER_HALF = 15;
export const ROUND_WINS_TO_END = 16;
export const HALFTIME_DURATION_MS = 8000;       // brief intermission

export type MatchPhase = 'pre' | 'round' | 'halftime' | 'matchEnd';

export interface MatchPlayerSlot {
  id: string;
  /** Initial side at match start; flips at halftime via `currentSide`. */
  startingSide: Side;
  /** Current side, after any halftime swap. */
  currentSide: Side;
  money: number;
  kills: number;
  deaths: number;
  assists: number;
  /** Round-scoped flags (reset each round at end). */
  planted: boolean;
  defused: boolean;
  killWeapons: import('../weapons/definitions').WeaponId[];
}

export interface MatchState {
  phase: MatchPhase;
  /** 1..30 once round is active. */
  roundNumber: number;
  /** Round wins per current-side assignment. T/CT here are the *active*
   *  sides at the time, not start-of-match sides. */
  scoreT: number;
  scoreCT: number;
  /** Loss streak per current side. */
  streaks: LossStreaks;
  players: Map<string, MatchPlayerSlot>;
  round: RoundState | null;
  /** When phase==='halftime' or 'matchEnd', this is when it ends. */
  phaseEndMs: number;
  matchWinner: Side | null;
}

export interface MatchInit {
  /** All player ids present at match start, with their starting side. */
  players: Array<{ id: string; side: Side }>;
}

export function makeMatch(init: MatchInit): MatchState {
  const players = new Map<string, MatchPlayerSlot>();
  for (const p of init.players) {
    players.set(p.id, {
      id: p.id,
      startingSide: p.side,
      currentSide: p.side,
      money: STARTING_MONEY,
      kills: 0, deaths: 0, assists: 0,
      planted: false, defused: false, killWeapons: [],
    });
  }
  return {
    phase: 'pre',
    roundNumber: 0,
    scoreT: 0,
    scoreCT: 0,
    streaks: { T: 0, CT: 0 },
    players,
    round: null,
    phaseEndMs: 0,
    matchWinner: null,
  };
}

/** Pick a T-side player to carry the bomb. Prefer the local player so the
 *  human can plant; otherwise the first T in the list. */
export function pickBombCarrier(match: MatchState, charactersAlive: Character[]): string | null {
  const tIds = [...match.players.values()]
    .filter(p => p.currentSide === 'T')
    .map(p => p.id);
  if (tIds.length === 0) return null;
  // Prefer 'local' if present and alive on T side.
  const localId = 'local';
  if (tIds.includes(localId)) {
    const c = charactersAlive.find(ch => ch.id === localId && ch.alive);
    if (c) return localId;
  }
  for (const id of tIds) {
    const c = charactersAlive.find(ch => ch.id === id && ch.alive);
    if (c) return id;
  }
  return tIds[0]!;
}

/** Begin the next round. Caller is responsible for resetting characters
 *  (HP, position, inventory) before calling. */
export function beginRound(match: MatchState, nowMs: number, characters: Character[]): MatchState {
  const next: MatchState = { ...match };
  next.phase = 'round';
  next.roundNumber += 1;
  const carrier = pickBombCarrier(next, characters);
  next.round = makeRound(next.roundNumber, nowMs, carrier);
  next.phaseEndMs = nowMs + FREEZE_TIME_MS;
  return next;
}

/** Apply a round-end. Computes economy rewards, updates score, decides
 *  next phase (halftime / next round / matchEnd). */
export function endRound(match: MatchState, nowMs: number): MatchState {
  if (!match.round || !match.round.outcome) return match;
  const outcome = match.round.outcome;

  // Score update for current-side bookkeeping.
  const next: MatchState = { ...match };
  if (outcome.winner === 'T') next.scoreT += 1;
  else next.scoreCT += 1;

  // Build per-player money snapshot for the economy module.
  const moneySnapshot: PerPlayerMoney[] = [];
  for (const p of next.players.values()) {
    moneySnapshot.push({
      id: p.id,
      side: p.currentSide,
      money: p.money,
      aliveAtEnd: characterAlive(p.id, /* injected later */ []) /* unused; see note below */,
      planted: p.planted,
      defused: p.defused,
      killWeapons: p.killWeapons,
    });
  }
  // Note: aliveAtEnd is currently informational; current economy formulas
  // don't read it but the field is kept for forward compatibility.

  const result = applyRoundEnd(moneySnapshot, next.streaks, outcome);
  next.streaks = result.newStreaks;
  for (const p of result.players) {
    const slot = next.players.get(p.id);
    if (!slot) continue;
    slot.money = p.money;
    slot.planted = false;
    slot.defused = false;
    slot.killWeapons = [];
  }

  // Halftime check (after round 15).
  if (next.roundNumber === ROUNDS_PER_HALF) {
    next.phase = 'halftime';
    next.phaseEndMs = nowMs + HALFTIME_DURATION_MS;
    return next;
  }

  // Match end check (first to ROUND_WINS_TO_END).
  if (next.scoreT >= ROUND_WINS_TO_END || next.scoreCT >= ROUND_WINS_TO_END) {
    next.phase = 'matchEnd';
    next.matchWinner = next.scoreT >= ROUND_WINS_TO_END ? 'T' : 'CT';
    next.round = null;
    return next;
  }

  // Otherwise, sit in 'round' phase with `round.phase==='end'` until the
  // round-end delay expires; the caller calls beginRound() afterward.
  return next;
}

/** Apply the halftime side swap and money reset. Caller should also reset
 *  inventories to default and respawn everyone. */
export function applyHalftime(match: MatchState): MatchState {
  const next: MatchState = { ...match };
  for (const p of next.players.values()) {
    p.currentSide = p.currentSide === 'T' ? 'CT' : 'T';
    p.planted = false;
    p.defused = false;
    p.killWeapons = [];
  }
  // Reset money via economy helper for consistency.
  const snapshot: PerPlayerMoney[] = [...next.players.values()].map((p) => ({
    id: p.id, side: p.currentSide, money: p.money,
    aliveAtEnd: false, planted: false, defused: false, killWeapons: [],
  }));
  const reset = resetMoneyForHalftime(snapshot);
  for (const r of reset) {
    const s = next.players.get(r.id);
    if (s) s.money = r.money;
  }
  // Swap score so the HUD always shows winner-first per current side.
  // (We keep T/CT bookkeeping in current sides; total score remains valid.)
  const tmp = next.scoreT;
  next.scoreT = next.scoreCT;
  next.scoreCT = tmp;
  next.streaks = { T: 0, CT: 0 };
  next.round = null;
  return next;
}

export interface MatchStepInputs extends StepInputs {}

/** Drive the match forward by one sim tick. Returns the new state. */
export function stepMatch(match: MatchState, inputs: MatchStepInputs): MatchState {
  const next: MatchState = { ...match };
  if (next.phase === 'round' && next.round) {
    next.round = stepRound(next.round, inputs);

    // Apply bomb explosion damage exactly once on the tick the bomb finishes.
    if (
      next.round.bomb &&
      next.round.bomb.outcome === 'exploded' &&
      next.round.bomb.pos &&
      !next.round.bombDamageApplied
    ) {
      applyBombExplosionDamage(next.round.bomb.pos, inputs.characters);
      next.round = { ...next.round, bombDamageApplied: true };
    }
  }
  return next;
}

function characterAlive(_id: string, _characters: Character[]): boolean {
  // Stub — see endRound note. Returns false to keep type honest; not used.
  return false;
}
