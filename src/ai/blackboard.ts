/** Per-team shared knowledge. The blackboard is the only piece of state
 *  bots can read from each other — Pass 2 perception was strictly
 *  per-bot, which produced a lot of "the bot doesn't seem to know what
 *  its teammate just saw" moments. With M5 the strategist owns this
 *  object and seeds bots' brain context every tick.
 *
 *  Reads are cheap (plain objects + Map lookups). Writes happen at
 *  perception ticks (aggregating each bot's KnownEnemies into the team
 *  map at degraded confidence) and on round-level events (death, plant). */

import type { Bot } from '../entities/bot';
import type { KnownEnemy } from './perception';
import type { Role, Side, StrategyId } from './plans';

export interface TeamObjective {
  /** World-space target (callout centroid by default). */
  x: number;
  z: number;
  /** Optional default facing yaw in radians. */
  facingYaw?: number;
  /** The callout id this objective resolves to (for debug + role tags). */
  callout: string;
  /** The role assignment behind this objective. */
  role: Role;
}

export type TeamEvent =
  | { type: 'death'; victimId: string; tMs: number }
  | { type: 'bombPlanted'; site: 'A' | 'B'; x: number; z: number; tMs: number }
  | { type: 'enemySpotted'; enemyId: string; x: number; z: number; tMs: number };

export interface BombInfo {
  /** Bomb FSM phase mirrored here so bots don't need a direct
   *  dependency on match/bomb. */
  phase: 'carried' | 'planting' | 'planted' | 'defusing' | 'finished';
  carrierId: string | null;
  site: 'A' | 'B' | null;
  pos: { x: number; y: number; z: number } | null;
}

const MAX_EVENTS = 32;
/** Aggregated KnownEnemy entries from bots get this confidence — strictly
 *  worse than first-hand 'visible' and 'recent' so the bot's own intel
 *  always wins for its own decisions. */
const REPORTED_CONFIDENCE: KnownEnemy['confidence'] = 'recent';

export interface TeamBlackboard {
  side: Side;
  /** Current strategy. The strategist sets this on round start and on
   *  bomb plant. */
  strategy: StrategyId;
  /** Per-bot role and objective. Filled by the strategist. */
  roleByBot: Map<string, Role>;
  objectiveByBot: Map<string, TeamObjective>;
  /** Aggregated enemy intel from teammates. Includes degraded versions
   *  of each bot's per-bot KnownEnemies, so a bot looking at this map
   *  sees what its team has spotted. */
  knownEnemies: Map<string, KnownEnemy>;
  /** Current bomb state, mirrored from the round each tick. */
  bomb: BombInfo;
  /** Sim ms when the current strategy was installed. */
  strategyInstalledAtMs: number;
  /** Recent team-level events. Newest first; capped at MAX_EVENTS. */
  events: TeamEvent[];
}

export function makeBlackboard(side: Side): TeamBlackboard {
  return {
    side,
    strategy: side === 'T' ? 't_default_a' : 'ct_default',
    roleByBot: new Map(),
    objectiveByBot: new Map(),
    knownEnemies: new Map(),
    bomb: { phase: 'carried', carrierId: null, site: null, pos: null },
    strategyInstalledAtMs: 0,
    events: [],
  };
}

/** Record a team-level event. Old entries past the cap are dropped. */
export function recordEvent(bb: TeamBlackboard, ev: TeamEvent): void {
  bb.events.unshift(ev);
  if (bb.events.length > MAX_EVENTS) bb.events.length = MAX_EVENTS;
}

/** Pull each bot's per-bot KnownEnemies into the team map at degraded
 *  confidence. Newer per-bot intel wins ties. Drop entries that nobody
 *  has seen recently (>3 s) so old ghosts don't drive decisions. */
export function aggregateKnown(bb: TeamBlackboard, bots: ReadonlyArray<Bot>, nowMs: number): void {
  const FORGET_MS = 3000;
  // Mark and sweep — gather first-hand intel from each bot, then drop
  // entries the team hasn't refreshed.
  const seen = new Set<string>();
  for (const bot of bots) {
    if (!bot.character.alive) continue;
    if (bot.character.team !== bb.side) continue;
    for (const e of bot.perception.known.values()) {
      if (nowMs - e.lastSeenMs > FORGET_MS) continue;
      seen.add(e.id);
      const existing = bb.knownEnemies.get(e.id);
      // Promote to 'visible' only when the team genuinely has eyes on
      // the enemy right now — otherwise everything aggregates as
      // 'reported' (we map this to 'recent' so the brain still treats
      // it as actionable but won't fire blind).
      const incomingConf = e.confidence === 'visible' ? 'visible' : REPORTED_CONFIDENCE;
      if (!existing || e.lastSeenMs > existing.lastSeenMs) {
        bb.knownEnemies.set(e.id, {
          id: e.id, x: e.x, y: e.y, z: e.z,
          lastSeenMs: e.lastSeenMs,
          confidence: incomingConf,
        });
      }
    }
  }
  for (const [id, entry] of bb.knownEnemies) {
    if (!seen.has(id) && nowMs - entry.lastSeenMs > FORGET_MS) {
      bb.knownEnemies.delete(id);
    }
  }
}

/** Refresh the alive/dead lists + bomb mirror in one call. */
export function refreshTeamRoster(
  bb: TeamBlackboard,
  bots: ReadonlyArray<Bot>,
  bomb: BombInfo,
): void {
  bb.bomb = bomb;
  // Reduce stale role entries — drop assignments for ids that no longer
  // exist on this team. Dead bots keep their role so the debug HUD can
  // show "what they were doing".
  for (const id of [...bb.roleByBot.keys()]) {
    const stillOnTeam = bots.some(b => b.id === id && b.character.team === bb.side);
    if (!stillOnTeam) bb.roleByBot.delete(id);
  }
}

/** How many bots on this team are alive right now. */
export function aliveCount(bb: TeamBlackboard, bots: ReadonlyArray<Bot>): number {
  let n = 0;
  for (const b of bots) if (b.character.team === bb.side && b.character.alive) n++;
  return n;
}
