/** Strategist — picks a plan, assigns roles, and writes objectives into
 *  the team blackboard. Event-driven, not per-tick: runs on round start
 *  and on bomb plant. Future M5+ extensions will trigger replans on
 *  significant deaths and on entry-frag confirmations.
 *
 *  The strategist deliberately does NOT touch bot brain state directly.
 *  It writes to `TeamBlackboard.strategy` / `roleByBot` / `objectiveByBot`
 *  and the bot brains read from there. This keeps the strategy a pure
 *  data transform and lets the debug HUD render exactly what the brain
 *  is consuming. */

import type { World } from '../map/world';
import { polygonCentroid } from '../map/world';
import type { Bot } from '../entities/bot';
import type { MatchPlayerSlot } from '../match/match';
import type { TeamBlackboard, BombInfo } from './blackboard';
import { recordEvent } from './blackboard';
import type { NavGrid } from '../nav/grid';
import { PLANS, plansForSide, type EcoTier, type PlanDef, type Side, type StrategyId } from './plans';
import { lineupsFor, type GrenadeLineup } from './grenadeLineups';

const FULL_BUY_PER_PLAYER = 4500;
const FORCE_BUY_PER_PLAYER = 2500;

/** Decide a plan for the team based on team mean money + a deterministic
 *  per-round dice roll. We always pick from the `normal` pool because
 *  the eco plans in the library deliberately stack bots near spawn, and
 *  the buy logic already enforces the "save your money" half of an eco
 *  round on its own. Picking an eco plan here would double-up — bots
 *  would have pistols AND huddle at spawn, which makes for the worst
 *  pistol round in history. The `EcoTier` argument is preserved on the
 *  signature so the picker can re-introduce eco plans later (e.g. when
 *  someone authors distributed eco plans that don't all stack on
 *  T_SPAWN). */
function pickPreplanPlan(
  side: Side,
  _ecoTier: EcoTier,
  roundNumber: number,
): PlanDef {
  const eligible = plansForSide(side).filter(p =>
    p.phase === 'pre_plant' && p.ecoTier === 'normal'
  );
  if (eligible.length === 0) {
    return plansForSide(side)[0]!;
  }
  const idx = lcgPick(roundNumber * 17 + (side === 'T' ? 5 : 11), eligible.length);
  return eligible[idx]!;
}

/** Pick a post-plant plan for the given site. T defends; CT retakes. */
function pickPostPlantPlan(side: Side, site: 'A' | 'B'): PlanDef {
  if (side === 'T') {
    return site === 'A' ? PLANS.t_post_plant_a : PLANS.t_post_plant_b;
  }
  return site === 'A' ? PLANS.ct_retake_a : PLANS.ct_retake_b;
}

/** Drop in a plan: write strategy, roles, and objectives into the
 *  blackboard. Bot order is preserved so role index stays stable across
 *  consecutive replans (avoids a bot that was the entry suddenly becoming
 *  the lurker mid-round).
 *
 *  Each slot's callout centroid is snapped to the nearest walkable cell
 *  on the nav grid so a callout with a tight or partially blocked
 *  centroid (PIT, MID_DOORS, B_TUNNELS_*) doesn't strand the assigned
 *  bot at spawn. If the snap fails entirely, we fall back to the
 *  bombsite centroid — never a polygon corner, which is often itself
 *  in a wall. */
function applyPlan(
  bb: TeamBlackboard,
  plan: PlanDef,
  bots: ReadonlyArray<Bot>,
  world: World,
  navGrid: NavGrid,
  nowMs: number,
): void {
  bb.strategy = plan.id;
  bb.strategyInstalledAtMs = nowMs;
  bb.roleByBot.clear();
  bb.objectiveByBot.clear();

  const teamBots = bots.filter(b => b.character.team === bb.side);
  // Stable ordering by id so plan slot N always lands on the same bot
  // for consistent role assignment across replans.
  teamBots.sort((a, b) => a.id.localeCompare(b.id));

  // Pre-compute a global fallback: bombsite A centroid. Bombsites are
  // large, flat polygons authored to be reachable, so they're a good
  // last-resort target when a callout simply can't be snapped.
  const fallback = world.bombSites[0]
    ? polygonCentroid(world.bombSites[0].polygon)
    : ([0, 0] as const);

  for (let i = 0; i < teamBots.length; i++) {
    const bot = teamBots[i]!;
    const slot = plan.slots[Math.min(i, plan.slots.length - 1)]!;
    const where = world.callouts.get(slot.callout)?.centroid;
    let x = where ? where[0] : fallback[0];
    let z = where ? where[1] : fallback[1];

    // Snap to walkable. If even the larger search fails, fall back to
    // the bombsite centroid — and snap THAT too, to be safe.
    const snapped = navGrid.nearestWalkable(x, z);
    if (snapped) {
      const c = navGrid.cellCenterWorld(snapped.i, snapped.j);
      x = c.x; z = c.z;
    } else {
      const fb = navGrid.nearestWalkable(fallback[0], fallback[1]);
      if (fb) {
        const c = navGrid.cellCenterWorld(fb.i, fb.j);
        x = c.x; z = c.z;
      }
      // eslint-disable-next-line no-console
      console.warn(`[strategist] callout ${slot.callout} did not snap to navmesh; using bombsite fallback`);
    }

    let facingYaw: number | undefined;
    if (slot.facingCallout) {
      const target = world.callouts.get(slot.facingCallout)?.centroid;
      if (target) {
        facingYaw = Math.atan2(target[0] - x, target[1] - z);
      }
    }

    bb.roleByBot.set(bot.id, slot.role);
    bb.objectiveByBot.set(bot.id, {
      x, z, facingYaw,
      callout: slot.callout,
      role: slot.role,
    });
  }

  // Spread the plan's grenade lineups across the team's bots. Each
  // lineup needs a bot that's near (or pathing toward) its fromCallout
  // — the simplest stable rule is "assign the bot whose objective
  // callout matches fromCallout, otherwise the closest unassigned bot
  // by current pos." We give each bot at most one lineup; bots without
  // one stick to plain pathing.
  const lineups = lineupsFor(plan.id);
  const assigned = new Set<string>();
  for (const lu of lineups) {
    const winner = pickBotForLineup(teamBots, bb, lu, assigned);
    if (!winner) continue;
    winner.brain.pendingLineup = lu;
    assigned.add(winner.id);
  }
  // Bots that didn't pick up a lineup this round drop any stale one
  // from the previous round.
  for (const bot of teamBots) {
    if (!assigned.has(bot.id)) bot.brain.pendingLineup = null;
  }
}

function pickBotForLineup(
  bots: ReadonlyArray<Bot>,
  bb: TeamBlackboard,
  lu: GrenadeLineup,
  alreadyAssigned: ReadonlySet<string>,
): Bot | null {
  // First preference: a bot whose objective IS the lineup's
  // fromCallout. They're already heading there.
  for (const b of bots) {
    if (alreadyAssigned.has(b.id)) continue;
    const obj = bb.objectiveByBot.get(b.id);
    if (obj?.callout === lu.fromCallout) return b;
  }
  // Fall back to whichever unassigned bot is closest to fromCallout
  // right now. The bot will detour; brain Save / Engage / etc still
  // override.
  return bots.find(b => !alreadyAssigned.has(b.id)) ?? null;
}

/** Compute the team's eco tier from MatchPlayerSlots. */
function teamEcoTier(side: Side, players: ReadonlyMap<string, MatchPlayerSlot>): EcoTier {
  let total = 0;
  let count = 0;
  for (const p of players.values()) {
    if (p.currentSide !== side) continue;
    total += p.money;
    count += 1;
  }
  const mean = count > 0 ? total / count : 0;
  if (mean >= FULL_BUY_PER_PLAYER) return 'normal';
  if (mean >= FORCE_BUY_PER_PLAYER) return 'normal';      // force reuses normal plans
  return 'eco';
}

/** Round-start: pick + apply a pre-plant plan for the team. Idempotent
 *  if called twice with the same blackboard state — overwrites the
 *  previous plan. */
export function planRoundStart(
  bb: TeamBlackboard,
  bots: ReadonlyArray<Bot>,
  players: ReadonlyMap<string, MatchPlayerSlot>,
  world: World,
  navGrid: NavGrid,
  roundNumber: number,
  nowMs: number,
): void {
  const eco = teamEcoTier(bb.side, players);
  const plan = pickPreplanPlan(bb.side, eco, roundNumber);
  applyPlan(bb, plan, bots, world, navGrid, nowMs);
}

/** React to a bomb plant. T strategist installs a defensive plan; CT
 *  strategist installs a retake plan. Both target the planted site. */
export function reactToBombPlanted(
  bb: TeamBlackboard,
  bots: ReadonlyArray<Bot>,
  bomb: BombInfo,
  world: World,
  navGrid: NavGrid,
  nowMs: number,
): void {
  if (!bomb.site || !bomb.pos) return;
  const plan = pickPostPlantPlan(bb.side, bomb.site);
  applyPlan(bb, plan, bots, world, navGrid, nowMs);
  recordEvent(bb, {
    type: 'bombPlanted',
    site: bomb.site,
    x: bomb.pos.x, z: bomb.pos.z,
    tMs: nowMs,
  });
}

/** Look up the world XZ for a bot's current objective. Returns null when
 *  the strategist hasn't assigned anything (e.g. very early boot before
 *  the first round has been planned). */
export function objectivePosFor(bb: TeamBlackboard, botId: string): { x: number; z: number } | null {
  const obj = bb.objectiveByBot.get(botId);
  if (!obj) return null;
  return { x: obj.x, z: obj.z };
}

function lcgPick(seed: number, n: number): number {
  // Two-stage xorshift hash (Murmur-style finalizer). A plain LCG was a
  // dud because 1664525 % 5 === 0, which collapsed all picks for our
  // 5-plan buckets to a single index. The finalizer scrambles the high
  // bits enough that small modulus values still vary across seeds.
  let s = (seed | 0) || 1;
  s = (Math.imul(s, 1664525) + 1013904223) | 0;
  s = Math.imul(s ^ (s >>> 16), 2246822507) | 0;
  s = Math.imul(s ^ (s >>> 13), 3266489909) | 0;
  s = (s ^ (s >>> 16)) >>> 0;
  return s % n;
}

/** Re-export for tests. */
export { pickPreplanPlan, pickPostPlantPlan, teamEcoTier };
