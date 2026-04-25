/** Keyboard, mouse, and pointer-lock state. The engine pulls input state
 *  once per simulation tick (so all bots and the player see the same input
 *  for that tick). Edges (`pressed`/`released`) are computed at consume time
 *  and reset by `commitTick()`. */

import { events } from './events';

export type KeyCode = string; // KeyboardEvent.code, e.g. 'KeyW', 'Space'

class InputState {
  private readonly down = new Set<KeyCode>();
  private readonly pressedThisTick = new Set<KeyCode>();
  private readonly releasedThisTick = new Set<KeyCode>();

  /** Mouse delta accumulated since the last `commitTick()`. */
  private mouseDx = 0;
  private mouseDy = 0;

  private mouseDownButtons = 0;            // bitmask of currently-down buttons
  private mousePressedThisTick = 0;        // edges
  private mouseReleasedThisTick = 0;

  private _pointerLocked = false;
  private _bound = false;
  private _canvas: HTMLCanvasElement | null = null;

  /** Mouse sensitivity in radians per pixel. Tuned to feel like CS:GO ~2.0. */
  sensitivity = 0.0022;

  // Bound handlers kept on the instance so we can detach.
  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (!this.down.has(e.code)) {
      this.down.add(e.code);
      this.pressedThisTick.add(e.code);
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (this.down.delete(e.code)) {
      this.releasedThisTick.add(e.code);
    }
  };

  private readonly onMouseMove = (e: MouseEvent) => {
    if (!this._pointerLocked) return;
    this.mouseDx += e.movementX;
    this.mouseDy += e.movementY;
  };

  private readonly onMouseDown = (e: MouseEvent) => {
    const bit = 1 << e.button;
    if ((this.mouseDownButtons & bit) === 0) {
      this.mouseDownButtons |= bit;
      this.mousePressedThisTick |= bit;
    }
  };

  private readonly onMouseUp = (e: MouseEvent) => {
    const bit = 1 << e.button;
    if ((this.mouseDownButtons & bit) !== 0) {
      this.mouseDownButtons &= ~bit;
      this.mouseReleasedThisTick |= bit;
    }
  };

  private readonly onContextMenu = (e: MouseEvent) => {
    // Right-click is used in-game (e.g. AWP scope), so suppress the
    // browser context menu when the click lands on the render canvas.
    if (this._canvas && e.target === this._canvas) {
      e.preventDefault();
    }
  };

  private readonly onPointerLockChange = () => {
    const locked = document.pointerLockElement === this._canvas;
    if (locked === this._pointerLocked) return;
    this._pointerLocked = locked;
    if (!locked) {
      // Clear keys to avoid stuck inputs when focus is lost.
      this.down.clear();
      this.pressedThisTick.clear();
      this.releasedThisTick.clear();
      this.mouseDx = 0;
      this.mouseDy = 0;
      this.mouseDownButtons = 0;
      this.mousePressedThisTick = 0;
      this.mouseReleasedThisTick = 0;
    }
    events.emit('input:pointerLockChanged', { locked });
  };

  private readonly onBlur = () => {
    // Same as pointer lock loss — drop everything.
    this.down.clear();
    this.pressedThisTick.clear();
    this.releasedThisTick.clear();
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.mouseDownButtons = 0;
    this.mousePressedThisTick = 0;
    this.mouseReleasedThisTick = 0;
  };

  attach(canvas: HTMLCanvasElement): void {
    if (this._bound) return;
    this._canvas = canvas;
    this._bound = true;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  detach(): void {
    if (!this._bound) return;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this._bound = false;
    this._canvas = null;
  }

  requestPointerLock(): void {
    if (!this._canvas) return;
    void this._canvas.requestPointerLock();
  }

  releasePointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  get pointerLocked(): boolean {
    return this._pointerLocked;
  }

  isDown(code: KeyCode): boolean {
    return this.down.has(code);
  }

  /** True only on the tick the key transitioned to down. */
  wasPressed(code: KeyCode): boolean {
    return this.pressedThisTick.has(code);
  }

  wasReleased(code: KeyCode): boolean {
    return this.releasedThisTick.has(code);
  }

  isMouseDown(button: number): boolean {
    return (this.mouseDownButtons & (1 << button)) !== 0;
  }

  wasMousePressed(button: number): boolean {
    return (this.mousePressedThisTick & (1 << button)) !== 0;
  }

  wasMouseReleased(button: number): boolean {
    return (this.mouseReleasedThisTick & (1 << button)) !== 0;
  }

  /** Consume mouse delta accumulated since the last consumption. */
  consumeMouseDelta(): { dx: number; dy: number } {
    const out = { dx: this.mouseDx, dy: this.mouseDy };
    this.mouseDx = 0;
    this.mouseDy = 0;
    return out;
  }

  /** Called by the loop after a sim tick consumes inputs. Clears the
   *  per-tick edges so they don't leak to the next tick. */
  commitTick(): void {
    this.pressedThisTick.clear();
    this.releasedThisTick.clear();
    this.mousePressedThisTick = 0;
    this.mouseReleasedThisTick = 0;
  }
}

export const input = new InputState();
