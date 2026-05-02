/** Procedural humanoid mesh — torso + head + legs + helmet/vest/arms.
 *  Used by all characters. The mesh is parented to a single TransformNode
 *  per character, so we move the node and the parts come along.
 *
 *  Materials are reused across characters of the same team. Only one
 *  TransformNode is moved per character per render frame; the gear
 *  meshes are static children and don't add to the per-frame matrix
 *  cost beyond Babylon's parent walk. */

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

const sharedMats = new Map<string, StandardMaterial>();
function sharedMat(name: string, build: (m: StandardMaterial) => void): StandardMaterial {
  const hit = sharedMats.get(name);
  if (hit) return hit;
  const m = new StandardMaterial(name, getScene());
  build(m);
  sharedMats.set(name, m);
  return m;
}

function getSkinMaterial(): StandardMaterial {
  return sharedMat('skin', (m) => {
    m.diffuseColor = new Color3(0.38, 0.28, 0.20);
    m.specularColor = new Color3(0.06, 0.06, 0.06);
  });
}
function getVestMaterial(): StandardMaterial {
  return sharedMat('vest', (m) => {
    m.diffuseColor = new Color3(0.10, 0.10, 0.11);
    m.specularColor = new Color3(0.05, 0.05, 0.05);
  });
}
function getHelmetMaterial(): StandardMaterial {
  return sharedMat('helmet', (m) => {
    m.diffuseColor = new Color3(0.18, 0.18, 0.20);
    m.specularColor = new Color3(0.12, 0.12, 0.12);
    m.specularPower = 32;
  });
}
function getBootMaterial(): StandardMaterial {
  return sharedMat('boot', (m) => {
    m.diffuseColor = new Color3(0.06, 0.05, 0.04);
    m.specularColor = new Color3(0.02, 0.02, 0.02);
  });
}

export interface HumanoidParts {
  root: TransformNode;
  body: Mesh;
  head: Mesh;
  legs: Mesh;
  /** Static gear children — kept on the parts list so disposeHumanoid
   *  cleans them up. Not addressed individually after build. */
  gear: Mesh[];
}

export function createHumanoid(team: 'T' | 'CT', name: string): HumanoidParts {
  const scene = getScene();
  const root = new TransformNode(`hum-${name}`, scene);

  const teamMat = getTeamMaterial(team);
  const skin = getSkinMaterial();
  const vest = getVestMaterial();
  const helmet = getHelmetMaterial();
  const boot = getBootMaterial();

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

  // ----- Gear: helmet, vest, pouches, shoulders, boots ----------------
  // Each piece is a small box parented to the body part it should
  // track (head for helmet, body for vest/shoulders/belt/pouches, root
  // for boots). Crouch shrinks legs and lowers body+head; gear comes
  // along automatically through its parent.
  const gear: Mesh[] = [];
  const part = (n: string, w: number, h: number, d: number, x: number, y: number, z: number, mat: StandardMaterial, parent: TransformNode): Mesh => {
    const mesh = MeshBuilder.CreateBox(`hum-${name}-${n}`, { width: w, height: h, depth: d }, scene);
    mesh.position = new Vector3(x, y, z);
    mesh.material = mat;
    mesh.parent = parent;
    mesh.receiveShadows = true;
    addShadowCaster(mesh);
    gear.push(mesh);
    return mesh;
  };

  // Helmet shell — flat box on top of the head. Parent: head.
  part('helmet',     0.30, 0.13, 0.30,  0,  0.10, 0.00, helmet, head);
  part('helmet-rim', 0.32, 0.04, 0.32,  0,  0.03, 0.00, helmet, head);

  // Body armor — vest + plate + shoulders + belt + pouches. Parent: body.
  part('vest',       0.58, 0.55, 0.36,  0,    0.15, 0.01, vest, body);
  part('vest-plate', 0.30, 0.30, 0.04,  0,    0.15, 0.18, vest, body);
  part('shoulder-l', 0.16, 0.16, 0.30, -0.27, 0.37, 0.00, vest, body);
  part('shoulder-r', 0.16, 0.16, 0.30,  0.27, 0.37, 0.00, vest, body);
  part('belt',       0.50, 0.06, 0.34,  0,   -0.13, 0.00, vest, body);
  part('pouch-l',    0.10, 0.13, 0.10, -0.20, -0.21, 0.16, vest, body);
  part('pouch-r',    0.10, 0.13, 0.10,  0.20, -0.21, 0.16, vest, body);

  // Boots — at ground level, independent of crouch (parent: root, not legs).
  part('boot-l',     0.20, 0.10, 0.30, -0.10,  0.06, 0.04, boot, root);
  part('boot-r',     0.20, 0.10, 0.30,  0.10,  0.06, 0.04, boot, root);

  return { root, body, head, legs, gear };
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
  for (const g of parts.gear) g.dispose();
  parts.root.dispose();
}

/** Tear a body part off the humanoid for a gore-kill effect. Clones the
 *  matching mesh at its current world transform, reparents the clone to
 *  the scene root (so it can fly freely without following the corpse),
 *  and hides the original on the humanoid so the body looks mutilated.
 *  Returns the detached mesh so the visuals module can run physics on
 *  it and let it fall to the ground.
 *
 *  Helmet pieces ride along when the head goes — they're parented to the
 *  head, so cloning the head alone leaves them stuck mid-air. The
 *  function returns the additional helmet clones via the second return
 *  slot for the same physics treatment. */
export function detachBodyPart(
  parts: HumanoidParts,
  kind: 'head' | 'arm' | 'leg' | 'chest',
): { primary: Mesh; extras: Mesh[] } | null {
  let primaryOriginal: Mesh | undefined;
  const extraOriginals: Mesh[] = [];

  switch (kind) {
    case 'head':
      primaryOriginal = parts.head;
      // The helmet shell + rim are parented to head — they have to come
      // along or they'll float in mid-air.
      for (const g of parts.gear) {
        if (g.name.includes('helmet')) extraOriginals.push(g);
      }
      break;
    case 'leg':
      primaryOriginal = parts.legs;
      // Boots are root-parented, but rip the closer one off too for
      // visual coherence.
      for (const g of parts.gear) {
        if (g.name.includes('boot')) extraOriginals.push(g);
      }
      break;
    case 'arm':
      // We don't have a dedicated arm mesh — the shoulder gear stands
      // in for the limb. Pick whichever shoulder is still attached.
      for (const g of parts.gear) {
        if (/shoulder-/.test(g.name) && g.isEnabled()) {
          primaryOriginal = g; break;
        }
      }
      break;
    case 'chest':
      // Body shot — peel a shoulder pad off as a gib. The torso itself
      // stays so the corpse still has a recognisable shape.
      for (const g of parts.gear) {
        if (/shoulder-/.test(g.name) && g.isEnabled()) {
          primaryOriginal = g; break;
        }
      }
      break;
  }

  if (!primaryOriginal) return null;

  const clonePart = (orig: Mesh): Mesh | null => {
    const clone = orig.clone(`gib-${orig.name}`, null);
    if (!clone) return null;
    // Clone retains the original's local transform; convert to absolute
    // world transform before reparenting so the gib stays where the
    // body part was visually.
    const absPos = orig.getAbsolutePosition();
    const absRot = orig.absoluteRotationQuaternion;
    clone.setParent(null);
    clone.position.copyFrom(absPos);
    clone.rotationQuaternion = absRot.clone();
    clone.rotation.set(0, 0, 0);
    return clone;
  };

  const primary = clonePart(primaryOriginal);
  if (!primary) return null;
  primaryOriginal.setEnabled(false);

  const extras: Mesh[] = [];
  for (const e of extraOriginals) {
    const c = clonePart(e);
    if (c) extras.push(c);
    e.setEnabled(false);
  }

  return { primary, extras };
}
