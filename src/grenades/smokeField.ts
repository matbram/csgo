/** Smoke field — registry of active smoke clouds and the math to ask
 *  "how blocked is this ray by smoke?". Shared by the combat hitscan
 *  (so bots can't aim through smoke) and the bot perception LOS (so
 *  bots can't see through smoke either).
 *
 *  Each smoke is a sphere of fixed radius that decays linearly toward
 *  the end of its lifetime. Vision rays accumulate "obscurity" along
 *  their chord intersection with each active sphere; once total
 *  obscurity exceeds a threshold, the ray is considered fully blocked.
 *  Bullets will eventually pay damage falloff through smoke; for Pass 1
 *  we leave bullet penetration unchanged and only block sight. */

export interface SmokeCloud {
  x: number; y: number; z: number;
  /** Effective radius. Shrinks slightly over time as the cloud thins. */
  radius: number;
  /** Sim ms when this cloud should disappear. */
  expiresMs: number;
  /** Sim ms when the cloud was spawned. Used for the expand-then-shrink
   *  visual envelope. */
  spawnedAtMs: number;
}

/** Chord length through smoke (in meters) at which we treat the ray as
 *  fully blocked. CS:GO smokes are ~6 m wide; one full pass is plenty. */
const FULL_BLOCK_CHORD_M = 1.0;

export class SmokeField {
  private clouds: SmokeCloud[] = [];

  add(c: SmokeCloud): void {
    this.clouds.push(c);
  }

  /** Drop expired clouds. Called from the grenade system tick. */
  prune(nowMs: number): void {
    let w = 0;
    for (let r = 0; r < this.clouds.length; r++) {
      const c = this.clouds[r]!;
      if (nowMs < c.expiresMs) {
        if (w !== r) this.clouds[w] = c;
        w++;
      }
    }
    this.clouds.length = w;
  }

  /** Snapshot for visuals. The renderer should not mutate. */
  list(): ReadonlyArray<SmokeCloud> {
    return this.clouds;
  }

  /** Compute "is this ray blocked by smoke" along a direction within
   *  `maxT` meters from the origin. Returns the t-distance (0..maxT) at
   *  which the ray's accumulated chord first exceeds FULL_BLOCK_CHORD_M
   *  — or `null` if it never does. Callers treat that as a hard wall
   *  for visibility purposes. */
  blockingT(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxT: number,
  ): number | null {
    if (this.clouds.length === 0) return null;
    let accumulated = 0;
    let earliestExit = maxT;
    for (const c of this.clouds) {
      const seg = raySphereSegment(ox, oy, oz, dx, dy, dz, c.x, c.y, c.z, c.radius, maxT);
      if (!seg) continue;
      const chord = seg.tExit - seg.tEnter;
      accumulated += chord;
      if (accumulated >= FULL_BLOCK_CHORD_M) {
        // Find the t at which we crossed the threshold.
        const overshoot = accumulated - FULL_BLOCK_CHORD_M;
        return Math.max(0, seg.tExit - overshoot);
      }
      if (seg.tExit < earliestExit) earliestExit = seg.tExit;
    }
    return null;
  }

  clear(): void {
    this.clouds.length = 0;
  }
}

interface SphereSegment { tEnter: number; tExit: number; }

/** Solve `|origin + t*dir - center| = radius` for the nearest entry
 *  and exit `t` values clipped to [0, maxT]. Returns null if the ray
 *  doesn't cross the sphere within range. */
function raySphereSegment(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number,
  r: number, maxT: number,
): SphereSegment | null {
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  // Quadratic in t: |dir|^2 t^2 + 2 (dir . l) t + (|l|^2 - r^2) = 0.
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (dx * lx + dy * ly + dz * lz);
  const c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return null;
  const s = Math.sqrt(disc);
  const t0 = (-b - s) / (2 * a);
  const t1 = (-b + s) / (2 * a);
  const tEnter = Math.max(0, t0);
  const tExit = Math.min(maxT, t1);
  if (tExit <= tEnter) return null;
  return { tEnter, tExit };
}
