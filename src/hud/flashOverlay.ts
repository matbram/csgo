/** Flashbang screen overlay. Shows a bright white veil that fades to
 *  transparent over the local player's `flashedUntilMs` interval. The
 *  effect intentionally bleeds slightly past the bot perception clear
 *  time so the player sees a quick after-image even on glancing flashes. */

import type { Character } from '../entities/character';

export class FlashOverlay {
  private readonly el: HTMLDivElement;
  /** Remember the duration of the current flash so we can compute a
   *  decaying alpha. Set on transition, cleared at expiry. */
  private flashStartedAtMs = 0;
  private flashEndsAtMs = 0;
  private prevFlashedUntilMs = 0;

  constructor() {
    const host = document.getElementById('hud-root');
    if (!host) throw new Error('#hud-root not found');
    this.el = document.createElement('div');
    this.el.className = 'flash-overlay';
    this.el.style.opacity = '0';
    host.appendChild(this.el);
  }

  /** Sync the overlay against the local player's character record. */
  update(player: Character, nowMs: number): void {
    const until = player.flashedUntilMs ?? 0;
    if (until > this.prevFlashedUntilMs) {
      // New / extended flash — pin the start so the alpha curve uses
      // the full duration even on overlapping flashes.
      this.flashStartedAtMs = nowMs;
      this.flashEndsAtMs = until;
    }
    this.prevFlashedUntilMs = until;

    if (nowMs >= this.flashEndsAtMs) {
      this.el.style.opacity = '0';
      return;
    }
    const total = Math.max(1, this.flashEndsAtMs - this.flashStartedAtMs);
    const elapsed = nowMs - this.flashStartedAtMs;
    // Hold near full opacity at the very start, then ease to zero.
    const linear = 1 - elapsed / total;
    const alpha = Math.max(0, Math.min(1, Math.pow(linear, 0.6)));
    this.el.style.opacity = String(alpha);
  }
}
