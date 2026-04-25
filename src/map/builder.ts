/** Walks the authoring tree and produces:
 *  - Babylon visual meshes (merged per material for low draw calls).
 *  - `World` collision data (boxes + ramps as OBBs).
 *  - Callouts, spawns, bomb sites, buy zones.
 *
 *  Group transforms compose multiplicatively (a group inside a group sees
 *  parent's origin and yaw applied to its own).
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { Quaternion } from '@babylonjs/core/Maths/math.vector';
import { addShadowCaster } from '../engine/lighting';
import { getScene } from '../engine/scene';
import { getMaterial, type MaterialName } from '../materials/library';
import {
  type Block,
  type GroupBlock,
  type BoxBlock,
  type RampBlock,
  type ZoneBlock,
  type SpawnBlock,
  type BombSiteBlock,
  type BuyZoneBlock,
  type Vec2,
  type Vec3,
} from './types';
import {
  type BoxCollider,
  type RampCollider,
  World,
  polygonCentroid,
} from './world';

const DEG = Math.PI / 180;

interface Transform {
  ox: number; oy: number; oz: number;
  yaw: number; // radians
}

interface MaterialBatch {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  vertexCount: number;
}

class Builder {
  readonly world = new World();
  private readonly batches = new Map<MaterialName, MaterialBatch>();

  build(root: Block): { world: World; meshes: Mesh[] } {
    this.traverse(root, { ox: 0, oy: 0, oz: 0, yaw: 0 });
    const meshes = this.flush();
    return { world: this.world, meshes };
  }

  private traverse(b: Block, t: Transform): void {
    switch (b.kind) {
      case 'group': return this.traverseGroup(b, t);
      case 'box':   return this.emitBox(b, t);
      case 'ramp':  return this.emitRamp(b, t);
      case 'zone':  return this.emitZone(b, t);
      case 'spawn': return this.emitSpawn(b, t);
      case 'bombsite': return this.emitBombSite(b, t);
      case 'buyzone':  return this.emitBuyZone(b, t);
    }
  }

  private traverseGroup(g: GroupBlock, parent: Transform): void {
    const yawAdd = (g.yawDeg ?? 0) * DEG;
    const local = g.origin ?? [0, 0, 0];
    // Transform local origin by parent yaw, then translate.
    const cy = Math.cos(parent.yaw), sy = Math.sin(parent.yaw);
    const wx = parent.ox + local[0] * cy + local[2] * sy;
    const wz = parent.oz + (-local[0] * sy + local[2] * cy);
    const wy = parent.oy + local[1];
    const child: Transform = { ox: wx, oy: wy, oz: wz, yaw: parent.yaw + yawAdd };
    for (const c of g.children) this.traverse(c, child);
  }

  private emitBox(b: BoxBlock, t: Transform): void {
    const at = b.at ?? [0, 0, 0];
    const cy = Math.cos(t.yaw), sy = Math.sin(t.yaw);
    // Bottom-center of the box in world space:
    const baseX = t.ox + at[0] * cy + at[2] * sy;
    const baseZ = t.oz + (-at[0] * sy + at[2] * cy);
    const baseY = t.oy + at[1];
    const yaw = t.yaw + (b.yawDeg ?? 0) * DEG;

    const sx = b.size[0], syHeight = b.size[1], sz = b.size[2];
    // Center of the box:
    const cx2 = baseX, cz2 = baseZ, cy2 = baseY + syHeight / 2;

    if (!(b.invisible)) {
      this.appendBoxGeometry(b.material, cx2, cy2, cz2, sx, syHeight, sz, yaw, b.uvScale);
    }

    if (b.solid !== false) {
      const collider = makeBoxCollider(cx2, cy2, cz2, sx, syHeight, sz, yaw, b.walkable !== false, b.surface ?? 'sand');
      this.world.boxes.push(collider);
      this.world.expandBounds(
        collider.aabbMinX, collider.aabbMinY, collider.aabbMinZ,
        collider.aabbMaxX, collider.aabbMaxY, collider.aabbMaxZ,
      );
    } else if (!b.invisible) {
      // Even non-solid visible blocks contribute to bounds.
      this.world.expandBounds(
        cx2 - sx, cy2 - syHeight / 2, cz2 - sz,
        cx2 + sx, cy2 + syHeight / 2, cz2 + sz,
      );
    }
  }

  private emitRamp(b: RampBlock, t: Transform): void {
    const at = b.at ?? [0, 0, 0];
    const cy = Math.cos(t.yaw), sy = Math.sin(t.yaw);
    const baseX = t.ox + at[0] * cy + at[2] * sy;
    const baseZ = t.oz + (-at[0] * sy + at[2] * cy);
    const baseY = t.oy + at[1];
    const yaw = t.yaw + (b.yawDeg ?? 0) * DEG;
    const length = b.size[0], height = b.size[1], width = b.size[2];

    this.appendRampGeometry(b.material, baseX, baseY, baseZ, length, height, width, yaw, b.uvScale);

    const collider = makeRampCollider(baseX, baseY, baseZ, length, height, width, yaw, b.surface ?? 'sand');
    this.world.ramps.push(collider);
    this.world.expandBounds(
      collider.aabbMinX, collider.aabbMinY, collider.aabbMinZ,
      collider.aabbMaxX, collider.aabbMaxY, collider.aabbMaxZ,
    );
  }

  private emitZone(b: ZoneBlock, t: Transform): void {
    const transformed = b.polygon.map((p) => transformXZ(p, t));
    const yMin = b.yRange?.[0] ?? -1;
    const yMax = b.yRange?.[1] ?? 8;
    this.world.callouts.set(b.callout, {
      id: b.callout,
      polygon: transformed,
      yMin: yMin + t.oy,
      yMax: yMax + t.oy,
      centroid: polygonCentroid(transformed),
      adjacent: b.adjacent ?? [],
      ...(b.facing !== undefined ? { facing: b.facing } : {}),
    });
  }

  private emitSpawn(b: SpawnBlock, t: Transform): void {
    const cy = Math.cos(t.yaw), sy = Math.sin(t.yaw);
    const wx = t.ox + b.at[0] * cy + b.at[2] * sy;
    const wz = t.oz + (-b.at[0] * sy + b.at[2] * cy);
    const wy = t.oy + b.at[1];
    this.world.spawns.push({
      team: b.team,
      pos: new Vector3(wx, wy, wz),
      yaw: t.yaw + (b.yawDeg ?? 0) * DEG,
    });
  }

  private emitBombSite(b: BombSiteBlock, t: Transform): void {
    const transformed = b.polygon.map((p) => transformXZ(p, t));
    this.world.bombSites.push({
      site: b.site,
      polygon: transformed,
      yMin: (b.yRange?.[0] ?? -1) + t.oy,
      yMax: (b.yRange?.[1] ?? 8) + t.oy,
    });
  }

  private emitBuyZone(b: BuyZoneBlock, t: Transform): void {
    const transformed = b.polygon.map((p) => transformXZ(p, t));
    this.world.buyZones.push({
      team: b.team,
      polygon: transformed,
      yMin: (b.yRange?.[0] ?? -1) + t.oy,
      yMax: (b.yRange?.[1] ?? 8) + t.oy,
    });
  }

  // Geometry batching ------------------------------------------------------

  private getBatch(name: MaterialName): MaterialBatch {
    let batch = this.batches.get(name);
    if (!batch) {
      batch = { positions: [], normals: [], uvs: [], indices: [], vertexCount: 0 };
      this.batches.set(name, batch);
    }
    return batch;
  }

  private appendBoxGeometry(
    name: MaterialName,
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    yaw: number,
    uvScale: Vec2 | undefined,
  ): void {
    const b = this.getBatch(name);
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;

    // 8 corners (local), then transform.
    const corners: Vec3[] = [
      [-hx, -hy, -hz], [ hx, -hy, -hz], [ hx, -hy,  hz], [-hx, -hy,  hz],
      [-hx,  hy, -hz], [ hx,  hy, -hz], [ hx,  hy,  hz], [-hx,  hy,  hz],
    ];
    const wc = corners.map(([x, y, z]) => [
      cx + x * cosY + z * sinY,
      cy + y,
      cz + (-x * sinY + z * cosY),
    ] as Vec3);

    // 6 faces: bottom, top, +x, -x, +z, -z (post-rotation).
    // We compute world-space normals via face indices using cross product.
    type Face = { v: number[]; uvAxes: 'xz' | 'yz' | 'xy' };
    const faces: Face[] = [
      { v: [0, 1, 2, 3], uvAxes: 'xz' }, // bottom
      { v: [4, 7, 6, 5], uvAxes: 'xz' }, // top
      { v: [1, 5, 6, 2], uvAxes: 'yz' }, // +x face
      { v: [0, 3, 7, 4], uvAxes: 'yz' }, // -x face
      { v: [3, 2, 6, 7], uvAxes: 'xy' }, // +z face
      { v: [0, 4, 5, 1], uvAxes: 'xy' }, // -z face
    ];

    const usx = uvScale?.[0] ?? Math.max(1, sx / 2);
    const usz = uvScale?.[1] ?? Math.max(1, sz / 2);
    const usy = Math.max(1, sy / 2);

    for (const f of faces) {
      const a = wc[f.v[0]!]!, b1 = wc[f.v[1]!]!, c = wc[f.v[2]!]!, d = wc[f.v[3]!]!;
      const ex = b1[0] - a[0], ey = b1[1] - a[1], ez = b1[2] - a[2];
      const fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
      let nx = ey * fz - ez * fy;
      let ny = ez * fx - ex * fz;
      let nz = ex * fy - ey * fx;
      const ln = Math.hypot(nx, ny, nz) || 1;
      nx /= ln; ny /= ln; nz /= ln;

      const start = b.vertexCount;
      const verts = [a, b1, c, d];
      const uvs: Vec2[] = verts.map((v) => {
        switch (f.uvAxes) {
          case 'xz': return [v[0] / usx, v[2] / usz];
          case 'yz': return [v[2] / usz, v[1] / usy];
          case 'xy': return [v[0] / usx, v[1] / usy];
        }
      });

      for (let i = 0; i < 4; i++) {
        const p = verts[i]!;
        b.positions.push(p[0], p[1], p[2]);
        b.normals.push(nx, ny, nz);
        b.uvs.push(uvs[i]![0], uvs[i]![1]);
      }
      b.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      b.vertexCount += 4;
    }
  }

  private appendRampGeometry(
    name: MaterialName,
    bx: number, by: number, bz: number,
    length: number, height: number, width: number,
    yaw: number,
    uvScale: Vec2 | undefined,
  ): void {
    const b = this.getBatch(name);
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    // 6 vertices forming a triangular prism. Local axes:
    //  +x along length (lower edge at x=0, upper edge at x=length)
    //  +y up (height at upper edge only)
    //  +z width (split half each way)
    const hw = width / 2;
    const local: Vec3[] = [
      [0, 0, -hw],         // 0: bottom near
      [length, 0, -hw],    // 1: bottom far
      [length, height, -hw], // 2: top far near-side
      [0, 0, hw],          // 3: bottom near +z
      [length, 0, hw],     // 4: bottom far +z
      [length, height, hw],  // 5: top far +z
    ];
    const wc = local.map(([x, y, z]) => [
      bx + x * cosY + z * sinY,
      by + y,
      bz + (-x * sinY + z * cosY),
    ] as Vec3);

    const usx = uvScale?.[0] ?? Math.max(1, length / 2);
    const usz = uvScale?.[1] ?? Math.max(1, width / 2);

    type Face = { v: number[]; uv: Vec2[] };
    const faces: Face[] = [
      // Slanted top (the walkable surface)
      { v: [0, 1, 5, 3], uv: [[0, 0], [length / usx, 0], [length / usx, width / usz], [0, width / usz]] },
      // Bottom flat (under the ramp)
      { v: [3, 4, 1, 0], uv: [[0, 0], [length / usx, 0], [length / usx, width / usz], [0, width / usz]] },
      // Triangular sides
      { v: [0, 1, 2], uv: [[0, 0], [length / usx, 0], [length / usx, height / usz]] },
      { v: [3, 5, 4], uv: [[0, 0], [length / usx, height / usz], [length / usx, 0]] },
      // Vertical back face (at the high end)
      { v: [1, 4, 5, 2], uv: [[0, 0], [width / usx, 0], [width / usx, height / usz], [0, height / usz]] },
    ];

    for (const f of faces) {
      const a = wc[f.v[0]!]!, b1 = wc[f.v[1]!]!, c = wc[f.v[2]!]!;
      const ex = b1[0] - a[0], ey = b1[1] - a[1], ez = b1[2] - a[2];
      const fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
      let nx = ey * fz - ez * fy;
      let ny = ez * fx - ex * fz;
      let nz = ex * fy - ey * fx;
      const ln = Math.hypot(nx, ny, nz) || 1;
      nx /= ln; ny /= ln; nz /= ln;

      const start = b.vertexCount;
      for (let i = 0; i < f.v.length; i++) {
        const p = wc[f.v[i]!]!;
        const uv = f.uv[i]!;
        b.positions.push(p[0], p[1], p[2]);
        b.normals.push(nx, ny, nz);
        b.uvs.push(uv[0], uv[1]);
      }
      if (f.v.length === 4) {
        b.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
        b.vertexCount += 4;
      } else {
        b.indices.push(start, start + 1, start + 2);
        b.vertexCount += 3;
      }
    }
  }

  private flush(): Mesh[] {
    const scene = getScene();
    const meshes: Mesh[] = [];
    for (const [name, batch] of this.batches) {
      if (batch.vertexCount === 0) continue;
      const mesh = new Mesh(`world-${name}`, scene);
      const data = new VertexData();
      data.positions = batch.positions;
      data.normals = batch.normals;
      data.uvs = batch.uvs;
      data.indices = batch.indices;
      data.applyToMesh(mesh, false);
      mesh.material = getMaterial(name);
      mesh.receiveShadows = true;
      mesh.checkCollisions = false;
      mesh.isPickable = true;
      mesh.freezeWorldMatrix();
      mesh.alwaysSelectAsActiveMesh = false;
      addShadowCaster(mesh);
      meshes.push(mesh);
    }
    // Defensive: prevent unused import lint by wiring up VertexBuffer / Quaternion / MeshBuilder
    // (we may use them later, but they're harmless to import here).
    void VertexBuffer; void MeshBuilder; void Quaternion;
    return meshes;
  }
}

function transformXZ(p: Vec2, t: Transform): Vec2 {
  const cy = Math.cos(t.yaw), sy = Math.sin(t.yaw);
  return [
    t.ox + p[0] * cy + p[1] * sy,
    t.oz + (-p[0] * sy + p[1] * cy),
  ];
}

function makeBoxCollider(
  cx: number, cy: number, cz: number,
  sx: number, sy: number, sz: number,
  yaw: number,
  walkable: boolean,
  surface: BoxCollider['surface'],
): BoxCollider {
  const cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw);
  // Compute AABB after rotation.
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const ax = Math.abs(cosYaw) * hx + Math.abs(sinYaw) * hz;
  const az = Math.abs(sinYaw) * hx + Math.abs(cosYaw) * hz;
  return {
    centerX: cx, centerY: cy, centerZ: cz,
    halfX: hx, halfY: hy, halfZ: hz,
    yaw, cosYaw, sinYaw,
    walkable, surface,
    aabbMinX: cx - ax, aabbMaxX: cx + ax,
    aabbMinY: cy - hy, aabbMaxY: cy + hy,
    aabbMinZ: cz - az, aabbMaxZ: cz + az,
  };
}

function makeRampCollider(
  bx: number, by: number, bz: number,
  length: number, height: number, width: number,
  yaw: number,
  surface: RampCollider['surface'],
): RampCollider {
  const cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw);
  const hw = width / 2;
  // 6 corners
  const corners: Vec3[] = [
    [0, 0, -hw], [length, 0, -hw], [length, height, -hw],
    [0, 0,  hw], [length, 0,  hw], [length, height,  hw],
  ];
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const [x, y, z] of corners) {
    const wx = bx + x * cosYaw + z * sinYaw;
    const wy = by + y;
    const wz = bz + (-x * sinYaw + z * cosYaw);
    if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
    if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
    if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
  }
  return {
    originX: bx, originY: by, originZ: bz,
    length, height, width,
    yaw, cosYaw, sinYaw,
    surface,
    aabbMinX: minX, aabbMaxX: maxX,
    aabbMinY: minY, aabbMaxY: maxY,
    aabbMinZ: minZ, aabbMaxZ: maxZ,
  };
}

export function buildMap(root: Block): { world: World; meshes: Mesh[] } {
  return new Builder().build(root);
}
