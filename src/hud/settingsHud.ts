/** Settings menu — modal panel with sliders and radios bound to the
 *  settings store. Toggled with Esc (when pointer-locked, in-round) or
 *  via the gear button on the start overlay.
 *
 *  This panel does NOT pause the simulation; the round keeps ticking
 *  while the user fiddles with sliders. Pointer lock is released while
 *  open so the user can drag sliders, and re-acquired on close. */

import { settings, type DifficultyTier, type QualityTier } from '../engine/settings';
import { input } from '../engine/input';

export class SettingsHud {
  private readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private visible = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.root = document.createElement('div');
    this.root.className = 'settings-menu hidden';
    this.root.innerHTML = `
      <div class="settings-card">
        <div class="settings-header">
          <div class="settings-title">SETTINGS</div>
          <button class="settings-close" type="button" aria-label="Close">×</button>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Audio</div>
          <label class="settings-row">
            <span class="settings-row-label">Master volume</span>
            <input type="range" min="0" max="1" step="0.01" data-key="masterVolume">
            <span class="settings-row-value" data-bind="masterVolume">0%</span>
          </label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Mouse</div>
          <label class="settings-row">
            <span class="settings-row-label">Sensitivity</span>
            <input type="range" min="0.0005" max="0.005" step="0.0001" data-key="sensitivity">
            <span class="settings-row-value" data-bind="sensitivity">0</span>
          </label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Crosshair</div>
          <label class="settings-row">
            <span class="settings-row-label">Color</span>
            <input type="color" data-key="crosshairColor">
            <span class="settings-row-value" data-bind="crosshairColor">#ffffff</span>
          </label>
          <label class="settings-row">
            <span class="settings-row-label">Scale</span>
            <input type="range" min="0.5" max="2.5" step="0.1" data-key="crosshairScale">
            <span class="settings-row-value" data-bind="crosshairScale">1.0×</span>
          </label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Bots</div>
          <div class="settings-row settings-row-radio">
            <span class="settings-row-label">Difficulty</span>
            <div class="settings-segment" data-key="difficulty">
              <button data-value="easy" type="button">Easy</button>
              <button data-value="medium" type="button">Medium</button>
              <button data-value="hard" type="button">Hard</button>
            </div>
          </div>
          <div class="settings-section-note">Difficulty applies to bots created in the next round.</div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Graphics</div>
          <div class="settings-row settings-row-radio">
            <span class="settings-row-label">Quality</span>
            <div class="settings-segment" data-key="quality">
              <button data-value="low" type="button">Low</button>
              <button data-value="medium" type="button">Medium</button>
              <button data-value="high" type="button">High</button>
            </div>
          </div>
          <div class="settings-section-note">Lower quality reduces particle counts and post-FX cost. The adaptive detector may further drop quality on slow frames.</div>
        </div>

        <div class="settings-footer">
          <button class="settings-reset" type="button">Reset to defaults</button>
          <span class="settings-footer-hint">Esc to close</span>
        </div>
      </div>
    `;
    this.host.appendChild(this.root);
    this.bindControls();
    this.syncFromSettings();
    settings.subscribe(() => this.syncFromSettings());
  }

  isOpen(): boolean { return this.visible; }

  open(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.classList.remove('hidden');
    // Sliders need pointer events; pointer lock blocks the cursor.
    input.releasePointerLock();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.add('hidden');
    input.requestPointerLock();
  }

  toggle(): void {
    if (this.visible) this.close(); else this.open();
  }

  private bindControls(): void {
    this.root.querySelector('.settings-close')?.addEventListener('click', () => this.close());
    this.root.querySelector('.settings-reset')?.addEventListener('click', () => settings.reset());

    for (const el of this.root.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
      el.addEventListener('input', () => {
        const key = el.dataset.key as keyof ReturnType<typeof settings.get>;
        const v = parseFloat(el.value);
        if (Number.isFinite(v)) settings.set(key as never, v as never);
      });
    }
    for (const el of this.root.querySelectorAll<HTMLInputElement>('input[type="color"]')) {
      el.addEventListener('input', () => {
        const key = el.dataset.key as keyof ReturnType<typeof settings.get>;
        settings.set(key as never, el.value as never);
      });
    }
    for (const seg of this.root.querySelectorAll<HTMLDivElement>('.settings-segment')) {
      const key = seg.dataset.key as 'difficulty' | 'quality';
      for (const btn of seg.querySelectorAll<HTMLButtonElement>('button')) {
        btn.addEventListener('click', () => {
          const value = btn.dataset.value;
          if (!value) return;
          if (key === 'difficulty') settings.set('difficulty', value as DifficultyTier);
          else if (key === 'quality') settings.set('quality', value as QualityTier);
        });
      }
    }
  }

  private syncFromSettings(): void {
    const s = settings.get();
    const setRange = (key: keyof typeof s, value: number) => {
      const el = this.root.querySelector<HTMLInputElement>(`input[data-key="${key}"]`);
      if (el) el.value = String(value);
    };
    const setColor = (key: keyof typeof s, value: string) => {
      const el = this.root.querySelector<HTMLInputElement>(`input[data-key="${key}"]`);
      if (el) el.value = value;
    };
    setRange('masterVolume', s.masterVolume);
    setRange('sensitivity', s.sensitivity);
    setRange('crosshairScale', s.crosshairScale);
    setColor('crosshairColor', s.crosshairColor);

    const setBind = (key: keyof typeof s, text: string) => {
      const el = this.root.querySelector<HTMLSpanElement>(`[data-bind="${key}"]`);
      if (el) el.textContent = text;
    };
    setBind('masterVolume', `${Math.round(s.masterVolume * 100)}%`);
    // Sensitivity is shown in CS:GO-ish units (rad/px × ~880 ≈ in-game number).
    setBind('sensitivity', (s.sensitivity * 880).toFixed(2));
    setBind('crosshairScale', `${s.crosshairScale.toFixed(1)}×`);
    setBind('crosshairColor', s.crosshairColor.toUpperCase());

    for (const seg of this.root.querySelectorAll<HTMLDivElement>('.settings-segment')) {
      const key = seg.dataset.key as keyof typeof s;
      const cur = String(s[key]);
      for (const btn of seg.querySelectorAll<HTMLButtonElement>('button')) {
        btn.classList.toggle('selected', btn.dataset.value === cur);
      }
    }
  }
}
