/** Per-bot "brain" — picks one of a handful of high-level actions every
 *  ~200 ms (utility selector with hysteresis), and runs that action's
 *  per-tick logic every sim tick (aim, fire, reload, walk).
 *
 *  Actions in Pass 2:
 *    Engage         — face the best known enemy, fire when on target
 *    Reload         — out of combat with a low mag → R
 *    MoveToObjective — follow the A* path the path service produced
 *    Idle           — final fallback when there's no path and no enemy
 *
 *  Pass 3 adds Plant / Defuse, fed in through the existing match-step
 *  intent struct so the bomb FSM doesn't need to know who's a bot. */

import type { Bot } from '../entities/bot';
import type { Character } from '../entities/character';
import { hitboxPose } from '../entities/character';
import type { FiringController } from '../combat/firing';
import type { Perception } from './perception';
import type { BotDifficulty } from './difficulty';
import { activeInstance, switchTo } from '../weapons/inventory';
import type { World } from '../map/world';
import type { BombState } from '../match/bomb';
import { pointInPolygon2D } from '../map/world';
import type { TeamBlackboard } from './blackboard';
import type { GrenadeLineup } from './grenadeLineups';
import type { GrenadeSystem } from '../grenades/system';
import { forkRng, getMatchSeed, type SeededRng } from './rng';
import type { WorldStateView } from './world/state';
import { planFor } from './goap/planner';
import type { PlannedAction, Goal, PlanInputs } from './goap/types';

export type BrainState = 'idle' | 'movetoObj' | 'engage' | 'reload' | 'plant' | 'defuse' | 'save' | 'throwGrenade';

const DECISION_INTERVAL_MS = 200;     // 5 Hz
/** Bonus utility for the action that's already running so we don't
 *  flip-flop between Engage and MoveToObjective every decision tick. */
const HYSTERESIS = 5;
/** A CT bot considers itself "near" a planted bomb when within this many
 *  meters in XZ — slightly larger than the defuse range (1.0 m) so the
 *  brain commits to a defuse approach before the FSM accepts it. */
const DEFUSE_APPROACH_M = 1.4;
/** HP threshold below which a bot is willing to retreat. Combined with
 *  team-vs-team count this drives the Save action. */
const SAVE_LOW_HP = 60;

export interface BrainContext {
  /** All characters in the world (so the brain can resolve a known-enemy
   *  id back to the live Character record for current-tick chest pos). */
  characters: Character[];
  /** Current bomb state — drives plant/defuse intents. */
  bomb: BombState | null;
  /** World — needed for bombsite polygon tests. */
  world: World;
  /** Team blackboard — drives objectives, save logic, shared intel. */
  blackboard: TeamBlackboard | null;
  /** Number of teammates alive (excludes self) and number of enemies
   *  alive. The strategist refreshes these every tick before brains
   *  step. */
  teammatesAlive: number;
  enemiesAlive: number;
  /** Centroid of this team's spawn buy zone. Used by Save to retreat
   *  toward safety. */
  spawnX: number;
  spawnZ: number;
  /** Grenade system — the brain calls into it when executing a lineup. */
  grenades: GrenadeSystem;
  /** Sim ms when the round entered live phase. Used to gate 'opening'
   *  lineups (only consider them within the first few seconds). */
  liveSinceMs: number;
  /** Per-tick immutable world view shared across all AI layers. Phase 0
   *  threads it through but the legacy decide() still reads from the
   *  flat fields above. Phase 3 cuts the planner over to reading from
   *  this view directly and the flat fields go away. */
  view: WorldStateView;
}

export class Brain {
  state: BrainState = 'idle';
  /** Sim ms of the last action transition — used by callers for debug. */
  stateChangedMs = 0;
  private nextDecisionMs = 0;

  /** Engagement bookkeeping. */
  private engageId: string | null = null;
  private engageStartMs = 0;
  /** Aim noise sample, refreshed per `aimNoiseResampleMs` window. */
  private noiseYawDeg = 0;
  private noisePitchDeg = 0;
  private noiseUntilMs = 0;
  /** Whether the last tick actually pulled the trigger (used for trigger
   *  edges on semi/bolt weapons). */
  private firedLastTick = false;
  /** True while the brain wants the bot to hold the plant key. main.ts
   *  reads this to assemble the per-tick PlanterIntent for the bomb FSM. */
  wantsPlant = false;
  /** True while the brain wants the bot to hold the defuse key. */
  wantsDefuse = false;
  /** Context captured at the top of step() so decide() (which runs at a
   *  lower cadence) can see the same world state without us having to
   *  thread the ctx through the call. */
  private lastCtx: BrainContext | null = null;
  /** Lineup the bot picked up this round; null when nothing to throw. */
  pendingLineup: GrenadeLineup | null = null;
  /** Sim ms before which we don't try to throw — used to give the bot a
   *  beat to get into position after picking up a lineup. */
  private throwReadyAtMs = 0;
  /** Per-bot deterministic RNG, forked from the match seed by bot id.
   *  Drives aim noise (+ future GOAP cost jitter). Each bot owns its own
   *  stream so reordering bot evaluation in the loop doesn't shift any
   *  bot's draws — replays stay stable. */
  private readonly rng: SeededRng;
  /** Phase 3 GOAP queue. When non-null, the brain consumes head action
   *  per planning tick; advances on completion; replans when goal
   *  changes or the plan is exhausted. */
  plannedActions: PlannedAction[] | null = null;
  /** Index into plannedActions for the action currently being run. */
  plannedActionIdx = 0;
  /** Goal the planner picked at the last replan — for the F4 HUD. */
  currentGoal: Goal | null = null;

  constructor(
    private readonly difficulty: BotDifficulty,
    phaseMs: number,
    botId: string,
  ) {
    this.nextDecisionMs = phaseMs;
    this.rng = forkRng(getMatchSeed(), `brain:${botId}`);
  }

  /** Per sim-tick step. Returns an indication of whether the brain wants
   *  the bot to follow its A* path this tick. */
  step(
    bot: Bot,
    perception: Perception,
    ctx: BrainContext,
    firing: FiringController,
    dtMs: number,
    nowMs: number,
  ): { followPath: boolean } {
    this.lastCtx = ctx;
    if (nowMs >= this.nextDecisionMs) {
      this.nextDecisionMs = nowMs + DECISION_INTERVAL_MS;
      if (bot.usePlanner) {
        this.decideViaPlanner(bot, perception, ctx, nowMs);
      } else {
        this.decide(bot, perception, nowMs);
      }
    }

    // Resample aim noise on its own clock.
    if (nowMs >= this.noiseUntilMs) {
      this.noiseYawDeg = this.rng.gaussian() * this.difficulty.aimErrorDeg;
      this.noisePitchDeg = this.rng.gaussian() * this.difficulty.aimErrorDeg;
      this.noiseUntilMs = nowMs + this.difficulty.aimNoiseResampleMs;
    }

    let followPath = true;
    // Default plant/defuse to false; the runPlant/runDefuse branches
    // re-assert true when active.
    this.wantsPlant = false;
    this.wantsDefuse = false;
    switch (this.state) {
      case 'engage':
        followPath = false;
        this.runEngage(bot, perception, ctx, firing, dtMs, nowMs);
        break;
      case 'reload':
        followPath = false;
        this.runReload(bot, firing, nowMs);
        break;
      case 'plant':
        followPath = false;
        this.runPlant(bot, firing, nowMs);
        break;
      case 'defuse':
        followPath = false;
        this.runDefuse(bot, firing, nowMs);
        break;
      case 'save':
        // Save retreats toward spawn — let the path follower run, but
        // the strategist owns the Save objective so this is just normal
        // pathing toward a different target.
        this.runIdleFire(bot, firing, nowMs);
        break;
      case 'throwGrenade':
        followPath = false;
        this.runThrowGrenade(bot, ctx, firing, dtMs, nowMs);
        break;
      case 'movetoObj':
        // Movement happens via stepBot's path follower. Brain only feeds a
        // null fire input so weapon state ticks normally (deploy + reload
        // timers still need firing.step to advance them).
        this.runIdleFire(bot, firing, nowMs);
        break;
      case 'idle':
      default:
        this.runIdleFire(bot, firing, nowMs);
        break;
    }

    return { followPath };
  }

  // ---- Decision ------------------------------------------------------

  private decide(bot: Bot, perception: Perception, nowMs: number): void {
    const ctx = this.lastCtx!;
    const target = perception.bestTarget(bot.character.pos.x, bot.character.pos.z);
    const inst = bot.character.inventory ? activeInstance(bot.character.inventory) : null;

    const u = {
      engage: 0,
      reload: 0,
      moveto: 0,
      idle: 0,
      plant: 0,
      defuse: 0,
      save: 0,
      throwGrenade: 0,
    };

    // ---- Throw grenade: bot has a pending lineup, owns the right
    //      kind, and is in throw position. We score below engage so a
    //      visible enemy interrupts the throw (preferable: shoot first,
    //      throw later) but above moveto so the bot prioritizes the
    //      lineup over its anchor objective.
    if (this.pendingLineup && bot.character.inventory && nowMs >= this.throwReadyAtMs) {
      const lu = this.pendingLineup;
      const haveKind = bot.character.inventory.grenades.some(g => g.def.id === lu.kind);
      const triggerOk = isLineupTriggered(lu, ctx, nowMs);
      if (haveKind && triggerOk) {
        // Distance to the fromCallout — bot must be in throw position.
        const fromPos = ctx.world.callouts.get(lu.fromCallout)?.centroid;
        if (fromPos) {
          const dx = fromPos[0] - bot.character.pos.x;
          const dz = fromPos[1] - bot.character.pos.z;
          const dist = Math.hypot(dx, dz);
          // Within a few meters: ready to throw.
          // Further out: we want to keep moving via the strategist's
          // objective; the lineup will fire once the bot arrives.
          if (dist <= 3.0) u.throwGrenade = 80;
        }
      } else if (!haveKind) {
        // Lineup is unrunnable (we never bought / used it). Drop it.
        this.pendingLineup = null;
      }
    }

    // ---- Plant: T carrier on a bombsite, no immediate threat.
    const bomb = ctx.bomb;
    if (
      bot.character.team === 'T' &&
      bot.character.inventory?.c4 &&
      bomb &&
      (bomb.phase === 'carried' || bomb.phase === 'planting') &&
      bomb.carrierId === bot.id &&
      !perception.hasVisible() &&
      onBombsite(ctx, bot.character.pos.x, bot.character.pos.y, bot.character.pos.z)
    ) {
      u.plant = 110;     // beats engage when alone on site
    }

    // ---- Defuse: CT near a planted bomb, no immediate threat.
    if (
      bot.character.team === 'CT' &&
      bomb &&
      (bomb.phase === 'planted' || bomb.phase === 'defusing') &&
      bomb.pos &&
      !perception.hasVisible()
    ) {
      const dx = bomb.pos.x - bot.character.pos.x;
      const dz = bomb.pos.z - bot.character.pos.z;
      if (dx * dx + dz * dz <= DEFUSE_APPROACH_M * DEFUSE_APPROACH_M) {
        u.defuse = 110;
      }
    }

    // ---- Save: outnumbered + low HP, no critical task pending. T bots
    // never save while they could plant; CT bots never save while a
    // bomb is planted — both situations trump survival economics.
    //
    // We deliberately do NOT trigger Save based on the strategy being
    // an eco_save plan: those plans already place bots in passive
    // positions, and re-routing them all to spawn on top of that just
    // produces a "huddle at spawn" round.
    const outnumbered = ctx.enemiesAlive >= ctx.teammatesAlive + 2;
    const wounded = bot.character.hp <= SAVE_LOW_HP;
    const tCanPlant = bot.character.team === 'T' && bot.character.inventory?.c4 != null;
    const ctMustDefuse = bot.character.team === 'CT' && bomb && bomb.phase === 'planted';
    if (
      !tCanPlant && !ctMustDefuse &&
      outnumbered && wounded
    ) {
      u.save = 70;     // beats moveto/idle/reload but loses to engage on visible
    }

    if (target && target.confidence === 'visible' && inst && inst.def.fireMode !== 'planted') {
      const ammoOk = inst.def.magazine === 0 || inst.ammoMag > 0;
      u.engage = ammoOk ? 100 : 0;
    } else if (target && target.confidence === 'recent' && inst && inst.def.fireMode !== 'planted') {
      // We saw them recently — point in their direction but don't fire blind.
      u.engage = 30;
    }

    if (inst && inst.def.magazine > 0) {
      const magFrac = inst.ammoMag / inst.def.magazine;
      if (magFrac <= this.difficulty.reloadAtMagFraction && inst.ammoReserve > 0 && !perception.hasVisible()) {
        u.reload = 60;
      }
    }

    if (bot.path && bot.path.length > 0 && bot.pathIdx < bot.path.length) {
      u.moveto = 40;
    } else if (bot.objective) {
      u.moveto = 25;       // we want a path but don't have one yet
    }

    u.idle = 5;

    if (this.state) {
      switch (this.state) {
        case 'engage':       u.engage += HYSTERESIS; break;
        case 'reload':       u.reload += HYSTERESIS; break;
        case 'movetoObj':    u.moveto += HYSTERESIS; break;
        case 'idle':         u.idle += HYSTERESIS; break;
        case 'plant':        u.plant += HYSTERESIS; break;
        case 'defuse':       u.defuse += HYSTERESIS; break;
        case 'save':         u.save += HYSTERESIS; break;
        case 'throwGrenade': u.throwGrenade += HYSTERESIS; break;
      }
    }

    let next: BrainState = 'idle';
    let bestU = u.idle;
    if (u.engage       > bestU) { next = 'engage'; bestU = u.engage; }
    if (u.reload       > bestU) { next = 'reload'; bestU = u.reload; }
    if (u.moveto       > bestU) { next = 'movetoObj'; bestU = u.moveto; }
    if (u.save         > bestU) { next = 'save';   bestU = u.save;   }
    if (u.throwGrenade > bestU) { next = 'throwGrenade'; bestU = u.throwGrenade; }
    if (u.plant        > bestU) { next = 'plant';  bestU = u.plant;  }
    if (u.defuse       > bestU) { next = 'defuse'; bestU = u.defuse; }

    if (next !== this.state) {
      this.state = next;
      this.stateChangedMs = nowMs;
      if (next === 'engage') {
        // Acquired a target — start the reaction timer.
        this.engageId = target?.id ?? null;
        this.engageStartMs = nowMs;
      } else {
        this.engageId = null;
      }
    }

    // If we're already engaging but the active enemy id changed, reset
    // the reaction timer — swinging onto a new target shouldn't fire
    // instantly.
    if (next === 'engage' && target && target.id !== this.engageId) {
      this.engageId = target.id;
      this.engageStartMs = nowMs;
    }
  }

  /** Phase 3: planner-driven decide. Maintains a `plannedActions`
   *  queue. Each call:
   *    1. Advances the queue head if its completion predicate is true.
   *    2. Replans (calls `planFor`) when the queue is exhausted, when
   *       no plan exists, or when the goal kind no longer matches the
   *       situation (e.g. a visible enemy appeared while we were
   *       walking to a callout — bump to 'eliminate').
   *    3. Maps the head action to a legacy brain state; the existing
   *       run* dispatch in step() executes the actual tick work.
   *
   *  This split (planner picks intent; legacy code executes) keeps the
   *  blast radius small — every existing run* method still runs. */
  private decideViaPlanner(bot: Bot, perception: Perception, ctx: BrainContext, nowMs: number): void {
    // Advance head action if complete.
    if (this.plannedActions && this.plannedActionIdx < this.plannedActions.length) {
      const head = this.plannedActions[this.plannedActionIdx]!;
      if (this.actionComplete(head, bot, perception, ctx, nowMs)) {
        this.plannedActionIdx += 1;
      }
    }
    // (Re)plan if needed: no plan, plan exhausted, or goal mismatch.
    const needPlan =
      !this.plannedActions ||
      this.plannedActionIdx >= this.plannedActions.length ||
      this.shouldReplan(bot, perception, ctx);
    if (needPlan) {
      const input = buildPlanInputs(bot, perception, ctx);
      const result = planFor(input, bot.identity.personality);
      this.plannedActions = result?.plan ?? null;
      this.plannedActionIdx = 0;
      this.currentGoal = result?.goal ?? null;
    }

    const head = this.plannedActions && this.plannedActionIdx < this.plannedActions.length
      ? this.plannedActions[this.plannedActionIdx]!
      : null;
    if (!head) {
      this.state = 'idle';
      return;
    }

    // Map head action → legacy brain state, with side effects so the
    // existing run<State> dispatch executes the right sub-routine.
    switch (head.kind) {
      case 'engage':
        if (head.targetId && head.targetId !== this.engageId) {
          this.engageId = head.targetId;
          this.engageStartMs = nowMs;
        }
        this.state = 'engage';
        break;
      case 'reload':
        this.state = 'reload';
        break;
      case 'plant':
        this.state = 'plant';
        break;
      case 'defuse':
        this.state = 'defuse';
        break;
      case 'moveToCallout': {
        // Override bot.objective if the planner picked a different
        // destination than the strategist's slot. Inline the body of
        // setBotObjective to avoid a circular import (brain ↔ bot).
        if (head.x !== undefined && head.z !== undefined) {
          const cur = bot.objective;
          if (!cur || Math.hypot(cur.x - head.x, cur.z - head.z) > 0.5) {
            bot.objective = { x: head.x, z: head.z };
            bot.path = null;
            bot.pathIdx = 0;
            bot.nextPlanAfterMs = 0;
          }
        }
        this.state = 'movetoObj';
        break;
      }
      case 'holdAngle': {
        // Reach the spot via the existing path follower; once close,
        // adopt the desired facing. We surface this as 'idle' so the
        // brain doesn't move; controller yaw nudge happens here.
        if (head.facingYaw !== undefined) {
          const k = 0.20;
          bot.controller.state.yaw = lerpAngle(bot.controller.state.yaw, head.facingYaw, k);
        }
        this.state = 'idle';
        break;
      }
    }
  }

  /** Predicate per action kind — when true, the action is done and
   *  we advance the queue. */
  private actionComplete(a: PlannedAction, bot: Bot, perception: Perception, ctx: BrainContext, _nowMs: number): boolean {
    switch (a.kind) {
      case 'moveToCallout': {
        if (a.x === undefined || a.z === undefined) return true;
        const dx = bot.character.pos.x - a.x;
        const dz = bot.character.pos.z - a.z;
        return Math.hypot(dx, dz) < 1.2;
      }
      case 'engage': {
        // Done when target is gone (dead or out of perception entirely).
        if (!a.targetId) return true;
        const known = perception.known.get(a.targetId);
        if (!known) return true;
        const live = ctx.characters.find(c => c.id === a.targetId);
        return !live || !live.alive;
      }
      case 'reload': {
        const inv = bot.character.inventory;
        if (!inv) return true;
        const inst = activeInstance(inv);
        if (inst.def.magazine === 0) return true;
        return inst.ammoMag / inst.def.magazine >= 0.95;
      }
      case 'plant':
        return ctx.bomb?.phase === 'planted' || ctx.bomb?.phase === 'finished';
      case 'defuse':
        return ctx.bomb?.phase === 'finished' || ctx.bomb?.phase === 'carried';
      case 'holdAngle':
        // Hold persists; the goal-mismatch check in shouldReplan() is
        // what eventually retires this action when something more
        // urgent comes up.
        return false;
    }
  }

  /** Has the situation changed enough that the current goal/plan
   *  is wrong? Cheap goal-kind comparison — replans on visible enemy
   *  appearance / disappearance, bomb phase change, big HP drop. */
  private shouldReplan(bot: Bot, perception: Perception, ctx: BrainContext): boolean {
    if (!this.currentGoal) return true;
    const visible = perception.bestTarget(bot.character.pos.x, bot.character.pos.z);
    const haveVisibleEnemy = visible !== null && visible.confidence === 'visible';
    // Visible enemy + we weren't on 'eliminate' → escalate.
    if (haveVisibleEnemy && this.currentGoal.kind !== 'eliminate') return true;
    // Bomb planted while we were doing something else → CT side rotates.
    if (ctx.bomb?.phase === 'planted' && bot.character.team === 'CT'
        && this.currentGoal.kind !== 'defuse' && this.currentGoal.kind !== 'eliminate') {
      return true;
    }
    return false;
  }

  // ---- Action execution ---------------------------------------------

  private runEngage(
    bot: Bot,
    perception: Perception,
    ctx: BrainContext,
    firing: FiringController,
    _dtMs: number,
    nowMs: number,
  ): void {
    if (!this.engageId || !bot.character.inventory) {
      this.runIdleFire(bot, firing, nowMs);
      return;
    }
    // Resolve the engage target's current chest pos. If the live character
    // is dead/missing we fall back to the last-known position from
    // perception.known so the bot still finishes its swing onto cover.
    const live = ctx.characters.find(c => c.id === this.engageId);
    let tx: number, ty: number, tz: number;
    let aimingAtKnown = false;
    if (live && live.alive) {
      const pose = hitboxPose(live);
      tx = pose.baseX;
      ty = pose.baseY + pose.eye * 0.6;
      tz = pose.baseZ;
    } else {
      const known = perception.known.get(this.engageId);
      if (!known) {
        this.runIdleFire(bot, firing, nowMs);
        return;
      }
      tx = known.x; ty = known.y; tz = known.z;
      aimingAtKnown = true;
    }

    // Compute desired yaw/pitch from eye → target.
    const eyeX = bot.character.pos.x;
    const eyeY = bot.character.pos.y + bot.character.currentEye;
    const eyeZ = bot.character.pos.z;
    const dx = tx - eyeX;
    const dy = ty - eyeY;
    const dz = tz - eyeZ;
    const horiz = Math.hypot(dx, dz);
    const targetYaw = Math.atan2(dx, dz) + degToRad(this.noiseYawDeg);
    const targetPitch = Math.atan2(dy, horiz) + degToRad(this.noisePitchDeg);

    // Smooth current aim toward target. The controller's yaw/pitch IS the
    // bot's aim in our model — there's no separate eye-vs-body track yet.
    const k = 1 - Math.exp(-_dtMs / Math.max(1, this.difficulty.trackingLagMs));
    bot.controller.state.yaw = lerpAngle(bot.controller.state.yaw, targetYaw, k);
    bot.controller.state.pitch = clampPitch(
      bot.controller.state.pitch + (targetPitch - bot.controller.state.pitch) * k,
    );
    bot.character.yaw = bot.controller.state.yaw;
    bot.character.pitch = bot.controller.state.pitch;

    // Decide whether to pull the trigger.
    const reactionElapsed = nowMs - this.engageStartMs >= this.difficulty.reactionMs;
    const aimErrorDeg = aimErrorDegrees(
      bot.controller.state.yaw, bot.controller.state.pitch,
      Math.atan2(dx, dz), Math.atan2(dy, horiz),
    );
    const onTarget = aimErrorDeg <= this.difficulty.fireAimToleranceDeg;
    const shouldFire = reactionElapsed && onTarget && !aimingAtKnown;

    const inst = activeInstance(bot.character.inventory);
    const fireMode = inst.def.fireMode;
    let triggerHeld = false;
    let triggerEdge = false;
    if (shouldFire) {
      if (fireMode === 'auto') {
        triggerHeld = true;
      } else if (fireMode === 'semi' || fireMode === 'bolt' || fireMode === 'burst' || fireMode === 'melee') {
        // Pulse the trigger: edge once, off the next sim tick. The firing
        // controller's per-shot rate-limit covers cadence.
        triggerEdge = !this.firedLastTick;
      }
    }

    const aim = aimRequest(bot, fireMode);
    const result = firing.step(nowMs, bot.character, inst, aim, {
      triggerHeld,
      triggerEdge,
      reloadEdge: false,
      secondaryEdge: false,
    });
    this.firedLastTick = result !== 'none';
  }

  private runReload(bot: Bot, firing: FiringController, nowMs: number): void {
    if (!bot.character.inventory) return;
    const inst = activeInstance(bot.character.inventory);
    const reloadEdge = inst.state === 'ready' || inst.state === 'empty';
    const aim = aimRequest(bot, inst.def.fireMode);
    firing.step(nowMs, bot.character, inst, aim, {
      triggerHeld: false,
      triggerEdge: false,
      reloadEdge,
      secondaryEdge: false,
    });
    this.firedLastTick = false;
  }

  /** Plant action — stand still and signal the match's bomb FSM that
   *  we're holding the plant key. main.ts assembles a PlanterIntent
   *  from this flag plus the carrier's pos. */
  private runPlant(bot: Bot, firing: FiringController, nowMs: number): void {
    this.wantsPlant = true;
    this.runIdleFire(bot, firing, nowMs);
  }

  /** Throw the current pending lineup. Steps:
   *    1. Switch to the right grenade kind in the inventory.
   *    2. Wait the deploy interval (handled by firing-state poll).
   *    3. Aim at the target callout (smoothed yaw + 0.4 rad upward
   *       pitch — the lob arc handles the rest).
   *    4. When deployed AND on target, throw via grenadeSystem and
   *       remove the consumed grenade from the bot's stack.
   *
   *  After throwing, the lineup is cleared and the brain falls back to
   *  movetoObj naturally next decide(). */
  private runThrowGrenade(
    bot: Bot,
    ctx: BrainContext,
    firing: FiringController,
    dtMs: number,
    nowMs: number,
  ): void {
    if (!this.pendingLineup || !bot.character.inventory) {
      this.runIdleFire(bot, firing, nowMs);
      return;
    }
    const lu = this.pendingLineup;
    const inv = bot.character.inventory;
    // 1) Deploy the right grenade. If a different kind is currently
    // active, switch — switchTo handles deploy timing.
    const idxOfKind = inv.grenades.findIndex(g => g.def.id === lu.kind);
    if (idxOfKind < 0) {
      this.pendingLineup = null;
      this.runIdleFire(bot, firing, nowMs);
      return;
    }
    if (inv.active !== 'grenade' || inv.activeGrenadeIdx !== idxOfKind) {
      inv.activeGrenadeIdx = idxOfKind;
      // Force an active-slot swap so the grenade enters its deploy
      // phase. switchTo refuses a no-op switch when slot is unchanged,
      // so flip via a temporary re-assignment.
      if (inv.active !== 'grenade') {
        switchTo(inv, 'grenade', nowMs);
      } else {
        const inst = inv.grenades[idxOfKind]!;
        inst.state = 'deploying';
        inst.stateUntilMs = nowMs + inst.def.deployMs;
      }
    }

    // 2) Aim. Target = callout centroid; pitch = 25° upward for a lob.
    const target = ctx.world.callouts.get(lu.targetCallout)?.centroid;
    if (!target) {
      this.pendingLineup = null;
      this.runIdleFire(bot, firing, nowMs);
      return;
    }
    const eyeX = bot.character.pos.x;
    const eyeY = bot.character.pos.y + bot.character.currentEye;
    const eyeZ = bot.character.pos.z;
    const dx = target[0] - eyeX;
    const dz = target[1] - eyeZ;
    const desiredYaw = Math.atan2(dx, dz);
    const desiredPitch = -0.45;        // ~25° upward (negative pitch
                                       // looks up in our convention).
    const k = 1 - Math.exp(-dtMs / 80);
    bot.controller.state.yaw = lerpAngle(bot.controller.state.yaw, desiredYaw, k);
    bot.controller.state.pitch = bot.controller.state.pitch + (desiredPitch - bot.controller.state.pitch) * k;
    bot.character.yaw = bot.controller.state.yaw;
    bot.character.pitch = bot.controller.state.pitch;

    // 3) Throw when the grenade is deployed and aim is close enough.
    const inst = inv.grenades[inv.activeGrenadeIdx]!;
    const aimErrYaw = Math.abs(angleDiff(bot.controller.state.yaw, desiredYaw));
    const aimErrPitch = Math.abs(bot.controller.state.pitch - desiredPitch);
    if (inst.state === 'ready' && aimErrYaw < 0.1 && aimErrPitch < 0.15) {
      const cosP = Math.cos(bot.controller.state.pitch);
      ctx.grenades.throw_(
        lu.kind,
        bot.id,
        {
          ox: eyeX, oy: eyeY, oz: eyeZ,
          fwdX: Math.sin(bot.controller.state.yaw) * cosP,
          fwdY: Math.sin(bot.controller.state.pitch),
          fwdZ: Math.cos(bot.controller.state.yaw) * cosP,
          power: 'full',
        },
        nowMs,
      );
      inv.grenades.splice(inv.activeGrenadeIdx, 1);
      inv.activeGrenadeIdx = 0;
      // Drop back to a real weapon so the next decide() picks engage
      // or moveto correctly.
      if (inv.primary) inv.active = 'primary';
      else if (inv.secondary) inv.active = 'secondary';
      else inv.active = 'knife';
      this.pendingLineup = null;
    } else {
      this.runIdleFire(bot, firing, nowMs);
    }
  }

  /** Defuse action — same shape, but we want the defuse key. */
  private runDefuse(bot: Bot, firing: FiringController, nowMs: number): void {
    this.wantsDefuse = true;
    this.runIdleFire(bot, firing, nowMs);
  }

  /** "Idle fire" is a misnomer — we just step the firing controller with
   *  no input so deploy / reload timers continue advancing. Without this
   *  call, a bot that switches weapons mid-path never finishes its deploy. */
  private runIdleFire(bot: Bot, firing: FiringController, nowMs: number): void {
    if (!bot.character.inventory) return;
    const inst = activeInstance(bot.character.inventory);
    const aim = aimRequest(bot, inst.def.fireMode);
    firing.step(nowMs, bot.character, inst, aim, {
      triggerHeld: false,
      triggerEdge: false,
      reloadEdge: false,
      secondaryEdge: false,
    });
    this.firedLastTick = false;
  }
}

// ---- Helpers --------------------------------------------------------

/** Adapter: build the planner's `PlanInputs` from the brain's tick
 *  context. Lives here (not in goap/) because the conversion knows
 *  about Bot/Character/Perception shapes the planner shouldn't depend
 *  on directly. */
function buildPlanInputs(bot: Bot, perception: Perception, ctx: BrainContext): PlanInputs {
  const c = bot.character;
  const inv = c.inventory;
  const inst = inv ? activeInstance(inv) : null;
  const ammoFraction = inst && inst.def.magazine > 0 ? inst.ammoMag / inst.def.magazine : null;
  const visible = perception.bestTarget(c.pos.x, c.pos.z);
  let visibleEnemyId: string | null = null;
  let visibleEnemyPos: PlanInputs['visibleEnemyPos'] = null;
  let recentEnemyId: string | null = null;
  let recentEnemyPos: PlanInputs['recentEnemyPos'] = null;
  if (visible) {
    if (visible.confidence === 'visible') {
      visibleEnemyId = visible.id;
      visibleEnemyPos = { x: visible.x, y: visible.y, z: visible.z };
    } else {
      recentEnemyId = visible.id;
      recentEnemyPos = { x: visible.x, y: visible.y, z: visible.z };
    }
  }
  const bombInfo = ctx.bomb;
  const bombPos = bombInfo?.pos ?? null;
  const objBoard = ctx.blackboard?.objectiveByBot.get(bot.id);
  const objective = objBoard
    ? { callout: objBoard.callout as PlanInputs['objective'] extends infer O ? O extends { callout: infer C } ? C : never : never,
        x: objBoard.x, z: objBoard.z, facingYaw: objBoard.facingYaw }
    : null;
  return {
    selfId: bot.id,
    side: c.team,
    pos: { x: c.pos.x, y: c.pos.y, z: c.pos.z },
    hp: c.hp,
    hasC4: !!c.inventory?.c4,
    ammoFraction,
    bomb: bombInfo
      ? { phase: bombInfo.phase, site: bombInfo.site, pos: bombPos ? { x: bombPos.x, y: bombPos.y, z: bombPos.z } : null }
      : { phase: 'finished', site: null, pos: null },
    visibleEnemyId, visibleEnemyPos,
    recentEnemyId, recentEnemyPos,
    objective: objective as PlanInputs['objective'],
    teammatesAlive: ctx.teammatesAlive,
    enemiesAlive: ctx.enemiesAlive,
  };
}

function isLineupTriggered(lu: GrenadeLineup, ctx: BrainContext, nowMs: number): boolean {
  switch (lu.trigger) {
    case 'opening':
      // Open the round: only fire within the first 6 s of live phase.
      return nowMs - ctx.liveSinceMs < 6000;
    case 'pre_push':
      // Throw when at least one teammate is already engaged or pushing.
      // Approximation: fire any time during live phase except opening.
      return nowMs - ctx.liveSinceMs >= 4000;
    case 'on_plant':
      return ctx.bomb !== null && (ctx.bomb.phase === 'planted' || ctx.bomb.phase === 'defusing');
  }
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function onBombsite(ctx: BrainContext, x: number, y: number, z: number): boolean {
  for (const s of ctx.world.bombSites) {
    if (y < s.yMin - 0.1 || y > s.yMax + 0.1) continue;
    if (pointInPolygon2D(x, z, s.polygon)) return true;
  }
  return false;
}

function aimRequest(bot: Bot, _mode: string): { ox: number; oy: number; oz: number; fwdX: number; fwdY: number; fwdZ: number } {
  const yaw = bot.controller.state.yaw;
  const pitch = bot.controller.state.pitch;
  const cosP = Math.cos(pitch);
  return {
    ox: bot.character.pos.x,
    oy: bot.character.pos.y + bot.character.currentEye,
    oz: bot.character.pos.z,
    fwdX: Math.sin(yaw) * cosP,
    fwdY: Math.sin(pitch),
    fwdZ: Math.cos(yaw) * cosP,
  };
}

function degToRad(d: number): number { return d * Math.PI / 180; }

function lerpAngle(a: number, b: number, k: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * k;
}

const PITCH_LIMIT = Math.PI / 2 - 0.02;
function clampPitch(p: number): number {
  return p < -PITCH_LIMIT ? -PITCH_LIMIT : p > PITCH_LIMIT ? PITCH_LIMIT : p;
}

function aimErrorDegrees(curYaw: number, curPitch: number, tgtYaw: number, tgtPitch: number): number {
  let dy = tgtYaw - curYaw;
  while (dy > Math.PI) dy -= Math.PI * 2;
  while (dy < -Math.PI) dy += Math.PI * 2;
  const dp = tgtPitch - curPitch;
  return Math.hypot(dy, dp) * 180 / Math.PI;
}
