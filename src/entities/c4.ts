/** C4 visual entity. Owns a small green box with an LED that blinks at
 *  a rate proportional to remaining time.
 *
 *  When `setBombState()` is called with phase==='planted' the entity is
 *  placed at the bomb position and beeps; otherwise it's hidden (the
 *  bomb is carried by a player and we don't render a separate world
 *  mesh for the carry — the model's view-model represents it in hand). */

import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { getScene } from '../engine/scene';
import { addShadowCaster } from '../engine/lighting';
import type { BombState } from '../match/bomb';
import { BOMB_TIMER_MS } from '../match/bomb';
import { playSoundAt } from '../audio/audio';

export class C4Entity {
  private readonly root: TransformNode;
  private readonly body: Mesh;
  private readonly led: Mesh;
  private readonly ledMat: StandardMaterial;
  private nextBeepMs = 0;
  private visible = false;

  constructor() {
    const scene = getScene();
    this.root = new TransformNode('c4-root', scene);

    this.body = MeshBuilder.CreateBox('c4-body', { width: 0.30, height: 0.18, depth: 0.20 }, scene);
    const bodyMat = new StandardMaterial('c4-body-mat', scene);
    bodyMat.diffuseColor = new Color3(0.12, 0.30, 0.16);
    bodyMat.specularColor = new Color3(0.05, 0.05, 0.05);
    this.body.material = bodyMat;
    this.body.parent = this.root;
    this.body.receiveShadows = true;
    addShadowCaster(this.body);

    this.led = MeshBuilder.CreateSphere('c4-led', { diameter: 0.04, segments: 6 }, scene);
    this.ledMat = new StandardMaterial('c4-led-mat', scene);
    this.ledMat.emissiveColor = new Color3(1.0, 0.1, 0.1);
    this.ledMat.diffuseColor = new Color3(0.1, 0, 0);
    this.ledMat.specularColor = new Color3(0, 0, 0);
    this.led.material = this.ledMat;
    this.led.position.set(0.05, 0.10, 0.10);
    this.led.parent = this.root;

    this.root.setEnabled(false);
  }

  /** Update from current bomb state. Called every render frame. */
  update(bomb: BombState | null, nowMs: number): void {
    if (!bomb || (bomb.phase !== 'planted' && bomb.phase !== 'defusing')) {
      if (this.visible) {
        this.root.setEnabled(false);
        this.visible = false;
      }
      return;
    }
    if (!bomb.pos) return;
    if (!this.visible) {
      this.root.setEnabled(true);
      this.visible = true;
    }
    this.root.position.set(bomb.pos.x, bomb.pos.y + 0.10, bomb.pos.z);

    const remaining = bomb.explodeAtMs - nowMs;
    const totalDuration = BOMB_TIMER_MS;
    const elapsedFrac = 1 - Math.max(0, Math.min(1, remaining / totalDuration));

    // Beep cadence accelerates from 1s → 0.07s as the timer counts down.
    const cadenceMs = Math.max(70, 1000 * Math.pow(1 - elapsedFrac, 2));
    if (nowMs >= this.nextBeepMs) {
      this.nextBeepMs = nowMs + cadenceMs;
      // Pulse the LED brightness on each beep.
      this.ledMat.emissiveColor.set(1.0, 0.2, 0.2);
      setTimeout(() => this.ledMat.emissiveColor.set(0.4, 0.05, 0.05), 60);
      playSoundAt('c4_beep', bomb.pos.x, bomb.pos.y + 0.20, bomb.pos.z, { volume: 0.55, maxDistance: 60 });
    }
  }

  dispose(): void {
    this.body.dispose();
    this.led.dispose();
    this.root.dispose();
  }
}
