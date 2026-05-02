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
 *
 *  The active `character` and `controller` references are mutable: when
 *  the player dies and takes over a teammate bot, both flip to the bot's
 *  records so input/movement/combat keep working without code that walks
 *  these fields needing to know who's behind the wheel. The originals are
 *  preserved on `ownCharacter` / `ownController` so we can restore them
 *  when the round resets.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { CharacterController } from './controller';
import type { Character } from '../entities/character';
import { defaultInventory } from '../weapons/inventory';

export class LocalPlayer {
  /** Currently-active character. Defaults to the player's own; flips to
   *  a bot's character record while possessing it. */
  character: Character;
  /** Currently-active kinematic controller. Same swap rule as above. */
  controller: CharacterController;
  /** The player's own character (id='local'). Stable across possessions. */
  readonly ownCharacter: Character;
  /** The player's own controller. Stable across possessions. */
  readonly ownController: CharacterController;
  /** Id of the bot we're currently possessing, or null when driving our
   *  own body. The main loop reads this to skip the possessed bot's AI
   *  tick (otherwise the brain would fight the player's input). */
  possessedBotId: string | null = null;

  constructor(controller: CharacterController, team: 'T' | 'CT') {
    this.controller = controller;
    this.ownController = controller;
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
      hasKit: false,
      alive: true,
      inventory: inv,
      speed: 0,
      inAir: false,
      crouching: false,
      legDamage: 0,
      armDamage: 0,
      legDetached: false,
      armDetached: false,
    };
    this.ownCharacter = this.character;
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

  /** Take over a teammate bot. The bot's character + controller become
   *  the active pair, so combat / camera / view-model code that reads
   *  `localPlayer.character` and `localPlayer.controller` automatically
   *  follows the new body. Caller is responsible for disabling the bot's
   *  AI tick (otherwise the brain will overwrite yaw/pitch each frame). */
  possess(bot: { id: string; character: Character; controller: CharacterController }): void {
    this.character = bot.character;
    this.controller = bot.controller;
    this.possessedBotId = bot.id;
  }

  /** Release any active possession and restore our own character +
   *  controller. Call on round reset / respawn. */
  releasePossession(): void {
    this.character = this.ownCharacter;
    this.controller = this.ownController;
    this.possessedBotId = null;
  }
}
