/** Custom kinematic capsule controller, tuned for CS:GO-like feel.
 *
 *  Key tunables:
 *    - run speed, walk speed, crouch speed
 *    - ground accel, air accel, friction
 *    - jump impulse, gravity
 *    - capsule radius, standing/crouch height
 *
 *  Counter-strafing falls out of the friction + accel model — pressing the
 *  opposite key applies opposing accel and the strong ground friction
 *  brings velocity to ~0 in 1–2 ticks.
 *
 *  The controller is deterministic per fixed sim tick. It receives an input
 *  snapshot and produces a position/velocity update. It does NOT touch
 *  Babylon meshes — that's the FPS camera's job. */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { WorldQuery, type GroundHit } from './physics';

export interface ControllerInput {
  /** wishDir in world XZ (will be normalized; magnitude treated as analog 0..1). */
  wishX: number;
  wishZ: number;
  /** intent flags */
  jump: boolean;
  walk: boolean;
  crouch: boolean;
  /** Multiplier on the move speed (1 = base, 0.85 = AK, 0.65 = AWP). */
  speedScale?: number;
}

export interface ControllerTunables {
  runSpeed: number;
  walkSpeed: number;
  crouchSpeed: number;
  groundAccel: number;
  airAccel: number;
  friction: number;
  jumpImpulse: number;
  gravity: number;
  radius: number;
  standHeight: number;
  crouchHeight: number;
  /** How tall a step we can auto-up. */
  stepUpMax: number;
  /** Eye height when standing/crouching (offset from capsule base). */
  standEye: number;
  crouchEye: number;
  /** Crouch transition half-life (ms). */
  crouchSmoothMs: number;
}

export const DEFAULT_TUNABLES: ControllerTunables = {
  runSpeed: 6.5,
  walkSpeed: 3.4,
  crouchSpeed: 2.3,
  groundAccel: 90,
  airAccel: 30,
  friction: 9.0,
  jumpImpulse: 5.4,
  gravity: 18.0,
  radius: 0.36,
  standHeight: 1.80,
  crouchHeight: 1.30,
  stepUpMax: 0.45,
  standEye: 1.65,
  crouchEye: 1.15,
  crouchSmoothMs: 120,
};

export interface ControllerState {
  pos: Vector3;
  vel: Vector3;
  yaw: number;
  pitch: number;
  /** Visual eye height — interpolated; capsule height also lerps. */
  currentHeight: number;
  currentEye: number;
  crouching: boolean;
  /** True if we're held-by-ceiling and want to stand but can't. */
  forcedCrouch: boolean;
  onGround: boolean;
  groundNormalY: number;
  groundSurface: GroundHit['surface'];
  /** Distance traveled since last footstep emission. */
  footstepDist: number;
  walking: boolean;
  /** Last horizontal speed (for HUD/audio). */
  speed: number;
}

export class CharacterController {
  state: ControllerState;
  readonly tunables: ControllerTunables;
  private readonly query: WorldQuery;

  constructor(query: WorldQuery, startPos: Vector3, startYaw: number, t: ControllerTunables = DEFAULT_TUNABLES) {
    this.query = query;
    this.tunables = t;
    this.state = {
      pos: startPos.clone(),
      vel: Vector3.Zero(),
      yaw: startYaw,
      pitch: 0,
      currentHeight: t.standHeight,
      currentEye: t.standEye,
      crouching: false,
      forcedCrouch: false,
      onGround: false,
      groundNormalY: 1,
      groundSurface: 'sand',
      footstepDist: 0,
      walking: false,
      speed: 0,
    };
  }

  /** Snap to the ground if a surface is within drop range. Used at spawn. */
  snapToGround(): void {
    const t = this.tunables;
    const hit = this.query.groundProbe(this.state.pos.x, this.state.pos.z, this.state.pos.y + 0.5, 5);
    if (hit) {
      this.state.pos.y = hit.y;
      this.state.onGround = true;
      this.state.groundNormalY = hit.normalY;
      this.state.groundSurface = hit.surface;
      this.state.vel.y = 0;
    }
    void t;
  }

  step(dtMs: number, input: ControllerInput): void {
    const dt = dtMs / 1000;
    const t = this.tunables;
    const s = this.state;

    // ----- Crouch state -----
    s.crouching = input.crouch;
    const wantHeight = s.crouching ? t.crouchHeight : t.standHeight;
    const wantEye = s.crouching ? t.crouchEye : t.standEye;
    // If we want to stand but ceiling is in the way, stay crouched.
    if (!s.crouching && s.currentHeight < t.standHeight - 0.01) {
      const clear = this.query.capsuleClear(s.pos.x, s.pos.y, s.pos.z, t.radius, t.standHeight);
      if (!clear) {
        s.forcedCrouch = true;
      } else {
        s.forcedCrouch = false;
      }
    } else {
      s.forcedCrouch = false;
    }
    const targetH = s.forcedCrouch ? t.crouchHeight : wantHeight;
    const targetEye = s.forcedCrouch ? t.crouchEye : wantEye;
    // Exponential smoothing on height/eye.
    const k = 1 - Math.pow(0.5, dtMs / t.crouchSmoothMs);
    s.currentHeight += (targetH - s.currentHeight) * k;
    s.currentEye += (targetEye - s.currentEye) * k;

    // ----- Wish direction -----
    let wx = input.wishX, wz = input.wishZ;
    const wlen2 = wx * wx + wz * wz;
    if (wlen2 > 1) {
      const wlen = Math.sqrt(wlen2);
      wx /= wlen;
      wz /= wlen;
    }
    const baseSpeed = s.crouching || s.forcedCrouch
      ? t.crouchSpeed
      : input.walk
        ? t.walkSpeed
        : t.runSpeed;
    const moveSpeed = baseSpeed * (input.speedScale ?? 1);
    s.walking = input.walk && !s.crouching && !s.forcedCrouch;

    // ----- Friction (ground only) -----
    if (s.onGround) {
      const speed = Math.hypot(s.vel.x, s.vel.z);
      if (speed > 0) {
        // CS:GO-style friction: drop speed by `friction * dt * max(speed, stopSpeed)`
        const stopSpeed = 1.0;
        const drop = Math.max(speed, stopSpeed) * t.friction * dt;
        const newSpeed = Math.max(0, speed - drop);
        const scale = newSpeed / speed;
        s.vel.x *= scale;
        s.vel.z *= scale;
      }
    }

    // ----- Acceleration -----
    if (wlen2 > 0) {
      const accel = s.onGround ? t.groundAccel : t.airAccel;
      // Source-style accelerate: project current vel on wish dir, add (wish_speed - current).
      const currentInWish = s.vel.x * wx + s.vel.z * wz;
      const addSpeed = moveSpeed - currentInWish;
      if (addSpeed > 0) {
        const accelSpeed = Math.min(accel * dt * moveSpeed, addSpeed);
        s.vel.x += wx * accelSpeed;
        s.vel.z += wz * accelSpeed;
      }
    }

    // ----- Gravity -----
    if (!s.onGround) {
      s.vel.y -= t.gravity * dt;
    }

    // ----- Jump -----
    if (input.jump && s.onGround && !s.forcedCrouch) {
      s.vel.y = t.jumpImpulse;
      s.onGround = false;
    }

    // ----- Move horizontal with collision -----
    let dx = s.vel.x * dt;
    let dz = s.vel.z * dt;

    const before = this.query.resolveHorizontal(
      s.pos.x, s.pos.y, s.pos.z, dx, dz, t.radius, s.currentHeight,
    );
    let resolvedDx = before.dx;
    let resolvedDz = before.dz;

    // Try a step-up if our motion was significantly blocked: lift the
    // capsule by stepUpMax, redo horizontal resolution, then drop back.
    if (s.onGround && (Math.abs(resolvedDx - dx) > 0.001 || Math.abs(resolvedDz - dz) > 0.001)) {
      const lifted = this.query.resolveHorizontal(
        s.pos.x, s.pos.y + t.stepUpMax, s.pos.z, dx, dz, t.radius, s.currentHeight,
      );
      const liftedX = s.pos.x + lifted.dx;
      const liftedZ = s.pos.z + lifted.dz;
      const liftedDistSq = (lifted.dx - dx) * (lifted.dx - dx) + (lifted.dz - dz) * (lifted.dz - dz);
      const baseDistSq = (resolvedDx - dx) * (resolvedDx - dx) + (resolvedDz - dz) * (resolvedDz - dz);
      // Step-up wins if it produced more motion AND ground exists at the new position.
      if (liftedDistSq < baseDistSq) {
        const ground = this.query.groundProbe(liftedX, liftedZ, s.pos.y + t.stepUpMax + 0.1, t.stepUpMax + 0.1);
        if (ground && ground.y >= s.pos.y - 0.01) {
          resolvedDx = lifted.dx;
          resolvedDz = lifted.dz;
          // Snap to ground at the stepped-up height.
          s.pos.y = ground.y;
        }
      }
    }

    s.pos.x += resolvedDx;
    s.pos.z += resolvedDz;

    // Kill velocity component into the wall so we don't accumulate energy.
    if (before.hitNormalX !== 0 || before.hitNormalZ !== 0) {
      const dot = s.vel.x * before.hitNormalX + s.vel.z * before.hitNormalZ;
      if (dot < 0) {
        s.vel.x -= before.hitNormalX * dot;
        s.vel.z -= before.hitNormalZ * dot;
      }
    }

    // ----- Vertical move + ground check -----
    s.pos.y += s.vel.y * dt;
    const ground = this.query.groundProbe(s.pos.x, s.pos.z, s.pos.y + 0.1, s.vel.y < 0 ? Math.max(0.5, -s.vel.y * dt + 0.4) : 0.05);
    if (ground && s.vel.y <= 0 && s.pos.y - ground.y < 0.5) {
      // Snap to ground.
      s.pos.y = ground.y;
      s.vel.y = 0;
      s.onGround = true;
      s.groundNormalY = ground.normalY;
      s.groundSurface = ground.surface;
    } else if (ground && s.pos.y < ground.y) {
      // Catch case where we ended up below ground (shouldn't happen but defensive).
      s.pos.y = ground.y;
      s.vel.y = 0;
      s.onGround = true;
      s.groundNormalY = ground.normalY;
      s.groundSurface = ground.surface;
    } else {
      s.onGround = false;
    }

    // ----- Footstep accumulator (sound system reads this) -----
    const horizSpeed = Math.hypot(s.vel.x, s.vel.z);
    s.speed = horizSpeed;
    if (s.onGround && horizSpeed > 0.1) {
      s.footstepDist += horizSpeed * dt;
    } else {
      s.footstepDist *= 0.9; // decay so a small movement and stop doesn't trip a step.
    }
  }
}
