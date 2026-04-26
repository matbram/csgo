/** Spectator camera. When the local player dies the camera detaches
 *  from their body and rides the eye of an alive teammate, CS:GO style.
 *  LMB / RMB cycle through the candidate list; `next()` and `prev()`
 *  expose the same intent for the input layer.
 *
 *  We deliberately keep this stateless about respawn: when the player's
 *  character flips back to alive, the main loop simply stops calling
 *  applyToCamera() and lets fps.syncRender() reattach to the local
 *  controller as normal. */

import type { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import type { Bot } from '../entities/bot';

export class Spectator {
  /** Bots considered as spectate candidates this tick. Refreshed each
   *  frame so dead teammates fall out of the rotation automatically. */
  private candidates: Bot[] = [];
  private targetIdx = 0;
  /** Sticky id so the camera keeps following the same teammate until
   *  they die — otherwise candidate-list reshuffles would jump cameras
   *  every frame. */
  private currentTargetId: string | null = null;

  refresh(bots: ReadonlyArray<Bot>, team: 'T' | 'CT'): void {
    const alive = bots.filter(b => b.character.team === team && b.character.alive);
    this.candidates = alive;
    if (this.candidates.length === 0) {
      this.currentTargetId = null;
      this.targetIdx = 0;
      return;
    }
    // Try to keep the same target across refreshes.
    const sameIdx = this.candidates.findIndex(b => b.id === this.currentTargetId);
    if (sameIdx >= 0) {
      this.targetIdx = sameIdx;
    } else {
      this.targetIdx = Math.min(this.targetIdx, this.candidates.length - 1);
      this.currentTargetId = this.candidates[this.targetIdx]!.id;
    }
  }

  /** Cycle to the next candidate (LMB). */
  next(): void {
    if (this.candidates.length === 0) return;
    this.targetIdx = (this.targetIdx + 1) % this.candidates.length;
    this.currentTargetId = this.candidates[this.targetIdx]!.id;
  }

  /** Cycle to the previous candidate (RMB). */
  prev(): void {
    if (this.candidates.length === 0) return;
    this.targetIdx = (this.targetIdx - 1 + this.candidates.length) % this.candidates.length;
    this.currentTargetId = this.candidates[this.targetIdx]!.id;
  }

  currentTarget(): Bot | null {
    if (this.candidates.length === 0) return null;
    return this.candidates[this.targetIdx] ?? null;
  }

  /** Snap the camera to the current target's eye and aim along their
   *  yaw/pitch. Returns true when a target was found, false when there
   *  was nobody alive to spectate. */
  applyToCamera(camera: UniversalCamera): boolean {
    const t = this.currentTarget();
    if (!t) return false;
    const c = t.character;
    camera.position.set(c.pos.x, c.pos.y + c.currentEye, c.pos.z);
    camera.rotation.y = c.yaw;
    camera.rotation.x = -c.pitch;
    camera.rotation.z = 0;
    return true;
  }
}
