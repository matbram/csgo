/** Procedural humanoid mesh — torso, head, arms, legs as boxes/capsules.
 *  Used by all characters. The mesh is parented to a single TransformNode
 *  per character, so we move the node and the parts come along.
 *
 *  Materials are reused across characters of the same team. Only one
 *  TransformNode is moved per character per render frame. */

import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { getScene } from '../engine/scene';
import { addShadowCaster } from '../engine/lighting';

const teamMaterials = new Map<string, StandardMaterial>();

function getTeamMaterial(team: 'T' | 'CT'): StandardMaterial {
  const key = `team-${team}`;
  const hit = teamMaterials.get(key);
  if (hit) return hit;
  const scene = getScene();
  const mat = new StandardMaterial(key, scene);
  if (team === 'T') {
    mat.diffuseColor = new Color3(0.65, 0.42, 0.20);    // tan / orange
    mat.emissiveColor = new Color3(0.06, 0.04, 0.02);
  } else {
    mat.diffuseColor = new Color3(0.20, 0.28, 0.42);    // navy
    mat.emissiveColor = new Color3(0.02, 0.03, 0.05);
  }
  mat.specularColor = new Color3(0.05, 0.05, 0.05);
  teamMaterials.set(key, mat);
  return mat;
}

let darkSkin: StandardMaterial | null = null;
function getSkinMaterial(): StandardMaterial {
  if (darkSkin) return darkSkin;
  const scene = getScene();
  darkSkin = new StandardMaterial('skin', scene);
  darkSkin.diffuseColor = new Color3(0.38, 0.28, 0.20);
  darkSkin.specularColor = new Color3(0.06, 0.06, 0.06);
  return darkSkin;
}

export interface HumanoidParts {
  root: TransformNode;
  body: Mesh;
  head: Mesh;
  legs: Mesh;
}

export function createHumanoid(team: 'T' | 'CT', name: string): HumanoidParts {
  const scene = getScene();
  const root = new TransformNode(`hum-${name}`, scene);

  const teamMat = getTeamMaterial(team);
  const skin = getSkinMaterial();

  // Torso — box. Positioned so its center is at base + 1.05 (between stomach top and chest top).
  const body = MeshBuilder.CreateBox(`hum-${name}-body`, { width: 0.55, height: 0.95, depth: 0.32 }, scene);
  body.position = new Vector3(0, 1.05, 0);
  body.material = teamMat;
  body.parent = root;
  body.receiveShadows = true;
  addShadowCaster(body);

  // Head — sphere at base + eye + 0.10 (matches hitbox).
  const head = MeshBuilder.CreateSphere(`hum-${name}-head`, { diameter: 0.26, segments: 12 }, scene);
  head.position = new Vector3(0, 1.75, 0);
  head.material = skin;
  head.parent = root;
  head.receiveShadows = true;
  addShadowCaster(head);

  // Legs — single tapered box (cheaper than two cylinders) covering thighs+shins.
  const legs = MeshBuilder.CreateBox(`hum-${name}-legs`, { width: 0.42, height: 0.95, depth: 0.32 }, scene);
  legs.position = new Vector3(0, 0.5, 0);
  legs.material = teamMat;
  legs.parent = root;
  legs.receiveShadows = true;
  addShadowCaster(legs);

  return { root, body, head, legs };
}

/** Sync a humanoid to a character's pose. Crouching shrinks the legs
 *  (they squat) and lowers the torso/head accordingly. Also resets all
 *  three rotation axes so a previously-tipped-over corpse stands back up
 *  when the character respawns. */
export function syncHumanoidPose(parts: HumanoidParts, x: number, y: number, z: number, yaw: number, eye: number, height: number): void {
  parts.root.position.set(x, y, z);
  // Babylon default: rotation.y rotates around +Y, positive turns from +Z to +X
  // (matches our yaw convention where forward = (sin yaw, 0, cos yaw)).
  parts.root.rotation.x = 0;
  parts.root.rotation.y = yaw;
  parts.root.rotation.z = 0;

  // Scale legs by height-to-stand ratio (1.80 standing → factor 1, crouching ~1.30 → 0.72)
  const legScale = Math.max(0.55, height / 1.80);
  parts.legs.scaling.y = legScale;
  parts.legs.position.y = 0.5 * legScale;

  parts.body.position.y = legScale * 0.95 + 0.10;
  // Head position is relative to root.
  parts.head.position.set(0, eye + 0.10, 0);
}

export function disposeHumanoid(parts: HumanoidParts): void {
  parts.body.dispose();
  parts.head.dispose();
  parts.legs.dispose();
  parts.root.dispose();
}
