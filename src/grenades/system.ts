/** Grenade system — owns the pool of in-flight grenades, their physics
 *  step, and the per-kind detonation handlers. Side effects (smoke
 *  cloud spawn, fire patch spawn, damage application, flash blindness)
 *  flow into the SmokeField, FirePatchField, and Character records.
 *  Visuals subscribe to the grenade events emitted along the way.
 *
 *  Physics is hand-rolled — a sphere with gravity that bounces off the
 *  axis-aligned-after-yaw OBBs that make up the world. That's enough
 *  for Dust 2's blockout level; if we add complex non-AABB geometry
 *  later (slanted ramps where grenades roll oddly) we'd swap in Havok. */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Character } from '../entities/character';
import { hitboxPose } from '../entities/character';
import type { World } from '../map/world';
import type { WorldQuery } from '../player/physics';
import { events } from '../engine/events';
import { SmokeField } from './smokeField';
import { FirePatchField } from './firePatch';

export type GrenadeKind = 'he' | 'flashbang' | 'smoke' | 'molotov' | 'decoy';

interface KindParams {
  fuseMs: number;
  /** Detonate on FIRST surface contact instead of after fuse. Used for
   *  molotov. */
  detonateOnImpact?: boolean;
  /** Bounce restitution (0 = stop, 1 = perfect bounce). */
  restitution: number;
  /** Linear ground friction applied per second of contact. Stops the
   *  grenade rolling forever. */
  friction: number;
  /** Visual / collision sphere radius. */
  radius: number;
  /** Detonation parameters — read by the per-kind handlers below. */
  damageRadiusM?: number;
  damageMaxHp?: number;
  flashRadiusM?: number;
  flashMaxMs?: number;
  smokeRadiusM?: number;
  smokeDurationMs?: number;
  fireRadiusM?: number;
  fireDurationMs?: number;
}

const PARAMS: Record<GrenadeKind, KindParams> = {
  he: {
    fuseMs: 1500, detonateOnImpact: true, restitution: 0.45, friction: 1.0, radius: 0.08,
    damageRadiusM: 8.0, damageMaxHp: 98,
  },
  flashbang: {
    fuseMs: 1500, detonateOnImpact: true, restitution: 0.50, friction: 1.0, radius: 0.07,
    flashRadiusM: 14.0, flashMaxMs: 3000,
  },
  smoke: {
    fuseMs: 1500, detonateOnImpact: true, restitution: 0.30, friction: 2.0, radius: 0.09,
    smokeRadiusM: 3.5, smokeDurationMs: 18_000,
  },
  molotov: {
    fuseMs: 700, detonateOnImpact: true, restitution: 0.10, friction: 4.0, radius: 0.08,
    fireRadiusM: 2.4, fireDurationMs: 7000,
  },
  // Decoys bounce, settle, and "fire" intermittently for several
  // seconds. We model the lifetime as a long fuse and emit fake
  // gunshot events from the system while the decoy is alive — the
  // detonation itself is silent (no real damage).
  decoy: {
    fuseMs: 6000, restitution: 0.30, friction: 2.5, radius: 0.07,
  },
};

const GRAVITY = 9.81;
/** Above-zero speed at which we consider the grenade "at rest" — fuse
 *  keeps ticking, but we don't bother with sub-millimeter physics. */
const REST_SPEED_SQ = 0.05 * 0.05;

export interface ThrowOptions {
  ox: number; oy: number; oz: number;
  /** Throw direction (typically camera forward). */
  fwdX: number; fwdY: number; fwdZ: number;
  /** Throw type: full press (LMB) vs underhand (RMB). */
  power: 'full' | 'underhand';
}

const FULL_THROW_SPEED = 22;
const UNDERHAND_SPEED = 11;

interface GrenadeEntity {
  id: number;
  kind: GrenadeKind;
  throwerId: string;
  active: boolean;
  pos: Vector3;
  vel: Vector3;
  detonateAtMs: number;
  spawnedAtMs: number;
  /** Last surface collision normal (so the molotov spawns its fire
   *  patch on the ground rather than mid-air). */
  lastNormalY: number;
  /** Decoy: sim ms of the next fake-shot emission. */
  nextDecoyShotMs: number;
}

export class GrenadeSystem {
  readonly smoke = new SmokeField();
  readonly fire = new FirePatchField();
  private readonly grenades: GrenadeEntity[] = [];
  private nextId = 1;

  constructor(
    private readonly world: World,
    private readonly query: WorldQuery,
    private readonly characters: () => ReadonlyArray<Character>,
  ) {}

  /** Reset all in-flight effects. Called at round start so old smokes
   *  don't bleed into the new round. */
  reset(): void {
    this.grenades.length = 0;
    this.smoke.clear();
    this.fire.clear();
  }

  /** Throw a grenade. Returns the spawned entity id (mainly for tests). */
  throw_(kind: GrenadeKind, throwerId: string, opts: ThrowOptions, nowMs: number): number {
    const p = PARAMS[kind];
    const speed = opts.power === 'underhand' ? UNDERHAND_SPEED : FULL_THROW_SPEED;
    const grenade: GrenadeEntity = {
      id: this.nextId++,
      kind,
      throwerId,
      active: true,
      pos: new Vector3(opts.ox, opts.oy, opts.oz),
      vel: new Vector3(opts.fwdX * speed, opts.fwdY * speed + 1.5, opts.fwdZ * speed),
      detonateAtMs: nowMs + p.fuseMs,
      spawnedAtMs: nowMs,
      lastNormalY: 0,
      // Decoys start firing 0.5 s after they land. Other kinds ignore this.
      nextDecoyShotMs: nowMs + 700,
    };
    this.grenades.push(grenade);
    events.emit('grenade:thrown', {
      grenadeId: grenade.id,
      kind,
      throwerId,
      ox: opts.ox, oy: opts.oy, oz: opts.oz,
      vx: grenade.vel.x, vy: grenade.vel.y, vz: grenade.vel.z,
      tMs: nowMs,
    });
    return grenade.id;
  }

  list(): ReadonlyArray<GrenadeEntity> {
    return this.grenades;
  }

  step(dtMs: number, nowMs: number): void {
    const dt = dtMs / 1000;
    for (const g of this.grenades) {
      if (!g.active) continue;
      this.stepGrenade(g, dt, nowMs);
    }
    // Compact dead entries.
    let w = 0;
    for (let r = 0; r < this.grenades.length; r++) {
      const g = this.grenades[r]!;
      if (g.active) {
        if (w !== r) this.grenades[w] = g;
        w++;
      }
    }
    this.grenades.length = w;
    this.smoke.prune(nowMs);
    this.fire.step(nowMs, this.characters());
  }

  // ---- Internal -----------------------------------------------------

  private stepGrenade(g: GrenadeEntity, dt: number, nowMs: number): void {
    const p = PARAMS[g.kind];

    // Gravity.
    g.vel.y -= GRAVITY * dt;

    // Predict next position.
    const nx = g.pos.x + g.vel.x * dt;
    const ny = g.pos.y + g.vel.y * dt;
    const nz = g.pos.z + g.vel.z * dt;

    // Cheap sphere-vs-OBB resolution: probe the new position against
    // every OBB and reflect off the deepest penetration. We only iterate
    // boxes; ramps are walkable surfaces, and the grenade's gravity-
    // dominated arc handles them adequately when `lastNormalY > 0.6`.
    const hit = this.resolveSphereAgainstBoxes(nx, ny, nz, p.radius);
    if (hit) {
      // Move the sphere out of penetration, then reflect velocity.
      g.pos.set(hit.x, hit.y, hit.z);
      const vn = g.vel.x * hit.nx + g.vel.y * hit.ny + g.vel.z * hit.nz;
      if (vn < 0) {
        g.vel.x -= (1 + p.restitution) * vn * hit.nx;
        g.vel.y -= (1 + p.restitution) * vn * hit.ny;
        g.vel.z -= (1 + p.restitution) * vn * hit.nz;
        // Tangential friction — prevents the grenade rolling forever.
        const fric = p.friction * dt;
        g.vel.x *= Math.max(0, 1 - fric);
        g.vel.z *= Math.max(0, 1 - fric);
      }
      g.lastNormalY = hit.ny;
      events.emit('grenade:bounce', { grenadeId: g.id, x: g.pos.x, y: g.pos.y, z: g.pos.z, tMs: nowMs });
      // Molotov needs a floor-facing surface so its fire patch sits on
      // the ground; HE / flash / smoke detonate on any solid contact.
      if (p.detonateOnImpact && (g.kind !== 'molotov' || hit.ny > 0.6)) {
        this.detonate(g, nowMs);
        return;
      }
    } else {
      g.pos.set(nx, ny, nz);
    }

    // Ground check via the world query — handles ramps + the global
    // floor without needing every floor patch in the OBB sweep.
    const ground = this.query.groundProbe(g.pos.x, g.pos.z, g.pos.y + 0.5, 5.0);
    if (ground && g.pos.y - p.radius <= ground.y + 0.001) {
      g.pos.y = ground.y + p.radius;
      if (g.vel.y < 0) {
        g.vel.y = -g.vel.y * p.restitution;
        const fric = p.friction * dt;
        g.vel.x *= Math.max(0, 1 - fric);
        g.vel.z *= Math.max(0, 1 - fric);
      }
      g.lastNormalY = 1;
      // Ground touch counts as impact for HE / flash / smoke. Molotov
      // is allowed to skip-roll briefly so it lands flat — it detonates
      // once it's slowed enough that the fire patch won't slide.
      if (p.detonateOnImpact && (g.kind !== 'molotov' || Math.abs(g.vel.x) + Math.abs(g.vel.z) < 1.5)) {
        this.detonate(g, nowMs);
        return;
      }
    }

    // Decoy: while alive, intermittently emit a fake gunshot so bots
    // hear something to investigate. We piggy-back on the existing
    // 'combat:fire' channel — bot perception treats the resulting
    // sound report as low-confidence intel, identical to a real shot.
    if (g.kind === 'decoy' && nowMs >= g.nextDecoyShotMs) {
      events.emit('combat:fire', {
        shooterId: `decoy:${g.id}`,
        weapon: 'ak47',  // arbitrary — pick a gun whose synth buffer exists
        ox: g.pos.x, oy: g.pos.y, oz: g.pos.z,
        dx: 0, dy: 1, dz: 0,
        sprayIndex: 0,
        tMs: nowMs,
      });
      // ~0.4..0.9 s between fake shots.
      g.nextDecoyShotMs = nowMs + 400 + Math.random() * 500;
    }

    // Fuse expiry.
    if (nowMs >= g.detonateAtMs) {
      this.detonate(g, nowMs);
      return;
    }
    // Fully at-rest grenades still wait for the fuse but don't waste
    // physics on sub-millimeter movement.
    if (g.vel.lengthSquared() < REST_SPEED_SQ) {
      g.vel.set(0, 0, 0);
    }
  }

  private detonate(g: GrenadeEntity, nowMs: number): void {
    g.active = false;
    events.emit('grenade:detonated', {
      grenadeId: g.id,
      kind: g.kind,
      throwerId: g.throwerId,
      x: g.pos.x, y: g.pos.y, z: g.pos.z,
      tMs: nowMs,
    });
    switch (g.kind) {
      case 'he':        this.detonateHe(g, nowMs); break;
      case 'flashbang': this.detonateFlash(g, nowMs); break;
      case 'smoke':     this.detonateSmoke(g, nowMs); break;
      case 'molotov':   this.detonateMolotov(g, nowMs); break;
      case 'decoy':     /* silent — fake-fire ticks did the work */ break;
    }
  }

  // ---- Per-kind detonation -----------------------------------------

  private detonateHe(g: GrenadeEntity, nowMs: number): void {
    const p = PARAMS.he;
    const radius = p.damageRadiusM!;
    const maxHp = p.damageMaxHp!;
    for (const c of this.characters()) {
      if (!c.alive) continue;
      const pose = hitboxPose(c);
      const tx = pose.baseX;
      const ty = pose.baseY + pose.eye * 0.55;
      const tz = pose.baseZ;
      const dx = tx - g.pos.x;
      const dy = ty - g.pos.y;
      const dz = tz - g.pos.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius) continue;
      // LoS-checked: scale by penetration if a wall blocks.
      const dirLen = dist || 1;
      const ndx = dx / dirLen, ndy = dy / dirLen, ndz = dz / dirLen;
      const wall = this.query.rayWorld(g.pos.x, g.pos.y, g.pos.z, ndx, ndy, ndz, dist - 0.05);
      const losFactor = wall ? 0.25 : 1.0;
      // Inverse-square-ish falloff clamped at the radius.
      const t = dist / radius;
      const damage = Math.floor(maxHp * (1 - t * t) * losFactor);
      if (damage <= 0) continue;
      const armorTake = Math.min(c.armor, Math.floor(damage * 0.5));
      const hpDelta = c.armor > 0 ? Math.max(0, damage - armorTake) : damage;
      c.armor = Math.max(0, c.armor - armorTake);
      c.hp = Math.max(0, c.hp - hpDelta);
      if (c.hp <= 0) {
        c.alive = false;
        events.emit('combat:kill', {
          attackerId: g.throwerId, victimId: c.id, weapon: 'he',
          headshot: false, tMs: nowMs,
        });
      } else {
        // Grenade damage has no aimed direction — pick a synthetic one
        // pointing radially outward from the explosion so the blood
        // visual sprays away from the blast.
        const inv = dist > 1e-3 ? 1 / dist : 0;
        events.emit('combat:hit', {
          attackerId: g.throwerId, victimId: c.id, weapon: 'he',
          hitbox: 'chest', segment: 'chest', side: null,
          damage: hpDelta, headshot: false, killing: false,
          corpseHit: false,
          limbDetached: null,
          hitX: tx, hitY: ty, hitZ: tz,
          victimFootY: c.pos.y,
          dirX: (tx - g.pos.x) * inv,
          dirY: (ty - g.pos.y) * inv,
          dirZ: (tz - g.pos.z) * inv,
          distance: dist, tMs: nowMs,
        });
      }
    }
  }

  private detonateFlash(g: GrenadeEntity, nowMs: number): void {
    const p = PARAMS.flashbang;
    const radius = p.flashRadiusM!;
    const maxMs = p.flashMaxMs!;
    for (const c of this.characters()) {
      if (!c.alive) continue;
      const pose = hitboxPose(c);
      const ex = pose.baseX;
      const ey = pose.baseY + pose.eye;
      const ez = pose.baseZ;
      const dx = g.pos.x - ex;
      const dy = g.pos.y - ey;
      const dz = g.pos.z - ez;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radius) continue;
      // LoS — walls block the flash entirely.
      const dirLen = dist || 1;
      const wall = this.query.rayWorld(ex, ey, ez, dx / dirLen, dy / dirLen, dz / dirLen, dist - 0.05);
      if (wall) continue;
      // Alignment with character's forward — full duration when staring
      // at the flash, near-zero when facing away.
      const yaw = c.yaw;
      const cosP = Math.cos(c.pitch);
      const fX = Math.sin(yaw) * cosP;
      const fY = Math.sin(c.pitch);
      const fZ = Math.cos(yaw) * cosP;
      const align = Math.max(0, (dx * fX + dy * fY + dz * fZ) / dirLen);
      const distFactor = 1 - dist / radius;
      const blindMs = Math.floor(maxMs * align * distFactor);
      if (blindMs <= 0) continue;
      const cur = c.flashedUntilMs ?? 0;
      c.flashedUntilMs = Math.max(cur, nowMs + blindMs);
    }
  }

  private detonateSmoke(g: GrenadeEntity, nowMs: number): void {
    const p = PARAMS.smoke;
    this.smoke.add({
      x: g.pos.x, y: g.pos.y, z: g.pos.z,
      radius: p.smokeRadiusM!,
      expiresMs: nowMs + p.smokeDurationMs!,
      spawnedAtMs: nowMs,
    });
  }

  private detonateMolotov(g: GrenadeEntity, nowMs: number): void {
    const p = PARAMS.molotov;
    // Snap the patch to the floor — molotov detonates on contact, but
    // if it detonated mid-air for any reason we still want a sane patch
    // anchored on a real surface.
    const ground = this.query.groundProbe(g.pos.x, g.pos.z, g.pos.y + 0.3, 4) ?? { y: g.pos.y };
    this.fire.spawn(g.pos.x, ground.y, g.pos.z, g.throwerId, nowMs, {
      radius: p.fireRadiusM, durationMs: p.fireDurationMs,
    });
  }

  // ---- Sphere vs world ---------------------------------------------

  private resolveSphereAgainstBoxes(
    px: number, py: number, pz: number, radius: number,
  ): { x: number; y: number; z: number; nx: number; ny: number; nz: number } | null {
    let bestDepth = 0;
    let bestNx = 0, bestNy = 0, bestNz = 0;
    let bestX = px, bestY = py, bestZ = pz;
    for (const b of this.world.boxes) {
      // Broad-phase AABB.
      if (px + radius < b.aabbMinX || px - radius > b.aabbMaxX) continue;
      if (py + radius < b.aabbMinY || py - radius > b.aabbMaxY) continue;
      if (pz + radius < b.aabbMinZ || pz - radius > b.aabbMaxZ) continue;
      // Transform into local frame.
      const wx = px - b.centerX, wy = py - b.centerY, wz = pz - b.centerZ;
      const lx = wx * b.cosYaw - wz * b.sinYaw;
      const ly = wy;
      const lz = wx * b.sinYaw + wz * b.cosYaw;
      const cx = clamp(lx, -b.halfX, b.halfX);
      const cy = clamp(ly, -b.halfY, b.halfY);
      const cz = clamp(lz, -b.halfZ, b.halfZ);
      const dx = lx - cx, dy = ly - cy, dz = lz - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= radius * radius) continue;
      const dist = Math.sqrt(Math.max(d2, 1e-10));
      const depth = radius - dist;
      if (depth <= bestDepth) continue;
      // Normal in local space. If center is inside, push along the
      // shallowest axis.
      let nlx: number, nly: number, nlz: number;
      if (d2 > 1e-8) {
        nlx = dx / dist;
        nly = dy / dist;
        nlz = dz / dist;
      } else {
        const xOut = b.halfX - Math.abs(lx);
        const yOut = b.halfY - Math.abs(ly);
        const zOut = b.halfZ - Math.abs(lz);
        if (xOut < yOut && xOut < zOut) {
          nlx = lx >= 0 ? 1 : -1; nly = 0; nlz = 0;
        } else if (yOut < zOut) {
          nlx = 0; nly = ly >= 0 ? 1 : -1; nlz = 0;
        } else {
          nlx = 0; nly = 0; nlz = lz >= 0 ? 1 : -1;
        }
      }
      // Local normal -> world normal (yaw rotation R).
      const nwx = nlx * b.cosYaw + nlz * b.sinYaw;
      const nwy = nly;
      const nwz = -nlx * b.sinYaw + nlz * b.cosYaw;
      bestDepth = depth;
      bestNx = nwx; bestNy = nwy; bestNz = nwz;
      bestX = px + nwx * depth;
      bestY = py + nwy * depth;
      bestZ = pz + nwz * depth;
    }
    if (bestDepth <= 0) return null;
    return { x: bestX, y: bestY, z: bestZ, nx: bestNx, ny: bestNy, nz: bestNz };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
