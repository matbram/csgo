/** Bomb-related HUD elements:
 *  - "BOMB" carrier indicator (top-left)
 *  - Plant prompt (centered, below crosshair) — "PRESS [E] TO PLANT"
 *  - Defuse prompt (centered) — "HOLDING E TO DEFUSE"
 *  - Plant progress bar (during plant action)
 *  - Defuse progress bar (during defuse action)
 *
 *  Updated each render frame from match + character + bomb state. */

import type { Character } from '../entities/character';
import type { BombState } from '../match/bomb';
import { PLANT_TIME_MS } from '../match/bomb';
import { pointInPolygon2D } from '../map/world';
import type { World } from '../map/world';

export class BombHud {
  private readonly carrierEl: HTMLDivElement;
  private readonly promptEl: HTMLDivElement;
  private readonly progressWrap: HTMLDivElement;
  private readonly progressBar: HTMLDivElement;
  private readonly progressLabel: HTMLDivElement;

  constructor(host: HTMLElement) {
    this.carrierEl = document.createElement('div');
    this.carrierEl.className = 'bomb-carrier hidden';
    this.carrierEl.textContent = 'BOMB';
    host.appendChild(this.carrierEl);

    this.promptEl = document.createElement('div');
    this.promptEl.className = 'action-prompt hidden';
    host.appendChild(this.promptEl);

    this.progressWrap = document.createElement('div');
    this.progressWrap.className = 'action-progress hidden';
    this.progressBar = document.createElement('div');
    this.progressBar.className = 'action-progress-bar';
    this.progressLabel = document.createElement('div');
    this.progressLabel.className = 'action-progress-label';
    this.progressWrap.append(this.progressLabel, this.progressBar);
    host.appendChild(this.progressWrap);
  }

  update(local: Character, bomb: BombState | null, world: World): void {
    // Carrier indicator: visible when local has the C4 in inventory and is alive.
    const hasC4 = !!local.inventory?.c4 && local.alive;
    this.carrierEl.classList.toggle('hidden', !hasC4);

    // Determine where the player is.
    const inBombSite = (() => {
      for (const s of world.bombSites) {
        if (local.pos.y < s.yMin - 0.2 || local.pos.y > s.yMax + 0.2) continue;
        if (pointInPolygon2D(local.pos.x, local.pos.z, s.polygon)) return s.site;
      }
      return null as 'A' | 'B' | null;
    })();

    // Decide prompt + progress based on phase.
    let promptText = '';
    let progress = 0;
    let progressLabel = '';

    if (bomb) {
      if (bomb.phase === 'planting' && bomb.carrierId === local.id) {
        progress = bomb.plantProgressMs / PLANT_TIME_MS;
        progressLabel = 'PLANTING…';
      } else if (bomb.phase === 'defusing' && bomb.defuserId === local.id) {
        progress = bomb.defuseProgressMs / Math.max(1, bomb.defuseTimeMs);
        progressLabel = 'DEFUSING…';
      } else if (bomb.phase === 'planted' && local.team === 'CT' && local.alive && bomb.pos) {
        const dx = local.pos.x - bomb.pos.x;
        const dz = local.pos.z - bomb.pos.z;
        if (dx * dx + dz * dz <= 1.0 * 1.0) {
          promptText = local.hasKit ? 'HOLD [E] TO DEFUSE (kit)' : 'HOLD [E] TO DEFUSE';
        }
      } else if ((bomb.phase === 'carried' || bomb.phase === 'planting') && bomb.carrierId === local.id && local.team === 'T' && local.alive) {
        if (inBombSite) {
          promptText = `HOLD [E] TO PLANT (${inBombSite})`;
        } else if (hasC4) {
          // Helpful hint when carrying but not in a site yet.
          promptText = 'CARRY THE BOMB TO A OR B SITE';
        }
      }
    }

    if (promptText) {
      this.promptEl.textContent = promptText;
      this.promptEl.classList.remove('hidden');
    } else {
      this.promptEl.classList.add('hidden');
    }

    if (progress > 0) {
      this.progressWrap.classList.remove('hidden');
      this.progressBar.style.width = `${Math.min(100, Math.max(0, progress * 100))}%`;
      this.progressLabel.textContent = progressLabel;
    } else {
      this.progressWrap.classList.add('hidden');
    }
  }
}
