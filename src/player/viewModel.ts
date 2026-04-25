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

    const base = this.hand.position;
    base.x = 0.18 + bobX + this.smoothedKickX * 0.04;
    base.y = -0.18 + bobY + reloadOffsetY - this.smoothedKickY * 0.012;
    base.z = 0.32 - this.smoothedKickZ * 0.18;
    this.hand.rotation.x = this.smoothedRotX;
    this.hand.rotation.y = this.smoothedRotY;
    this.hand.rotation.z = reloadRotZ;
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
