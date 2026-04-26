/** Adaptive quality detector — watches frame time and steps the
 *  effective quality tier down when the renderer struggles. Steps
 *  back up when frames are comfortably under budget for a sustained
 *  window.
 *
 *  This sits BELOW the user's configured tier in the settings store:
 *  the detector never raises quality above the user's choice, only
 *  drops it. The user sees the chosen tier in the menu; the renderer
 *  uses min(user, adaptive). */

import { settings, type QualityTier } from './settings';
import { setQualityTier } from './postfx';

const TIERS: QualityTier[] = ['low', 'medium', 'high'];

const SLOW_FRAME_MS = 22;        // ≈ < 45 FPS — pressure
const FAST_FRAME_MS = 14;        // ≈ > 70 FPS — headroom
const SLOW_WINDOW_MS = 1500;     // sustained pressure before downgrade
const FAST_WINDOW_MS = 8000;     // sustained headroom before upgrade

class AdaptiveMonitor {
  private slowMsAcc = 0;
  private fastMsAcc = 0;
  private appliedTier: QualityTier | null = null;
  private userCeiling: QualityTier = 'high';

  start(): void {
    settings.subscribe((s) => {
      // User changed the ceiling — re-apply our floor under the new ceiling.
      this.userCeiling = s.quality;
      this.applyEffective(this.appliedTier ?? s.quality);
    });
  }

  /** Call once per render frame with the rendered frame's wall time. */
  step(frameMs: number): void {
    if (frameMs > SLOW_FRAME_MS) {
      this.slowMsAcc += frameMs;
      this.fastMsAcc = 0;
      if (this.slowMsAcc >= SLOW_WINDOW_MS) {
        this.downgrade();
        this.slowMsAcc = 0;
      }
    } else if (frameMs < FAST_FRAME_MS) {
      this.fastMsAcc += frameMs;
      this.slowMsAcc = Math.max(0, this.slowMsAcc - frameMs);
      if (this.fastMsAcc >= FAST_WINDOW_MS) {
        this.upgrade();
        this.fastMsAcc = 0;
      }
    } else {
      // Mid-band: bleed both accumulators toward zero.
      this.slowMsAcc = Math.max(0, this.slowMsAcc - frameMs * 0.5);
      this.fastMsAcc = Math.max(0, this.fastMsAcc - frameMs * 0.5);
    }
  }

  private downgrade(): void {
    const cur = this.appliedTier ?? this.userCeiling;
    const idx = TIERS.indexOf(cur);
    if (idx <= 0) return;          // already at 'low'
    this.applyEffective(TIERS[idx - 1]!);
  }

  private upgrade(): void {
    const cur = this.appliedTier ?? this.userCeiling;
    const idx = TIERS.indexOf(cur);
    if (idx >= TIERS.length - 1) return;  // already at 'high'
    const next = TIERS[idx + 1]!;
    if (TIERS.indexOf(next) > TIERS.indexOf(this.userCeiling)) return; // ceiling
    this.applyEffective(next);
  }

  private applyEffective(tier: QualityTier): void {
    // Clamp to the user's ceiling.
    const userIdx = TIERS.indexOf(this.userCeiling);
    const tierIdx = Math.min(TIERS.indexOf(tier), userIdx);
    const clamped = TIERS[tierIdx] ?? this.userCeiling;
    if (this.appliedTier === clamped) return;
    this.appliedTier = clamped;
    setQualityTier(clamped);
  }
}

export const adaptiveQuality = new AdaptiveMonitor();
