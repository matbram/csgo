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
import { HALF_PI, expSmooth } from '../util/math';
import type { CharacterController } from './controller';

const PITCH_LIMIT = HALF_PI - 0.02;

const FOV_NORMAL = 1.40;       // ~80° vertical
const FOV_SCOPED = 0.45;       // ~26° vertical

export class FpsCamera {
  readonly camera: UniversalCamera;
  private readonly player: CharacterController;
  /** Bob phase advances with horizontal distance traveled. */
  private bobPhase = 0;
  /** Smoothed view bob offset components for a clean reset to zero. */
  private bobOffsetY = 0;
  private bobOffsetX = 0;
  /** Target FOV — smoothed in syncRender. */
  private targetFov = FOV_NORMAL;
  /** Scope-aware mouse sensitivity multiplier. While scoped we lower the
   *  sensitivity in proportion to the FOV change so the same mouse motion
   *  rotates by the same on-screen pixels. */
  private sensScale = 1;

  constructor(player: CharacterController) {
    this.player = player;
    const scene = getScene();
    this.camera = new UniversalCamera('fps-camera', new Vector3(0, 0, 0), scene);
    this.camera.minZ = 0.05;
    this.camera.maxZ = 350;
    this.camera.fov = FOV_NORMAL;
    this.camera.inertia = 0;       // no Babylon-driven smoothing
    this.camera.angularSensibility = 1;
    // Disable Babylon's built-in input controllers — we drive yaw/pitch ourselves.
    this.camera.inputs.clear();
    scene.activeCamera = this.camera;
  }

  /** Set the camera's FOV target (in radians). Useful for sniper scope.
   *  Pass `null` to return to normal. */
  setScopeFov(fov: number | null): void {
    this.targetFov = fov ?? FOV_NORMAL;
    // Sensitivity scales with FOV ratio so look-feel matches pixel-distance.
    this.sensScale = this.targetFov / FOV_NORMAL;
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
    const sens = input.sensitivity * this.sensScale;
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
    // Smoothly interpolate FOV toward the target (scope in/out).
    this.camera.fov = expSmooth(this.camera.fov, this.targetFov, 50, time.renderDtMs);
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
