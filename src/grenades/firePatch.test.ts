import { describe, it, expect } from 'vitest';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { FirePatchField } from './firePatch';
import type { Character } from '../entities/character';

function makeChar(id: string, x: number, z: number): Character {
  return {
    id, team: 'T', isLocal: false,
    pos: new Vector3(x, 0, z),
    currentHeight: 1.80, currentEye: 1.65,
    yaw: 0, pitch: 0,
    hp: 100, armor: 0, helmet: false, hasKit: false, alive: true,
    inventory: null,
    speed: 0, inAir: false, crouching: false,
    legDamage: 0, armDamage: 0, legDetached: false, armDetached: false,
  };
}

describe('FirePatchField', () => {
  it('damages a character standing inside the patch each tick', () => {
    const f = new FirePatchField();
    const c = makeChar('a', 0, 0);
    f.spawn(0, 0, 0, 'thrower', 0, { radius: 2, durationMs: 1000 });
    // Step at t=251 (one tick due) — should deal 10 damage (40 dps × 0.25 s).
    f.step(251, [c]);
    expect(c.hp).toBe(90);
    f.step(503, [c]);
    expect(c.hp).toBe(80);
  });

  it('does not damage a character outside the patch', () => {
    const f = new FirePatchField();
    const c = makeChar('a', 5, 0);
    f.spawn(0, 0, 0, 'thrower', 0, { radius: 2, durationMs: 1000 });
    f.step(1000, [c]);
    expect(c.hp).toBe(100);
  });

  it('expires the patch after its duration', () => {
    const f = new FirePatchField();
    f.spawn(0, 0, 0, 'thrower', 0, { radius: 2, durationMs: 500 });
    expect(f.list().length).toBe(1);
    f.step(600, []);
    expect(f.list().length).toBe(0);
  });

  it('isInside reports membership', () => {
    const f = new FirePatchField();
    f.spawn(10, 0, 10, 'thrower', 0, { radius: 1.5, durationMs: 1000 });
    expect(f.isInside(10, 10)).toBe(true);
    expect(f.isInside(11.5, 10)).toBe(true);
    expect(f.isInside(12, 10)).toBe(false);
  });
});
