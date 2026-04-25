/** Fire patches — molotov + incendiary impact spreads. Each patch is a
 *  flat circle on the ground that ticks damage every 250 ms while a
 *  character's capsule center is inside its radius. Patches expire after
 *  ~7 s and are then released to the pool. */

import type { Character } from '../entities/character';

const TICK_MS = 250;
const DPS = 40;             // damage per second; tick damage = DPS * (TICK_MS/1000)
const DEFAULT_RADIUS_M = 2.4;
const DEFAULT_DURATION_MS = 7000;

export interface FirePatch {
  id: number;
  x: number; y: number; z: number;
  radius: number;
  expiresMs: number;
  /** Sim ms at next damage tick. */
  nextTickMs: number;
  /** Throwing character id — used so the kill credit goes to them when
   *  the burn finishes a target. */
  throwerId: string;
}

export class FirePatchField {
  private patches: FirePatch[] = [];
  private nextId = 1;

  spawn(x: number, y: number, z: number, throwerId: string, nowMs: number, opts?: { radius?: number; durationMs?: number }): FirePatch {
    const patch: FirePatch = {
      id: this.nextId++,
      x, y, z,
      radius: opts?.radius ?? DEFAULT_RADIUS_M,
      expiresMs: nowMs + (opts?.durationMs ?? DEFAULT_DURATION_MS),
      nextTickMs: nowMs + TICK_MS,
      throwerId,
    };
    this.patches.push(patch);
    return patch;
  }

  list(): ReadonlyArray<FirePatch> {
    return this.patches;
  }

  /** Returns true if (x, z) is inside any active patch. Bot pathing
   *  uses this to avoid walking through fire. */
  isInside(x: number, z: number): boolean {
    for (const p of this.patches) {
      const dx = x - p.x;
      const dz = z - p.z;
      if (dx * dx + dz * dz <= p.radius * p.radius) return true;
    }
    return false;
  }

  /** Per-tick: deal damage to characters inside any patch and prune
   *  expired ones. */
  step(nowMs: number, characters: ReadonlyArray<Character>): void {
    let w = 0;
    for (let r = 0; r < this.patches.length; r++) {
      const p = this.patches[r]!;
      if (nowMs >= p.expiresMs) continue;
      while (nowMs >= p.nextTickMs) {
        const tickDamage = Math.floor(DPS * TICK_MS / 1000);
        for (const c of characters) {
          if (!c.alive) continue;
          const dx = c.pos.x - p.x;
          const dz = c.pos.z - p.z;
          if (dx * dx + dz * dz > p.radius * p.radius) continue;
          // Burn ignores armor (CS:GO behaviour).
          c.hp = Math.max(0, c.hp - tickDamage);
          if (c.hp <= 0) c.alive = false;
        }
        p.nextTickMs += TICK_MS;
      }
      if (w !== r) this.patches[w] = p;
      w++;
    }
    this.patches.length = w;
  }

  clear(): void {
    this.patches.length = 0;
  }
}
