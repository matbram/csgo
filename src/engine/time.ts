/** Single source of truth for time. The render loop advances `wallMs` each
 *  frame; the fixed-timestep loop advances `simMs` in `SIM_STEP_MS` chunks.
 *  Gameplay code should read `simMs` for game logic and `wallMs` for
 *  cosmetic things (view bob, particles). */

export const SIM_HZ = 60;
export const SIM_STEP_MS = 1000 / SIM_HZ;
/** Hard cap on how many sim steps we run in a single render frame, so a
 *  paused tab doesn't cause the spiral of death when it resumes. */
export const MAX_SUBSTEPS = 5;

class GameTime {
  wallMs = 0;
  simMs = 0;
  /** Render delta time in ms (clamped). */
  renderDtMs = 0;
}

export const time = new GameTime();
