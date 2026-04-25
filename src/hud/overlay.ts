/** Manages the start overlay shown when pointer lock is not held.
 *  Click-to-play gesture is required by the browser to acquire pointer lock.
 *  We re-show the overlay whenever pointer lock is lost. */

import { events } from '../engine/events';
import { input } from '../engine/input';

export class StartOverlay {
  private readonly root: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly canvas: HTMLCanvasElement;
  private bound = false;
  /** Becomes true once the user has acquired pointer lock for the first time.
   *  After that, losing lock (Esc, buy menu, etc.) does NOT re-show the
   *  start overlay — that would block other UI. The user can click the
   *  canvas anywhere to re-acquire lock. */
  private everLocked = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const root = document.getElementById('overlay-root');
    if (!root) throw new Error('#overlay-root not found');
    const btn = document.getElementById('start-button');
    if (!(btn instanceof HTMLButtonElement)) throw new Error('#start-button missing');
    this.root = root;
    this.button = btn;
  }

  bind(): void {
    if (this.bound) return;
    this.bound = true;
    this.button.addEventListener('click', this.requestLock);
    this.canvas.addEventListener('click', this.requestLock);
    events.on('input:pointerLockChanged', ({ locked }) => {
      if (locked) {
        this.everLocked = true;
        this.show(false);
      } else if (!this.everLocked) {
        this.show(true);
      }
      // After first lock, never re-show the start overlay automatically.
    });
  }

  show(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  private readonly requestLock = (): void => {
    input.requestPointerLock();
  };
}

export function ensureCrosshair(): void {
  const host = document.getElementById('hud-root');
  if (!host) throw new Error('#hud-root not found');
  if (host.querySelector('.crosshair')) return;
  const cx = document.createElement('div');
  cx.className = 'crosshair';
  host.appendChild(cx);
}
