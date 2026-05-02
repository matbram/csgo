/** Tactical map graph — cover, peek, hold-angle, pre-aim, exposure.
 *  This is the data the planner needs that the raw nav grid + callout
 *  polygons don't carry. We derive most of it from existing data at
 *  world-load time and accept a small per-map hand-tuning overlay for
 *  the spots that auto-detection can't get right.
 *
 *  ──────────────────────────────────────────────────────────────────
 *  What lives here:
 *    - `CoverNode`   — one position adjacent to an eye-height obstacle.
 *                       Carries a normal vector pointing AWAY from the
 *                       wall, the cover height class, and the callout
 *                       it belongs to.
 *    - `PeekNode`    — a `CoverNode` plus an offset position the bot
 *                       moves to when it wants to peek out, plus the
 *                       callout(s) that position exposes via LOS.
 *    - `HoldAngle`   — a (cover, facingYaw, exposesCallout) triple.
 *                       Multiple per cover: a B-doors anchor holds
 *                       one angle towards tunnels, another towards
 *                       site.
 *    - `PreAimSpot`  — keyed by (callout, targetCallout). The yaw +
 *                       pitch a bot should set while traversing
 *                       `callout` if they expect engagement from
 *                       `targetCallout`. Cheap; one per callout pair.
 *    - `ExposureMap` — per nav cell, a 0..1 estimate of "how visible
 *                       am I right now to the contested area". Used by
 *                       the future MoveCovered action's cost overlay.
 *
 *  ──────────────────────────────────────────────────────────────────
 *  Derivation outline (per-map at boot, ~20–80 ms):
 *    1.  Walk the nav grid. For each walkable cell, check 4 cardinal
 *        neighbours; if a neighbour is non-walkable AND there is a
 *        solid box at eye height (1.55 m) above that neighbour cell's
 *        floor, this cell is a CoverCell with the normal pointing
 *        from neighbour to self.
 *    2.  Compact: cluster cover cells by callout + 2-cell window
 *        radius. One representative CoverNode per cluster.
 *    3.  For each CoverNode, the "peek" cell is the cell immediately
 *        in the cover's tangent direction (perpendicular to normal).
 *        If that peek cell is walkable AND has clear LOS to a callout
 *        centroid the cover does NOT see, we record a PeekNode.
 *    4.  Hold angles: for each CoverNode, take the callout's authored
 *        `facing` (when present) plus any adjacent callout that has
 *        clear LOS from the cover position. One HoldAngle each.
 *    5.  Pre-aim spots: every (callout A, adjacent callout B) pair
 *        gets a PreAimSpot whose yaw aims from A's centroid towards
 *        B's centroid, with a small downward pitch.
 *    6.  Exposure map: a Float32Array of size cellsX*cellsZ. For each
 *        cell, count clear-LOS rays (sampled, not exhaustive) to
 *        bombsite centroids. Normalise. The planner reads this as a
 *        per-cell extra cost when planning covered movement.
 *
 *  All produced data is read-only after build. The TacticalOverlay
 *  shipped per-map can ADD hold angles, mark cover nodes as head-glitch
 *  spots, or override a peek node's `exposes` set — but it never
 *  removes auto-derived nodes. */

import type { CalloutId } from '../../map/types';
import type { World } from '../../map/world';
import type { NavGrid } from '../../nav/grid';
import type { WorldQuery } from '../../player/physics';

export type CoverHeight = 'full' | 'low';

export interface CoverNode {
  id: number;
  /** World-space cover-anchor position (cell center, ground Y). */
  x: number; y: number; z: number;
  /** Normal vector pointing AWAY from the cover (where the threat is). */
  normalX: number; normalZ: number;
  /** 'full' if a standing player is fully concealed from the normal
   *  direction; 'low' if only a crouching one is. */
  height: CoverHeight;
  /** Containing callout, or null when the cover sits on a callout edge. */
  callout: CalloutId | null;
  /** Marked by the hand-tune overlay. A head-glitch is a low-cover spot
   *  whose top edge lines up with eye height — leaning over it shows
   *  only the head. The planner uses these to choose `HeadGlitch`
   *  actions in Phase 3+. */
  headGlitch: boolean;
}

export interface PeekNode {
  id: number;
  coverId: number;
  /** Cell the bot moves to when peeking. World coords, ground Y. */
  peekX: number; peekY: number; peekZ: number;
  /** Callouts visible from the peek position that are NOT visible from
   *  the cover position. The planner uses this for "peek to gain info /
   *  trade kill". */
  exposes: CalloutId[];
}

export interface HoldAngle {
  coverId: number;
  /** Facing yaw a bot adopts when holding from this cover. Radians,
   *  matches the bot's controller yaw convention. */
  yaw: number;
  /** Slight downward pitch — head-level for a typical entry. */
  pitch: number;
  /** Callout this angle covers. */
  exposes: CalloutId | null;
  /** When true, this hold puts the bot on the head-glitch silhouette
   *  for the cover. Mirrored from CoverNode.headGlitch. */
  headGlitch: boolean;
}

export interface PreAimSpot {
  /** Where the bot is. */
  callout: CalloutId;
  /** Where the engagement is expected from. */
  targetCallout: CalloutId;
  yaw: number;
  pitch: number;
}

export interface TacticalGraph {
  cover: CoverNode[];
  peeks: PeekNode[];
  holdAngles: HoldAngle[];
  /** Indexed [calloutId][targetCalloutId]. Use the helper `preAimFor`. */
  preAim: Map<CalloutId, Map<CalloutId, PreAimSpot>>;
  /** Per nav-cell exposure score 0..1 (1 = fully exposed to contested
   *  area). Length cellsX*cellsZ. */
  exposure: Float32Array;
  /** Aux: cover representatives clustered by callout. Useful for HUD
   *  rendering and quick lookup. */
  coverByCallout: Map<CalloutId, CoverNode[]>;
}

export interface TacticalOverlay {
  /** Per-cover overrides. Matched by approximate position (within
   *  CLUSTER_RADIUS_M). */
  headGlitchAt?: Array<{ x: number; z: number; callout?: CalloutId }>;
  /** Extra hold angles (e.g. authored "AWP from PIT toward A_LONG"). */
  extraHoldAngles?: Array<{
    callout: CalloutId;
    fromX: number; fromZ: number;
    yawDeg: number;
    exposes?: CalloutId;
    headGlitch?: boolean;
  }>;
  /** Override pre-aim spots (rare; auto-derivation is usually fine). */
  preAimOverride?: Array<{
    callout: CalloutId;
    targetCallout: CalloutId;
    yawDeg: number;
    pitchDeg?: number;
  }>;
}

export interface BuildOptions {
  /** Eye height we test for cover obstruction. CS:GO standing eye is
   *  ~1.62; we use 1.55 so partial concealment registers as full cover. */
  eyeHeight: number;
  /** Crouch eye height — for `low` cover detection. */
  crouchEye: number;
  /** Cluster radius (m) for cover compaction. Cover cells within this
   *  radius collapse into one representative. */
  clusterRadius: number;
  /** LOS sample range (m) when computing peek-node `exposes`. */
  peekRangeM: number;
  /** Number of bombsite samples used for the exposure map. */
  exposureSamplesPerSite: number;
}

export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  eyeHeight: 1.55,
  crouchEye: 1.05,
  clusterRadius: 1.6,
  peekRangeM: 22,
  exposureSamplesPerSite: 4,
};

let nextId = 1;
function id(): number { return nextId++; }

/** Build the graph. Pure function over (world, grid, query, overlay)
 *  so unit tests can pin behaviour on synthetic geometry. */
export function buildTacticalGraph(
  world: World,
  grid: NavGrid,
  query: WorldQuery,
  overlay: TacticalOverlay = {},
  opts: BuildOptions = DEFAULT_BUILD_OPTIONS,
): TacticalGraph {
  // Snapshot callout centroids at grid floor heights so the LOS helpers
  // don't pay the polygonCentroid + worldToCell cost per ray.
  setCalloutSnapshot(world, grid);

  const cover = deriveCover(world, grid, query, opts);
  applyHeadGlitchOverlay(cover, overlay);
  const coverByCallout = clusterByCallout(cover);

  const peeks = derivePeeks(cover, grid, query, opts);
  const holdAngles = deriveHoldAngles(cover, world, query, opts);
  applyExtraHoldAngles(holdAngles, cover, overlay);
  const preAim = derivePreAim(world);
  applyPreAimOverride(preAim, overlay);
  const exposure = deriveExposureMap(world, grid, query, opts);

  return { cover, peeks, holdAngles, preAim, exposure, coverByCallout };
}

/** Lookup helper for the planner. */
export function preAimFor(g: TacticalGraph, callout: CalloutId, target: CalloutId): PreAimSpot | null {
  return g.preAim.get(callout)?.get(target) ?? null;
}

// ──────────────────────────────────────────────────────────────
//  Derivation passes
// ──────────────────────────────────────────────────────────────

function deriveCover(
  world: World,
  grid: NavGrid,
  query: WorldQuery,
  opts: BuildOptions,
): CoverNode[] {
  const out: CoverNode[] = [];
  // Cardinal neighbours. We use 4-way (not 8) — a diagonal cover relation
  // would require both adjacent cardinals to be cover too, which is
  // already covered by the cardinals themselves.
  const NEI: ReadonlyArray<readonly [number, number]> = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];
  for (let j = 0; j < grid.cellsZ; j++) {
    for (let i = 0; i < grid.cellsX; i++) {
      if (!grid.isWalkable(i, j)) continue;
      const here = grid.cellCenterWorld(i, j);
      const groundY = grid.groundYAt(i, j);
      for (const [di, dj] of NEI) {
        const ni = i + di;
        const nj = j + dj;
        if (grid.inBounds(ni, nj) && grid.isWalkable(ni, nj)) continue;
        // The neighbour is non-walkable. Confirm there's eye-height
        // geometry on it, else this is just a map edge / hole.
        const neiCenter = grid.cellCenterWorld(ni, nj);
        const eyeY = groundY + opts.eyeHeight;
        const dx = neiCenter.x - here.x;
        const dz = neiCenter.z - here.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1e-3) continue;
        const ndx = dx / dist;
        const ndz = dz / dist;
        // Probe slightly past the neighbour cell center.
        const probeT = grid.cellSize * 0.9;
        const standingHit = query.rayWorld(here.x, eyeY, here.z, ndx, 0, ndz, probeT);
        const crouchY = groundY + opts.crouchEye;
        const crouchHit = query.rayWorld(here.x, crouchY, here.z, ndx, 0, ndz, probeT);
        let height: CoverHeight | null = null;
        if (standingHit) height = 'full';
        else if (crouchHit) height = 'low';
        if (!height) continue;
        // Normal points AWAY from the wall (toward `here` from `nei`).
        const normalX = -ndx;
        const normalZ = -ndz;
        out.push({
          id: id(),
          x: here.x, y: groundY, z: here.z,
          normalX, normalZ, height,
          callout: world.calloutAt(here.x, groundY + 0.1, here.z),
          headGlitch: false,
        });
      }
    }
  }
  return compactCover(out, opts.clusterRadius);
}

/** Cluster cover nodes within `radius` into a single representative.
 *  We pick the node with the most "cover sides" (i.e. when several
 *  cells share a corner, the corner wins) by counting nearby cells. */
function compactCover(cover: CoverNode[], radius: number): CoverNode[] {
  if (cover.length === 0) return cover;
  const radSq = radius * radius;
  // Greedy: walk the list; for each unkept node, scoop up neighbours
  // within radius and pick the one with the fattest local count.
  const kept: CoverNode[] = [];
  const consumed = new Uint8Array(cover.length);
  for (let i = 0; i < cover.length; i++) {
    if (consumed[i]) continue;
    const cluster: number[] = [i];
    const a = cover[i]!;
    for (let j = i + 1; j < cover.length; j++) {
      if (consumed[j]) continue;
      const b = cover[j]!;
      const dx = a.x - b.x, dz = a.z - b.z;
      if (dx * dx + dz * dz <= radSq) cluster.push(j);
    }
    // Average the normals; pick the highest-cover one as the
    // representative position.
    let nx = 0, nz = 0;
    let bestIdx = cluster[0]!;
    let bestKey = -Infinity;
    for (const k of cluster) {
      consumed[k] = 1;
      const c = cover[k]!;
      nx += c.normalX;
      nz += c.normalZ;
      // Prefer 'full' cover and high-count locations as the rep.
      const key = (c.height === 'full' ? 100 : 0) + cluster.length;
      if (key > bestKey) { bestKey = key; bestIdx = k; }
    }
    const rep = cover[bestIdx]!;
    const len = Math.hypot(nx, nz) || 1;
    kept.push({
      ...rep,
      normalX: nx / len,
      normalZ: nz / len,
    });
  }
  return kept;
}

function applyHeadGlitchOverlay(cover: CoverNode[], overlay: TacticalOverlay): void {
  if (!overlay.headGlitchAt) return;
  const RADIUS_SQ = DEFAULT_BUILD_OPTIONS.clusterRadius ** 2;
  for (const tag of overlay.headGlitchAt) {
    let best: CoverNode | null = null;
    let bestSq = RADIUS_SQ * 4;
    for (const c of cover) {
      if (tag.callout && c.callout && tag.callout !== c.callout) continue;
      const dx = c.x - tag.x, dz = c.z - tag.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestSq) { bestSq = d2; best = c; }
    }
    if (best) best.headGlitch = true;
  }
}

function clusterByCallout(cover: CoverNode[]): Map<CalloutId, CoverNode[]> {
  const out = new Map<CalloutId, CoverNode[]>();
  for (const c of cover) {
    if (!c.callout) continue;
    const list = out.get(c.callout) ?? [];
    list.push(c);
    out.set(c.callout, list);
  }
  return out;
}

function derivePeeks(
  cover: CoverNode[],
  grid: NavGrid,
  query: WorldQuery,
  opts: BuildOptions,
): PeekNode[] {
  const out: PeekNode[] = [];
  for (const c of cover) {
    // The peek cell is offset along the cover tangent (perpendicular to
    // normal). We try both signs and keep whichever is walkable.
    const tx = -c.normalZ;
    const tz = c.normalX;
    const stride = grid.cellSize * 1.5;
    for (const sign of [1, -1] as const) {
      const px = c.x + tx * sign * stride;
      const pz = c.z + tz * sign * stride;
      const cell = grid.worldToCell(px, pz);
      if (!cell) continue;
      if (!grid.isWalkable(cell.i, cell.j)) continue;
      const py = grid.groundYAt(cell.i, cell.j);
      const exposes = los_exposesCallouts(px, py + opts.eyeHeight, pz, query, opts.peekRangeM);
      if (exposes.length === 0) continue;
      out.push({
        id: id(),
        coverId: c.id,
        peekX: px, peekY: py, peekZ: pz,
        exposes,
      });
    }
  }
  return out;
}

/** Cheap LOS check from (eyeX, eyeY, eyeZ) to centroids of all
 *  callouts within range; return those reachable without world hit. */
function los_exposesCallouts(
  eyeX: number, eyeY: number, eyeZ: number,
  query: WorldQuery,
  rangeM: number,
): CalloutId[] {
  // We need world callouts here; the function doesn't take World as
  // arg (cleaner API). We pass it via closure — use the module-local
  // cache set on first build.
  const out: CalloutId[] = [];
  if (!_calloutSnapshot) return out;
  for (const c of _calloutSnapshot) {
    const dx = c.cx - eyeX;
    const dz = c.cz - eyeZ;
    const dist = Math.hypot(dx, dz);
    if (dist > rangeM || dist < 0.5) continue;
    const dy = (c.cy + 1.4) - eyeY;
    const fullDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const ndx = dx / fullDist, ndy = dy / fullDist, ndz = dz / fullDist;
    const hit = query.rayWorld(eyeX, eyeY, eyeZ, ndx, ndy, ndz, fullDist - 0.2);
    if (!hit) out.push(c.id);
  }
  return out;
}

interface CalloutSnap { id: CalloutId; cx: number; cy: number; cz: number }
let _calloutSnapshot: CalloutSnap[] | null = null;

function setCalloutSnapshot(world: World, grid: NavGrid): void {
  const out: CalloutSnap[] = [];
  for (const c of world.callouts.values()) {
    const cx = c.centroid[0];
    const cz = c.centroid[1];
    const cell = grid.worldToCell(cx, cz);
    const cy = cell ? grid.groundYAt(cell.i, cell.j) : (c.yMin + 0.1);
    out.push({ id: c.id, cx, cy, cz });
  }
  _calloutSnapshot = out;
}

function deriveHoldAngles(
  cover: CoverNode[],
  world: World,
  query: WorldQuery,
  opts: BuildOptions,
): HoldAngle[] {
  const out: HoldAngle[] = [];
  for (const c of cover) {
    if (!c.callout) continue;
    const callout = world.callouts.get(c.callout);
    if (!callout) continue;
    const candidates: CalloutId[] = [];
    if (callout.facing) candidates.push(callout.facing);
    for (const adj of callout.adjacent) candidates.push(adj);
    for (const target of dedupe(candidates)) {
      const t = world.callouts.get(target);
      if (!t) continue;
      const dx = t.centroid[0] - c.x;
      const dz = t.centroid[1] - c.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1.5 || dist > opts.peekRangeM * 1.5) continue;
      // LOS sanity — cover should actually see the target.
      const eyeY = c.y + opts.eyeHeight;
      const targetCell = (() => {
        const cell = _calloutSnapshot?.find(s => s.id === target);
        return cell ? cell.cy + 1.4 : c.y + 1.4;
      })();
      const fullDist = Math.sqrt(dx * dx + (targetCell - eyeY) ** 2 + dz * dz);
      const ndx = dx / fullDist;
      const ndy = (targetCell - eyeY) / fullDist;
      const ndz = dz / fullDist;
      const hit = query.rayWorld(c.x, eyeY, c.z, ndx, ndy, ndz, fullDist - 0.2);
      if (hit) continue;
      out.push({
        coverId: c.id,
        yaw: Math.atan2(dx, dz),
        pitch: Math.atan2(targetCell - eyeY, Math.hypot(dx, dz)) * -0.6, // bias slightly down
        exposes: target,
        headGlitch: c.headGlitch,
      });
    }
  }
  return out;
}

function applyExtraHoldAngles(
  holdAngles: HoldAngle[],
  cover: CoverNode[],
  overlay: TacticalOverlay,
): void {
  if (!overlay.extraHoldAngles) return;
  for (const extra of overlay.extraHoldAngles) {
    // Snap to the nearest cover node within the same callout (or
    // anywhere if the callout match fails).
    let best: CoverNode | null = null;
    let bestSq = Infinity;
    for (const c of cover) {
      if (c.callout !== extra.callout) continue;
      const dx = c.x - extra.fromX, dz = c.z - extra.fromZ;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestSq) { bestSq = d2; best = c; }
    }
    if (!best) continue;
    holdAngles.push({
      coverId: best.id,
      yaw: extra.yawDeg * (Math.PI / 180),
      pitch: -0.05,
      exposes: extra.exposes ?? null,
      headGlitch: extra.headGlitch ?? best.headGlitch,
    });
  }
}

function derivePreAim(world: World): Map<CalloutId, Map<CalloutId, PreAimSpot>> {
  const out = new Map<CalloutId, Map<CalloutId, PreAimSpot>>();
  for (const c of world.callouts.values()) {
    let inner = out.get(c.id);
    if (!inner) { inner = new Map(); out.set(c.id, inner); }
    for (const targetId of c.adjacent) {
      const t = world.callouts.get(targetId);
      if (!t) continue;
      const dx = t.centroid[0] - c.centroid[0];
      const dz = t.centroid[1] - c.centroid[1];
      inner.set(targetId, {
        callout: c.id,
        targetCallout: targetId,
        yaw: Math.atan2(dx, dz),
        pitch: -0.04,        // ~head height at ~25 m
      });
    }
  }
  return out;
}

function applyPreAimOverride(
  preAim: Map<CalloutId, Map<CalloutId, PreAimSpot>>,
  overlay: TacticalOverlay,
): void {
  if (!overlay.preAimOverride) return;
  for (const ovr of overlay.preAimOverride) {
    let inner = preAim.get(ovr.callout);
    if (!inner) { inner = new Map(); preAim.set(ovr.callout, inner); }
    inner.set(ovr.targetCallout, {
      callout: ovr.callout,
      targetCallout: ovr.targetCallout,
      yaw: ovr.yawDeg * (Math.PI / 180),
      pitch: (ovr.pitchDeg ?? -3) * (Math.PI / 180),
    });
  }
}

function deriveExposureMap(
  world: World,
  grid: NavGrid,
  query: WorldQuery,
  opts: BuildOptions,
): Float32Array {
  const out = new Float32Array(grid.cellsX * grid.cellsZ);
  // Sample 4 points per bombsite: centroid and three ~1 m perturbations.
  const samples: Array<{ x: number; y: number; z: number }> = [];
  for (const site of world.bombSites) {
    const c = polygonCentroid(site.polygon);
    samples.push({ x: c[0], y: site.yMin + 1.6, z: c[1] });
    for (let k = 1; k < opts.exposureSamplesPerSite; k++) {
      const ang = (k / opts.exposureSamplesPerSite) * Math.PI * 2;
      samples.push({
        x: c[0] + Math.cos(ang) * 1.2,
        y: site.yMin + 1.6,
        z: c[1] + Math.sin(ang) * 1.2,
      });
    }
  }
  if (samples.length === 0) return out;
  const invSamples = 1 / samples.length;
  for (let j = 0; j < grid.cellsZ; j++) {
    for (let i = 0; i < grid.cellsX; i++) {
      const idx2 = j * grid.cellsX + i;
      if (!grid.isWalkable(i, j)) continue;
      const c = grid.cellCenterWorld(i, j);
      const eyeY = grid.groundYAt(i, j) + opts.eyeHeight;
      let visible = 0;
      for (const s of samples) {
        const dx = s.x - c.x, dy = s.y - eyeY, dz = s.z - c.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 0.1) continue;
        const hit = query.rayWorld(c.x, eyeY, c.z, dx / d, dy / d, dz / d, d - 0.2);
        if (!hit) visible += 1;
      }
      out[idx2] = visible * invSamples;
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────

function dedupe<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x); out.push(x);
  }
  return out;
}

function polygonCentroid(poly: ReadonlyArray<readonly [number, number]>): [number, number] {
  if (poly.length === 0) return [0, 0];
  let sx = 0, sz = 0;
  for (const [x, z] of poly) { sx += x; sz += z; }
  return [sx / poly.length, sz / poly.length];
}
