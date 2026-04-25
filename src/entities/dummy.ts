/** Stationary dummies for combat testing. They are real `Character`s that
 *  take damage and die, but they don't move or shoot. M4 (bots) replaces
 *  them with real bots. */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Character } from './character';
import type { HumanoidParts } from './humanoid';
import { createHumanoid, syncHumanoidPose, disposeHumanoid } from './humanoid';

export interface Dummy {
  character: Character;
  parts: HumanoidParts;
}

let nextId = 1;

export function createDummy(team: 'T' | 'CT', x: number, y: number, z: number, yaw: number, opts?: { armor?: number; helmet?: boolean }): Dummy {
  const id = `dummy-${nextId++}`;
  const parts = createHumanoid(team, id);
  const character: Character = {
    id,
    team,
    isLocal: false,
    pos: new Vector3(x, y, z),
    currentHeight: 1.80,
    currentEye: 1.65,
    yaw,
    pitch: 0,
    hp: 100,
    armor: opts?.armor ?? 0,
    helmet: opts?.helmet ?? false,
    hasKit: false,
    alive: true,
    inventory: null,
    speed: 0,
    inAir: false,
    crouching: false,
  };
  syncHumanoidPose(parts, x, y, z, yaw, character.currentEye, character.currentHeight);
  return { character, parts };
}

export function syncDummy(d: Dummy): void {
  const c = d.character;
  // Tip dead dummies over so the kill is visually obvious.
  if (!c.alive) {
    d.parts.root.rotation.x = -Math.PI / 2.2;
    d.parts.root.position.set(c.pos.x, c.pos.y + 0.2, c.pos.z);
    return;
  }
  syncHumanoidPose(d.parts, c.pos.x, c.pos.y, c.pos.z, c.yaw, c.currentEye, c.currentHeight);
}

export function disposeDummy(d: Dummy): void {
  disposeHumanoid(d.parts);
}
