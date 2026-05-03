/** Top-left rolling feed of synthesised bot callouts on the local
 *  player's team. Reads the per-team blackboard's `commsState.log` each
 *  frame, filters by delivery (the local player has zero comms latency
 *  — they hear their team in real time), and renders one row per
 *  callout. Old rows fade out after a few seconds.
 *
 *  Mirrors the shape of CombatHud's killfeed for visual consistency. */

import type { TeamBlackboard } from '../ai/blackboard';
import type { Bot } from '../entities/bot';
import { formatCallout, type Callout } from '../ai/comms/callouts';

const ROW_LIFETIME_MS = 5_500;
const ROW_FADE_MS = 800;
const MAX_ROWS = 6;

interface FeedRow {
  el: HTMLDivElement;
  calloutId: number;
  expiresMs: number;
}

export class CalloutFeedHud {
  private readonly host: HTMLElement;
  private readonly container: HTMLDivElement;
  private readonly rows: FeedRow[] = [];

  constructor() {
    const host = document.getElementById('hud-root');
    if (!host) throw new Error('#hud-root not found');
    this.host = host;
    this.container = document.createElement('div');
    this.container.className = 'callout-feed';
    this.host.appendChild(this.container);
  }

  /** Refresh from the local player's team blackboard. `bots` is used
   *  only to look up the emitter's display name. */
  update(
    nowMs: number,
    localTeamBoard: TeamBlackboard | null,
    bots: ReadonlyArray<Bot>,
  ): void {
    if (localTeamBoard) {
      // Newest first in the log — push any unseen entries (skipping
      // those still in transit; local player has 0 latency so all are
      // delivered immediately, but we keep the gate for symmetry).
      for (const c of localTeamBoard.comms.log) {
        if (this.rows.some(r => r.calloutId === c.id)) continue;
        // Only display the kinds the player benefits from seeing —
        // skip 'reloading' / 'holdingAngle' (chatty, low value).
        if (c.kind === 'reloading' || c.kind === 'holdingAngle') continue;
        this.appendRow(c, bots, nowMs);
      }
    }
    // Fade + reap.
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!;
      const remaining = r.expiresMs - nowMs;
      if (remaining <= 0) {
        r.el.remove();
        this.rows.splice(i, 1);
      } else if (remaining < ROW_FADE_MS) {
        r.el.style.opacity = String(remaining / ROW_FADE_MS);
      }
    }
  }

  private appendRow(c: Callout, bots: ReadonlyArray<Bot>, nowMs: number): void {
    // Cap rows; oldest expires first.
    while (this.rows.length >= MAX_ROWS) {
      const oldest = this.rows.shift();
      oldest?.el.remove();
    }
    const speakerBot = bots.find(b => b.id === c.emitterId);
    const speaker = c.emitterId === 'local'
      ? 'YOU'
      : speakerBot?.identity.name ?? c.emitterId;
    const teamCls = c.side === 'T' ? 't' : 'ct';
    const el = document.createElement('div');
    el.className = `callout-row ${teamCls}`;
    const speakerEl = document.createElement('span');
    speakerEl.className = 'speaker';
    speakerEl.textContent = speaker;
    const textEl = document.createElement('span');
    textEl.className = 'text';
    textEl.textContent = formatCallout(c);
    el.appendChild(speakerEl);
    el.appendChild(textEl);
    this.container.appendChild(el);
    this.rows.push({ el, calloutId: c.id, expiresMs: nowMs + ROW_LIFETIME_MS });
  }

  dispose(): void {
    for (const r of this.rows) r.el.remove();
    this.rows.length = 0;
    this.container.remove();
  }
}
