/** Map authoring types. The map is described as a tree of `Block`s. The
 *  builder traverses the tree and produces (a) visual meshes, (b) collision
 *  AABBs/ramps for the controller, (c) callout polygons, (d) spawn lists,
 *  (e) bomb sites and buy zones. All in-world units are meters. */

import type { MaterialName } from '../materials/library';

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export type CalloutId =
  | 'T_SPAWN' | 'OUTSIDE_LONG' | 'LONG_DOORS' | 'A_LONG' | 'PIT' | 'A_CROSS'
  | 'A_SITE' | 'A_SHORT' | 'CATWALK' | 'MID' | 'MID_DOORS' | 'SUICIDE'
  | 'T_RAMP' | 'B_TUNNELS_UPPER' | 'B_TUNNELS_LOWER' | 'B_SITE' | 'B_PLAT'
  | 'BACK_PLAT' | 'B_WINDOW' | 'FENCE' | 'B_DOORS' | 'CT_MID' | 'CT_SPAWN';

export type Team = 'T' | 'CT';

export interface BoxBlock {
  kind: 'box';
  /** size [x,y,z] in meters */
  size: Vec3;
  /** local origin offset (center of box on x,z; bottom on y) */
  at?: Vec3;
  /** rotation around y axis in degrees */
  yawDeg?: number;
  material: MaterialName;
  /** Tile multiplier on each axis (visual). Default computed from size. */
  uvScale?: Vec2;
  /** Block participates in collision (default true). */
  solid?: boolean;
  /** Block is walkable on top (default true if solid). Walkable surfaces
   *  contribute to ground checks. Non-walkable boxes still block movement. */
  walkable?: boolean;
  /** Block casts shadows (default true). */
  castsShadow?: boolean;
  /** Block receives shadows (default true). */
  receivesShadow?: boolean;
  /** Hidden from rendering — used for invisible collision walls. */
  invisible?: boolean;
  /** Surface tag (read by audio for footstep sounds). */
  surface?: 'sand' | 'wood' | 'metal' | 'concrete' | 'stone';
  /** Friendly name for debug. */
  name?: string;
}

export interface RampBlock {
  kind: 'ramp';
  /** size [length,height,width]. Ramp goes up along +x in local space. */
  size: Vec3;
  at?: Vec3;
  yawDeg?: number;
  material: MaterialName;
  uvScale?: Vec2;
  surface?: BoxBlock['surface'];
  name?: string;
}

export interface ZoneBlock {
  kind: 'zone';
  callout: CalloutId;
  /** Polygon in world XZ. Should be ordered (CW or CCW; we'll normalize). */
  polygon: Vec2[];
  /** Vertical range. Defaults to [-1, 8] which fits a typical floor. */
  yRange?: [number, number];
  /** Adjacent callouts for the navigation/strategy graph. */
  adjacent?: CalloutId[];
  /** Default facing direction (where you face when defending). */
  facing?: CalloutId;
}

export interface SpawnBlock {
  kind: 'spawn';
  team: Team;
  at: Vec3;
  /** facing yaw in degrees */
  yawDeg?: number;
}

export interface BombSiteBlock {
  kind: 'bombsite';
  site: 'A' | 'B';
  polygon: Vec2[];
  yRange?: [number, number];
}

export interface BuyZoneBlock {
  kind: 'buyzone';
  team: Team;
  polygon: Vec2[];
  yRange?: [number, number];
}

export interface GroupBlock {
  kind: 'group';
  name: string;
  /** Origin offset applied to all children. */
  origin?: Vec3;
  /** Rotation around y in degrees applied to all children. */
  yawDeg?: number;
  children: Block[];
}

export type Block =
  | BoxBlock
  | RampBlock
  | ZoneBlock
  | SpawnBlock
  | BombSiteBlock
  | BuyZoneBlock
  | GroupBlock;

// Convenience constructors --------------------------------------------------

export function box(b: Omit<BoxBlock, 'kind'>): BoxBlock {
  return { kind: 'box', ...b };
}
export function ramp(b: Omit<RampBlock, 'kind'>): RampBlock {
  return { kind: 'ramp', ...b };
}
export function zone(b: Omit<ZoneBlock, 'kind'>): ZoneBlock {
  return { kind: 'zone', ...b };
}
export function spawn(b: Omit<SpawnBlock, 'kind'>): SpawnBlock {
  return { kind: 'spawn', ...b };
}
export function bombsite(b: Omit<BombSiteBlock, 'kind'>): BombSiteBlock {
  return { kind: 'bombsite', ...b };
}
export function buyzone(b: Omit<BuyZoneBlock, 'kind'>): BuyZoneBlock {
  return { kind: 'buyzone', ...b };
}
export function group(name: string, origin: Vec3, children: Block[], yawDeg = 0): GroupBlock {
  return { kind: 'group', name, origin, yawDeg, children };
}
