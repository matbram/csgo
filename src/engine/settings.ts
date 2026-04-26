/** Global user settings — persisted to localStorage so changes survive
 *  reloads. Modules subscribe via `settings.subscribe()` to react to
 *  changes (the audio mixer for volume, the input system for
 *  sensitivity, the crosshair for color).
 *
 *  Defaults are the values previously hard-coded across the codebase
 *  (volume 0.55, sensitivity 0.0022, etc.) so the first load is
 *  identical to the pre-settings build. */

export type DifficultyTier = 'easy' | 'medium' | 'hard';
export type QualityTier = 'low' | 'medium' | 'high';

export interface UserSettings {
  /** Master output gain, 0..1. */
  masterVolume: number;
  /** Mouse look sensitivity in radians per pixel at default FOV. */
  sensitivity: number;
  /** Crosshair color as a hex string (#rrggbb). */
  crosshairColor: string;
  /** Crosshair scale multiplier (1.0 = default). */
  crosshairScale: number;
  /** Bot difficulty for the next round / match. */
  difficulty: DifficultyTier;
  /** Particle / post-FX quality tier. The adaptive detector may downgrade
   *  this at runtime; the user's choice is the ceiling. */
  quality: QualityTier;
}

const DEFAULTS: UserSettings = {
  masterVolume: 0.55,
  sensitivity: 0.0022,
  crosshairColor: '#fff4dc',
  crosshairScale: 1.0,
  difficulty: 'medium',
  quality: 'high',
};

const STORAGE_KEY = 'csgo-clone-settings-v1';

type Listener = (s: UserSettings) => void;

class SettingsStore {
  private state: UserSettings = { ...DEFAULTS };
  private readonly listeners = new Set<Listener>();

  constructor() {
    this.load();
  }

  get(): Readonly<UserSettings> { return this.state; }

  set<K extends keyof UserSettings>(key: K, value: UserSettings[K]): void {
    if (this.state[key] === value) return;
    this.state[key] = value;
    this.save();
    for (const l of this.listeners) l(this.state);
  }

  /** Replace several fields at once; emits a single notification. */
  patch(partial: Partial<UserSettings>): void {
    let changed = false;
    for (const k of Object.keys(partial) as Array<keyof UserSettings>) {
      const v = partial[k];
      if (v !== undefined && this.state[k] !== v) {
        (this.state[k] as UserSettings[typeof k]) = v as UserSettings[typeof k];
        changed = true;
      }
    }
    if (!changed) return;
    this.save();
    for (const l of this.listeners) l(this.state);
  }

  reset(): void {
    this.state = { ...DEFAULTS };
    this.save();
    for (const l of this.listeners) l(this.state);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    // Fire once so subscribers can sync their initial state.
    l(this.state);
    return () => this.listeners.delete(l);
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<UserSettings>;
      // Merge with defaults so a stale settings shape (older version)
      // gracefully picks up new fields without erroring.
      this.state = sanitize({ ...DEFAULTS, ...parsed });
    } catch {
      // Invalid JSON or storage unavailable — fall through with defaults.
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Quota exceeded / storage disabled — settings just won't persist.
    }
  }
}

function sanitize(s: UserSettings): UserSettings {
  return {
    masterVolume: clamp01(s.masterVolume),
    sensitivity: clampRange(s.sensitivity, 0.0005, 0.01),
    crosshairColor: /^#[0-9a-fA-F]{6}$/.test(s.crosshairColor) ? s.crosshairColor : DEFAULTS.crosshairColor,
    crosshairScale: clampRange(s.crosshairScale, 0.5, 2.5),
    difficulty: s.difficulty === 'easy' || s.difficulty === 'hard' ? s.difficulty : 'medium',
    quality: s.quality === 'low' || s.quality === 'medium' ? s.quality : 'high',
  };
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export const settings = new SettingsStore();
