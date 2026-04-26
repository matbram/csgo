import { describe, it, expect } from 'vitest';
import { SmokeField } from './smokeField';

describe('SmokeField.blockingT', () => {
  it('returns null when there are no clouds', () => {
    const f = new SmokeField();
    expect(f.blockingT(0, 1.5, 0, 1, 0, 0, 50)).toBeNull();
  });

  it('blocks a ray that passes through a thick smoke', () => {
    const f = new SmokeField();
    // 3.5m radius cloud centered at x=10. A ray along +x from origin
    // crosses 7m of smoke chord — well past the 1m block threshold.
    f.add({ x: 10, y: 1.5, z: 0, radius: 3.5, expiresMs: 99_999_999, spawnedAtMs: 0 });
    const t = f.blockingT(0, 1.5, 0, 1, 0, 0, 50);
    expect(t).not.toBeNull();
    // The block should fall inside the cloud — at least partway through
    // the entry side, not past the exit.
    expect(t!).toBeGreaterThan(6);
    expect(t!).toBeLessThan(13.5);
  });

  it('does not block a glancing ray', () => {
    const f = new SmokeField();
    // Cloud well above the ray — no chord intersection.
    f.add({ x: 10, y: 8, z: 0, radius: 1.5, expiresMs: 99_999_999, spawnedAtMs: 0 });
    expect(f.blockingT(0, 1.5, 0, 1, 0, 0, 50)).toBeNull();
  });

  it('prune drops expired clouds', () => {
    const f = new SmokeField();
    f.add({ x: 0, y: 0, z: 0, radius: 1, expiresMs: 100, spawnedAtMs: 0 });
    f.add({ x: 0, y: 0, z: 0, radius: 1, expiresMs: 1000, spawnedAtMs: 0 });
    f.prune(500);
    expect(f.list().length).toBe(1);
    expect(f.list()[0]!.expiresMs).toBe(1000);
  });

  it('combines chords from overlapping clouds', () => {
    const f = new SmokeField();
    // Two small clouds in a line — neither alone exceeds 1m chord at
    // r=0.4 (max chord 0.8m), but their combined chord does.
    f.add({ x: 5, y: 1.5, z: 0, radius: 0.4, expiresMs: 99_999_999, spawnedAtMs: 0 });
    f.add({ x: 6, y: 1.5, z: 0, radius: 0.4, expiresMs: 99_999_999, spawnedAtMs: 0 });
    const t = f.blockingT(0, 1.5, 0, 1, 0, 0, 50);
    expect(t).not.toBeNull();
  });
});
