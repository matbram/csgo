/** Local player binding. Wraps the kinematic CharacterController and a
 *  Character record so combat treats the player like any other entity.
 *
 *  Each sim tick we:
 *    1. Apply mouse look
 *    2. Build wishDir from input + yaw
 *    3. Step the controller
 *    4. Mirror controller state into the Character (pos, height, eye,
 *       speed, inAir, crouching).
 *
 *  The view model is a separate concern (player/viewModel.ts).
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { CharacterController } from './controller';
import type { Character } from '../entities/character';
import { defaultInventory } from '../weapons/inventory';

export class LocalPlayer {
  readonly character: Character;
  readonly controller: CharacterController;

  constructor(controller: CharacterController, team: 'T' | 'CT') {
    this.controller = controller;
    const inv = defaultInventory(team);
    this.character = {
      id: 'local',
      team,
      isLocal: true,
      pos: new Vector3(0, 0, 0),
      currentHeight: 1.80,
      currentEye: 1.65,
      yaw: 0,
      pitch: 0,
      hp: 100,
      armor: 0,
      helmet: false,
      alive: true,
      inventory: inv,
      speed: 0,
      inAir: false,
      crouching: false,
    };
    this.syncFromController();
  }

  /** Mirror the kinematic controller state into the character record. */
  syncFromController(): void {
    const s = this.controller.state;
    const c = this.character;
    c.pos.copyFrom(s.pos);
    c.currentHeight = s.currentHeight;
    c.currentEye = s.currentEye;
    c.yaw = s.yaw;
    c.pitch = s.pitch;
    c.crouching = s.crouching || s.forcedCrouch;
    c.inAir = !s.onGround;
    c.speed = s.speed;
  }
}
