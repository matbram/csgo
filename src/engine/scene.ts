/** The single Babylon `Scene`, plus our own engine boot. Ownership: `app.ts`
 *  owns `Engine` and `Scene` lifecycles; everything else borrows references
 *  through `getScene()`/`getEngine()`. */

import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Color4 } from '@babylonjs/core/Maths/math.color';

export interface EngineHandles {
  engine: Engine;
  scene: Scene;
  canvas: HTMLCanvasElement;
}

let handles: EngineHandles | null = null;

export function createEngine(canvas: HTMLCanvasElement): EngineHandles {
  if (handles) return handles;
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: false,
    stencil: true,
    powerPreference: 'high-performance',
    antialias: true,
    adaptToDeviceRatio: true,
    failIfMajorPerformanceCaveat: false,
  });
  // Cap DPR so retina screens don't tank the frame rate.
  const cap = 1.5;
  if (window.devicePixelRatio > cap) {
    engine.setHardwareScalingLevel(window.devicePixelRatio / cap);
  }

  const scene = new Scene(engine);
  // Distant haze color matches the warm sky so the horizon blends.
  scene.clearColor = new Color4(0.78, 0.69, 0.55, 1.0);
  // Useful global tweaks for an FPS:
  scene.collisionsEnabled = false;     // we do our own swept collision
  scene.useRightHandedSystem = false;  // Babylon default
  // Don't auto-clear depth — we want depth from the only camera.
  scene.autoClear = true;
  scene.autoClearDepthAndStencil = true;

  handles = { engine, scene, canvas };

  window.addEventListener('resize', () => {
    engine.resize();
  });

  return handles;
}

export function getEngine(): Engine {
  if (!handles) throw new Error('Engine not initialized — call createEngine() first');
  return handles.engine;
}

export function getScene(): Scene {
  if (!handles) throw new Error('Scene not initialized — call createEngine() first');
  return handles.scene;
}

export function getCanvas(): HTMLCanvasElement {
  if (!handles) throw new Error('Canvas not initialized — call createEngine() first');
  return handles.canvas;
}

export function disposeEngine(): void {
  if (!handles) return;
  handles.scene.dispose();
  handles.engine.dispose();
  handles = null;
}
