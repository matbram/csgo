/** Tab scoreboard. Shows both teams with kills / assists / deaths /
 *  money / ping rows. Visible while Tab is held; hidden otherwise. */

import type { MatchState } from '../match/match';
import type { Character } from '../entities/character';
import type { Bot } from '../entities/bot';

export class Scoreboard {
  private readonly el: HTMLDivElement;
  private visible = false;

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'scoreboard hidden';
    host.appendChild(this.el);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.classList.toggle('hidden', !v);
  }

  isVisible(): boolean { return this.visible; }

  update(match: MatchState, characters: Character[], bots?: ReadonlyArray<Bot>): void {
    if (!this.visible) return;
    // Build rows.
    const aliveById = new Map<string, boolean>();
    for (const c of characters) aliveById.set(c.id, c.alive);
    // Build a display-name lookup from the persistent bot identity so
    // the player sees "Falcon" instead of "t-bot-1".
    const nameById = new Map<string, string>();
    if (bots) {
      for (const b of bots) nameById.set(b.id, b.identity.name);
    }

    const tRows: string[] = [];
    const ctRows: string[] = [];

    const players = [...match.players.values()];
    for (const p of players) {
      const row = renderRow(
        p.id, nameById.get(p.id),
        aliveById.get(p.id) ?? false, p.kills, p.assists, p.deaths, p.money,
      );
      if (p.currentSide === 'T') tRows.push(row);
      else ctRows.push(row);
    }

    this.el.innerHTML = `
      <div class="sb-card">
        <div class="sb-header">
          <div class="sb-team t">TERRORISTS &nbsp;·&nbsp; ${match.scoreT}</div>
          <div class="sb-vs">vs</div>
          <div class="sb-team ct">${match.scoreCT} &nbsp;·&nbsp; COUNTER-TERRORISTS</div>
        </div>
        <table class="sb-table">
          <thead>
            <tr><th>Player</th><th class="num">K</th><th class="num">A</th><th class="num">D</th><th class="num">$</th></tr>
          </thead>
          <tbody class="t-body">
            ${tRows.join('')}
          </tbody>
          <tbody class="ct-body">
            ${ctRows.join('')}
          </tbody>
        </table>
        <div class="sb-footer">Round ${match.round?.number ?? '—'} of 30</div>
      </div>
    `;
  }
}

function renderRow(id: string, displayName: string | undefined, alive: boolean, k: number, a: number, d: number, money: number): string {
  const display = id === 'local' ? 'You' : (displayName ?? id);
  return `
    <tr class="sb-row${alive ? '' : ' dead'}">
      <td class="name">${escapeHtml(display)}</td>
      <td class="num">${k}</td>
      <td class="num">${a}</td>
      <td class="num">${d}</td>
      <td class="num money">$${money}</td>
    </tr>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;'
  );
}
