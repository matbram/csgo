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

  /** Wheel deltaY accumulated since last `consumeWheelTicks()`. We expose
   *  this as an integer count of "ticks" — each ~100 of native deltaY is
   *  one tick — so trackpads (which send fractional deltas) and mice
   *  (which send larger discrete deltas) both produce one switch per
   *  notch as expected. */
  private wheelAccum = 0;

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

  private readonly onWheel = (e: WheelEvent) => {
    if (!this._pointerLocked) return;
    // Browsers report deltas in different units — pixels (0), lines (1),
    // pages (2). Normalize to a unit roughly matching one mouse notch.
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    this.wheelAccum += e.deltaY * unit;
    // Don't let the page scroll under the canvas while the game is live.
    e.preventDefault();
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
      this.wheelAccum = 0;
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
    this.wheelAccum = 0;
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
    // `wheel` must not be passive so we can preventDefault while locked.
    window.addEventListener('wheel', this.onWheel, { passive: false });
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
    window.removeEventListener('wheel', this.onWheel);
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

  /** Consume accumulated wheel motion as a signed integer count of "ticks":
   *  positive when the user scrolled DOWN (deltaY > 0, conventionally
   *  "next" in lists), negative for scroll UP. Each ~100 units of native
   *  deltaY is one tick. Any sub-tick remainder is preserved across calls
   *  so slow trackpad scrolls still register eventually. */
  consumeWheelTicks(): number {
    const STEP = 100;
    if (this.wheelAccum > -STEP && this.wheelAccum < STEP) return 0;
    const ticks = (this.wheelAccum > 0 ? Math.floor(this.wheelAccum / STEP) : Math.ceil(this.wheelAccum / STEP));
    this.wheelAccum -= ticks * STEP;
    return ticks;
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
