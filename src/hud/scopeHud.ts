/** Sniper scope overlay. Renders heavy black side bars + a thin reticle
 *  cross + a level indicator. The actual zoom is owned by the camera FOV;
 *  this module is purely visual feedback so the player knows they're
 *  scoped and at which level.
 *
 *  We hide the regular crosshair while scoped so the two reticles don't
 *  fight each other. */

const ROOT_HOST_ID = 'hud-root';

export class ScopeHud {
  private readonly root: HTMLDivElement;
  private readonly levelEl: HTMLDivElement;
  private readonly crosshair: HTMLElement | null;
  private currentLevel = 0;

  constructor() {
    const host = document.getElementById(ROOT_HOST_ID);
    if (!host) throw new Error('#hud-root not found');
    this.root = document.createElement('div');
    this.root.className = 'scope-overlay hidden';
    this.root.innerHTML = `
      <div class="scope-bar scope-bar-left"></div>
      <div class="scope-bar scope-bar-right"></div>
      <div class="scope-bar scope-bar-top"></div>
      <div class="scope-bar scope-bar-bottom"></div>
      <div class="scope-circle"></div>
      <div class="scope-cross scope-cross-h"></div>
      <div class="scope-cross scope-cross-v"></div>
      <div class="scope-dot"></div>
      <div class="scope-level"></div>
    `;
    host.appendChild(this.root);
    this.levelEl = this.root.querySelector<HTMLDivElement>('.scope-level')!;
    this.crosshair = host.querySelector<HTMLElement>('.crosshair');
  }

  /** Drive the overlay from the active weapon's scope state. Pass 0 when
   *  the player is dead, the buy menu is open, or there's no scoped
   *  weapon — i.e. the *effective* level. The `style` arg controls
   *  whether to draw the heavy AWP-style black bars: ADS-style scopes
   *  (rifles, pistols) just adjust FOV with no overlay so the player
   *  keeps full peripheral vision down the sights. */
  setLevel(level: number, style: 'sniper' | 'ads' = 'sniper'): void {
    const wantOverlay = level > 0 && style === 'sniper';
    const targetLevel = wantOverlay ? level : 0;
    if (targetLevel === this.currentLevel) return;
    this.currentLevel = targetLevel;
    if (targetLevel <= 0) {
      this.root.classList.add('hidden');
      if (this.crosshair) this.crosshair.classList.remove('hidden');
    } else {
      this.root.classList.remove('hidden');
      // Tint differently per zoom level so the player can tell them apart.
      this.root.classList.toggle('scope-zoom-2', targetLevel >= 2);
      this.levelEl.textContent = targetLevel >= 2 ? 'ZOOM II' : 'ZOOM I';
      if (this.crosshair) this.crosshair.classList.add('hidden');
    }
  }
}
