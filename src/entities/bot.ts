/** Bot — one of the nine non-player characters in the match. Owns its own
 *  CharacterController so it moves through the world the same way the local
 *  player does (capsule physics, friction, gravity, step-up). Also owns a
 *  HumanoidParts mesh for visuals.
 *
 *  Pass 1 (this file) drives bots along an A* path toward an objective.
 *  Pass 2 will add perception + a controller adapter that pulls aim/fire
 *  intent from a behaviour tree; that intent will overlay onto the same
 *  controller step we use here. */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Character } from './character';
import { makeFreshLimbs, legSpeedScale, wholeLegsLost } from './character';
import { CharacterController, DEFAULT_TUNABLES } from '../player/controller';
import type { WorldQuery } from '../player/physics';
import { defaultInventory, activeInstance } from '../weapons/inventory';
import {
  createHumanoid, syncHumanoidPose, disposeHumanoid, setHumanoidWeapon,
  type HumanoidParts,
} from './humanoid';
import type { PathPoint } from '../nav/astar';
import type { PathService } from '../nav/pathService';
import { Perception } from '../ai/perception';
import { Brain } from '../ai/brain';
import { getDifficulty, withVariance, type DifficultyId } from '../ai/difficulty';
import { debugLog } from '../engine/debugLog';
import { getOrCreateIdentity, type BotIdentity } from '../ai/personality';

/** Distance to a waypoint at which we consider it reached and advance to
 *  the next one. A bit larger than a cell so bots don't hover on each
 *  waypoint trying to land on it exactly. */
const WAYPOINT_REACH_M = 0.55;
/** Cooldown before a bot will request a fresh path after a previous
 *  request returned null (rate-limited or unreachable). */
const PATH_RETRY_MS = 600;

export interface Bot {
  id: string;
  character: Character;
  controller: CharacterController;
  parts: HumanoidParts;
  /** Current path waypoints. Null when we have nothing to follow. */
  path: PathPoint[] | null;
  pathIdx: number;
  /** World-space goal we last requested a path to. Null when idle. */
  objective: { x: number; z: number } | null;
  /** Sim ms of the next allowed path request. Used to backoff after a
   *  failed request. */
  nextPlanAfterMs: number;
  /** AI brain + perception. Bots without this are pure path-followers
   *  (Pass 1 behaviour) — useful for tests and for bots that haven't
   *  been promoted to "active" yet. */
  perception: Perception;
  brain: Brain;
  /** When true the main loop skips this bot's AI tick (perception, brain,
   *  stepBot). Set while the local player is possessing this bot after
   *  death — otherwise the brain would overwrite the player's mouse aim
   *  and movement input every frame. */
  aiDisabled: boolean;
  /** Mirror of difficulty.commsLatencyMs — how long after a teammate
   *  emits a callout this bot can act on it. The comms layer reads from
   *  here directly so it doesn't have to reach into Brain internals. */
  commsLatencyMs: number;
  /** Persistent identity (display name + archetype + personality
   *  scalars). Loaded from localStorage on first construction; stable
   *  across rounds and (subject to localStorage) across sessions. */
  identity: BotIdentity;
  /** When true, the brain decides its next action via the GOAP planner
   *  (`src/ai/goap/planner.ts`) instead of the legacy utility selector.
   *  Phase 3 v1 turns this on for `expert` difficulty only; the
   *  planner falls through to legacy execution for the actual tick
   *  work, so this is safe to flip per bot at runtime. */
  usePlanner: boolean;
}

let nextBotId = 1;

export interface CreateBotOpts {
  id?: string;
  armor?: number;
  helmet?: boolean;
  difficulty?: DifficultyId;
  /** Stable per-team index (0..4) used for variance + perception stagger. */
  teamIndex?: number;
}

export function createBot(
  team: 'T' | 'CT',
  spawnX: number, spawnY: number, spawnZ: number, spawnYaw: number,
  query: WorldQuery,
  opts?: CreateBotOpts,
): Bot {
  const id = opts?.id ?? `${team.toLowerCase()}-bot-${nextBotId++}`;
  const parts = createHumanoid(team, id);
  const startPos = new Vector3(spawnX, spawnY, spawnZ);
  const controller = new CharacterController(query, startPos, spawnYaw, DEFAULT_TUNABLES);
  controller.snapToGround();
  const character: Character = {
    id,
    team,
    isLocal: false,
    pos: controller.state.pos.clone(),
    currentHeight: controller.state.currentHeight,
    currentEye: controller.state.currentEye,
    yaw: spawnYaw,
    pitch: 0,
    hp: 100,
    armor: opts?.armor ?? 0,
    helmet: opts?.helmet ?? false,
    hasKit: false,
    alive: true,
    inventory: defaultInventory(team),
    speed: 0,
    inAir: false,
    crouching: false,
    limbs: makeFreshLimbs(),
  };
  syncHumanoidPose(parts, character.pos.x, character.pos.y, character.pos.z, character.yaw, character.currentEye, character.currentHeight);

  const teamIdx = opts?.teamIndex ?? 0;
  const difficulty = withVariance(getDifficulty(opts?.difficulty ?? 'medium'), teamIdx);
  // Stagger perception + decision phases by team index so 9 bots don't
  // all tick on the same sim frame. With 9 bots and ~100 ms perception,
  // an 11 ms phase per bot spreads them evenly across one tick window.
  const phaseMs = teamIdx * 11;
  const perception = new Perception(difficulty, phaseMs);
  const brain = new Brain(difficulty, phaseMs, id);
  const identity = getOrCreateIdentity(id);
  return {
    id,
    character,
    controller,
    parts,
    path: null,
    pathIdx: 0,
    objective: null,
    nextPlanAfterMs: 0,
    perception,
    brain,
    aiDisabled: false,
    // Higher-teamwork bots have a slightly faster comms loop than the
    // raw difficulty allows; lower-teamwork bots are slower (lurkers
    // don't call). Multiplier in 0.6..1.4 around the difficulty
    // baseline.
    commsLatencyMs: difficulty.commsLatencyMs * (1.4 - 0.8 * identity.personality.teamwork),
    identity,
    // Phase 6 default: medium / hard / expert all use the GOAP planner.
    // Easy stays on the legacy utility selector so the panic/abandon
    // pathway in `src/ai/reactive/index.ts` still has a forgiving
    // fallback brain to drop into.
    usePlanner: (opts?.difficulty ?? 'medium') !== 'easy',
  };
}

/** Sync the controller's spawn from the character record (which the
 *  match's roster reset writes to). Call after `resetCharacterForRound`
 *  and before stepping the bot for the new round. Also re-enables any
 *  humanoid part that was hidden by a dismemberment kill last round —
 *  otherwise a respawned bot would be missing a head. */
export function snapBotToCharacterPose(bot: Bot): void {
  const s = bot.controller.state;
  s.pos.copyFrom(bot.character.pos);
  s.yaw = bot.character.yaw;
  s.pitch = 0;
  s.vel.set(0, 0, 0);
  bot.controller.snapToGround();
  bot.path = null;
  bot.pathIdx = 0;
  bot.objective = null;
  bot.nextPlanAfterMs = 0;
  // Re-enable every detachable part — any limb torn off last round
  // gets put back so the respawned bot isn't missing pieces.
  const p = bot.parts;
  p.head.setEnabled(true);
  p.torso.setEnabled(true);
  p.pelvis.setEnabled(true);
  p.leftUpperArm.setEnabled(true);
  p.leftForearm.setEnabled(true);
  p.rightUpperArm.setEnabled(true);
  p.rightForearm.setEnabled(true);
  p.leftThigh.setEnabled(true);
  p.leftShin.setEnabled(true);
  p.leftFoot.setEnabled(true);
  p.rightThigh.setEnabled(true);
  p.rightShin.setEnabled(true);
  p.rightFoot.setEnabled(true);
  for (const g of p.gear) g.setEnabled(true);
}

/** Set a new objective and clear any in-flight path. The next sim tick
 *  will call into the path service to compute a fresh route. */
export function setBotObjective(bot: Bot, x: number, z: number): void {
  bot.objective = { x, z };
  bot.path = null;
  bot.pathIdx = 0;
  bot.nextPlanAfterMs = 0;
}

/** Per sim-tick step: request a path if needed, walk along it, step the
 *  controller, mirror state into the Character record. Dead bots are a
 *  no-op (they keep their ragdoll-tipped pose).
 *
 *  When `followPath` is false (the brain wants the bot to hold its
 *  ground while engaging or reloading), the bot still steps the
 *  controller so gravity / friction still apply, but with wishDir = 0. */
export function stepBot(
  bot: Bot,
  dtMs: number,
  nowMs: number,
  paths: PathService,
  opts?: { followPath?: boolean; faceMovement?: boolean },
): void {
  if (!bot.character.alive) {
    bot.character.speed = 0;
    bot.character.inAir = false;
    return;
  }
  const followPath = opts?.followPath ?? true;
  const faceMovement = opts?.faceMovement ?? true;

  // Plan a path if we have an objective but no route yet.
  if (bot.objective && (!bot.path || bot.path.length === 0) && nowMs >= bot.nextPlanAfterMs) {
    const start = { x: bot.controller.state.pos.x, z: bot.controller.state.pos.z };
    // Snapshot the budget BEFORE we ask. If it was already 0, the call
    // is a no-op (cache miss + null) and we just wait until next tick.
    // If we did burn a slot and still got null, the goal is unreachable
    // — back off for a while so we don't spin.
    const hadBudget = paths.budgetRemaining > 0;
    const result = paths.request(start, bot.objective);
    if (result && result.length > 0) {
      bot.path = result;
      bot.pathIdx = 0;
      if (debugLog.isEnabled('bots')) {
        debugLog.bots('path ok', {
          t: nowMs, id: bot.id,
          start, goal: bot.objective, len: result.length,
        });
      }
    } else if (hadBudget) {
      bot.nextPlanAfterMs = nowMs + PATH_RETRY_MS;
      if (debugLog.isEnabled('bots')) {
        debugLog.bots('path FAIL', {
          t: nowMs, id: bot.id,
          start, goal: bot.objective,
          backoffMs: PATH_RETRY_MS,
          reason: 'unreachable or unsnappable',
        });
      }
    }
    // Note: budget-exhausted skips are silent — they happen every frame
    // until the path service catches up and would dwarf the buffer.
  }

  // Compute wishDir toward the current waypoint, unless the caller has
  // suppressed path following (e.g. the bot is engaging an enemy).
  let wishX = 0, wishZ = 0;
  if (followPath && bot.path && bot.pathIdx < bot.path.length) {
    const wp = bot.path[bot.pathIdx]!;
    const dx = wp.x - bot.controller.state.pos.x;
    const dz = wp.z - bot.controller.state.pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < WAYPOINT_REACH_M * WAYPOINT_REACH_M) {
      bot.pathIdx += 1;
      // If we just consumed the last waypoint, fall through with wish=0.
      if (bot.pathIdx < bot.path.length) {
        const next = bot.path[bot.pathIdx]!;
        const ndx = next.x - bot.controller.state.pos.x;
        const ndz = next.z - bot.controller.state.pos.z;
        const nlen = Math.hypot(ndx, ndz) || 1;
        wishX = ndx / nlen;
        wishZ = ndz / nlen;
      } else {
        // Path complete; clear so we don't replan unless objective changes.
        bot.path = null;
      }
    } else {
      const len = Math.sqrt(d2);
      wishX = dx / len;
      wishZ = dz / len;
    }
  }

  // Face the movement direction unless the brain owns the yaw this tick
  // (e.g. while engaging — the brain points the bot at the enemy).
  if (faceMovement && (wishX !== 0 || wishZ !== 0)) {
    const desiredYaw = Math.atan2(wishX, wishZ);
    bot.controller.state.yaw = smoothYaw(bot.controller.state.yaw, desiredYaw, dtMs);
  }

  bot.controller.step(dtMs, {
    wishX,
    wishZ,
    jump: false,
    walk: false,
    crouch: false,
    speedScale: bot.character.inventory
      ? activeMoveSpeedScale(bot)
      : 1,
  });

  // Mirror controller state into the Character record so combat/HUD see it.
  const s = bot.controller.state;
  const c = bot.character;
  c.pos.copyFrom(s.pos);
  c.currentHeight = s.currentHeight;
  c.currentEye = s.currentEye;
  c.yaw = s.yaw;
  c.pitch = s.pitch;
  c.crouching = s.crouching || s.forcedCrouch;
  c.inAir = !s.onGround;
  c.speed = s.speed;
}

function activeMoveSpeedScale(bot: Bot): number {
  const inv = bot.character.inventory!;
  let scale: number;
  switch (inv.active) {
    case 'primary':   scale = inv.primary?.def.moveSpeedScale ?? 1; break;
    case 'secondary': scale = inv.secondary?.def.moveSpeedScale ?? 1; break;
    case 'knife':     scale = inv.knife.def.moveSpeedScale; break;
    case 'c4':        scale = inv.c4?.def.moveSpeedScale ?? 1; break;
    case 'grenade':   scale = inv.grenades[inv.activeGrenadeIdx]?.def.moveSpeedScale ?? 1; break;
  }
  // Limping bot. Speed scales by anatomical loss — a missing foot is
  // a noticeable limp, a missing whole leg drags. The brain still
  // pathfinds normally, it just makes slower progress. A leg-amputated
  // bot is effectively easy meat.
  scale *= legSpeedScale(bot.character);
  return scale;
}

/** Exponentially smooth yaw toward the desired heading along the shortest
 *  arc. Without this bots snap around when a waypoint changes direction. */
function smoothYaw(current: number, target: number, dtMs: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const k = 1 - Math.exp(-dtMs / 80);
  return current + diff * k;
}

/** Per render-frame: position + orient the humanoid mesh, and sync
 *  the visible weapon to whatever the bot currently has equipped.
 *  Tipped-over pose for dead bots; crawling pitch when both legs are
 *  blown off. */
export function syncBotMesh(bot: Bot): void {
  const c = bot.character;
  if (!c.alive) {
    bot.parts.root.rotation.x = -Math.PI / 2.2;
    bot.parts.root.rotation.z = 0;
    bot.parts.root.position.set(c.pos.x, c.pos.y + 0.2, c.pos.z);
    return;
  }
  syncHumanoidPose(bot.parts, c.pos.x, c.pos.y, c.pos.z, c.yaw, c.currentEye, c.currentHeight);
  // Both legs gone (whole-leg amputation, i.e. thigh detached on both
  // sides) → tip the torso forward so the body looks like it's
  // dragging itself along the ground. One whole leg gone → small
  // limp tilt so the bot reads as wounded instead of standing
  // straight on a missing limb.
  const legsGone = wholeLegsLost(c);
  if (legsGone >= 2) {
    bot.parts.root.rotation.x = -Math.PI / 2.4;
    bot.parts.root.position.y = c.pos.y + 0.20;
  } else if (legsGone === 1) {
    // Lean toward the missing side so the silhouette obviously limps.
    const lean = c.limbs.leftThigh.detached ? 0.25 : -0.25;
    bot.parts.root.rotation.z = lean;
  }

  // Pick a category for the weapon visual based on the active slot.
  // setHumanoidWeapon is idempotent on category, so calling it every
  // frame only allocates when the bot actually swaps weapons.
  let category: 'rifle' | 'pistol' | 'sniper' | 'knife' | 'grenade' | null = null;
  if (c.inventory) {
    const inst = activeInstance(c.inventory);
    const cat = inst.def.category;
    if (cat === 'rifle' || cat === 'smg' || cat === 'lmg' || cat === 'shotgun') category = 'rifle';
    else if (cat === 'pistol') category = 'pistol';
    else if (cat === 'sniper') category = 'sniper';
    else if (cat === 'knife') category = 'knife';
    else if (cat === 'grenade') category = 'grenade';
    else category = null;     // bomb / nothing visible
  }
  setHumanoidWeapon(bot.parts, category);
}

export function disposeBot(bot: Bot): void {
  disposeHumanoid(bot.parts);
}
