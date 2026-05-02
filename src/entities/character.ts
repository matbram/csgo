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
  /** Sim ms at which this character's flash blindness clears. Past
   *  values mean "not flashed". Both the local player overlay and the
   *  bot perception flash-degrade hook off this. */
  flashedUntilMs?: number;

  /** Cumulative limb damage trackers — a single big shot or several
   *  smaller ones to a limb eventually crosses the detach threshold,
   *  even if the character survives. We only track one side per type
   *  (left vs right is picked at detach time inside the humanoid). */
  legDamage: number;
  armDamage: number;
  /** True after the matching limb is permanently detached for the
   *  remainder of the round. Reset by resetCharacterForRound. The
   *  movement controller and firing inaccuracy code read these to
   *  apply impairment penalties. */
  legDetached: boolean;
  armDetached: boolean;
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
