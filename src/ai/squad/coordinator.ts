/** Squad coordinator — phase 5 v1.
 *
 *  The strategist (`src/ai/strategist.ts`) picks one plan per side per
 *  round at freeze→live and on bomb plant. That covers ~80% of the
 *  good behaviour but leaves a noticeable gap mid-round:
 *
 *    - When a teammate dies the surviving bots keep their old slot
 *      assignments. If the entry dies first, the support sits on a
 *      "wait at long" objective forever; nobody fills the entry role.
 *    - When a bot calls `siteClear`, the team carries on with its
 *      original plan — no rotation, no opportunism.
 *
 *  Phase 5 v1 fixes those two with the smallest possible coordinator:
 *
 *    on combat:kill (teammate)  → reapplyCurrentStrategy with surviving
 *                                  bots, slots 0..N-1 fill from the
 *                                  most-important roles.
 *    on siteClear callout        → redirect one alive teammate whose
 *                                  objective is on the cleared site
 *                                  toward the OTHER bombsite (rotate
 *                                  to where the action is).
 *
 *  Future v2 additions: pre-execute sync barriers (entries wait for
 *  smoker), HTN compound-task decomposition, replan on
 *  utilityConsumed-unexpectedly events. */

import type { Bot } from '../../entities/bot';
import type { TeamBlackboard } from '../blackboard';
import type { World } from '../../map/world';
import type { NavGrid } from '../../nav/grid';
import { events } from '../../engine/events';
import { reapplyCurrentStrategy } from '../strategist';
import type { Callout } from '../comms/callouts';
import { setBotObjective } from '../../entities/bot';
import { polygonCentroid } from '../../map/world';
import { debugLog } from '../../engine/debugLog';

export interface CoordinatorContext {
  botById: Map<string, Bot>;
  bots: () => ReadonlyArray<Bot>;
  tBoard: TeamBlackboard;
  ctBoard: TeamBlackboard;
  world: World;
  navGrid: NavGrid;
  /** Current sim ms — provided by the host loop because the event bus
   *  emits async to the AI tick. */
  simMs: () => number;
}

let installed = false;
let ctxRef: CoordinatorContext | null = null;
/** Track the last comms.log entry id we processed per board so we
 *  don't re-react to the same callout each frame. */
let lastSeenCalloutId = { T: 0, CT: 0 };

export function installSquadCoordinator(ctx: CoordinatorContext): void {
  ctxRef = ctx;
  if (installed) return;
  installed = true;

  events.on('combat:kill', ({ victimId, tMs }) => {
    const ctx = ctxRef;
    if (!ctx) return;
    const victim = ctx.botById.get(victimId);
    if (!victim) return;
    const board = victim.character.team === 'T' ? ctx.tBoard : ctx.ctBoard;
    const aliveCount = ctx.bots().filter(b => b.character.team === board.side && b.character.alive).length;
    // Skip refit when there's nobody (or only one) left to coordinate.
    // From a captureRound: T side dying out produced four refits in
    // 10 s including with 1 → 0 survivors, churning the blackboard
    // for no benefit.
    if (aliveCount <= 1) {
      if (debugLog.isEnabled('squad')) {
        debugLog.squad('refit-skip', {
          t: tMs, side: board.side,
          deceased: victim.id, deceasedName: victim.identity.name,
          survivorsLeft: aliveCount,
          reason: 'too-few-alive',
        });
      }
      return;
    }
    reapplyCurrentStrategy(board, ctx.bots(), ctx.world, ctx.navGrid, ctx.simMs());
    if (debugLog.isEnabled('squad')) {
      debugLog.squad('refit', {
        t: tMs,
        side: board.side,
        deceased: victim.id,
        deceasedName: victim.identity.name,
        survivorsLeft: aliveCount,
        strategy: board.strategy,
      });
    }
  });
}

/** Per-tick poll of the comms log for callouts the coordinator should
 *  react to. Cheap (length-bounded log; we only inspect entries we
 *  haven't seen yet). Called from main.ts after `tickComms`. */
export function tickSquadCoordinator(): void {
  const ctx = ctxRef;
  if (!ctx) return;
  for (const board of [ctx.tBoard, ctx.ctBoard] as const) {
    const log = board.comms.log;
    // Comms log is newest-first; walk from newest until we hit a
    // callout we've already processed.
    for (const c of log) {
      if (c.id <= lastSeenCalloutId[board.side]) break;
      handleCallout(c, board, ctx);
    }
    if (log.length > 0) lastSeenCalloutId[board.side] = log[0]!.id;
  }
}

function handleCallout(c: Callout, bb: TeamBlackboard, ctx: CoordinatorContext): void {
  // siteClear → rotate one bot off the cleared site to the other
  // bombsite. We pick the bot whose current objective is on the
  // cleared site (so the rotation is visible). When no bot is on the
  // cleared site, the call is informational only — no action.
  if (c.kind === 'siteClear') {
    const cleared = c.site;
    if (!cleared) return;
    const otherSite: 'A' | 'B' = cleared === 'A' ? 'B' : 'A';
    const otherSiteRegion = ctx.world.bombSites.find(s => s.site === otherSite);
    if (!otherSiteRegion) return;
    const target = polygonCentroid(otherSiteRegion.polygon);
    const snapped = ctx.navGrid.nearestWalkable(target[0], target[1]);
    const tx = snapped ? ctx.navGrid.cellCenterWorld(snapped.i, snapped.j).x : target[0];
    const tz = snapped ? ctx.navGrid.cellCenterWorld(snapped.i, snapped.j).z : target[1];

    // Find one alive bot on this team whose objective callout sits on
    // the cleared site. We use a coarse string match against the
    // callout id — A_SITE / B_SITE / B_DOORS / etc.
    const clearedToken = cleared === 'A' ? 'A_' : 'B_';
    let pick: Bot | null = null;
    for (const bot of ctx.bots()) {
      if (bot.character.team !== bb.side || !bot.character.alive) continue;
      const obj = bb.objectiveByBot.get(bot.id);
      if (!obj) continue;
      if (obj.callout.startsWith(clearedToken) || obj.callout === (cleared === 'A' ? 'PIT' : 'BACK_PLAT')) {
        pick = bot;
        break;
      }
    }
    if (!pick) return;
    // Update the blackboard objective so the planner / legacy brain
    // both see the new target on the next decide tick.
    bb.objectiveByBot.set(pick.id, {
      x: tx, z: tz,
      callout: otherSite === 'A' ? 'A_SITE' : 'B_SITE',
      role: bb.roleByBot.get(pick.id) ?? 'ct_rotator',
    });
    setBotObjective(pick, tx, tz);
    if (debugLog.isEnabled('squad')) {
      debugLog.squad('rotate', {
        t: c.tEmitMs,
        side: bb.side,
        cleared,
        rotatedId: pick.id,
        rotatedName: pick.identity.name,
        toSite: otherSite,
        triggeredBy: c.emitterId,
      });
    }
  }
}

/** Test/teardown helper. */
export function _resetSquadCoordinator(): void {
  installed = false;
  ctxRef = null;
  lastSeenCalloutId = { T: 0, CT: 0 };
}
