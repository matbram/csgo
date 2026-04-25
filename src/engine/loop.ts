/** Fixed-timestep simulation loop with a render tick on every rAF.
 *
 *  Pattern: accumulator. Each rAF advances `wallMs` by the real frame time
 *  (clamped to avoid spiral-of-death after tab pauses). The accumulator
 *  drains in `SIM_STEP_MS` chunks, calling registered sim systems each
 *  step. Then registered render systems run once. This guarantees gameplay
 *  is deterministic per sim tick regardless of frame rate. */

import { time, SIM_STEP_MS, MAX_SUBSTEPS } from './time';
import { events } from './events';
import { input } from './input';

export type SimSystem = (dtMs: number, simMs: number) => void;
export type RenderSystem = (renderDtMs: number) => void;

class Loop {
  private readonly simSystems: SimSystem[] = [];
  private readonly renderSystems: RenderSystem[] = [];
  private accumulator = 0;
  private lastTimestamp = 0;
  private rafId = 0;
  private running = false;
  /** When the loop's "internal frame" is being driven by Babylon's render
   *  observable instead of our own rAF. Babylon's runRenderLoop calls our
   *  step from inside its observable. We keep both modes working so the
   *  loop is testable in isolation. */
  private externalDrive = false;

  /** Hard cap on render frame time (ms) before we clamp it. Prevents
   *  catastrophic catch-up when the tab was backgrounded. */
  private readonly maxFrameMs = 250;

  registerSim(system: SimSystem): () => void {
    this.simSystems.push(system);
    return () => {
      const i = this.simSystems.indexOf(system);
      if (i >= 0) this.simSystems.splice(i, 1);
    };
  }

  registerRender(system: RenderSystem): () => void {
    this.renderSystems.push(system);
    return () => {
      const i = this.renderSystems.indexOf(system);
      if (i >= 0) this.renderSystems.splice(i, 1);
    };
  }

  /** Drive the loop from an external source (e.g. Babylon engine). */
  step(timestamp: number): void {
    if (!this.lastTimestamp) {
      this.lastTimestamp = timestamp;
      return;
    }
    let dt = timestamp - this.lastTimestamp;
    this.lastTimestamp = timestamp;
    if (dt > this.maxFrameMs) dt = this.maxFrameMs;

    time.wallMs += dt;
    time.renderDtMs = dt;

    this.accumulator += dt;
    let substeps = 0;
    while (this.accumulator >= SIM_STEP_MS && substeps < MAX_SUBSTEPS) {
      time.simMs += SIM_STEP_MS;
      for (const sys of this.simSystems) sys(SIM_STEP_MS, time.simMs);
      events.emit('sim:tick', { dtMs: SIM_STEP_MS, tMs: time.simMs });
      input.commitTick();
      this.accumulator -= SIM_STEP_MS;
      substeps++;
    }
    // If we hit MAX_SUBSTEPS, drop accumulator excess so we don't fall further behind.
    if (substeps >= MAX_SUBSTEPS && this.accumulator >= SIM_STEP_MS) {
      this.accumulator = 0;
    }

    events.emit('engine:beforeRender', { dtMs: dt });
    for (const sys of this.renderSystems) sys(dt);
    events.emit('engine:afterRender', { dtMs: dt });
  }

  startInternal(): void {
    if (this.running) return;
    this.running = true;
    this.externalDrive = false;
    const tick = (ts: number) => {
      if (!this.running || this.externalDrive) return;
      this.step(ts);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Switch the loop to be driven externally (Babylon's render loop calls
   *  `step` from its frame callback). Stops our own rAF. */
  bindExternal(): void {
    this.externalDrive = true;
    this.running = true;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }
}

export const loop = new Loop();
