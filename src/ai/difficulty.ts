/** Per-difficulty tunables for bot perception + aim + firing. The numbers
 *  trace closely to the design doc table. They flow through the controller
 *  adapter (src/ai/brain.ts) so a single difficulty knob shapes the whole
 *  feel of a match.
 *
 *  The single match-wide difficulty is set on creation; per-bot variance
 *  is layered on top so a "Hard" team isn't a uniform wall — one bot is
 *  half a notch weaker, one half a notch stronger. */

export type DifficultyId = 'easy' | 'medium' | 'hard' | 'expert';

export interface BotDifficulty {
  /** Sight → first-shot delay, in ms. The bot's aim still moves during
   *  this window — it just doesn't pull the trigger yet. */
  reactionMs: number;
  /** Stddev of aim noise added to the target heading each resample. */
  aimErrorDeg: number;
  /** How often (ms) the per-shot aim noise is resampled. Lower = jitterier. */
  aimNoiseResampleMs: number;
  /** Half-life (ms) for the exponential aim filter — higher = laggier
   *  aim, more "the bot is swinging onto you". */
  trackingLagMs: number;
  /** 0..1 fraction of the spray pattern they pull down to compensate. */
  sprayCompensation: number;
  /** Vision cone half-angle (radians). 0.96 ≈ ~110° FOV. */
  fovHalfRad: number;
  /** Max sight range in meters (clear conditions). */
  visionRangeM: number;
  /** Max yaw/pitch the bot will accept as "on target" before pulling the
   *  trigger. Combined with `aimErrorDeg` this stops Easy bots from
   *  laser-firing at the air. */
  fireAimToleranceDeg: number;
  /** Mag fraction below which the bot wants to reload when out of combat. */
  reloadAtMagFraction: number;
}

const TABLE: Record<DifficultyId, BotDifficulty> = {
  easy: {
    reactionMs: 600,
    aimErrorDeg: 4.0,
    aimNoiseResampleMs: 220,
    trackingLagMs: 220,
    sprayCompensation: 0.20,
    fovHalfRad: 1.0,        // ~115°
    visionRangeM: 32,
    fireAimToleranceDeg: 6.0,
    reloadAtMagFraction: 0.30,
  },
  medium: {
    reactionMs: 350,
    aimErrorDeg: 2.0,
    aimNoiseResampleMs: 160,
    trackingLagMs: 120,
    sprayCompensation: 0.50,
    fovHalfRad: 0.96,       // ~110°
    visionRangeM: 42,
    fireAimToleranceDeg: 4.0,
    reloadAtMagFraction: 0.30,
  },
  hard: {
    reactionMs: 200,
    aimErrorDeg: 1.0,
    aimNoiseResampleMs: 110,
    trackingLagMs: 70,
    sprayCompensation: 0.80,
    fovHalfRad: 0.96,
    visionRangeM: 50,
    fireAimToleranceDeg: 2.5,
    reloadAtMagFraction: 0.25,
  },
  expert: {
    reactionMs: 110,
    aimErrorDeg: 0.4,
    aimNoiseResampleMs: 80,
    trackingLagMs: 40,
    sprayCompensation: 0.95,
    fovHalfRad: 0.96,
    visionRangeM: 60,
    fireAimToleranceDeg: 1.5,
    reloadAtMagFraction: 0.20,
  },
};

export function getDifficulty(id: DifficultyId): BotDifficulty {
  return TABLE[id];
}

/** Apply a small per-bot variance — one bot in five is a notch weaker and
 *  one a notch stronger so the team feels uneven. `index` should be the
 *  bot's stable team index (0..4). */
export function withVariance(base: BotDifficulty, index: number): BotDifficulty {
  // Index 0 is slightly stronger, index 1 slightly weaker, others baseline.
  const scale = index === 0 ? 0.85 : index === 1 ? 1.20 : 1.0;
  return {
    ...base,
    reactionMs: base.reactionMs * scale,
    aimErrorDeg: base.aimErrorDeg * scale,
    trackingLagMs: base.trackingLagMs * scale,
    sprayCompensation: clamp01(base.sprayCompensation / scale),
    fireAimToleranceDeg: base.fireAimToleranceDeg * scale,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
