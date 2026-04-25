/** Build a unit-length shot direction from aim forward + spray + scatter.
 *  All angles in degrees. The forward vector is assumed unit length. */

const DEG = Math.PI / 180;

export interface Vec3 { x: number; y: number; z: number; }

/** Right vector for an FPS aim. We use world-up = (0,1,0) as a stable
 *  reference. If forward is near vertical the right is undefined; we
 *  fall back to (1,0,0). */
export function computeRight(fx: number, fy: number, fz: number): Vec3 {
  // right = normalize(forward × up) but for our purposes (camera forward
  // mostly horizontal) we use right = normalize((fz, 0, -fx)) in a
  // left-handed system to match yaw=0 forward=+z, right=+x.
  const len = Math.hypot(fz, fx);
  if (len < 1e-6) {
    return { x: 1, y: 0, z: 0 };
  }
  return { x: fz / len, y: 0, z: -fx / len };
  // Using only horizontal components keeps right horizontal even when
  // pitched, which is what FPS spray patterns expect.
  void fy;
}

/** Up vector orthogonal to forward + right. We use up = forward × right
 *  so that for forward=(0,0,1) and right=(1,0,0), up=(0,1,0). */
export function computeUp(fx: number, fy: number, fz: number, right: Vec3): Vec3 {
  const ux = fy * right.z - fz * right.y;
  const uy = fz * right.x - fx * right.z;
  const uz = fx * right.y - fy * right.x;
  const len = Math.hypot(ux, uy, uz) || 1;
  return { x: ux / len, y: uy / len, z: uz / len };
}

/** Final shot direction = forward, rotated by `sprayX` deg around up,
 *  then rotated by `sprayY` deg around right (positive = pitch up),
 *  then perturbed by a uniform random in a cone of half-angle scatterDeg. */
export function computeShotDir(
  fx: number, fy: number, fz: number,
  right: Vec3, up: Vec3,
  sprayXDeg: number, sprayYDeg: number,
  scatterDeg: number,
): Vec3 {
  // Convert sprayX/sprayY to small offsets in tangent space.
  const sx = Math.tan(sprayXDeg * DEG);
  const sy = Math.tan(sprayYDeg * DEG);
  // Random scatter inside a disk of radius tan(scatterDeg).
  let rx = 0, ry = 0;
  if (scatterDeg > 0) {
    const r = Math.tan(scatterDeg * DEG) * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    rx = Math.cos(a) * r;
    ry = Math.sin(a) * r;
  }
  const tx = sx + rx;
  const ty = sy + ry;
  const dx = fx + right.x * tx + up.x * ty;
  const dy = fy + right.y * tx + up.y * ty;
  const dz = fz + right.z * tx + up.z * ty;
  const len = Math.hypot(dx, dy, dz) || 1;
  return { x: dx / len, y: dy / len, z: dz / len };
}
