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
