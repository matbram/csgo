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
import { CharacterController, DEFAULT_TUNABLES } from '../player/controller';
import type { WorldQuery } from '../player/physics';
import { defaultInventory } from '../weapons/inventory';
import {
  createHumanoid, syncHumanoidPose, disposeHumanoid,
  type HumanoidParts,
} from './humanoid';
import type { PathPoint } from '../nav/astar';
import type { PathService } from '../nav/pathService';

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
}

let nextBotId = 1;

export function createBot(
  team: 'T' | 'CT',
  spawnX: number, spawnY: number, spawnZ: number, spawnYaw: number,
  query: WorldQuery,
  opts?: { id?: string; armor?: number; helmet?: boolean },
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
  };
  syncHumanoidPose(parts, character.pos.x, character.pos.y, character.pos.z, character.yaw, character.currentEye, character.currentHeight);
  return {
    id,
    character,
    controller,
    parts,
    path: null,
    pathIdx: 0,
    objective: null,
    nextPlanAfterMs: 0,
  };
}

/** Sync the controller's spawn from the character record (which the
 *  match's roster reset writes to). Call after `resetCharacterForRound`
 *  and before stepping the bot for the new round. */
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
 *  no-op (they keep their ragdoll-tipped pose). */
export function stepBot(bot: Bot, dtMs: number, nowMs: number, paths: PathService): void {
  if (!bot.character.alive) {
    bot.character.speed = 0;
    bot.character.inAir = false;
    return;
  }

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
    } else if (hadBudget) {
      bot.nextPlanAfterMs = nowMs + PATH_RETRY_MS;
    }
  }

  // Compute wishDir toward the current waypoint.
  let wishX = 0, wishZ = 0;
  if (bot.path && bot.pathIdx < bot.path.length) {
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

  // Face the movement direction. With no movement, keep last yaw.
  if (wishX !== 0 || wishZ !== 0) {
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
  switch (inv.active) {
    case 'primary':   return inv.primary?.def.moveSpeedScale ?? 1;
    case 'secondary': return inv.secondary?.def.moveSpeedScale ?? 1;
    case 'knife':     return inv.knife.def.moveSpeedScale;
    case 'c4':        return inv.c4?.def.moveSpeedScale ?? 1;
  }
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

/** Per render-frame: position + orient the humanoid mesh. Tipped-over
 *  pose for dead bots — same look as the legacy dummies. */
export function syncBotMesh(bot: Bot): void {
  const c = bot.character;
  if (!c.alive) {
    bot.parts.root.rotation.x = -Math.PI / 2.2;
    bot.parts.root.position.set(c.pos.x, c.pos.y + 0.2, c.pos.z);
    return;
  }
  syncHumanoidPose(bot.parts, c.pos.x, c.pos.y, c.pos.z, c.yaw, c.currentEye, c.currentHeight);
}

export function disposeBot(bot: Bot): void {
  disposeHumanoid(bot.parts);
}
