/** Bomb (C4) logic. The bomb has three meaningful states:
 *
 *    carried   — held by a T; the player can plant in a bomb site
 *    planted   — armed; counting down 40s; CTs can defuse
 *    finished  — defused or exploded
 *
 *  Plant action: T standing inside a bomb site polygon, holds E (handled
 *  by the input system) — a 3s plant action runs. Movement that leaves
 *  the bomb site or releasing E cancels and resets.
 *
 *  Defuse action: CT within ~1m of the planted bomb, holds E. 10s without
 *  kit, 5s with kit. Movement that breaks the proximity cancels — but the
 *  progress is preserved (CS:GO behavior).
 *
 *  This module is mostly pure: it owns plain state and exposes step() that
 *  consumes intent and time. Side effects (sound, HUD beeps) are emitted
 *  via the event bus. */

import type { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { events } from '../engine/events';
import { pointInPolygon2D } from '../map/world';
import type { World } from '../map/world';

export const PLANT_TIME_MS = 3000;
export const DEFUSE_TIME_NO_KIT_MS = 10_000;
export const DEFUSE_TIME_KIT_MS = 5000;
export const BOMB_TIMER_MS = 40_000;
export const BOMB_DAMAGE_RADIUS_M = 14.0;
export const BOMB_MAX_DAMAGE = 500;          // very lethal at center; falloff applies

export type BombPhase = 'carried' | 'planting' | 'planted' | 'defusing' | 'finished';

export interface BombState {
  phase: BombPhase;
  /** Carrier player id, while carried/planting. */
  carrierId: string | null;
  /** World position of the bomb. While carried, mirrors carrier. */
  pos: { x: number; y: number; z: number } | null;
  /** Plant site, set when planted (or planting). */
  site: 'A' | 'B' | null;
  /** Plant progress timer in ms (0..PLANT_TIME_MS). */
  plantProgressMs: number;
  /** Defuse progress timer (0..defuseTimeMs). Persists across cancels. */
  defuseProgressMs: number;
  /** Defuse total time (depends on kit). */
  defuseTimeMs: number;
  /** Defuser id while defusing. */
  defuserId: string | null;
  /** Wall-clock time of plant (ms in sim). */
  plantedAtMs: number;
  /** Computed time of explosion (= plantedAtMs + BOMB_TIMER_MS). */
  explodeAtMs: number;
  /** Outcome when phase === 'finished'. */
  outcome: 'defused' | 'exploded' | null;
}

export function makeBombState(carrierId: string): BombState {
  return {
    phase: 'carried',
    carrierId,
    pos: null,
    site: null,
    plantProgressMs: 0,
    defuseProgressMs: 0,
    defuseTimeMs: DEFUSE_TIME_NO_KIT_MS,
    defuserId: null,
    plantedAtMs: 0,
    explodeAtMs: 0,
    outcome: null,
  };
}

export interface PlanterIntent {
  /** Player id of the alive T currently trying to plant. */
  id: string;
  /** Position. */
  pos: Vector3;
  /** Are they holding the plant key this tick? */
  holdingPlant: boolean;
  /** Are they alive? */
  alive: boolean;
}

export interface DefuserIntent {
  id: string;
  pos: Vector3;
  /** Are they holding the defuse key this tick? */
  holdingDefuse: boolean;
  /** Has a kit (CT only)? */
  hasKit: boolean;
  alive: boolean;
}

/** Step the bomb state by one sim tick. Returns a copy with mutations applied. */
export function stepBomb(
  state: BombState,
  dtMs: number,
  nowMs: number,
  world: World,
  planter: PlanterIntent | null,
  defusers: DefuserIntent[],
): BombState {
  const out = { ...state };

  switch (out.phase) {
    case 'carried': {
      // While carried, position mirrors carrier (set by main loop directly).
      if (planter && planter.id === out.carrierId && planter.alive && planter.holdingPlant) {
        // Determine which bomb site they're in.
        const site = bombSiteAt(world, planter.pos.x, planter.pos.y, planter.pos.z);
        if (site !== null) {
          out.phase = 'planting';
          out.site = site;
          out.plantProgressMs = 0;
          out.pos = { x: planter.pos.x, y: planter.pos.y, z: planter.pos.z };
        }
      }
      break;
    }

    case 'planting': {
      // Cancel if the planter dies, releases the key, or leaves the site.
      const cancel = !planter
        || planter.id !== out.carrierId
        || !planter.alive
        || !planter.holdingPlant
        || bombSiteAt(world, planter.pos.x, planter.pos.y, planter.pos.z) !== out.site;
      if (cancel) {
        out.phase = 'carried';
        out.plantProgressMs = 0;
        out.site = null;
        out.pos = null;
        break;
      }
      out.plantProgressMs += dtMs;
      // Update bomb visual position to follow the planter's feet.
      out.pos = { x: planter!.pos.x, y: planter!.pos.y, z: planter!.pos.z };
      if (out.plantProgressMs >= PLANT_TIME_MS) {
        out.phase = 'planted';
        out.plantedAtMs = nowMs;
        out.explodeAtMs = nowMs + BOMB_TIMER_MS;
        out.carrierId = null;          // bomb is no longer carried
        events.emit('match:bombPlanted', {
          site: out.site!,
          x: out.pos!.x, y: out.pos!.y, z: out.pos!.z,
          tMs: nowMs,
        });
      }
      break;
    }

    case 'planted': {
      // Check explosion.
      if (nowMs >= out.explodeAtMs) {
        out.phase = 'finished';
        out.outcome = 'exploded';
        events.emit('match:bombExploded', {
          x: out.pos!.x, y: out.pos!.y, z: out.pos!.z, tMs: nowMs,
        });
        break;
      }
      // Pick a defuser candidate: alive CT within 1.0m of the bomb who is
      // pressing the defuse key. (Multiple is allowed but the closest wins;
      // CS:GO actually allows only one defuser at a time.)
      const cand = closestEligibleDefuser(out.pos!, defusers);
      if (cand) {
        out.phase = 'defusing';
        out.defuserId = cand.id;
        out.defuseTimeMs = cand.hasKit ? DEFUSE_TIME_KIT_MS : DEFUSE_TIME_NO_KIT_MS;
      }
      break;
    }

    case 'defusing': {
      const def = defusers.find((d) => d.id === out.defuserId);
      const cancel = !def || !def.alive || !def.holdingDefuse || distanceXZ(out.pos!, def.pos) > 1.0;
      if (cancel) {
        out.phase = 'planted';
        out.defuserId = null;
        // Progress is preserved per CS:GO behavior.
        break;
      }
      // Check explosion races defuse.
      if (nowMs >= out.explodeAtMs) {
        out.phase = 'finished';
        out.outcome = 'exploded';
        events.emit('match:bombExploded', {
          x: out.pos!.x, y: out.pos!.y, z: out.pos!.z, tMs: nowMs,
        });
        break;
      }
      out.defuseProgressMs += dtMs;
      if (out.defuseProgressMs >= out.defuseTimeMs) {
        out.phase = 'finished';
        out.outcome = 'defused';
        events.emit('match:bombDefused', {
          defuserId: out.defuserId!,
          x: out.pos!.x, y: out.pos!.y, z: out.pos!.z, tMs: nowMs,
        });
      }
      break;
    }

    case 'finished':
      // No-op — round logic will reset.
      break;
  }

  return out;
}

function bombSiteAt(world: World, x: number, y: number, z: number): 'A' | 'B' | null {
  for (const s of world.bombSites) {
    if (y < s.yMin - 0.1 || y > s.yMax + 0.1) continue;
    if (pointInPolygon2D(x, z, s.polygon)) return s.site;
  }
  return null;
}

function closestEligibleDefuser(pos: { x: number; y: number; z: number }, defusers: DefuserIntent[]): DefuserIntent | null {
  let best: DefuserIntent | null = null;
  let bestD2 = Infinity;
  for (const d of defusers) {
    if (!d.alive || !d.holdingDefuse) continue;
    const dx = d.pos.x - pos.x;
    const dz = d.pos.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < 1.0 * 1.0 && d2 < bestD2) {
      best = d;
      bestD2 = d2;
    }
  }
  return best;
}

function distanceXZ(p: { x: number; y: number; z: number }, q: Vector3): number {
  const dx = q.x - p.x;
  const dz = q.z - p.z;
  return Math.hypot(dx, dz);
}
