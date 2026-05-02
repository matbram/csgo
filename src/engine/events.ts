/** Typed pub/sub event bus. Single global instance is fine for this project's scope.
 *  Listeners registered for unknown keys are still type-safe because the
 *  `EventMap` interface is the source of truth — extend it where new events
 *  are introduced. */

export interface EventMap {
  // Engine lifecycle
  'engine:beforeRender': { dtMs: number };
  'engine:afterRender': { dtMs: number };
  'sim:tick': { dtMs: number; tMs: number };
  // Input
  'input:pointerLockChanged': { locked: boolean };
  'input:resize': { width: number; height: number };
  // Debug
  'debug:toggle': { enabled: boolean };
  // Combat
  'combat:fire': {
    shooterId: string;
    weapon: string;
    ox: number; oy: number; oz: number;
    dx: number; dy: number; dz: number;
    sprayIndex: number;
    tMs: number;
  };
  'combat:bulletImpact': {
    x: number; y: number; z: number;
    nx: number; ny: number; nz: number;
    surface: string;
    distance: number;
    tMs: number;
  };
  'combat:tracer': {
    sx: number; sy: number; sz: number;
    ex: number; ey: number; ez: number;
    tMs: number;
  };
  'combat:hit': {
    attackerId: string;
    victimId: string;
    weapon: string;
    /** Coarse damage class — head/chest/stomach/arm/leg. Drives the
     *  CS:GO damage multiplier; the HUD formats kill feed text from it. */
    hitbox: string;
    /** Precise anatomical segment struck (or randomly chosen for
     *  corpse hits): head, chest, stomach, upperArm/forearm/hand,
     *  thigh/shin/foot. Visuals route dismemberment off this. */
    segment:
      | 'head' | 'chest' | 'stomach'
      | 'upperArm' | 'forearm' | 'hand'
      | 'thigh' | 'shin' | 'foot';
    /** Side of the body the segment is on. Null for centre-line
     *  segments (head/chest/stomach), 'left' or 'right' otherwise. */
    side: 'left' | 'right' | null;
    damage: number;
    headshot: boolean;
    killing: boolean;
    /** True when the bullet struck an already-dead body. The damage
     *  applied is 0, no kill credit, but visuals still fire the
     *  full gore stack (gibs + blood) so corpses can be mutilated. */
    corpseHit: boolean;
    /** When set, this hit pushed the cumulative per-segment damage
     *  past the detach threshold — the segment tears off mid-fight
     *  even on a non-killing shot, and any distal segments cascade
     *  off with it (lose the thigh → shin and foot follow). The
     *  payload names the proximal break point; the visuals layer
     *  asks the humanoid to detach that segment which handles the
     *  cascade internally. The victim keeps fighting (slower / less
     *  accurate). */
    limbDetached: {
      segment:
        | 'upperArm' | 'forearm' | 'hand'
        | 'thigh' | 'shin' | 'foot';
      side: 'left' | 'right';
    } | null;
    hitX: number; hitY: number; hitZ: number;
    /** Victim's foot Y at the time of impact — used by blood-decal
     *  visuals to drop a pool on the surface they're standing on. */
    victimFootY: number;
    /** Direction the bullet was traveling when it hit (unit vector).
     *  Used to offset blood spray away from the shooter. */
    dirX: number; dirY: number; dirZ: number;
    distance: number;
    tMs: number;
  };
  'combat:kill': {
    attackerId: string;
    victimId: string;
    weapon: string;
    headshot: boolean;
    tMs: number;
  };
  'combat:reload': { shooterId: string; weapon: string; tMs: number };
  'combat:weaponSwitch': { shooterId: string; weapon: string; tMs: number };
  /** A character took a running step. Walking (Shift) and crouching are
   *  silent — those characters never emit this event. Audio plays the
   *  surface-specific clip; perception lets bots hear an enemy through
   *  walls. `surface` matches the box collider's surface tag. */
  'character:footstep': {
    id: string;
    x: number; y: number; z: number;
    surface: 'sand' | 'wood' | 'metal' | 'concrete' | 'stone';
    tMs: number;
  };
  'grenade:thrown': {
    grenadeId: number;
    kind: 'he' | 'flashbang' | 'smoke' | 'molotov' | 'decoy';
    throwerId: string;
    ox: number; oy: number; oz: number;
    vx: number; vy: number; vz: number;
    tMs: number;
  };
  'grenade:bounce': {
    grenadeId: number; x: number; y: number; z: number; tMs: number;
  };
  'grenade:detonated': {
    grenadeId: number;
    kind: 'he' | 'flashbang' | 'smoke' | 'molotov' | 'decoy';
    throwerId: string;
    x: number; y: number; z: number;
    tMs: number;
  };
  // Match
  'match:bombPlanted': { site: 'A' | 'B'; x: number; y: number; z: number; tMs: number };
  'match:bombDefused': { defuserId: string; x: number; y: number; z: number; tMs: number };
  'match:bombExploded': { x: number; y: number; z: number; tMs: number };
  'match:roundStart': { number: number; tMs: number };
  'match:roundEnd': {
    number: number;
    winner: 'T' | 'CT';
    reason: string;
    playerWon: boolean;
    tMs: number;
  };
  'match:halftime': { tMs: number };
  'match:matchEnd': { winner: 'T' | 'CT'; tMs: number };
}

type Listener<K extends keyof EventMap> = (payload: EventMap[K]) => void;

class EventBus {
  private readonly listeners = new Map<keyof EventMap, Set<Listener<keyof EventMap>>>();

  on<K extends keyof EventMap>(key: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener as Listener<keyof EventMap>);
    return () => set?.delete(listener as Listener<keyof EventMap>);
  }

  emit<K extends keyof EventMap>(key: K, payload: EventMap[K]): void {
    const set = this.listeners.get(key);
    if (!set) return;
    // Snapshot so listeners can mutate the set without affecting iteration.
    for (const l of [...set]) {
      try {
        (l as Listener<K>)(payload);
      } catch (err) {
        // Don't let a bad listener take down the loop.
        console.error(`[events] listener for ${String(key)} threw`, err);
      }
    }
  }

  /** Drop every listener. Useful for HMR and tests. */
  clear(): void {
    this.listeners.clear();
  }
}

export const events = new EventBus();
