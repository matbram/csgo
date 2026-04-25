/** Common character data. The local player and bots both wrap this; dummy
 *  targets in M2 also use it. */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Inventory } from '../weapons/inventory';
import type { HitboxPose } from '../combat/hitbox';

export type CharacterTeam = 'T' | 'CT';

export interface Character {
  id: string;
  team: CharacterTeam;
  /** True if this is the human-controlled player. */
  isLocal: boolean;
  /** Capsule base position. */
  pos: Vector3;
  /** Capsule current height (interpolated when crouching). */
  currentHeight: number;
  /** Eye height above base. */
  currentEye: number;
  yaw: number;
  pitch: number;

  hp: number;
  armor: number;
  helmet: boolean;
  /** CT defuse kit. */
  hasKit: boolean;
  alive: boolean;
  inventory: Inventory | null;

  /** True for moving entities — matters for inaccuracy. */
  speed: number;
  inAir: boolean;
  crouching: boolean;
  /** True while a sniper rifle is scoped (right-click held). Reduces
   *  inaccuracy and changes camera FOV + view-model visibility. */
  scoped: boolean;
}

export function hitboxPose(c: Character): HitboxPose {
  return {
    baseX: c.pos.x,
    baseY: c.pos.y,
    baseZ: c.pos.z,
    eye: c.currentEye,
    height: c.currentHeight,
  };
}
