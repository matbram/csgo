/** Diagnostics surface — exposed on `window.__game` for the user to
 *  capture and share AI logs. Lives in src/ai/ so the imports stay
 *  AI-local; the main bootstrap glues it onto `__game`.
 *
 *  Two ergonomic helpers:
 *
 *    __game.captureRound()
 *      Bundle every debug channel buffer + match snapshot + bot
 *      identities + last 30 callouts + perf counters + seed into one
 *      JSON, and trigger a download as `csgo-round-<seed>.json`.
 *      Drag the file into a chat to share with the developer.
 *
 *    __game.perf
 *      Rolling counters for AI hot paths (planner, reactive, comms).
 *      `console.log(__game.perf)` shows mean / max / count since the
 *      last reset.
 *
 *  And a URL flag — `?diag=1` — auto-enables every debug channel at
 *  boot so the user doesn't have to remember the console incantations
 *  before playing the round they want to capture. */

import type { Bot } from '../entities/bot';
import type { MatchState } from '../match/match';
import type { TeamBlackboard } from './blackboard';
import { debugLog } from '../engine/debugLog';
import { getMatchSeed } from './rng';
import { getPlannerPerf } from './brain';

export interface CaptureInputs {
  bots: ReadonlyArray<Bot>;
  match: MatchState;
  tBoard: TeamBlackboard;
  ctBoard: TeamBlackboard;
}

export interface RoundCapture {
  capturedAt: string;
  seed: number;
  match: {
    phase: string;
    roundNumber: number;
    scoreT: number;
    scoreCT: number;
    roundPhase: string | null;
  };
  bots: Array<{
    id: string;
    name: string;
    archetype: string;
    side: 'T' | 'CT';
    alive: boolean;
    hp: number;
    armor: number;
    helmet: boolean;
    usePlanner: boolean;
    commsLatencyMs: number;
    personality: Record<string, number>;
    role: string | null;
    objectiveCallout: string | null;
    brainState: string;
    currentGoal: string | null;
    currentAction: string | null;
    plannedActions: string[];
    knownEnemyCount: number;
  }>;
  comms: {
    T: Array<Record<string, unknown>>;
    CT: Array<Record<string, unknown>>;
  };
  perf: {
    planner: { calls: number; meanMs: number; maxMs: number };
  };
  channels: Record<string, string>;
}

export function buildCapture(input: CaptureInputs): RoundCapture {
  const { bots, match, tBoard, ctBoard } = input;
  const dumpComms = (bb: TeamBlackboard) => bb.comms.log.slice(0, 30).map(c => ({
    id: c.id, kind: c.kind, side: c.side, emitterId: c.emitterId,
    tEmitMs: c.tEmitMs, where: c.where ?? null, site: c.site,
    enemyId: c.enemyId, count: c.count, nade: c.nade,
  }));
  const botRows = bots.map(b => {
    const c = b.character;
    const board = c.team === 'T' ? tBoard : ctBoard;
    const obj = board.objectiveByBot.get(b.id);
    const planned = b.brain.plannedActions ?? [];
    const idx = b.brain.plannedActionIdx;
    return {
      id: b.id,
      name: b.identity.name,
      archetype: b.identity.archetype,
      side: c.team,
      alive: c.alive,
      hp: c.hp,
      armor: c.armor,
      helmet: c.helmet,
      usePlanner: b.usePlanner,
      commsLatencyMs: Number(b.commsLatencyMs.toFixed(0)),
      personality: { ...b.identity.personality },
      role: board.roleByBot.get(b.id) ?? null,
      objectiveCallout: obj?.callout ?? null,
      brainState: b.brain.state,
      currentGoal: b.brain.currentGoal?.kind ?? null,
      currentAction: planned[idx]?.label ?? null,
      plannedActions: planned.slice(idx, idx + 4).map(a => a.label),
      knownEnemyCount: b.perception.known.size,
    };
  });
  return {
    capturedAt: new Date().toISOString(),
    seed: getMatchSeed(),
    match: {
      phase: match.phase,
      roundNumber: match.roundNumber,
      scoreT: match.scoreT,
      scoreCT: match.scoreCT,
      roundPhase: match.round?.phase ?? null,
    },
    bots: botRows,
    comms: {
      T: dumpComms(tBoard),
      CT: dumpComms(ctBoard),
    },
    perf: {
      planner: getPlannerPerf(),
    },
    channels: debugLog.snapshotAll(),
  };
}

/** Trigger a browser file download for the capture JSON. Falls back
 *  to logging to the console if the DOM is unavailable (tests, SSR). */
export function downloadCapture(input: CaptureInputs): void {
  const cap = buildCapture(input);
  const json = JSON.stringify(cap, null, 2);
  if (typeof document === 'undefined') {
    // eslint-disable-next-line no-console
    console.log('[diagnostics] capture (no document):\n' + json);
    return;
  }
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `csgo-round-${cap.seed}-r${cap.match.roundNumber}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  // eslint-disable-next-line no-console
  console.log(`[diagnostics] downloaded capture (seed=${cap.seed} round=${cap.match.roundNumber})`);
}
