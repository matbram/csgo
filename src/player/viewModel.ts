/** Procedural first-person view model. Draws the active weapon parented
 *  to the camera with a small offset. Animates fire kick, deploy, reload,
 *  and idle bob. Each weapon category has its own primitive assembly:
 *  rifle (long body + magazine + grip), pistol (short body + grip), etc.
 *
 *  Style aim: stylized realism with material zones (metal vs polymer vs
 *  wood) that read at FPS scale without needing high-poly meshes. */

import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Node } from '@babylonjs/core/node';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { getScene } from '../engine/scene';
import { time } from '../engine/time';
import type { WeaponCategory } from '../weapons/definitions';
import type { WeaponInstance } from '../weapons/inventory';
import { expSmooth } from '../util/math';

interface ViewModelMaterials {
  metal: StandardMaterial;
  polymer: StandardMaterial;
  wood: StandardMaterial;
  accent: StandardMaterial;
}

/** Total swing animation duration in ms. Calibrated to fit inside the
 *  knife's primary fire interval (90 rpm → 667 ms) with margin. */
const SWING_DURATION_MS = 280;
/** Stab animation is longer to match the slower secondary-attack rate
 *  (50 rpm → 1200 ms). */
const STAB_DURATION_MS = 450;

type MeleeKind = 'slash' | 'stab';

interface SwingPose {
  posX: number; posY: number; posZ: number;
  rotX: number; rotY: number; rotZ: number;
}

const ZERO_SWING: SwingPose = { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 0 };

/** Hand-tuned three-phase slash curve. `dir` is +1/-1 to alternate the
 *  slash side across consecutive swings — the knife arcs L→R then R→L.
 *  Tuned to be unambiguously visible: the blade leaves the screen edge
 *  during the strike before whipping back. */
function swingCurve(t: number, dir: number): SwingPose {
  if (t >= 1) return ZERO_SWING;
  if (t < 0.25) {
    // Wind-up: pull the knife to the opposite side and tilt up.
    const k = t / 0.25;
    return {
      posX: -0.18 * k * dir,
      posY:  0.08 * k,
      posZ: -0.05 * k,
      rotX: -0.70 * k,
      rotY:  0.55 * k * dir,
      rotZ:  0.80 * k * dir,
    };
  }
  if (t < 0.50) {
    // Strike: hard arc across the screen + forward thrust. The blade
    // sweeps from -0.18 to +0.30 horizontally — half the screen width.
    const k = (t - 0.25) / 0.25;
    return {
      posX: -0.18 * dir + 0.48 * k * dir,
      posY:  0.08 - 0.18 * k,
      posZ: -0.05 + 0.30 * k,
      rotX: -0.70 + 1.30 * k,
      rotY:  0.55 * dir - 1.10 * k * dir,
      rotZ:  0.80 * dir - 1.55 * k * dir,
    };
  }
  // Recovery: ease back to neutral over the longer second half.
  const k = 1 - (t - 0.50) / 0.50;
  return {
    posX:  0.30 * k * dir,
    posY: -0.10 * k,
    posZ:  0.25 * k,
    rotX:  0.60 * k,
    rotY: -0.55 * k * dir,
    rotZ: -0.75 * k * dir,
  };
}

/** Stab curve: pull the knife back and up, then thrust straight forward
 *  and hold briefly at full extension before recovering. No left/right
 *  component — a stab is committed and centered. The forward thrust is
 *  large (~40 cm) so the blade clearly punches forward past the camera. */
function stabCurve(t: number): SwingPose {
  if (t >= 1) return ZERO_SWING;
  if (t < 0.25) {
    // Wind-up: pull back and up, knife pitched well up.
    const k = t / 0.25;
    return {
      posX: 0,
      posY:  0.10 * k,
      posZ: -0.18 * k,
      rotX: -0.85 * k,
      rotY: 0,
      rotZ: 0,
    };
  }
  if (t < 0.45) {
    // Thrust: hard forward + level out the blade. Goes past neutral so
    // the knife clearly punches outward.
    const k = (t - 0.25) / 0.20;
    return {
      posX: 0,
      posY:  0.10 - 0.13 * k,
      posZ: -0.18 + 0.58 * k,
      rotX: -0.85 + 1.05 * k,
      rotY: 0,
      rotZ: 0,
    };
  }
  if (t < 0.60) {
    // Hold at full extension — sells the impact and gives the player
    // a clear "the knife is OUT" frame.
    return {
      posX: 0,
      posY: -0.03,
      posZ:  0.40,
      rotX:  0.20,
      rotY: 0,
      rotZ: 0,
    };
  }
  // Recovery: ease back.
  const k = 1 - (t - 0.60) / 0.40;
  return {
    posX: 0,
    posY: -0.03 * k,
    posZ:  0.40 * k,
    rotX:  0.20 * k,
    rotY: 0,
    rotZ: 0,
  };
}

let mats: ViewModelMaterials | null = null;
function getMats(): ViewModelMaterials {
  if (mats) return mats;
  const scene = getScene();
  const metal = new StandardMaterial('vm-metal', scene);
  metal.diffuseColor = new Color3(0.18, 0.18, 0.20);
  metal.specularColor = new Color3(0.4, 0.4, 0.45);
  metal.specularPower = 64;

  const polymer = new StandardMaterial('vm-polymer', scene);
  polymer.diffuseColor = new Color3(0.10, 0.10, 0.10);
  polymer.specularColor = new Color3(0.10, 0.10, 0.10);
  polymer.specularPower = 16;

  const wood = new StandardMaterial('vm-wood', scene);
  wood.diffuseColor = new Color3(0.42, 0.27, 0.16);
  wood.specularColor = new Color3(0.05, 0.05, 0.05);

  const accent = new StandardMaterial('vm-accent', scene);
  accent.diffuseColor = new Color3(0.55, 0.45, 0.18);
  accent.specularColor = new Color3(0.3, 0.3, 0.3);

  mats = { metal, polymer, wood, accent };
  return mats;
}

interface ViewModelHandle {
  root: TransformNode;
  /** Offset from camera in camera local space. */
  baseLocalPos: Vector3;
  /** Current animated offset (kick, bob). */
  kickPos: Vector3;
  kickRot: Vector3;
  /** For idle bob. */
  bobPhase: number;
  /** Muzzle position node (where bullets and flashes spawn). */
  muzzle: TransformNode;
  /** Children to dispose. */
  parts: Mesh[];
  category: WeaponCategory;
}

export class ViewModel {
  private current: ViewModelHandle | null = null;
  private currentWeaponId: string | null = null;
  /** Parent transform hooked to the camera. */
  private readonly hand: TransformNode;
  private smoothedKickX = 0;
  private smoothedKickY = 0;
  private smoothedKickZ = 0;
  private smoothedRotX = 0;
  private smoothedRotY = 0;
  /** Set externally by the firing system to add kick. */
  private kickImpulseX = 0;
  private kickImpulseY = 0;
  private kickImpulseZ = 0;
  /** Reload tween (0..1, 1 = mid-reload). */
  private reloadProgress = 0;
  private isReloading = false;
  /** Whether the view model meshes should currently be rendered. */
  private visible = true;
  /** Melee swing tween (0..1). 1 means no swing in progress; advances to 1
   *  over the duration appropriate for the current `swingKind`. */
  private swingT = 1;
  /** Direction sign for the current slash. Alternates each swing so
   *  consecutive slashes don't look identical. Unused for stabs. */
  private swingDir = 1;
  /** Which animation curve the current swing is playing. */
  private swingKind: MeleeKind = 'slash';

  constructor(parent: Node) {
    const scene = getScene();
    this.hand = new TransformNode('view-model-hand', scene);
    this.hand.parent = parent;
    // Default offset in camera-local space: slightly right, down, forward.
    this.hand.position = new Vector3(0.18, -0.18, 0.32);
  }

  setWeapon(inst: WeaponInstance | null): void {
    if (inst === null) {
      if (this.current) this.disposeCurrent();
      this.currentWeaponId = null;
      return;
    }
    if (this.currentWeaponId === inst.def.id) return;
    if (this.current) this.disposeCurrent();
    const handle = buildViewModel(this.hand, inst.def.category);
    this.current = handle;
    this.currentWeaponId = inst.def.id;
    // Re-apply current visibility so a hot weapon swap during scope still
    // hides the new mesh.
    if (!this.visible) {
      for (const m of handle.parts) m.setEnabled(false);
    }
  }

  /** Add a fire kick. Called by the firing controller after a successful shot. */
  addKick(amountX: number, amountY: number, amountZ = 0.05): void {
    this.kickImpulseX += amountX;
    this.kickImpulseY += amountY;
    this.kickImpulseZ += amountZ;
  }

  setReloading(active: boolean): void {
    this.isReloading = active;
  }

  /** Kick off a melee swing tween. `kind` selects slash (LMB, alternates
   *  L/R) or stab (RMB, centered thrust). The animation duration is
   *  chosen to fit within the matching attack's fire interval. */
  triggerSwing(kind: MeleeKind = 'slash'): void {
    this.swingT = 0;
    this.swingKind = kind;
    if (kind === 'slash') this.swingDir = -this.swingDir;
  }

  /** Hide or show the weapon mesh (e.g. while a sniper scope is active). */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (this.current) {
      for (const m of this.current.parts) m.setEnabled(visible);
    }
  }

  /** Returns the muzzle world position (used as bullet origin and for
   *  muzzle flash placement). Returns null if no weapon is equipped. */
  getMuzzleWorld(out: Vector3): boolean {
    if (!this.current) return false;
    out.copyFrom(this.current.muzzle.getAbsolutePosition());
    return true;
  }

  /** Per-render-frame update. */
  update(speedMS: number, dtMs: number): void {
    if (!this.current) return;
    const v = this.current;
    // Decay kick toward 0 with exp smoothing (~120ms half-life).
    this.kickImpulseX = expSmooth(this.kickImpulseX, 0, 80, dtMs);
    this.kickImpulseY = expSmooth(this.kickImpulseY, 0, 80, dtMs);
    this.kickImpulseZ = expSmooth(this.kickImpulseZ, 0, 80, dtMs);

    this.smoothedKickX = expSmooth(this.smoothedKickX, this.kickImpulseX, 60, dtMs);
    this.smoothedKickY = expSmooth(this.smoothedKickY, this.kickImpulseY, 60, dtMs);
    this.smoothedKickZ = expSmooth(this.smoothedKickZ, this.kickImpulseZ, 60, dtMs);
    this.smoothedRotX = expSmooth(this.smoothedRotX, this.kickImpulseY * 0.04, 60, dtMs);
    this.smoothedRotY = expSmooth(this.smoothedRotY, this.kickImpulseX * 0.03, 60, dtMs);

    // Idle bob with movement.
    v.bobPhase += (speedMS / 6.5) * (dtMs / 1000) * 8;
    const bobAmpY = (speedMS / 6.5) * 0.018;
    const bobAmpX = (speedMS / 6.5) * 0.012;
    const bobY = Math.sin(v.bobPhase) * bobAmpY;
    const bobX = Math.cos(v.bobPhase * 0.5) * bobAmpX;

    // Reload tween: lower the gun while reloading.
    let reloadOffsetY = 0;
    let reloadRotZ = 0;
    if (this.isReloading) {
      this.reloadProgress = Math.min(1, this.reloadProgress + dtMs / 500);
    } else {
      this.reloadProgress = Math.max(0, this.reloadProgress - dtMs / 250);
    }
    reloadOffsetY = -0.10 * this.reloadProgress;
    reloadRotZ = -0.4 * this.reloadProgress;

    // Swing tween. Slash and stab share the same time variable but use
    // different curves and durations.
    if (this.swingT < 1) {
      const dur = this.swingKind === 'stab' ? STAB_DURATION_MS : SWING_DURATION_MS;
      this.swingT = Math.min(1, this.swingT + dtMs / dur);
    }
    const swing = this.swingKind === 'stab'
      ? stabCurve(this.swingT)
      : swingCurve(this.swingT, this.swingDir);

    const base = this.hand.position;
    base.x = 0.18 + bobX + this.smoothedKickX * 0.04 + swing.posX;
    base.y = -0.18 + bobY + reloadOffsetY - this.smoothedKickY * 0.012 + swing.posY;
    base.z = 0.32 - this.smoothedKickZ * 0.18 + swing.posZ;
    this.hand.rotation.x = this.smoothedRotX + swing.rotX;
    this.hand.rotation.y = this.smoothedRotY + swing.rotY;
    this.hand.rotation.z = reloadRotZ + swing.rotZ;
  }

  private disposeCurrent(): void {
    if (!this.current) return;
    for (const m of this.current.parts) m.dispose();
    this.current.muzzle.dispose();
    this.current.root.dispose();
    this.current = null;
  }

  dispose(): void {
    this.disposeCurrent();
    this.hand.dispose();
  }
}

function buildViewModel(parent: Node, category: WeaponCategory): ViewModelHandle {
  const scene = getScene();
  const m = getMats();
  const root = new TransformNode('view-model-root', scene);
  root.parent = parent;
  const parts: Mesh[] = [];

  const mkBox = (name: string, size: { width?: number; height?: number; depth?: number }, pos: [number, number, number], mat: StandardMaterial): Mesh => {
    const mesh = MeshBuilder.CreateBox(name, size, scene);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.material = mat;
    mesh.parent = root;
    mesh.receiveShadows = false;
    mesh.isPickable = false;
    parts.push(mesh);
    return mesh;
  };

  // Use ".rendererCamera" trick later if needed; for M2 the view model uses
  // the same camera and we keep parts close enough not to z-clip.
  const muzzle = new TransformNode('view-model-muzzle', scene);
  muzzle.parent = root;

  if (category === 'rifle') {
    // Receiver
    mkBox('vm-receiver', { width: 0.06, height: 0.06, depth: 0.55 }, [0, 0, 0.05], m.metal);
    // Barrel
    mkBox('vm-barrel', { width: 0.025, height: 0.025, depth: 0.35 }, [0, 0.005, 0.45], m.metal);
    // Stock
    mkBox('vm-stock', { width: 0.05, height: 0.06, depth: 0.20 }, [0, -0.02, -0.20], m.wood);
    // Magazine
    mkBox('vm-mag', { width: 0.05, height: 0.10, depth: 0.05 }, [0, -0.08, 0.05], m.polymer);
    // Grip
    mkBox('vm-grip', { width: 0.04, height: 0.08, depth: 0.04 }, [0, -0.06, -0.08], m.polymer);
    // Front handguard
    mkBox('vm-handguard', { width: 0.06, height: 0.05, depth: 0.20 }, [0, -0.005, 0.20], m.wood);
    // Sight
    mkBox('vm-sight', { width: 0.02, height: 0.03, depth: 0.04 }, [0, 0.05, 0.10], m.metal);
    muzzle.position.set(0, 0.005, 0.62);
  } else if (category === 'pistol') {
    // Slide
    mkBox('vm-slide', { width: 0.04, height: 0.04, depth: 0.18 }, [0, 0.02, 0.04], m.metal);
    // Frame/grip
    mkBox('vm-frame', { width: 0.04, height: 0.06, depth: 0.05 }, [0, -0.03, -0.02], m.polymer);
    mkBox('vm-grip', { width: 0.04, height: 0.10, depth: 0.04 }, [0, -0.08, -0.04], m.polymer);
    // Trigger guard
    mkBox('vm-trigger', { width: 0.03, height: 0.02, depth: 0.04 }, [0, -0.025, 0], m.metal);
    muzzle.position.set(0, 0.02, 0.14);
  } else if (category === 'sniper') {
    // Receiver
    mkBox('vm-receiver', { width: 0.06, height: 0.06, depth: 0.55 }, [0, 0, 0.10], m.metal);
    // Long barrel
    mkBox('vm-barrel', { width: 0.025, height: 0.025, depth: 0.55 }, [0, 0.005, 0.55], m.metal);
    // Scope
    mkBox('vm-scope', { width: 0.04, height: 0.06, depth: 0.18 }, [0, 0.07, 0.10], m.metal);
    mkBox('vm-scope-front', { width: 0.05, height: 0.07, depth: 0.04 }, [0, 0.07, 0.20], m.polymer);
    // Stock
    mkBox('vm-stock', { width: 0.06, height: 0.06, depth: 0.30 }, [0, -0.04, -0.20], m.wood);
    // Grip
    mkBox('vm-grip', { width: 0.04, height: 0.08, depth: 0.04 }, [0, -0.06, -0.10], m.wood);
    muzzle.position.set(0, 0.005, 0.85);
  } else if (category === 'knife') {
    // Blade
    mkBox('vm-blade', { width: 0.02, height: 0.05, depth: 0.20 }, [0, 0, 0.10], m.metal);
    // Hilt
    mkBox('vm-hilt', { width: 0.025, height: 0.07, depth: 0.10 }, [0, -0.04, -0.05], m.wood);
    muzzle.position.set(0, 0, 0.20);
  } else if (category === 'grenade') {
    // Spherical body held forward in the throwing hand. A short pin
    // tab on top makes the silhouette read as a grenade rather than a
    // generic ball. Muzzle is in front of the hand so the throw origin
    // is sensible.
    const body = MeshBuilder.CreateSphere('vm-grenade-body', { diameter: 0.10, segments: 10 }, scene);
    body.position.set(0, -0.02, 0.10);
    body.material = m.metal;
    body.parent = root;
    body.isPickable = false;
    parts.push(body);
    mkBox('vm-grenade-pin', { width: 0.015, height: 0.025, depth: 0.015 }, [0, 0.04, 0.10], m.accent);
    muzzle.position.set(0, -0.02, 0.16);
  } else {
    // Default: simple box (e.g., C4 carry, smg, lmg)
    mkBox('vm-block', { width: 0.10, height: 0.10, depth: 0.20 }, [0, 0, 0.10], m.polymer);
    muzzle.position.set(0, 0, 0.15);
  }

  return {
    root,
    baseLocalPos: new Vector3(0.18, -0.18, 0.32),
    kickPos: new Vector3(),
    kickRot: new Vector3(),
    bobPhase: 0,
    muzzle,
    parts,
    category,
  };
}

void time;
