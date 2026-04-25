import { Vector3 } from '@babylonjs/core/Maths/math.vector';

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const TWO_PI = Math.PI * 2;
export const HALF_PI = Math.PI / 2;

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate-independent exponential smoothing. `halfLifeMs` is the time
 *  to close half the gap. Returns the smoothed value. */
export function expSmooth(current: number, target: number, halfLifeMs: number, dtMs: number): number {
  if (halfLifeMs <= 0) return target;
  const k = 1 - Math.pow(0.5, dtMs / halfLifeMs);
  return current + (target - current) * k;
}

export function expSmoothVec3(out: Vector3, current: Vector3, target: Vector3, halfLifeMs: number, dtMs: number): Vector3 {
  if (halfLifeMs <= 0) {
    out.copyFrom(target);
    return out;
  }
  const k = 1 - Math.pow(0.5, dtMs / halfLifeMs);
  out.x = current.x + (target.x - current.x) * k;
  out.y = current.y + (target.y - current.y) * k;
  out.z = current.z + (target.z - current.z) * k;
  return out;
}

export function approachAngle(current: number, target: number, maxDelta: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= TWO_PI;
  while (diff < -Math.PI) diff += TWO_PI;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
