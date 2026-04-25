/** Per-bot perception. Runs at 10 Hz, staggered across bots so the cost
 *  is even (one bot ticks per ~6 sim frames at 60 Hz). Maintains a
 *  KnownEnemies map: who the bot has seen, where, and how confident the
 *  intel is.
 *
 *  Pass 2 covers vision (cone test + LOS) only. Pass 3 layers in sound
 *  events with a degraded confidence flag. Cross-team blackboard sharing
 *  is M5; for now each bot only knows what *it* has seen or heard. */

import type { Character } from '../entities/character';
import { hitboxPose } from '../entities/character';
import type { WorldQuery } from '../player/physics';
import type { BotDifficulty } from './difficulty';
import type { SmokeField } from '../grenades/smokeField';

export type EnemyConfidence = 'visible' | 'recent' | 'sound';

export interface KnownEnemy {
  id: string;
  x: number; y: number; z: number;
  /** Sim ms when this entry was last refreshed. */
  lastSeenMs: number;
  confidence: EnemyConfidence;
}

export const PERCEPTION_INTERVAL_MS = 100;       // 10 Hz
export const VISIBLE_DECAY_MS = 250;             // grace before 'visible' → 'recent'
export const RECENT_FORGET_MS = 3_000;           // drop entries older than this

export class Perception {
  readonly known = new Map<string, KnownEnemy>();
  /** Set of enemy ids currently in line-of-sight this tick. Refreshed each
   *  perception tick; drives 'visible' decay. */
  private currentlyVisible = new Set<string>();
  /** Sim ms of the last perception tick. Initialised so the first tick
   *  fires shortly after spawn (avoids 9 bots ticking on the same frame). */
  private nextTickMs = 0;

  constructor(private readonly difficulty: BotDifficulty, phaseMs: number) {
    this.nextTickMs = phaseMs;
  }

  /** Check if this perception tick should run now and run it if so. */
  maybeStep(self: Character, characters: Character[], query: WorldQuery, nowMs: number, smoke?: SmokeField | null): void {
    if (nowMs < this.nextTickMs) {
      // Still apply confidence decay every frame so 'visible' → 'recent'
      // happens promptly when the target ducks behind cover.
      this.decay(nowMs);
      return;
    }
    this.nextTickMs = nowMs + PERCEPTION_INTERVAL_MS;
    this.tick(self, characters, query, nowMs, smoke);
  }

  /** Closest currently-known enemy that we'd actually engage. Prefers
   *  'visible' over 'recent' over 'sound'; within a confidence tier picks
   *  the closest. Returns null when nothing's tracked. */
  bestTarget(selfX: number, selfZ: number): KnownEnemy | null {
    let best: KnownEnemy | null = null;
    let bestKey = -Infinity;
    for (const e of this.known.values()) {
      const dx = e.x - selfX;
      const dz = e.z - selfZ;
      const d2 = dx * dx + dz * dz;
      // Higher key = better. Confidence dominates distance.
      const tier = e.confidence === 'visible' ? 1e6 : e.confidence === 'recent' ? 1e3 : 0;
      const key = tier - d2;
      if (key > bestKey) {
        bestKey = key;
        best = e;
      }
    }
    return best;
  }

  hasVisible(): boolean {
    for (const e of this.known.values()) if (e.confidence === 'visible') return true;
    return false;
  }

  /** Inject a heard event from a gunshot or footstep emitter. Sound has
   *  the lowest confidence — bots will turn to face the noise but won't
   *  fire blind into it. We refuse to downgrade a recent sighting. */
  reportSound(id: string, x: number, y: number, z: number, nowMs: number): void {
    const existing = this.known.get(id);
    if (existing && existing.lastSeenMs > nowMs - 1000 && existing.confidence !== 'sound') {
      return;
    }
    this.known.set(id, { id, x, y, z, lastSeenMs: nowMs, confidence: 'sound' });
  }

  private tick(self: Character, characters: Character[], query: WorldQuery, nowMs: number, smoke?: SmokeField | null): void {
    this.currentlyVisible.clear();
    // A flashed bot can't see anything new this tick — they keep their
    // last-known intel but visibility decays as if nobody was in sight.
    // The flash duration also drops their effective FOV / range, but
    // for this pass an all-or-nothing block is enough to make a flash
    // tactically meaningful.
    if (self.flashedUntilMs !== undefined && nowMs < self.flashedUntilMs) {
      this.decay(nowMs);
      return;
    }
    const eyeX = self.pos.x;
    const eyeY = self.pos.y + self.currentEye;
    const eyeZ = self.pos.z;
    const fX = Math.sin(self.yaw) * Math.cos(self.pitch);
    const fY = Math.sin(self.pitch);
    const fZ = Math.cos(self.yaw) * Math.cos(self.pitch);
    const cosFovHalf = Math.cos(this.difficulty.fovHalfRad);
    const rangeSq = this.difficulty.visionRangeM * this.difficulty.visionRangeM;

    for (const c of characters) {
      if (!c.alive) continue;
      if (c.id === self.id) continue;
      if (c.team === self.team) continue;
      const pose = hitboxPose(c);
      const tx = pose.baseX;
      const tz = pose.baseZ;
      const ty = pose.baseY + pose.eye * 0.6;          // chest-ish
      const dx = tx - eyeX;
      const dy = ty - eyeY;
      const dz = tz - eyeZ;
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 > rangeSq) continue;
      const dist = Math.sqrt(dist2);
      // Cone test
      const cosAngle = (dx * fX + dy * fY + dz * fZ) / dist;
      if (cosAngle < cosFovHalf) continue;
      // LOS — block only on world geometry. Any character intervening is
      // ignored for the LOS check itself (hitbox raycasts get more nuanced
      // in CS:GO; we accept that "I can see them through a teammate" can
      // sometimes happen, which is fine for our scope).
      const inv = 1 / dist;
      const ndx = dx * inv, ndy = dy * inv, ndz = dz * inv;
      const blocker = query.rayWorld(eyeX, eyeY, eyeZ, ndx, ndy, ndz, dist - 0.05);
      if (blocker) continue;
      // Smoke chord: if the cumulative chord through any active smoke
      // exceeds the field's threshold before reaching the target, the
      // bot can't see them this tick.
      if (smoke) {
        const blockT = smoke.blockingT(eyeX, eyeY, eyeZ, ndx, ndy, ndz, dist - 0.05);
        if (blockT !== null) continue;
      }
      // Visible.
      this.currentlyVisible.add(c.id);
      this.known.set(c.id, {
        id: c.id,
        x: c.pos.x, y: c.pos.y + c.currentEye * 0.5, z: c.pos.z,
        lastSeenMs: nowMs,
        confidence: 'visible',
      });
    }
    this.decay(nowMs);
  }

  private decay(nowMs: number): void {
    for (const [id, e] of this.known) {
      if (e.confidence === 'visible' && !this.currentlyVisible.has(id)) {
        if (nowMs - e.lastSeenMs > VISIBLE_DECAY_MS) {
          this.known.set(id, { ...e, confidence: 'recent' });
        }
      }
      if (nowMs - e.lastSeenMs > RECENT_FORGET_MS) {
        this.known.delete(id);
      }
    }
  }
}
