/** First-person camera. Reads player yaw/pitch each render frame, applies
 *  view bob proportional to horizontal speed, drives Babylon's `UniversalCamera`.
 *
 *  Mouse look is consumed once per simulation tick from `input.consumeMouseDelta()`,
 *  applied to player yaw/pitch, and pitch is clamped to ±89°. The camera's
 *  position is updated each render frame from `player.state.pos` + eye height.
 */

import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { getScene } from '../engine/scene';
import { input } from '../engine/input';
import { time } from '../engine/time';
import { HALF_PI } from '../util/math';
import type { CharacterController } from './controller';

const PITCH_LIMIT = HALF_PI - 0.02;
/** Default vertical FOV in radians (~80°). Restored when no scope is active. */
const DEFAULT_FOV_RAD = 1.40;
/** Mouse sensitivity scale at default FOV. We scale sensitivity with FOV
 *  so the screen-relative motion under a scope still feels deliberate. */
const BASE_SENS_AT_DEFAULT_FOV = 0.0022;

export class FpsCamera {
  readonly camera: UniversalCamera;
  /** The controller whose state drives the camera. Swappable so the
   *  camera can ride a possessed bot's controller after the local player
   *  dies and takes over a teammate. */
  private player: CharacterController;
  /** Bob phase advances with horizontal distance traveled. */
  private bobPhase = 0;
  /** Smoothed view bob offset components for a clean reset to zero. */
  private bobOffsetY = 0;
  private bobOffsetX = 0;
  /** Target vertical FOV (radians). The camera lerps toward this each render
   *  frame for a smooth scope transition. */
  private targetFovRad = DEFAULT_FOV_RAD;

  constructor(player: CharacterController) {
    this.player = player;
    const scene = getScene();
    this.camera = new UniversalCamera('fps-camera', new Vector3(0, 0, 0), scene);
    this.camera.minZ = 0.05;
    this.camera.maxZ = 350;
    this.camera.fov = DEFAULT_FOV_RAD;
    this.camera.inertia = 0;       // no Babylon-driven smoothing
    this.camera.angularSensibility = 1;
    // Disable Babylon's built-in input controllers — we drive yaw/pitch ourselves.
    this.camera.inputs.clear();
    scene.activeCamera = this.camera;
  }

  /** Re-bind the camera to a different controller. Called when the local
   *  player possesses a teammate bot (their controller becomes ours) and
   *  again when possession is released on the next round. */
  bindController(controller: CharacterController): void {
    this.player = controller;
  }

  /** Set the target vertical FOV in radians. The camera converges over a
   *  few frames so transitions don't snap. */
  setTargetFovRad(fovRad: number): void {
    this.targetFovRad = fovRad;
  }

  /** Reset target FOV to the default. */
  resetFov(): void {
    this.targetFovRad = DEFAULT_FOV_RAD;
  }

  get defaultFovRad(): number {
    return DEFAULT_FOV_RAD;
  }

  /** Apply mouse delta to player yaw/pitch. Called from a sim tick so the
   *  rotation aligns with simulation steps (no decoupling needed at 60Hz). */
  applyMouseLook(): void {
    if (!input.pointerLocked) {
      // Drain any latent delta to avoid a snap when lock is regained.
      input.consumeMouseDelta();
      return;
    }
    const { dx, dy } = input.consumeMouseDelta();
    if (dx === 0 && dy === 0) return;
    // Scale mouse sensitivity with the current FOV so a scoped weapon
    // doesn't whip past the target. Use the actual camera FOV (after
    // smoothing) so the feel matches what the player sees.
    const sens = input.sensitivity * (this.camera.fov / DEFAULT_FOV_RAD);
    this.player.state.yaw += dx * sens;
    // Wrap yaw to keep the value bounded.
    if (this.player.state.yaw > Math.PI) this.player.state.yaw -= Math.PI * 2;
    if (this.player.state.yaw < -Math.PI) this.player.state.yaw += Math.PI * 2;
    this.player.state.pitch -= dy * sens;
    if (this.player.state.pitch > PITCH_LIMIT) this.player.state.pitch = PITCH_LIMIT;
    if (this.player.state.pitch < -PITCH_LIMIT) this.player.state.pitch = -PITCH_LIMIT;
  }

  /** Position + orient the camera each render frame. View bob is driven by
   *  horizontal speed; landing impulse and breath-bob would go here later. */
  syncRender(): void {
    const s = this.player.state;
    // Advance bob phase by horizontal distance traveled this frame.
    const dist = s.speed * (time.renderDtMs / 1000);
    this.bobPhase += dist * 1.6; // 1.6 cycles per meter — feels right at run speed.

    const bobAmp = clamp01(s.speed / 6.5) * (s.crouching ? 0.018 : 0.045);
    const lateralAmp = clamp01(s.speed / 6.5) * (s.crouching ? 0.012 : 0.025);
    const targetBobY = -Math.abs(Math.sin(this.bobPhase * Math.PI)) * bobAmp;
    const targetBobX = Math.sin(this.bobPhase * Math.PI * 0.5) * lateralAmp;
    // Smooth so transitions don't pop.
    const k = 0.25;
    this.bobOffsetY += (targetBobY - this.bobOffsetY) * k;
    this.bobOffsetX += (targetBobX - this.bobOffsetX) * k;

    // Camera is at capsule base + currentEye + bobs.
    const right = Math.cos(s.yaw); // not used for offset translate, but for lateral component:
    void right;
    // Lateral bob along right vector (perpendicular to yaw)
    const cosY = Math.cos(s.yaw);
    const sinY = Math.sin(s.yaw);
    // Right vector for yaw=0 facing +z is +x. With our yaw convention
    // (forward = (sin yaw, 0, cos yaw)), right = (cos yaw, 0, -sin yaw).
    const rx = cosY;
    const rz = -sinY;
    this.camera.position.set(
      s.pos.x + rx * this.bobOffsetX,
      s.pos.y + s.currentEye + this.bobOffsetY,
      s.pos.z + rz * this.bobOffsetX,
    );
    // Set rotation directly to match player yaw/pitch.
    this.camera.rotation.y = s.yaw;
    this.camera.rotation.x = -s.pitch;
    // No roll for FPS.
    this.camera.rotation.z = 0;

    // Lerp toward target FOV. A short half-life feels snappy while still
    // hiding the snap of an instant zoom — CS:GO's scope is near-instant.
    const dt = time.renderDtMs;
    const fovK = 1 - Math.exp(-dt / 35);
    this.camera.fov += (this.targetFovRad - this.camera.fov) * fovK;
  }

  /** Forward unit vector for the player based on current yaw (no pitch). */
  forwardXZ(out: Vector3): Vector3 {
    const y = this.player.state.yaw;
    out.set(Math.sin(y), 0, Math.cos(y));
    return out;
  }

  rightXZ(out: Vector3): Vector3 {
    const y = this.player.state.yaw;
    out.set(Math.cos(y), 0, -Math.sin(y));
    return out;
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
