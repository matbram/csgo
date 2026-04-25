/** Sniper scope overlay. Fullscreen mask with a circular cut-out + dot
 *  in the center, plus thin reticle lines. Toggled visible/hidden via
 *  `setVisible(bool)`. The mask uses CSS radial-gradient mask, no canvas
 *  needed.
 *
 *  When visible, the regular crosshair is hidden (the dot replaces it). */

export class ScopeOverlay {
  private readonly el: HTMLDivElement;
  private visible = false;

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'scope-overlay hidden';
    this.el.innerHTML = `
      <div class="scope-mask"></div>
      <div class="scope-reticle">
        <div class="scope-h"></div>
        <div class="scope-v"></div>
        <div class="scope-dot"></div>
      </div>
    `;
    host.appendChild(this.el);
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    this.el.classList.toggle('hidden', !v);
    // Hide the regular crosshair while scoped.
    const crosshair = document.querySelector('.crosshair');
    if (crosshair) {
      (crosshair as HTMLElement).style.display = v ? 'none' : '';
    }
  }
}
