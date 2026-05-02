/** Roster management — reset characters at round start, build team
 *  rosters at match start.
 *
 *  Each entity is a Character record. The local player's character is
 *  shared with the kinematic CharacterController. Bot/dummy characters
 *  drive a humanoid mesh through the bot's render sync.
 *
 *  At round start we:
 *    1. Reset HP=100, alive=true, helmet/armor/kit per their loadout.
 *    2. Re-position each character at a spawn point for their side.
 *    3. Reset inventory to default (knife + side pistol) plus retained
 *       gear (carry-over rule: alive players keep their gear; dead
 *       players reset to default).
 *
 *  In M4 bots reset to the default loadout each round just like the local
 *  player would on death. Carry-over for surviving bots will follow when
 *  the strategist decides between full-buy and save in M5. */

import type { Character } from '../entities/character';
import type { World, Spawn } from '../map/world';
import { defaultInventory, makeInstance, type Inventory } from '../weapons/inventory';
import type { LocalPlayer } from '../player/localPlayer';
import type { Side } from './economy';

export interface ResetOptions {
  /** Whether a dead player should keep their previous inventory. CS:GO
   *  default: dead players reset; alive players keep. We thread this
   *  decision in via the caller so it's testable. */
  keepInventory: boolean;
}

/** Reset a Character for the start of a new round. */
export function resetCharacterForRound(
  c: Character,
  side: Side,
  spawn: Spawn,
  opts: ResetOptions,
): void {
  c.team = side;
  c.pos.copyFrom(spawn.pos);
  c.yaw = spawn.yaw;
  c.pitch = 0;
  c.hp = 100;
  c.alive = true;
  c.crouching = false;
  c.inAir = false;
  c.speed = 0;
  c.flashedUntilMs = 0;
  c.leftLegDamage = 0;
  c.rightLegDamage = 0;
  c.leftArmDamage = 0;
  c.rightArmDamage = 0;
  c.leftLegDetached = false;
  c.rightLegDetached = false;
  c.leftArmDetached = false;
  c.rightArmDetached = false;
  // Currently-armor and helmet are persistent goods — they're consumed
  // by damage, so we don't reset them. New round: keep what survived.
  // If the player died, the natural CS:GO behavior is they respawn fresh
  // with no armor. Our keepInventory flag governs that here.
  if (!opts.keepInventory) {
    c.armor = 0;
    c.helmet = false;
    c.hasKit = false;
    c.inventory = defaultInventory(side);
  } else if (c.inventory) {
    // Refill ammo to full magazines, reset state machine to ready.
    refillInventory(c.inventory);
  } else {
    c.inventory = defaultInventory(side);
  }
}

function refillInventory(inv: Inventory): void {
  const refill = (i: NonNullable<Inventory['primary']>) => {
    i.ammoMag = i.def.magazine;
    i.ammoReserve = i.def.reserve;
    i.state = 'ready';
    i.stateUntilMs = 0;
    i.lastFireMs = -Infinity;
    i.sprayIndex = 0;
    i.scopeLevel = 0;
  };
  if (inv.primary) refill(inv.primary);
  if (inv.secondary) refill(inv.secondary);
  if (inv.knife) refill(inv.knife);
  if (inv.c4) refill(inv.c4);
}

/** Pick spawns for a side — one per character, cycling if needed. */
export function pickSpawns(world: World, side: Side, count: number): Spawn[] {
  const all = world.spawnsForTeam(side);
  if (all.length === 0) return [];
  const out: Spawn[] = [];
  for (let i = 0; i < count; i++) {
    out.push(all[i % all.length]!);
  }
  return out;
}

/** Reset ALL characters for the round start. Anyone in `survivors` keeps
 *  their loadout (CS:GO behaviour); everyone else respawns fresh with
 *  the default side pistol + knife.
 *
 *  Callers should snapshot `c.alive` for each character BEFORE calling
 *  `resetCharacterForRound` (which sets alive = true), then pass the
 *  survivor ids through. */
export function resetRoster(
  characters: Character[],
  localPlayer: LocalPlayer,
  world: World,
  match: { players: { get(id: string): { currentSide: Side } | undefined } },
  survivors: ReadonlySet<string>,
): void {
  const tList: Character[] = [];
  const ctList: Character[] = [];
  for (const c of characters) {
    const slot = match.players.get(c.id);
    if (!slot) continue;
    c.team = slot.currentSide;
    if (slot.currentSide === 'T') tList.push(c);
    else ctList.push(c);
  }
  const tSpawns = pickSpawns(world, 'T', tList.length);
  const ctSpawns = pickSpawns(world, 'CT', ctList.length);

  for (let i = 0; i < tList.length; i++) {
    const c = tList[i]!;
    const spawn = tSpawns[i] ?? tSpawns[0]!;
    resetCharacterForRound(c, 'T', spawn, { keepInventory: survivors.has(c.id) });
  }
  for (let i = 0; i < ctList.length; i++) {
    const c = ctList[i]!;
    const spawn = ctSpawns[i] ?? ctSpawns[0]!;
    resetCharacterForRound(c, 'CT', spawn, { keepInventory: survivors.has(c.id) });
  }

  // Sync the local controller to the new spawn position/yaw. Always
  // operate on the local player's *own* character + controller, even
  // when they're currently possessing a teammate bot — the next round
  // restores them to their own body and the bot resets via its own
  // path (snapBotToCharacterPose).
  if (localPlayer.ownCharacter.alive) {
    const s = localPlayer.ownController.state;
    s.pos.copyFrom(localPlayer.ownCharacter.pos);
    s.yaw = localPlayer.ownCharacter.yaw;
    s.pitch = 0;
    s.vel.set(0, 0, 0);
    localPlayer.ownController.snapToGround();
  }
}

/** Give exactly one alive T the C4. */
export function assignBomb(characters: Character[], carrierId: string | null): void {
  for (const c of characters) {
    if (!c.inventory) continue;
    if (c.id === carrierId) {
      c.inventory.c4 = makeInstance('c4');
    } else {
      c.inventory.c4 = undefined;
    }
  }
}
