/** Reactive layer — fast (60 Hz) reflex behaviours that preempt the
 *  bot's planner / brain when something needs an immediate response.
 *  These are NOT decisions; they're animal instincts a planner
 *  shouldn't have to schedule:
 *
 *    - flashResponse: when blinded, turn away to limit further flash
 *      duration and crouch slightly so a follow-up shot misses high.
 *    - takeDamageFlinch: when shot from outside the view cone, snap
 *      aim toward the incoming direction for a brief window.
 *    - avoidMolly: when standing in a fire patch, force a panic step
 *      out — the brain is too slow to respond to "I'm burning".
 *    - panic (low-difficulty only): when very low HP and outnumbered,
 *      drop the current objective entirely and run for spawn.
 *
 *  Architecture: each tick, `tickReactive(bot, ctx, nowMs)` runs once
 *  per alive bot BEFORE the brain step. It mutates the bot's controller
 *  state (yaw / pitch / crouch) and the bot.objective when panic kicks
 *  in. The brain reads bot.brain.state as today; the only new contract
 *  is that the reactive layer can override controller intent for the
 *  current tick.
 *
 *  Personality coupling:
 *    - panic threshold scales with personality.riskAversion
 *    - flash-response strength scales with personality.patience
 *      (calmer bots turn less frantically)
 *    - flinch latency scales with difficulty.reactionMs
 *
 *  Determinism: any random tweak goes through the bot's seeded RNG via
 *  the brain's internal stream. The reactive layer itself does not call
 *  Math.random(). */

import type { Bot } from '../../entities/bot';
import { setBotObjective } from '../../entities/bot';
import type { FirePatchField } from '../../grenades/firePatch';
import { events } from '../../engine/events';
import { debugLog } from '../../engine/debugLog';

export interface ReactiveContext {
  fire: FirePatchField;
  /** Centroid of the bot's team spawn — panic retreats here. */
  spawnByTeam: { T: { x: number; z: number }; CT: { x: number; z: number } };
  /** When true, low-difficulty panic preempts (per-bot via difficulty). */
  panicEnabled: (bot: Bot) => boolean;
}

interface PerBotState {
  /** Last damage event from outside view cone — drives flinch. */
  lastDamageDirX: number;
  lastDamageDirZ: number;
  lastDamageMs: number;
  /** When the current flash override expires. */
  flashOverrideUntilMs: number;
  /** When the current flinch override expires. */
  flinchUntilMs: number;
  /** Sticky panic flag — set when the threshold first trips, cleared
   *  when HP recovers above 35 or only one enemy is alive. */
  panicActive: boolean;
}

const state = new Map<string, PerBotState>();

function getState(id: string): PerBotState {
  let s = state.get(id);
  if (!s) {
    s = {
      lastDamageDirX: 0, lastDamageDirZ: 0, lastDamageMs: -1,
      flashOverrideUntilMs: 0, flinchUntilMs: 0,
      panicActive: false,
    };
    state.set(id, s);
  }
  return s;
}

let installed = false;
/** Subscribe to combat:hit so the flinch trigger has the direction the
 *  damage came from. Runs once at boot. */
export function installReactive(): void {
  if (installed) return;
  installed = true;
  events.on('combat:hit', ({ victimId, dirX, dirZ, killing, tMs }) => {
    if (killing) return;
    const s = getState(victimId);
    s.lastDamageDirX = dirX;
    s.lastDamageDirZ = dirZ;
    s.lastDamageMs = tMs;
  });
}

/** Per-bot per-tick reflex pass. Mutates controller / objective in
 *  place. Cheap (constant-time per bot). */
export function tickReactive(
  bot: Bot,
  ctx: ReactiveContext,
  enemiesAlive: number,
  nowMs: number,
): void {
  if (!bot.character.alive) return;
  const s = getState(bot.id);
  const c = bot.character;
  const ctrl = bot.controller;

  // ── Flash response ────────────────────────────────────────────
  // While the character is blinded, swing yaw away from the source
  // (we approximate "source = previous facing" since perception's
  // flash setter doesn't carry the flash position) and force a small
  // crouch. Duration: until flashedUntilMs.
  const blindedUntil = c.flashedUntilMs ?? 0;
  if (blindedUntil > nowMs) {
    if (s.flashOverrideUntilMs < blindedUntil) {
      s.flashOverrideUntilMs = Math.min(blindedUntil, nowMs + 1200);
      // Patient bots turn less; jumpy bots flip 180.
      const turn = (Math.PI * 0.6) * (1.4 - bot.identity.personality.patience);
      // Sign pseudo-random but deterministic per flash — use the bot's
      // brain RNG indirectly via the bot id parity.
      const sign = bot.id.charCodeAt(bot.id.length - 1) % 2 === 0 ? 1 : -1;
      ctrl.state.yaw += turn * sign;
      if (debugLog.isEnabled('reactive')) {
        debugLog.reactive('flash', {
          t: nowMs, id: bot.id, name: bot.identity.name,
          patience: bot.identity.personality.patience,
          turnRad: Number((turn * sign).toFixed(2)),
          untilMs: blindedUntil,
        });
      }
    }
    // Pitch nudge: look down a touch so reactive spray goes high.
    ctrl.state.pitch = Math.min(Math.PI / 4, ctrl.state.pitch + 0.2);
  }

  // ── Take-damage flinch ────────────────────────────────────────
  // If we just took damage and the source is outside the view cone,
  // snap toward it for a brief window. Patient bots flinch less
  // (smaller fraction of full snap).
  if (s.lastDamageMs > 0 && nowMs - s.lastDamageMs < 220) {
    const dx = -s.lastDamageDirX;             // direction TO the shooter
    const dz = -s.lastDamageDirZ;
    const dot = Math.sin(ctrl.state.yaw) * dx + Math.cos(ctrl.state.yaw) * dz;
    // Outside the front 90° cone — flinch. dot < cos(45°) ≈ 0.707.
    if (dot < 0.707) {
      const desiredYaw = Math.atan2(dx, dz);
      const k = 0.45 * (1.3 - 0.6 * bot.identity.personality.patience);
      ctrl.state.yaw = lerpAngle(ctrl.state.yaw, desiredYaw, Math.min(0.8, k));
      const wasFlinching = s.flinchUntilMs > nowMs;
      s.flinchUntilMs = nowMs + 200;
      if (!wasFlinching && debugLog.isEnabled('reactive')) {
        debugLog.reactive('flinch', {
          t: nowMs, id: bot.id, name: bot.identity.name,
          fromDir: { x: Number(dx.toFixed(2)), z: Number(dz.toFixed(2)) },
          dot: Number(dot.toFixed(2)),
        });
      }
    }
  }

  // ── Avoid molotov ─────────────────────────────────────────────
  // Standing in a fire patch is universally bad — even Easy bots
  // sprint out. We do this by force-redirecting the objective for
  // 600 ms to a position 3 m away in the direction of the bot's
  // current facing (the brain re-pathfinds next frame). This is
  // crude but reliable and doesn't require search.
  if (ctx.fire.isInside(c.pos.x, c.pos.z)) {
    const fwdX = Math.sin(ctrl.state.yaw);
    const fwdZ = Math.cos(ctrl.state.yaw);
    const escape = { x: c.pos.x + fwdX * 3, z: c.pos.z + fwdZ * 3 };
    setBotObjective(bot, escape.x, escape.z);
    if (debugLog.isEnabled('reactive')) {
      debugLog.reactive('molly', {
        t: nowMs, id: bot.id, name: bot.identity.name,
        from: { x: Number(c.pos.x.toFixed(1)), z: Number(c.pos.z.toFixed(1)) },
        to: { x: Number(escape.x.toFixed(1)), z: Number(escape.z.toFixed(1)) },
      });
    }
  }

  // ── Panic (low-difficulty only) ───────────────────────────────
  // Sticky: trips once HP drops below threshold AND outnumbered;
  // releases when HP recovers OR only one enemy left.
  if (ctx.panicEnabled(bot)) {
    const threshold = 18 + 22 * bot.identity.personality.riskAversion;
    const outnumbered = enemiesAlive >= 2;
    if (!s.panicActive && c.hp <= threshold && outnumbered) {
      s.panicActive = true;
      if (debugLog.isEnabled('reactive')) {
        debugLog.reactive('panic-on', {
          t: nowMs, id: bot.id, name: bot.identity.name,
          hp: c.hp, threshold: Number(threshold.toFixed(1)),
          enemiesAlive,
        });
      }
    } else if (s.panicActive && (c.hp >= 50 || enemiesAlive <= 1)) {
      s.panicActive = false;
      if (debugLog.isEnabled('reactive')) {
        debugLog.reactive('panic-off', {
          t: nowMs, id: bot.id, name: bot.identity.name,
          hp: c.hp, enemiesAlive,
        });
      }
    }
    if (s.panicActive) {
      // Drop the current objective for spawn; clear plant/defuse intent
      // so the bot doesn't loiter on the bombsite while panicking.
      const spawn = ctx.spawnByTeam[c.team];
      setBotObjective(bot, spawn.x, spawn.z);
      bot.brain.wantsPlant = false;
      bot.brain.wantsDefuse = false;
      bot.brain.pendingLineup = null;
    }
  } else {
    s.panicActive = false;
  }
}

/** Test/dev helper. */
export function _resetReactiveState(): void {
  state.clear();
  installed = false;
}

function lerpAngle(a: number, b: number, k: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * k;
}
