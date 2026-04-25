/** Debug HUD overlay — FPS, position, current callout, controller state.
 *  Toggled with F3. */

import type { CharacterController } from '../player/controller';
import type { World } from '../map/world';
import { time } from '../engine/time';

export class DebugHud {
  private readonly el: HTMLDivElement;
  private readonly player: CharacterController;
  private readonly world: World;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fpsValue = 0;
  private lastUpdateMs = 0;
  private visible = true;

  constructor(player: CharacterController, world: World) {
    this.player = player;
    this.world = world;
    this.el = document.createElement('div');
    this.el.className = 'debug-panel';
    const host = document.getElementById('hud-root');
    if (!host) throw new Error('#hud-root not found');
    host.appendChild(this.el);
    this.render();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.display = v ? 'block' : 'none';
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  /** Called each render frame. */
  update(renderDtMs: number): void {
    if (!this.visible) return;
    this.fpsAccum += renderDtMs;
    this.fpsFrames += 1;
    if (this.fpsAccum >= 250) {
      this.fpsValue = (this.fpsFrames * 1000) / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
    if (time.wallMs - this.lastUpdateMs < 100) return;
    this.lastUpdateMs = time.wallMs;
    this.render();
  }

  private render(): void {
    const s = this.player.state;
    const callout = this.world.calloutAt(s.pos.x, s.pos.y, s.pos.z) ?? '—';
    const pad = (n: number, w = 6) => n.toFixed(2).padStart(w);
    const lines: string[] = [
      `FPS      ${this.fpsValue.toFixed(1).padStart(6)}    [F3 toggle]`,
      `pos      x ${pad(s.pos.x)}  y ${pad(s.pos.y)}  z ${pad(s.pos.z)}`,
      `vel      x ${pad(s.vel.x)}  y ${pad(s.vel.y)}  z ${pad(s.vel.z)}`,
      `speed    ${pad(s.speed)} m/s    onGround ${s.onGround ? 'yes' : 'no '}`,
      `look     yaw ${pad(s.yaw * 57.2957795)}  pitch ${pad(s.pitch * 57.2957795)}`,
      `callout  ${callout}`,
      `crouch   ${s.crouching ? 'YES' : 'no '} ${s.forcedCrouch ? '(forced)' : ''}    surface ${s.groundSurface}`,
    ];
    this.el.textContent = lines.join('\n');
  }
}
