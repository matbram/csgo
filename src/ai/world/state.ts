/** WorldStateView — an immutable, per-tick projection of everything the
 *  AI layers (reactive, planner, squad, strategist) need to read. Built
 *  once per AI tick from live entities + blackboards and handed by
 *  reference to all consumers.
 *
 *  Phase 0 (this file) is the bare-bones scaffold: it carries the same
 *  data the legacy `BrainContext` already exposes, plus per-bot fields
 *  that future GOAP phases will populate (goal stack, current action,
 *  threat level). Today the brain doesn't read it for decisions — only
 *  the debug HUD does. Phase 3 cuts the planner over to reading from
 *  here directly.
 *
 *  Why a separate module instead of growing `BrainContext`:
 *    1. The view is shared across teams and bots; `BrainContext` was
 *       per-bot. Building it once amortises the iteration costs.
 *    2. The future planner needs an immutable snapshot it can simulate
 *       forward through action effects. Holding a single typed object
 *       lets us swap to a copy-on-write overlay later without touching
 *       brain consumers.
 *    3. The debug HUD wants the same data the planner sees, not a
 *       parallel projection. */

import type { Bot } from '../../entities/bot';
import type { TeamBlackboard, BombInfo } from '../blackboard';
import type { Role, Side, StrategyId } from '../plans';

export interface TeamView {
  side: Side;
  strategy: StrategyId;
  /** Bot ids alive on this team. Excludes the local player. */
  aliveIds: ReadonlyArray<string>;
  /** Bot ids dead on this team this round. */
  deadIds: ReadonlyArray<string>;
  /** Total alive count including the local player when on this side. */
  aliveCount: number;
  /** Total enemy alive count from this team's perspective. */
  enemiesAlive: number;
  /** Aggregated team-known enemy count (from blackboard). */
  knownEnemyCount: number;
}

export interface BotView {
  id: string;
  team: Side;
  pos: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  hp: number;
  armor: number;
  helmet: boolean;
  alive: boolean;
  flashedUntilMs: number;
  /** Strategist-assigned role; null until the first plan is applied. */
  role: Role | null;
  /** Strategist-assigned objective callout id; null when none. */
  objectiveCallout: string | null;
  /** Current legacy brain state (e.g. 'engage', 'movetoObj'). Phase 3
   *  replaces this with a richer plan/action view; today we surface the
   *  brain state so the debug HUD has parity with the existing panel. */
  brainState: string;
  /** Per-bot first-hand perception count this tick. */
  knownEnemyCount: number;
  /** True when this bot has any visible enemy in its perception this tick. */
  hasVisibleEnemy: boolean;

  // ---- GOAP-ready fields (populated by future phases; defaults today)
  /** Top of stack first. Empty in phase 0. */
  goalStack: ReadonlyArray<string>;
  /** Action currently being executed. null in phase 0. */
  currentAction: string | null;
  /** Up to N upcoming actions (by debug HUD convention, the next 3). */
  plannedActions: ReadonlyArray<string>;
  /** 0..1 estimate of how dangerous the bot's situation is right now.
   *  Phase 0 returns 0 (placeholder); the reactive layer will set this. */
  threatLevel: number;
}

export interface WorldStateView {
  /** Sim ms at which this view was built. */
  simMs: number;
  /** Sim ms when the round entered live phase. Mirrors the legacy
   *  `liveSinceMs` on BrainContext. */
  liveSinceMs: number;
  /** Mirror of round phase so AI code doesn't import match types. */
  phase: 'freeze' | 'live' | 'end';
  /** Current bomb state. */
  bomb: BombInfo;
  teams: { T: TeamView; CT: TeamView };
  bots: ReadonlyMap<string, BotView>;
}

export interface BuildViewInputs {
  simMs: number;
  liveSinceMs: number;
  phase: 'freeze' | 'live' | 'end';
  bomb: BombInfo;
  bots: ReadonlyArray<Bot>;
  tBoard: TeamBlackboard;
  ctBoard: TeamBlackboard;
  /** Local-player aliveness contribution per side (0 or 1) so team
   *  alive-counts match the legacy heuristic. */
  localAlive: { T: number; CT: number };
}

export function buildWorldStateView(input: BuildViewInputs): WorldStateView {
  const { simMs, liveSinceMs, phase, bomb, bots, tBoard, ctBoard, localAlive } = input;

  const tAliveIds: string[] = [];
  const tDeadIds: string[] = [];
  const ctAliveIds: string[] = [];
  const ctDeadIds: string[] = [];
  const botMap = new Map<string, BotView>();

  for (const bot of bots) {
    const c = bot.character;
    if (c.team === 'T') {
      (c.alive ? tAliveIds : tDeadIds).push(bot.id);
    } else {
      (c.alive ? ctAliveIds : ctDeadIds).push(bot.id);
    }
    const board = c.team === 'T' ? tBoard : ctBoard;
    const obj = board.objectiveByBot.get(bot.id);
    let visible = false;
    for (const e of bot.perception.known.values()) {
      if (e.confidence === 'visible') { visible = true; break; }
    }
    botMap.set(bot.id, {
      id: bot.id,
      team: c.team,
      pos: { x: c.pos.x, y: c.pos.y, z: c.pos.z },
      yaw: c.yaw,
      pitch: c.pitch,
      hp: c.hp,
      armor: c.armor,
      helmet: c.helmet,
      alive: c.alive,
      flashedUntilMs: c.flashedUntilMs ?? 0,
      role: board.roleByBot.get(bot.id) ?? null,
      objectiveCallout: obj?.callout ?? null,
      brainState: bot.brain.state,
      knownEnemyCount: bot.perception.known.size,
      hasVisibleEnemy: visible,
      goalStack: EMPTY,
      currentAction: null,
      plannedActions: EMPTY,
      threatLevel: 0,
    });
  }

  const tAliveCount = tAliveIds.length + localAlive.T;
  const ctAliveCount = ctAliveIds.length + localAlive.CT;

  const teams: WorldStateView['teams'] = {
    T: {
      side: 'T',
      strategy: tBoard.strategy,
      aliveIds: tAliveIds,
      deadIds: tDeadIds,
      aliveCount: tAliveCount,
      enemiesAlive: ctAliveCount,
      knownEnemyCount: tBoard.knownEnemies.size,
    },
    CT: {
      side: 'CT',
      strategy: ctBoard.strategy,
      aliveIds: ctAliveIds,
      deadIds: ctDeadIds,
      aliveCount: ctAliveCount,
      enemiesAlive: tAliveCount,
      knownEnemyCount: ctBoard.knownEnemies.size,
    },
  };

  return { simMs, liveSinceMs, phase, bomb, teams, bots: botMap };
}

const EMPTY: ReadonlyArray<string> = Object.freeze([]);
