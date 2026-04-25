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
import type { Bot } from '../entities/bot';
import type { MatchPlayerSlot } from '../match/match';
import type { TeamBlackboard, BombInfo } from './blackboard';
import { recordEvent } from './blackboard';
import { PLANS, plansForSide, type EcoTier, type PlanDef, type Side, type StrategyId } from './plans';

const FULL_BUY_PER_PLAYER = 4500;
const FORCE_BUY_PER_PLAYER = 2500;

/** Decide a plan for the team based on team mean money + a deterministic
 *  per-round dice roll. */
function pickPreplanPlan(
  side: Side,
  ecoTier: EcoTier,
  roundNumber: number,
): PlanDef {
  const eligible = plansForSide(side).filter(p =>
    p.phase === 'pre_plant' && (p.ecoTier === ecoTier || (ecoTier !== 'eco' && p.ecoTier === 'normal'))
  );
  if (eligible.length === 0) {
    // Eco fall-through: even on a force round, an eco plan beats nothing.
    const eco = plansForSide(side).find(p => p.phase === 'pre_plant' && p.ecoTier === 'eco');
    return eco ?? plansForSide(side)[0]!;
  }
  // Deterministic round-seeded rotation so consecutive rounds vary.
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
 *  the lurker mid-round). */
function applyPlan(
  bb: TeamBlackboard,
  plan: PlanDef,
  bots: ReadonlyArray<Bot>,
  world: World,
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

  for (let i = 0; i < teamBots.length; i++) {
    const bot = teamBots[i]!;
    const slot = plan.slots[Math.min(i, plan.slots.length - 1)]!;
    const where = world.callouts.get(slot.callout)?.centroid;
    const fallback = world.bombSites[0]?.polygon[0] ?? [0, 0];
    const x = where ? where[0] : fallback[0];
    const z = where ? where[1] : fallback[1];

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
  roundNumber: number,
  nowMs: number,
): void {
  const eco = teamEcoTier(bb.side, players);
  const plan = pickPreplanPlan(bb.side, eco, roundNumber);
  applyPlan(bb, plan, bots, world, nowMs);
}

/** React to a bomb plant. T strategist installs a defensive plan; CT
 *  strategist installs a retake plan. Both target the planted site. */
export function reactToBombPlanted(
  bb: TeamBlackboard,
  bots: ReadonlyArray<Bot>,
  bomb: BombInfo,
  world: World,
  nowMs: number,
): void {
  if (!bomb.site || !bomb.pos) return;
  const plan = pickPostPlantPlan(bb.side, bomb.site);
  applyPlan(bb, plan, bots, world, nowMs);
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
