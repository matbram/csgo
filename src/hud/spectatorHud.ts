/** Spectator HUD — a small banner shown while the local player is dead
 *  telling them whose POV they're watching and how to cycle. Hides
 *  itself the moment alive flips back to true. */

export class SpectatorHud {
  private readonly el: HTMLDivElement;
  private visible = false;

  constructor() {
    const host = document.getElementById('hud-root');
    if (!host) throw new Error('#hud-root not found');
    this.el = document.createElement('div');
    this.el.className = 'spectator-banner hidden';
    host.appendChild(this.el);
  }

  setActive(active: boolean, targetId: string | null): void {
    if (active && targetId) {
      this.el.textContent = `SPECTATING ${targetId.toUpperCase()}  ·  LMB next  ·  RMB previous`;
      if (!this.visible) {
        this.el.classList.remove('hidden');
        this.visible = true;
      }
    } else if (!active && this.visible) {
      this.el.classList.add('hidden');
      this.visible = false;
    }
  }
}
