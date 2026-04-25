/** Match-end overlay. Shows winner + final score in a centered banner
 *  once `match.phase === 'matchEnd'`. The match doesn't auto-restart
 *  so the banner stays up indefinitely. Reload the page to play
 *  another match. */

import type { MatchState } from '../match/match';

export class MatchEndHud {
  private readonly root: HTMLDivElement;
  private visible = false;

  constructor() {
    const host = document.getElementById('hud-root');
    if (!host) throw new Error('#hud-root not found');
    this.root = document.createElement('div');
    this.root.className = 'match-end hidden';
    host.appendChild(this.root);
  }

  update(match: MatchState): void {
    if (match.phase !== 'matchEnd') {
      if (this.visible) {
        this.root.classList.add('hidden');
        this.visible = false;
      }
      return;
    }
    if (!this.visible) {
      const winner = match.matchWinner ?? 'CT';
      const winnerLabel = winner === 'T' ? 'TERRORISTS' : 'COUNTER-TERRORISTS';
      const winnerCls = winner === 'T' ? 't' : 'ct';
      // Score is stored relative to current sides; show both.
      const t = match.scoreT;
      const ct = match.scoreCT;
      this.root.innerHTML = `
        <div class="match-end-card">
          <div class="match-end-title ${winnerCls}">${winnerLabel} WIN</div>
          <div class="match-end-score">
            <span class="t">T ${t}</span>
            <span class="sep">—</span>
            <span class="ct">CT ${ct}</span>
          </div>
          <div class="match-end-hint">Reload the page to play another match.</div>
        </div>
      `;
      this.root.classList.remove('hidden');
      this.visible = true;
    }
  }
}
