/** Wires the existing typed event bus + per-tick perception state into
 *  the comms layer. One install on bootstrap; events fire from combat /
 *  match / grenade / character footstep listeners and synthesise the
 *  player-style callouts that make a team feel like a team.
 *
 *  Why a separate module from `callouts.ts`:
 *    - `callouts.ts` is the data + cooldown logic; `triggers.ts` is the
 *      glue. Tests pin `tryEmit` directly without faking the event bus.
 *    - Per-tick triggers (low HP, "I see new enemies this tick") live
 *      here too; called from main.ts each AI tick. */

import { events } from '../../engine/events';
import { tryEmit, isDelivered, type Callout } from './callouts';
import type { Bot } from '../../entities/bot';
import type { TeamBlackboard } from '../blackboard';
import type { World } from '../../map/world';
import { playCalloutCue } from '../../audio/audio';

export interface CommsContext {
  /** Resolve a bot id back to its live record (so triggers can read pos
   *  + team without scanning the bots array each event). */
  botById: Map<string, Bot>;
  tBoard: TeamBlackboard;
  ctBoard: TeamBlackboard;
  world: World;
}

let installed = false;
let ctxRef: CommsContext | null = null;

export function installCommsTriggers(ctx: CommsContext): void {
  ctxRef = ctx;
  if (installed) return;
  installed = true;

  // ---- combat:hit — victim takes damage. Two callouts:
  //      - low HP threshold cross → 'lowHp'
  //      - heavy damage from outside the bot's view cone → 'needBackup'
  //        (approximated as: dmg ≥ 50 in one event)
  events.on('combat:hit', ({ victimId, attackerId, damage, killing }) => {
    if (killing) return; // 'enemyDown' / 'tradeMe' handled by combat:kill
    const ctx = ctxRef;
    if (!ctx) return;
    const victim = ctx.botById.get(victimId);
    if (!victim || !victim.character.alive) return;

    if (victim.character.hp > 0 && victim.character.hp <= 35) {
      emit(victim, 'lowHp');
    } else if (damage >= 50) {
      emit(victim, 'needBackup', { whereByPos: true });
    }
    void attackerId;
  });

  // ---- combat:kill — short post-hoc callouts. Killer announces the
  //      down; the victim, if a bot, calls 'tradeMe' so a teammate can
  //      swing the angle. We resolve enemiesAlive *after* the kill via
  //      the blackboard refresh elsewhere; for now the killer always
  //      emits 'enemyDown' (not 'oneLeft' until phase 5 rewires).
  events.on('combat:kill', ({ attackerId, victimId }) => {
    const ctx = ctxRef;
    if (!ctx) return;
    const attacker = ctx.botById.get(attackerId);
    if (attacker && attacker.character.alive) {
      // Killer announces from the victim's location ("one down B"
      // reads better with the body's callout than the killer's).
      const victim = ctx.botById.get(victimId);
      const where = victim
        ? ctx.world.calloutAt(victim.character.pos.x, victim.character.pos.y, victim.character.pos.z) ?? null
        : null;
      const pos = victim ? victim.character.pos : attacker.character.pos;
      emit(attacker, 'enemyDown', {
        where,
        pos: { x: pos.x, y: pos.y, z: pos.z },
      });
    }
    const victim = ctx.botById.get(victimId);
    if (victim) {
      // Victim is dead but the body still has a position; that's where
      // we attribute the trade-me from.
      emit(victim, 'tradeMe', {
        whereByPos: true,
        enemyId: attackerId,
      });
    }
  });

  // ---- match:bombPlanted — once-per-team announcement.
  events.on('match:bombPlanted', ({ site, x, y, z }) => {
    const ctx = ctxRef;
    if (!ctx) return;
    // Both teams "hear" the plant — but only the planter side actually
    // calls it as info. CT side gets a 'bombHeard' from each alive bot
    // close enough to the plant; capped by the per-team rate gate.
    for (const board of [ctx.tBoard, ctx.ctBoard] as const) {
      const kind = board.side === 'T' ? 'bombPlantedCall' : 'bombHeard';
      // Pick the closest alive bot on this team to be the speaker.
      let speaker: Bot | null = null;
      let bestSq = Infinity;
      for (const bot of ctx.botById.values()) {
        if (bot.character.team !== board.side || !bot.character.alive) continue;
        const dx = bot.character.pos.x - x;
        const dz = bot.character.pos.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestSq) { speaker = bot; bestSq = d2; }
      }
      if (speaker) {
        emit(speaker, kind, { site, pos: { x, y, z } });
      }
    }
  });

  // ---- grenade:detonated — flash pop near a teammate triggers a
  //      'flashed' call from anyone caught in it. Cheap proxy: any bot
  //      within the flash radius (8 m) from the detonation.
  events.on('grenade:detonated', ({ kind, x, y, z }) => {
    const ctx = ctxRef;
    if (!ctx) return;
    if (kind !== 'flashbang') return;
    const RADIUS_SQ = 8 * 8;
    for (const bot of ctx.botById.values()) {
      if (!bot.character.alive) continue;
      const dx = bot.character.pos.x - x;
      const dy = bot.character.pos.y - y;
      const dz = bot.character.pos.z - z;
      if (dx * dx + dy * dy + dz * dz > RADIUS_SQ) continue;
      // Coarse — actually checking facing/LOS is the flash system's job
      // (which sets character.flashedUntilMs). We re-use that signal
      // below in tickComms for a more reliable trigger; this listener
      // is best-effort to catch the immediate moment.
      emit(bot, 'flashed');
    }
  });

  // ---- combat:reload — emitted by firing controller. Bot announces
  //      out-of-combat reloads so a teammate knows to swap forward.
  events.on('combat:reload', ({ shooterId }) => {
    const ctx = ctxRef;
    if (!ctx) return;
    const bot = ctx.botById.get(shooterId);
    if (!bot || !bot.character.alive) return;
    // Only call it when no visible enemy — mid-fight reloads are silent.
    let visible = false;
    for (const e of bot.perception.known.values()) {
      if (e.confidence === 'visible') { visible = true; break; }
    }
    if (!visible) emit(bot, 'reloading');
  });
}

/** Push delivered comms intel into receiver perception. A teammate's
 *  `spottedEnemy` (or `lurkSpotted`) callout, after this bot's
 *  commsLatencyMs has elapsed, surfaces as a 'sound'-tier entry on the
 *  receiver's own KnownEnemies map.
 *
 *  We use 'sound' confidence (not 'recent') because:
 *    - 'visible' would let the bot fire blind based on hearsay.
 *    - 'recent' is reserved for first-hand sightings the bot just lost.
 *    - 'sound' makes the bot face the call but still requires LOS to
 *      shoot — exactly how a real player reacts to a teammate's call.
 *
 *  Called from main.ts after `aggregateKnown` so the team aggregation
 *  doesn't immediately downgrade these entries back. */
export function applyCommsIntel(bots: ReadonlyArray<Bot>, nowMs: number): void {
  const ctx = ctxRef;
  if (!ctx) return;
  for (const board of [ctx.tBoard, ctx.ctBoard] as const) {
    for (const bot of bots) {
      if (!bot.character.alive) continue;
      if (bot.character.team !== board.side) continue;
      for (const c of board.comms.log) {
        if (c.emitterId === bot.id) continue;
        if (!isDelivered(c, bot.id, bot.commsLatencyMs, nowMs)) continue;
        if (c.kind !== 'spottedEnemy' && c.kind !== 'lurkSpotted' && c.kind !== 'tradeMe') continue;
        // Use the callout's recorded position; if it carries an enemy
        // id we keep it stable so the bot's own future sightings can
        // promote the entry.
        const enemyId = c.enemyId ?? `__call_${c.id}`;
        bot.perception.reportSound(enemyId, c.pos.x, c.pos.y, c.pos.z, c.tEmitMs);
      }
    }
  }
}

/** Per-tick (5 Hz is plenty) trigger that catches state edges the bus
 *  doesn't surface as discrete events: a bot acquiring a new visible
 *  enemy, or the bot's flashedUntilMs going from 0 → set. Called from
 *  main.ts' AI tick. */
export function tickComms(bots: ReadonlyArray<Bot>, nowMs: number): void {
  const ctx = ctxRef;
  if (!ctx) return;
  for (const bot of bots) {
    if (!bot.character.alive) continue;
    // 'spottedEnemy' — emit when the bot's own perception has at least
    // one visible enemy and the cooldown allows. We compute the count
    // and the most-frequent callout id.
    const visibleEnemies: { id: string; x: number; y: number; z: number }[] = [];
    for (const e of bot.perception.known.values()) {
      if (e.confidence === 'visible') visibleEnemies.push(e);
    }
    if (visibleEnemies.length > 0) {
      // Pick the closest enemy's location as the callout reference.
      let nearest = visibleEnemies[0]!;
      let bestSq = sq(nearest.x - bot.character.pos.x) + sq(nearest.z - bot.character.pos.z);
      for (let i = 1; i < visibleEnemies.length; i++) {
        const e = visibleEnemies[i]!;
        const d2 = sq(e.x - bot.character.pos.x) + sq(e.z - bot.character.pos.z);
        if (d2 < bestSq) { nearest = e; bestSq = d2; }
      }
      const where = ctx.world.calloutAt(nearest.x, nearest.y, nearest.z) ?? null;
      emit(bot, 'spottedEnemy', {
        where,
        count: visibleEnemies.length,
        pos: { x: nearest.x, y: nearest.y, z: nearest.z },
        enemyId: nearest.id,
      });
    }
    // 'flashed' — emitted on the rising edge of flashedUntilMs > nowMs.
    // The grenade:detonated handler covers the typical case but flashes
    // can also arrive via late LOS resolution; this catches stragglers.
    const flashedNow = (bot.character.flashedUntilMs ?? 0) > nowMs;
    if (flashedNow) emit(bot, 'flashed');
  }
}

function sq(x: number): number { return x * x; }

/** Helper: resolve emitter's pos + side, run tryEmit, fire audio cue.
 *  `whereByPos` means "look up the emitter's current callout"; useful
 *  when the caller hasn't precomputed it. */
function emit(
  bot: Bot,
  kind: Callout['kind'],
  opts?: {
    where?: import('../../map/types').CalloutId | null;
    whereByPos?: boolean;
    pos?: { x: number; y: number; z: number };
    site?: 'A' | 'B';
    enemyId?: string;
    count?: number;
    nade?: Callout['nade'];
  },
): void {
  const ctx = ctxRef;
  if (!ctx) return;
  const board = bot.character.team === 'T' ? ctx.tBoard : ctx.ctBoard;
  const pos = opts?.pos ?? { x: bot.character.pos.x, y: bot.character.pos.y, z: bot.character.pos.z };
  let where = opts?.where;
  if (where === undefined && opts?.whereByPos) {
    where = ctx.world.calloutAt(pos.x, pos.y, pos.z) ?? null;
  }
  const c = tryEmit({
    state: board.comms,
    bb: board,
    emitterId: bot.id,
    side: bot.character.team,
    kind,
    nowMs: simNowMs(),
    pos,
    where,
    site: opts?.site,
    enemyId: opts?.enemyId,
    count: opts?.count,
    nade: opts?.nade,
  });
  if (c) {
    playCalloutCue(c.kind, c.pos.x, c.pos.y, c.pos.z);
  }
}

// We pull sim time from the game loop via a small lazy hook — rather
// than threading it through every event listener. main.ts updates this
// at the top of each frame.
let _simNowMs = 0;
export function setCommsSimNow(simMs: number): void { _simNowMs = simMs; }
function simNowMs(): number { return _simNowMs; }

/** Test/teardown helper. */
export function uninstallCommsTriggers(): void {
  installed = false;
  ctxRef = null;
  _simNowMs = 0;
}
