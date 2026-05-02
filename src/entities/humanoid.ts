/** Procedural humanoid mesh — head, torso, pelvis, two arm groups,
 *  two leg groups, plus gear (helmet, vest, boots). Each limb is its
 *  own mesh so the gore visuals can detach a specific part on a
 *  killing hit. The combat layer asks for a clone of the matching
 *  part, hides the original on the corpse, and lets the clone fly
 *  off as a gib. */

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
function getPantsMaterial(team: 'T' | 'CT'): StandardMaterial {
  const key = `pants-${team}`;
  return sharedMat(key, (m) => {
    if (team === 'T') {
      m.diffuseColor = new Color3(0.32, 0.22, 0.12);
    } else {
      m.diffuseColor = new Color3(0.12, 0.16, 0.24);
    }
    m.specularColor = new Color3(0.04, 0.04, 0.04);
  });
}

export interface HumanoidParts {
  root: TransformNode;
  /** Direct mesh references — every one of these can be hidden by
   *  detachBodyPart() and cloned out as a flying gib. */
  head: Mesh;
  torso: Mesh;
  pelvis: Mesh;
  leftUpperArm: Mesh;
  leftForearm: Mesh;
  rightUpperArm: Mesh;
  rightForearm: Mesh;
  leftThigh: Mesh;
  leftShin: Mesh;
  leftFoot: Mesh;
  rightThigh: Mesh;
  rightShin: Mesh;
  rightFoot: Mesh;
  /** Static helmet / vest / belt / pouches. The detach logic uses
   *  name patterns to pull pieces (e.g. helmet shell) along with the
   *  body part they're sitting on. */
  gear: Mesh[];
  /** Anchor for whatever weapon the character is holding. Always
   *  exists; its children swap when the character switches weapons. */
  weaponAnchor: TransformNode;
  /** Anchor at the muzzle of the currently-equipped weapon. The combat
   *  visuals layer reads its absolute position to spawn muzzle-flash
   *  particles in the right place. */
  weaponMuzzle: TransformNode;
  /** Meshes belonging to the currently-equipped weapon. Replaced when
   *  the active weapon changes — disposed first so we don't leak. */
  weaponMeshes: Mesh[];
  /** Weapon category currently visible on the body — primary/secondary/
   *  knife use different geometries. Tracked here to avoid rebuilding
   *  the mesh every frame. */
  weaponCategory: 'rifle' | 'pistol' | 'sniper' | 'knife' | 'grenade' | null;
}

/** Style materials for the bot weapon meshes — separate from the
 *  view-model materials so we don't import the player viewModel
 *  module just for a couple of colours. */
function getBotWeaponMaterials(): {
  metal: StandardMaterial;
  polymer: StandardMaterial;
  wood: StandardMaterial;
} {
  return {
    metal: sharedMat('botgun-metal', (m) => {
      m.diffuseColor = new Color3(0.16, 0.16, 0.18);
      m.specularColor = new Color3(0.3, 0.3, 0.32);
      m.specularPower = 64;
    }),
    polymer: sharedMat('botgun-polymer', (m) => {
      m.diffuseColor = new Color3(0.08, 0.08, 0.08);
      m.specularColor = new Color3(0.05, 0.05, 0.05);
    }),
    wood: sharedMat('botgun-wood', (m) => {
      m.diffuseColor = new Color3(0.40, 0.26, 0.15);
      m.specularColor = new Color3(0.05, 0.05, 0.05);
    }),
  };
}

export function createHumanoid(team: 'T' | 'CT', name: string): HumanoidParts {
  const scene = getScene();
  const root = new TransformNode(`hum-${name}`, scene);

  const teamMat = getTeamMaterial(team);
  const skin = getSkinMaterial();
  const vest = getVestMaterial();
  const helmet = getHelmetMaterial();
  const boot = getBootMaterial();
  const pants = getPantsMaterial(team);

  // ------------------------------------------------------------------
  // Layout (in metres, root at the character's feet at ground level):
  //
  //   Head sphere     — center y = 1.71  (top ~1.82)
  //   Torso box       — center y = 1.32  height 0.50
  //   Pelvis box      — center y = 0.99  height 0.18
  //   Thigh box       — center y = 0.69  height 0.40
  //   Shin box        — center y = 0.27  height 0.42
  //   Foot box        — center y = 0.04  height 0.08
  //   Upper arm box   — center y = 1.27  height 0.36, x=±0.31
  //   Forearm box     — center y = 0.85  height 0.42, x=±0.31
  // ------------------------------------------------------------------

  const part = (
    n: string,
    width: number, height: number, depth: number,
    x: number, y: number, z: number,
    mat: StandardMaterial,
    parent: TransformNode,
  ): Mesh => {
    const mesh = MeshBuilder.CreateBox(`hum-${name}-${n}`, { width, height, depth }, scene);
    mesh.position.set(x, y, z);
    mesh.material = mat;
    mesh.parent = parent;
    mesh.receiveShadows = true;
    addShadowCaster(mesh);
    return mesh;
  };

  // Head
  const head = MeshBuilder.CreateSphere(`hum-${name}-head`, { diameter: 0.24, segments: 12 }, scene);
  head.position.set(0, 1.71, 0);
  head.material = skin;
  head.parent = root;
  head.receiveShadows = true;
  addShadowCaster(head);

  const torso = part('torso',  0.46, 0.50, 0.28,  0,    1.32, 0, teamMat, root);
  const pelvis = part('pelvis', 0.42, 0.18, 0.28,  0,    0.99, 0, teamMat, root);

  // Arms
  const luArm = part('larm-up',  0.12, 0.36, 0.12, -0.31, 1.27, 0, teamMat, root);
  const lfArm = part('larm-fwd', 0.11, 0.42, 0.11, -0.31, 0.85, 0, skin,    root);
  const ruArm = part('rarm-up',  0.12, 0.36, 0.12,  0.31, 1.27, 0, teamMat, root);
  const rfArm = part('rarm-fwd', 0.11, 0.42, 0.11,  0.31, 0.85, 0, skin,    root);

  // Legs
  const lThigh = part('lleg-thigh', 0.18, 0.40, 0.22, -0.11, 0.69, 0, pants, root);
  const lShin  = part('lleg-shin',  0.16, 0.42, 0.20, -0.11, 0.27, 0, pants, root);
  const lFoot  = part('lleg-foot',  0.20, 0.08, 0.30, -0.11, 0.04, 0.04, boot, root);
  const rThigh = part('rleg-thigh', 0.18, 0.40, 0.22,  0.11, 0.69, 0, pants, root);
  const rShin  = part('rleg-shin',  0.16, 0.42, 0.20,  0.11, 0.27, 0, pants, root);
  const rFoot  = part('rleg-foot',  0.20, 0.08, 0.30,  0.11, 0.04, 0.04, boot, root);

  // ----- Gear: helmet, vest, pouches, plate -----
  // Helmet shell sits on the head; cloning the head clones these too
  // because they're parented to it, so a headshot tears off head +
  // helmet as one visual chunk.
  const gear: Mesh[] = [];
  const addGear = (m: Mesh): Mesh => { gear.push(m); return m; };

  addGear(part('helmet',     0.30, 0.13, 0.30,  0,  0.10, 0.00, helmet, head));
  addGear(part('helmet-rim', 0.32, 0.04, 0.32,  0,  0.03, 0.00, helmet, head));

  // Body armor — vest plate + plate carrier on torso.
  addGear(part('vest',       0.50, 0.46, 0.32,  0,    0.00, 0.01, vest, torso));
  addGear(part('vest-plate', 0.30, 0.30, 0.04,  0,    0.00, 0.16, vest, torso));
  // Belt + pouches on pelvis.
  addGear(part('belt',       0.46, 0.06, 0.30,  0,    0.07, 0.00, vest, pelvis));
  addGear(part('pouch-l',    0.10, 0.13, 0.10, -0.16, -0.02, 0.16, vest, pelvis));
  addGear(part('pouch-r',    0.10, 0.13, 0.10,  0.16, -0.02, 0.16, vest, pelvis));
  // Shoulder pads on the upper arms — track the limb so a torn-off
  // arm flies away wearing its shoulder pad.
  addGear(part('shoulder-l', 0.16, 0.10, 0.16,  0,    0.20, 0, vest, luArm));
  addGear(part('shoulder-r', 0.16, 0.10, 0.16,  0,    0.20, 0, vest, ruArm));

  // Weapon anchor: a TransformNode parented to the bot's torso, sitting
  // on the right side at chest height pointing forward. Weapon meshes
  // (built via setHumanoidWeapon) live as children. Pose-sync moves
  // the anchor along with the torso during crouch.
  const weaponAnchor = new TransformNode(`hum-${name}-weapon`, scene);
  weaponAnchor.parent = torso;
  weaponAnchor.position.set(0.30, -0.05, 0.05);
  const weaponMuzzle = new TransformNode(`hum-${name}-muzzle`, scene);
  weaponMuzzle.parent = weaponAnchor;
  weaponMuzzle.position.set(0, 0, 0.5);

  return {
    root, head, torso, pelvis,
    leftUpperArm: luArm, leftForearm: lfArm,
    rightUpperArm: ruArm, rightForearm: rfArm,
    leftThigh: lThigh, leftShin: lShin, leftFoot: lFoot,
    rightThigh: rThigh, rightShin: rShin, rightFoot: rFoot,
    gear,
    weaponAnchor,
    weaponMuzzle,
    weaponMeshes: [],
    weaponCategory: null,
  };
}

/** Build a low-detail weapon visual for a bot and parent it to their
 *  weapon anchor. Idempotent with the parts.weaponCategory check —
 *  rebuilds only when the category actually changes (calling this
 *  every frame is cheap when the bot keeps the same weapon). */
export function setHumanoidWeapon(
  parts: HumanoidParts,
  category: 'rifle' | 'pistol' | 'sniper' | 'knife' | 'grenade' | null,
): void {
  if (parts.weaponCategory === category) return;
  // Tear down whatever was there.
  for (const m of parts.weaponMeshes) m.dispose();
  parts.weaponMeshes = [];
  parts.weaponCategory = category;
  if (!category) return;

  const scene = getScene();
  const m = getBotWeaponMaterials();
  const anchor = parts.weaponAnchor;
  const built: Mesh[] = [];

  const box = (name: string, w: number, h: number, d: number, x: number, y: number, z: number, mat: StandardMaterial): Mesh => {
    const mesh = MeshBuilder.CreateBox(`${anchor.name}-${name}`, { width: w, height: h, depth: d }, scene);
    mesh.position.set(x, y, z);
    mesh.material = mat;
    mesh.parent = anchor;
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    addShadowCaster(mesh);
    built.push(mesh);
    return mesh;
  };

  if (category === 'rifle') {
    box('body',     0.06, 0.08, 0.50,  0,  0.00, 0.10, m.metal);
    box('barrel',   0.03, 0.03, 0.34,  0,  0.012, 0.45, m.metal);
    box('stock',    0.05, 0.07, 0.18,  0, -0.02, -0.15, m.wood);
    box('mag',      0.05, 0.10, 0.05,  0, -0.10,  0.05, m.polymer);
    box('grip',     0.04, 0.08, 0.04,  0, -0.07, -0.03, m.polymer);
    parts.weaponMuzzle.position.set(0, 0.012, 0.65);
  } else if (category === 'sniper') {
    box('body',     0.06, 0.08, 0.55,  0,  0.00, 0.10, m.metal);
    box('barrel',   0.03, 0.03, 0.55,  0,  0.012, 0.55, m.metal);
    box('scope',    0.04, 0.05, 0.16,  0,  0.07,  0.12, m.metal);
    box('stock',    0.06, 0.07, 0.22,  0, -0.02, -0.18, m.wood);
    box('mag',      0.05, 0.06, 0.10,  0, -0.07,  0.05, m.polymer);
    parts.weaponMuzzle.position.set(0, 0.012, 0.86);
  } else if (category === 'pistol') {
    box('slide',    0.04, 0.05, 0.18,  0,  0.02, 0.06, m.metal);
    box('frame',    0.04, 0.07, 0.05,  0, -0.03, 0.00, m.polymer);
    box('grip',     0.04, 0.10, 0.04,  0, -0.08, -0.02, m.polymer);
    parts.weaponMuzzle.position.set(0, 0.02, 0.16);
  } else if (category === 'knife') {
    box('blade',    0.03, 0.02, 0.20,  0,  0.00, 0.10, m.metal);
    box('grip',     0.04, 0.03, 0.10,  0,  0.00, -0.04, m.wood);
    parts.weaponMuzzle.position.set(0, 0, 0.20);
  } else {
    // grenade: a tiny sphere stand-in. Bots rarely show this on their
    // body but we still build it so the muzzle anchor is sane.
    const sphere = MeshBuilder.CreateSphere(`${anchor.name}-grenade`, { diameter: 0.10, segments: 6 }, scene);
    sphere.parent = anchor;
    sphere.position.set(0, 0, 0.05);
    sphere.material = m.polymer;
    sphere.isPickable = false;
    addShadowCaster(sphere);
    built.push(sphere);
    parts.weaponMuzzle.position.set(0, 0, 0.10);
  }

  parts.weaponMeshes = built;
}

/** Sync a humanoid to a character's pose. Crouch is approximated by
 *  scaling the torso/head/arms down toward the pelvis and shrinking
 *  the leg meshes so the body crouches in place. We don't yet animate
 *  individual joints — the body holds a "rigid block" pose, but the
 *  separation into discrete meshes is what dismemberment needs. */
export function syncHumanoidPose(
  parts: HumanoidParts,
  x: number, y: number, z: number, yaw: number,
  eye: number, height: number,
): void {
  parts.root.position.set(x, y, z);
  parts.root.rotation.x = 0;
  parts.root.rotation.y = yaw;
  parts.root.rotation.z = 0;

  // Crouch ratio: 1.0 standing, ~0.72 crouching.
  const crouchRatio = Math.max(0.55, height / 1.80);
  // Shrink leg lengths and lower their centers proportionally so the
  // feet stay planted on the ground.
  const compress = (mesh: Mesh, restY: number): void => {
    mesh.scaling.y = crouchRatio;
    mesh.position.y = restY * crouchRatio;
  };
  compress(parts.leftThigh, 0.69);
  compress(parts.leftShin, 0.27);
  compress(parts.rightThigh, 0.69);
  compress(parts.rightShin, 0.27);
  // Feet stay full size at floor level.
  parts.leftFoot.scaling.y = 1;
  parts.rightFoot.scaling.y = 1;
  parts.leftFoot.position.y = 0.04;
  parts.rightFoot.position.y = 0.04;

  // Pelvis + torso + arms ride down with the legs.
  const pelvisY = 0.99 * crouchRatio;
  const torsoY = 1.32 * crouchRatio;
  parts.pelvis.position.y = pelvisY;
  parts.torso.position.y = torsoY;
  parts.leftUpperArm.position.y = 1.27 * crouchRatio;
  parts.rightUpperArm.position.y = 1.27 * crouchRatio;
  parts.leftForearm.position.y = 0.85 * crouchRatio;
  parts.rightForearm.position.y = 0.85 * crouchRatio;

  // Head sits at eye + small offset so it stays consistent with the
  // hitbox model regardless of crouch.
  parts.head.position.set(0, eye + 0.06, 0);
}

export function disposeHumanoid(parts: HumanoidParts): void {
  parts.head.dispose();
  parts.torso.dispose();
  parts.pelvis.dispose();
  parts.leftUpperArm.dispose();
  parts.leftForearm.dispose();
  parts.rightUpperArm.dispose();
  parts.rightForearm.dispose();
  parts.leftThigh.dispose();
  parts.leftShin.dispose();
  parts.leftFoot.dispose();
  parts.rightThigh.dispose();
  parts.rightShin.dispose();
  parts.rightFoot.dispose();
  for (const g of parts.gear) g.dispose();
  for (const m of parts.weaponMeshes) m.dispose();
  parts.weaponMuzzle.dispose();
  parts.weaponAnchor.dispose();
  parts.root.dispose();
}

/** Tear a body part off the humanoid. Picks meshes that match the
 *  hitbox kind, clones each at its current absolute world transform,
 *  hides the originals on the corpse, and returns the detached
 *  meshes so the visuals layer can run gib physics on them. The
 *  primary mesh is launched first (it's the "main" chunk), the
 *  extras come along at slightly reduced velocity (limbs trailing
 *  shoulder pads, helmet pieces following the head, etc.). */
export function detachBodyPart(
  parts: HumanoidParts,
  kind: 'head' | 'arm' | 'leg' | 'chest',
): { primary: Mesh; extras: Mesh[] } | null {
  // Pick a side at random for symmetric limbs. Both sides may already
  // be detached (e.g. multiple shots hitting different limbs) — in
  // that case we fall through and return null.
  const pickArm = (): Mesh[] => {
    if (parts.leftUpperArm.isEnabled()) return [parts.leftUpperArm, parts.leftForearm];
    if (parts.rightUpperArm.isEnabled()) return [parts.rightUpperArm, parts.rightForearm];
    return [];
  };
  const pickLeg = (): Mesh[] => {
    if (parts.leftThigh.isEnabled()) return [parts.leftThigh, parts.leftShin, parts.leftFoot];
    if (parts.rightThigh.isEnabled()) return [parts.rightThigh, parts.rightShin, parts.rightFoot];
    return [];
  };

  let primaryOriginal: Mesh | undefined;
  const extraOriginals: Mesh[] = [];

  switch (kind) {
    case 'head': {
      if (!parts.head.isEnabled()) return null;
      primaryOriginal = parts.head;
      // Helmet is parented to the head — cloning the head sphere alone
      // wouldn't take the helmet shell. Treat helmet pieces as extras.
      for (const g of parts.gear) {
        if (g.name.includes('helmet') && g.isEnabled()) extraOriginals.push(g);
      }
      break;
    }
    case 'arm': {
      const armPieces = pickArm();
      if (armPieces.length === 0) return null;
      primaryOriginal = armPieces[0];
      for (let i = 1; i < armPieces.length; i++) extraOriginals.push(armPieces[i]!);
      // Drag the matching shoulder pad along.
      const side = primaryOriginal === parts.leftUpperArm ? 'shoulder-l' : 'shoulder-r';
      const pad = parts.gear.find(g => g.name.includes(side) && g.isEnabled());
      if (pad) extraOriginals.push(pad);
      break;
    }
    case 'leg': {
      const legPieces = pickLeg();
      if (legPieces.length === 0) return null;
      primaryOriginal = legPieces[0];
      for (let i = 1; i < legPieces.length; i++) extraOriginals.push(legPieces[i]!);
      break;
    }
    case 'chest': {
      // Centre-mass kill — peel off the vest plate as a token chunk so
      // the corpse looks mutilated even when no limb came off. The
      // torso itself stays so the body is still recognisable.
      const plate = parts.gear.find(g => g.name.includes('vest-plate') && g.isEnabled());
      if (!plate) return null;
      primaryOriginal = plate;
      break;
    }
  }

  if (!primaryOriginal) return null;

  const clonePart = (orig: Mesh): Mesh | null => {
    const clone = orig.clone(`gib-${orig.name}`, null);
    if (!clone) return null;
    const absPos = orig.getAbsolutePosition();
    const absRot = orig.absoluteRotationQuaternion;
    clone.setParent(null);
    clone.position.copyFrom(absPos);
    clone.rotationQuaternion = absRot.clone();
    clone.rotation.set(0, 0, 0);
    // Reset scaling — the clone might have inherited a crouch squish
    // from the original; we want the gib at full size as it tumbles.
    clone.scaling.set(1, 1, 1);
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
