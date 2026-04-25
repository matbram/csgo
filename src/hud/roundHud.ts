/** Round HUD — top-center timer (round time, or bomb timer when planted),
 *  players-alive counters per side, score (T : CT). Also a freeze-time
 *  countdown banner.
 *
 *  Reads state from `MatchState` + characters list each render frame. */

import type { MatchState } from '../match/match';
import type { Character } from '../entities/character';

export class RoundHud {
  private readonly el: HTMLDivElement;

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'round-hud';
    this.el.innerHTML = `
      <div class="round-row">
        <div class="alive alive-t">5</div>
        <div class="score-block">
          <div class="score score-t">0</div>
          <div class="timer">1:55</div>
          <div class="score score-ct">0</div>
        </div>
        <div class="alive alive-ct">5</div>
      </div>
      <div class="round-banner hidden"></div>
    `;
    host.appendChild(this.el);
  }

  update(match: MatchState, characters: Character[], nowMs: number): void {
    const round = match.round;
    const tAlive = countAlive(characters, 'T');
    const ctAlive = countAlive(characters, 'CT');
    (this.el.querySelector('.alive-t') as HTMLDivElement).textContent = String(tAlive);
    (this.el.querySelector('.alive-ct') as HTMLDivElement).textContent = String(ctAlive);
    (this.el.querySelector('.score-t') as HTMLDivElement).textContent = String(match.scoreT);
    (this.el.querySelector('.score-ct') as HTMLDivElement).textContent = String(match.scoreCT);

    const timerEl = this.el.querySelector('.timer') as HTMLDivElement;
    const bannerEl = this.el.querySelector('.round-banner') as HTMLDivElement;
    timerEl.classList.remove('bomb', 'freeze');
    bannerEl.classList.add('hidden');

    if (match.phase === 'pre') {
      timerEl.textContent = '—';
      return;
    }
    if (match.phase === 'matchEnd') {
      const winner = match.matchWinner ?? 'CT';
      timerEl.textContent = `MATCH ${winner}`;
      bannerEl.textContent = `${winner === 'T' ? 'TERRORISTS' : 'COUNTER-TERRORISTS'} WIN THE MATCH`;
      bannerEl.classList.remove('hidden');
      return;
    }
    if (match.phase === 'halftime') {
      timerEl.textContent = 'HALFTIME';
      bannerEl.textContent = 'SIDES SWAP';
      bannerEl.classList.remove('hidden');
      return;
    }
    if (!round) {
      timerEl.textContent = '—';
      return;
    }

    if (round.phase === 'freeze') {
      timerEl.classList.add('freeze');
      timerEl.textContent = formatTime(round.phaseEndMs - nowMs);
      bannerEl.textContent = `ROUND ${round.number}`;
      bannerEl.classList.remove('hidden');
      return;
    }
    if (round.phase === 'end') {
      const w = round.outcome?.winner;
      timerEl.textContent = w ? `${w} WIN` : 'ROUND OVER';
      const reason = round.outcome?.reason;
      bannerEl.textContent = reason ? roundReasonText(reason) : 'Round over';
      bannerEl.classList.remove('hidden');
      return;
    }
    // Live
    if (round.bomb && round.bomb.phase === 'planted') {
      timerEl.classList.add('bomb');
      timerEl.textContent = formatTime(round.bomb.explodeAtMs - nowMs);
    } else if (round.bomb && round.bomb.phase === 'defusing') {
      timerEl.classList.add('bomb');
      timerEl.textContent = `DEFUSING ${formatTime(round.bomb.explodeAtMs - nowMs)}`;
    } else {
      timerEl.textContent = formatTime(round.phaseEndMs - nowMs);
    }
  }
}

function countAlive(chars: Character[], side: 'T' | 'CT'): number {
  let n = 0;
  for (const c of chars) if (c.team === side && c.alive) n++;
  return n;
}

function formatTime(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function roundReasonText(reason: string): string {
  switch (reason) {
    case 'ct_time': return 'Counter-Terrorists win — time';
    case 'ct_eliminate': return 'Counter-Terrorists win — eliminated';
    case 'ct_defuse': return 'Counter-Terrorists win — bomb defused';
    case 't_eliminate': return 'Terrorists win — eliminated';
    case 't_explode': return 'Terrorists win — bomb exploded';
    default: return 'Round over';
  }
}
