/** Combat HUD: HP/armor (bottom-left), ammo (bottom-right), hit marker
 *  (centered), killfeed (top-right), damage flash overlay.
 *
 *  Updates are event-driven where possible (kills, hits) and pulled from
 *  the player's character record otherwise (HP/ammo). */

import type { Character } from '../entities/character';
import type { WeaponInstance } from '../weapons/inventory';
import { events } from '../engine/events';

interface KillfeedEntry {
  el: HTMLDivElement;
  expiresMs: number;
}

export class CombatHud {
  private readonly host: HTMLElement;
  private readonly hpEl: HTMLDivElement;
  private readonly armorEl: HTMLDivElement;
  private readonly ammoEl: HTMLDivElement;
  private readonly weaponEl: HTMLDivElement;
  private readonly hitMarker: HTMLDivElement;
  private readonly damageFlash: HTMLDivElement;
  private readonly killfeed: HTMLDivElement;
  private readonly entries: KillfeedEntry[] = [];

  private hitMarkerEndMs = 0;
  private damageFlashEndMs = 0;
  private lastSeenHp = 100;

  constructor() {
    const host = document.getElementById('hud-root');
    if (!host) throw new Error('#hud-root not found');
    this.host = host;

    // Bottom-left: HP + armor
    const blStack = document.createElement('div');
    blStack.className = 'bottom-left-stack';
    this.host.appendChild(blStack);

    this.hpEl = document.createElement('div');
    this.hpEl.className = 'stat hp';
    blStack.appendChild(this.hpEl);

    this.armorEl = document.createElement('div');
    this.armorEl.className = 'stat armor';
    blStack.appendChild(this.armorEl);

    // Bottom-right: weapon + ammo
    const brStack = document.createElement('div');
    brStack.className = 'bottom-right-stack';
    this.host.appendChild(brStack);

    this.weaponEl = document.createElement('div');
    this.weaponEl.className = 'stat weapon';
    brStack.appendChild(this.weaponEl);

    this.ammoEl = document.createElement('div');
    this.ammoEl.className = 'stat ammo';
    brStack.appendChild(this.ammoEl);

    // Hit marker
    this.hitMarker = document.createElement('div');
    this.hitMarker.className = 'hit-marker';
    this.host.appendChild(this.hitMarker);

    // Damage flash
    this.damageFlash = document.createElement('div');
    this.damageFlash.className = 'damage-flash';
    this.host.appendChild(this.damageFlash);

    // Killfeed
    this.killfeed = document.createElement('div');
    this.killfeed.className = 'killfeed';
    this.host.appendChild(this.killfeed);

    // Subscriptions
    events.on('combat:hit', ({ attackerId, killing, corpseHit }) => {
      // Corpse mutilation shouldn't trip the hit-marker — the player
      // already killed this target, so a second flash would just
      // confuse "did I get a kill?" feedback.
      if (attackerId === 'local' && !corpseHit) {
        this.flashHitMarker(killing);
      }
    });
    events.on('combat:kill', (k) => this.appendKillfeed(k));
  }

  /** Called every render frame. */
  update(player: Character, nowMs: number): void {
    const hp = Math.max(0, Math.min(999, player.hp));
    const armor = Math.max(0, Math.min(999, player.armor));
    this.hpEl.textContent = `❤ ${hp}`;
    this.armorEl.textContent = armor > 0 ? `${player.helmet ? '⛨' : '◇'} ${armor}` : '';

    const inv = player.inventory;
    const inst = inv ? activeOrNull(inv) : null;
    if (inst) {
      this.weaponEl.textContent = inst.def.displayName.toUpperCase();
      this.ammoEl.textContent = inst.def.magazine > 0 ? `${inst.ammoMag} / ${inst.ammoReserve}` : '';
    } else {
      this.weaponEl.textContent = '';
      this.ammoEl.textContent = '';
    }

    // Damage flash on HP drop.
    if (player.hp < this.lastSeenHp) {
      this.damageFlashEndMs = nowMs + 250;
    }
    this.lastSeenHp = player.hp;

    if (nowMs < this.hitMarkerEndMs) {
      this.hitMarker.classList.add('on');
    } else {
      this.hitMarker.classList.remove('on');
    }

    if (nowMs < this.damageFlashEndMs) {
      const t = (this.damageFlashEndMs - nowMs) / 250;
      this.damageFlash.style.opacity = String(t * 0.5);
    } else {
      this.damageFlash.style.opacity = '0';
    }

    // Expire killfeed entries.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (nowMs > e.expiresMs) {
        e.el.classList.add('fade-out');
        setTimeout(() => e.el.remove(), 250);
        this.entries.splice(i, 1);
      }
    }
  }

  private flashHitMarker(killing: boolean): void {
    this.hitMarker.classList.toggle('kill', killing);
    this.hitMarkerEndMs = performance.now() + 200;
  }

  private appendKillfeed(k: { attackerId: string; victimId: string; weapon: string; headshot: boolean }): void {
    const el = document.createElement('div');
    el.className = 'killfeed-entry';
    const attacker = k.attackerId === 'local' ? 'You' : k.attackerId;
    const victim = k.victimId === 'local' ? 'You' : k.victimId;
    const weaponLabel = k.weapon.toUpperCase();
    el.innerHTML = `
      <span class="atk">${escape(attacker)}</span>
      <span class="weapon">${escape(weaponLabel)}${k.headshot ? ' ☠' : ''}</span>
      <span class="vic">${escape(victim)}</span>
    `;
    this.killfeed.appendChild(el);
    this.entries.push({ el, expiresMs: performance.now() + 6000 });
  }
}

function activeOrNull(inv: NonNullable<Character['inventory']>): WeaponInstance | null {
  switch (inv.active) {
    case 'primary': return inv.primary ?? null;
    case 'secondary': return inv.secondary ?? null;
    case 'knife': return inv.knife;
    case 'c4': return inv.c4 ?? null;
    case 'grenade': return inv.grenades[inv.activeGrenadeIdx] ?? null;
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;'
  );
}
