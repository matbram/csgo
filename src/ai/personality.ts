/** Per-bot personality + persistent named-bot roster.
 *
 *  Each bot gets a stable identity that survives match restarts:
 *    - A display name ("Falcon", "Hawk", "Viper") shown on the
 *      scoreboard and in the comms feed.
 *    - An archetype (entry_fragger, lurker, awper, support, igl)
 *      that biases scalar defaults.
 *    - Six 0..1 scalars that modulate cost weights in the planner
 *      (Phase 3+) and threshold logic in the reactive layer + comms
 *      module today.
 *
 *  The roster is persisted to localStorage under `csgo:botRoster`. On
 *  first boot we seed it from the seeded RNG so two browsers on the
 *  same `?seed=N` URL produce the same roster — replays stay stable.
 *
 *  Why archetypes:
 *    - Six scalars × N bots = a wide configuration space; archetypes
 *      collapse that to a handful of "feels-recognisable" templates.
 *    - The planner's cost weights mostly only care about a few scalar
 *      combinations (aggression × risk_aversion, teamwork × patience),
 *      so a small variation around an archetype produces noticeable
 *      individual feel without requiring per-scalar tuning. */

import { forkRng, getMatchSeed } from './rng';

export interface PersonalityProfile {
  /** Bias toward Swing/peek over Hold/wait. Higher → quicker to engage. */
  aggression: number;
  /** Bias toward holding angles, longer pre-aim, slower triggers. */
  patience: number;
  /** Higher → more comms, more likely to wait for trade kills, raises
   *  cost on solo pushes. */
  teamwork: number;
  /** Higher → uses utility on entries / executes; lower → saves nades. */
  utilityIQ: number;
  /** Higher → avoids exposed crossings; lower → takes them anyway. */
  riskAversion: number;
  /** Higher → planner replans on smaller info changes; lower → follows
   *  the original plan harder. */
  adaptability: number;
}

export type Archetype =
  | 'entry_fragger'
  | 'lurker'
  | 'awper'
  | 'support'
  | 'igl';

export interface BotIdentity {
  name: string;
  archetype: Archetype;
  personality: PersonalityProfile;
}

/** Per-archetype scalar templates. Random per-bot variance is layered on
 *  top so two "lurker" bots are recognisably similar but not identical. */
const ARCHETYPE_BASE: Record<Archetype, PersonalityProfile> = {
  entry_fragger: { aggression: 0.85, patience: 0.20, teamwork: 0.55, utilityIQ: 0.50, riskAversion: 0.20, adaptability: 0.55 },
  lurker:        { aggression: 0.40, patience: 0.85, teamwork: 0.30, utilityIQ: 0.45, riskAversion: 0.65, adaptability: 0.75 },
  awper:         { aggression: 0.45, patience: 0.85, teamwork: 0.55, utilityIQ: 0.40, riskAversion: 0.60, adaptability: 0.55 },
  support:       { aggression: 0.45, patience: 0.55, teamwork: 0.85, utilityIQ: 0.75, riskAversion: 0.50, adaptability: 0.60 },
  igl:           { aggression: 0.50, patience: 0.65, teamwork: 0.90, utilityIQ: 0.65, riskAversion: 0.45, adaptability: 0.85 },
};

/** Stable name pool. We pick deterministically so a given bot id always
 *  resolves to the same name across runs (modulo a localStorage wipe). */
const NAME_POOL = [
  'Falcon', 'Hawk', 'Viper', 'Cobra', 'Wolf', 'Raven', 'Bear', 'Tiger',
  'Phoenix', 'Lynx', 'Jackal', 'Eagle', 'Mantis', 'Owl', 'Shark', 'Fox',
  'Cypher', 'Echo', 'Sable', 'Drift',
];

const STORAGE_KEY = 'csgo:botRoster';

/** In-memory roster, mirroring localStorage. Loaded lazily. */
let cached: Record<string, BotIdentity> | null = null;

function loadRoster(): Record<string, BotIdentity> {
  if (cached) return cached;
  if (typeof window === 'undefined' || !window.localStorage) {
    cached = {};
    return cached;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    cached = raw ? (JSON.parse(raw) as Record<string, BotIdentity>) : {};
  } catch {
    cached = {};
  }
  return cached;
}

function saveRoster(): void {
  if (!cached) return;
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // Quota / disabled — silent (non-essential).
  }
}

/** Get (or generate + persist) the identity for a bot. The generator
 *  uses the seeded RNG forked by bot id, so two boots with the same
 *  match seed produce the same identities for first-time bots. */
export function getOrCreateIdentity(botId: string): BotIdentity {
  const roster = loadRoster();
  const existing = roster[botId];
  if (existing) return existing;
  const id = generateIdentity(botId, roster);
  roster[botId] = id;
  saveRoster();
  return id;
}

/** Test/dev helper — wipe the in-memory cache (and localStorage if
 *  available) so the next call regenerates. */
export function _resetRoster(): void {
  cached = {};
  if (typeof window !== 'undefined' && window.localStorage) {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
  }
}

function generateIdentity(botId: string, existing: Record<string, BotIdentity>): BotIdentity {
  const rng = forkRng(getMatchSeed(), `personality:${botId}`);
  // Pick an archetype uniformly. Five options; one bot per team can be
  // an IGL — but we don't enforce that at the per-id level (Phase 5 may
  // route an IGL constraint via the strategist).
  const archetypes: Archetype[] = ['entry_fragger', 'lurker', 'awper', 'support', 'igl'];
  const archetype = archetypes[Math.floor(rng.next() * archetypes.length)]!;
  // Pick a name not already taken in the existing roster.
  const taken = new Set(Object.values(existing).map(e => e.name));
  const free = NAME_POOL.filter(n => !taken.has(n));
  const name = free.length > 0
    ? free[Math.floor(rng.next() * free.length)]!
    : `${NAME_POOL[Math.floor(rng.next() * NAME_POOL.length)]!}-${botId.slice(-2)}`;
  return {
    name,
    archetype,
    personality: jitter(ARCHETYPE_BASE[archetype], rng),
  };
}

function jitter(base: PersonalityProfile, rng: ReturnType<typeof forkRng>): PersonalityProfile {
  const SPREAD = 0.10;
  const j = (v: number) => clamp01(v + (rng.next() - 0.5) * 2 * SPREAD);
  return {
    aggression:   j(base.aggression),
    patience:     j(base.patience),
    teamwork:     j(base.teamwork),
    utilityIQ:    j(base.utilityIQ),
    riskAversion: j(base.riskAversion),
    adaptability: j(base.adaptability),
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
