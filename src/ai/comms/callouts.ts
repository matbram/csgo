/** Synthesised player-style callouts. The comms layer is what makes a
 *  team of bots feel like a team rather than five isolated decision
 *  loops:
 *    - One bot spots an enemy → emits `spottedEnemy` with the callout id.
 *    - Teammates see the callout in the HUD feed after their personal
 *      `commsLatencyMs` (lower difficulty = sloppier comms).
 *    - Bots can read recent callouts from the team blackboard to bias
 *      their own decisions (e.g. "I heard a teammate just died on B,
 *      maybe I should rotate").
 *
 *  Storage model: the blackboard owns a per-team `commsLog` ring. Each
 *  Callout carries `tEmitMs`. Receivers compute their delivery time
 *  on read (`tEmitMs + bot.commsLatencyMs`); we deliberately do NOT
 *  precompute per-receiver delivery maps, because:
 *    1. A bot's commsLatencyMs may shift mid-round (e.g. flashed → +500
 *       ms) and we want that to take effect on already-queued callouts.
 *    2. The local player can read the feed too, with zero latency.
 *
 *  Cooldowns prevent spam: each bot has a per-callout-type cooldown
 *  before it can emit the same kind again. A global per-team rate cap
 *  prevents pathological situations (10-bot fights spamming the feed).
 *  Phase 4 will tune the cooldown by personality.teamwork.
 *
 *  Determinism: emission decisions never call Math.random(); when we add
 *  jitter (Phase 4), it'll go through the per-bot SeededRng. */

import type { CalloutId } from '../../map/types';
import type { TeamBlackboard } from '../blackboard';
import { recordEvent } from '../blackboard';

/** All callout kinds bots can emit. A small, curated set — adding more
 *  is one line here plus a phrase in `formatCallout`. */
export type CalloutKind =
  | 'spottedEnemy'    // "two A long" — a bot saw enemies
  | 'enemyDown'       // "one down B" — teammate killed an enemy
  | 'oneLeft'         // "last one A" — only one enemy remains
  | 'lowHp'           // "I'm low" — bot took heavy damage
  | 'needBackup'      // "need help A" — outnumbered or pinned
  | 'tradeMe'         // "trade me, A long" — emitted on death
  | 'flashed'         // "I'm flashed" — emitted when blinded
  | 'reloading'       // "reloading" — emitted on out-of-combat reload
  | 'bombHeard'       // "they're planting" — heard plant noise
  | 'bombPlantedCall' // "planted A" — synthesised plant comms
  | 'pushing'         // "pushing A" — about to engage forward
  | 'holdingAngle'    // "holding A long"
  | 'siteClear'       // "B clear"
  | 'lurkSpotted'     // "lurker mid"
  | 'nadeIncoming'    // "smoke A long" — saw incoming utility
  | 'rotateRequest';  // "rotate A"

export interface Callout {
  /** Stable id for HUD diffing and dedupe. */
  id: number;
  kind: CalloutKind;
  /** Bot that emitted. Local player uses 'local'. */
  emitterId: string;
  /** Side the callout is shared with — only same-side teammates hear it. */
  side: 'T' | 'CT';
  /** Sim ms the callout was emitted. Receivers add their commsLatencyMs
   *  to compute when it becomes actionable. */
  tEmitMs: number;
  /** Optional referenced callout id (the *map* callout, not the team).
   *  Most kinds carry one (the location being called); a few like
   *  `lowHp` and `reloading` don't. */
  where?: CalloutId | null;
  /** Optional bombsite for plant / clear / rotate kinds. */
  site?: 'A' | 'B';
  /** Optional enemy id payload (`tradeMe`, `lurkSpotted`). */
  enemyId?: string;
  /** Optional count payload (`spottedEnemy: 2`). */
  count?: number;
  /** Optional grenade kind for `nadeIncoming`. */
  nade?: 'he' | 'flashbang' | 'smoke' | 'molotov';
  /** Position in world space, for spatialised audio cue + HUD ping. */
  pos: { x: number; y: number; z: number };
}

/** How many callouts to keep per team. Older entries are evicted. */
export const CALLOUT_LOG_SIZE = 16;
/** Per-bot, per-kind emit cooldown. A bot won't spam the same callout. */
const COOLDOWN_BY_KIND: Record<CalloutKind, number> = {
  spottedEnemy:    2_000,
  enemyDown:       3_000,
  oneLeft:         5_000,
  lowHp:           8_000,
  needBackup:      6_000,
  tradeMe:         8_000,    // bots only emit this on death; cooldown is moot
  flashed:         3_000,
  reloading:       3_000,
  bombHeard:       6_000,
  bombPlantedCall: 9_999_999, // exactly once per round per team
  pushing:         4_000,
  holdingAngle:    8_000,
  siteClear:       6_000,
  lurkSpotted:     4_000,
  nadeIncoming:    2_500,
  rotateRequest:   6_000,
};
/** Hard floor on team-wide emissions per second to prevent feed spam. */
const TEAM_RATE_WINDOW_MS = 1_000;
const TEAM_RATE_MAX = 5;

let nextCalloutId = 1;

/** Per-team comms state — held on the blackboard. Phase 2 keeps this
 *  small; future phases will add per-bot priority weights and grouped
 *  callout-fusion (e.g. "two more A long" updating an existing entry). */
export interface CommsState {
  log: Callout[];
  /** Per-bot per-kind last-emit time. */
  cooldowns: Map<string, Map<CalloutKind, number>>;
  /** Rolling window of recent emit times for the team rate cap. */
  recentEmitsMs: number[];
  /** Per-round dedupe for `bombPlantedCall`. */
  bombPlantedCalled: boolean;
}

export function makeCommsState(): CommsState {
  return {
    log: [],
    cooldowns: new Map(),
    recentEmitsMs: [],
    bombPlantedCalled: false,
  };
}

/** Reset per-round state (cooldowns + bomb dedupe + log). Called at
 *  freeze→live transition. The log itself doesn't need clearing — old
 *  entries fall out via `CALLOUT_LOG_SIZE` — but a hard reset keeps the
 *  HUD clean between rounds. */
export function resetComms(state: CommsState): void {
  state.log.length = 0;
  state.cooldowns.clear();
  state.recentEmitsMs.length = 0;
  state.bombPlantedCalled = false;
}

export interface EmitInputs {
  state: CommsState;
  /** Team blackboard the callout lives on. We also push a TeamEvent for
   *  bots that read team events directly. */
  bb: TeamBlackboard;
  emitterId: string;
  side: 'T' | 'CT';
  kind: CalloutKind;
  nowMs: number;
  pos: { x: number; y: number; z: number };
  where?: CalloutId | null;
  site?: 'A' | 'B';
  enemyId?: string;
  count?: number;
  nade?: Callout['nade'];
}

/** Try to emit a callout. Returns the Callout if it landed, or null
 *  when filtered (cooldown, rate cap, dedupe). The callsite uses the
 *  return value to decide whether to play the audio cue. */
export function tryEmit(input: EmitInputs): Callout | null {
  const { state, bb, emitterId, side, kind, nowMs, pos } = input;

  // Per-bot per-kind cooldown.
  let perKind = state.cooldowns.get(emitterId);
  if (!perKind) {
    perKind = new Map();
    state.cooldowns.set(emitterId, perKind);
  }
  const lastEmit = perKind.get(kind);
  if (lastEmit !== undefined && nowMs - lastEmit < COOLDOWN_BY_KIND[kind]) {
    return null;
  }

  // bombPlantedCall is once per round per team.
  if (kind === 'bombPlantedCall') {
    if (state.bombPlantedCalled) return null;
    state.bombPlantedCalled = true;
  }

  // Team rate cap — drop the oldest entries that fell out of the window
  // first, then enforce.
  const cutoff = nowMs - TEAM_RATE_WINDOW_MS;
  while (state.recentEmitsMs.length > 0 && state.recentEmitsMs[0]! < cutoff) {
    state.recentEmitsMs.shift();
  }
  if (state.recentEmitsMs.length >= TEAM_RATE_MAX) {
    return null;
  }

  // Build + record.
  const c: Callout = {
    id: nextCalloutId++,
    kind,
    emitterId,
    side,
    tEmitMs: nowMs,
    where: input.where ?? null,
    site: input.site,
    enemyId: input.enemyId,
    count: input.count,
    nade: input.nade,
    pos: { x: pos.x, y: pos.y, z: pos.z },
  };
  state.log.unshift(c);
  if (state.log.length > CALLOUT_LOG_SIZE) state.log.length = CALLOUT_LOG_SIZE;
  perKind.set(kind, nowMs);
  state.recentEmitsMs.push(nowMs);

  // Mirror into team events so existing readers (debug log, future
  // strategist replan triggers) see it without subscribing to comms.
  recordEvent(bb, {
    type: 'enemySpotted',
    enemyId: input.enemyId ?? `__call_${kind}`,
    x: pos.x, z: pos.z,
    tMs: nowMs,
  });
  return c;
}

/** Whether `c` has been delivered to a receiver bot at sim ms `nowMs`,
 *  given the receiver's per-bot comms latency. The emitter receives
 *  their own callouts instantly. */
export function isDelivered(c: Callout, receiverId: string, receiverLatencyMs: number, nowMs: number): boolean {
  if (c.emitterId === receiverId) return true;
  return nowMs - c.tEmitMs >= receiverLatencyMs;
}

/** All callouts currently delivered to this receiver, newest first.
 *  Used by the brain's bias logic and by the HUD when filtered to a
 *  single bot's perspective. */
export function deliveredTo(state: CommsState, receiverId: string, receiverLatencyMs: number, nowMs: number): Callout[] {
  const out: Callout[] = [];
  for (const c of state.log) {
    if (isDelivered(c, receiverId, receiverLatencyMs, nowMs)) out.push(c);
  }
  return out;
}

/** Render a callout as a short human-readable string. Used by the HUD;
 *  also used by debug logs. */
export function formatCallout(c: Callout): string {
  const where = c.where ? ` ${formatCallout_where(c.where)}` : '';
  const site = c.site ? ` ${c.site}` : '';
  switch (c.kind) {
    case 'spottedEnemy': {
      const n = c.count ?? 1;
      const noun = n === 1 ? 'one' : n === 2 ? 'two' : `${n}`;
      return `${noun}${where || ' spotted'}`;
    }
    case 'enemyDown':       return `one down${where || site}`;
    case 'oneLeft':         return `last one${where || site}`;
    case 'lowHp':           return `I'm low`;
    case 'needBackup':      return `need help${where || site}`;
    case 'tradeMe':         return `trade me${where}`;
    case 'flashed':         return `I'm flashed`;
    case 'reloading':       return `reloading`;
    case 'bombHeard':       return `they're planting${where || site}`;
    case 'bombPlantedCall': return `bomb planted${site}`;
    case 'pushing':         return `pushing${where || site}`;
    case 'holdingAngle':    return `holding${where}`;
    case 'siteClear':       return `${c.site ?? (where.trim() || 'site')} clear`;
    case 'lurkSpotted':     return `lurker${where}`;
    case 'nadeIncoming':    return `${c.nade ?? 'nade'} incoming${where}`;
    case 'rotateRequest':   return `rotate${site || where}`;
  }
}

function formatCallout_where(c: CalloutId): string {
  // Callout ids are uppercase + underscores; humanise for the HUD.
  return c.toLowerCase().replace(/_/g, ' ');
}
