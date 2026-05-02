/** Seeded RNG for AI decisions. All random choices made by bots route
 *  through here so a round can be replayed deterministically by capturing
 *  the seed at round start.
 *
 *  We use Mulberry32 — a 32-bit state PRNG with good statistical quality
 *  for game-grade decisions and a single multiply-shift step per draw.
 *  Combat *visuals* (blood splatter, decal rotation) deliberately stay on
 *  Math.random() — they don't affect simulation outcomes and routing them
 *  through the seeded stream would couple replay determinism to render
 *  rate.
 *
 *  Usage:
 *    const rng = makeRng(seed);
 *    rng.next();         // 0..1
 *    rng.gaussian();     // ~N(0, 0.5)
 *    rng.pick(arr);      // uniform pick
 *    rng.range(2, 5);    // integer in [2,5)
 *
 *  A bot owns its own RNG (forked from the match-level seed by id). This
 *  way reordering bot evaluation in the loop doesn't shift everyone's
 *  draws — each bot draws from its own private stream. */

export interface SeededRng {
  /** Uniform 0..1 (matches Math.random's contract). */
  next(): number;
  /** Approximate 0-mean, ~0.5 stddev gaussian via Box-Muller. */
  gaussian(): number;
  /** Integer in [lo, hi). hi must be > lo. */
  range(lo: number, hi: number): number;
  /** Uniform pick from a non-empty array. Returns undefined on empty. */
  pick<T>(arr: ReadonlyArray<T>): T | undefined;
  /** Coin flip with given probability of true (default 0.5). */
  chance(p?: number): boolean;
  /** Snapshot the current state — useful for forking sub-streams. */
  snapshot(): number;
}

export function makeRng(seed: number): SeededRng {
  // Mulberry32: state must be a non-zero 32-bit unsigned int.
  let state = (seed | 0) || 0x9e3779b9;
  function next(): number {
    state = (state + 0x6D2B79F5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  }
  function gaussian(): number {
    // Box-Muller half-step; matches the existing brain.ts gaussian shape
    // (~0.5 stddev) so swapping it in shouldn't measurably change feel.
    const u = 1 - next();
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 0.5;
  }
  function range(lo: number, hi: number): number {
    return lo + Math.floor(next() * (hi - lo));
  }
  function pick<T>(arr: ReadonlyArray<T>): T | undefined {
    if (arr.length === 0) return undefined;
    return arr[Math.floor(next() * arr.length)];
  }
  function chance(p = 0.5): boolean {
    return next() < p;
  }
  function snapshot(): number {
    return state >>> 0;
  }
  return { next, gaussian, range, pick, chance, snapshot };
}

/** Derive a stable per-bot sub-stream from a match seed and bot id.
 *  String-hash so two bots with different ids get well-separated streams
 *  even if the match seed is small. */
export function forkRng(matchSeed: number, key: string): SeededRng {
  let h = matchSeed | 0;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  }
  return makeRng(h);
}

/** Default match seed when nothing else is supplied — derived from the
 *  current wall clock so non-replay sessions still feel non-deterministic.
 *  Replay tooling supplies the seed explicitly via `setMatchSeed`. */
let _matchSeed: number = (Date.now() & 0x7fffffff) || 1;
export function setMatchSeed(seed: number): void {
  _matchSeed = (seed | 0) || 1;
}
export function getMatchSeed(): number {
  return _matchSeed;
}
