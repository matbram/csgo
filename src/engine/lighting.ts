/** Sun + ambient + sky. The sky is a Babylon `SkyMaterial`-driven sphere
 *  built procedurally — no HDRI download. Once created, we can also
 *  capture the sky into an environment texture for IBL on PBR materials,
 *  but for M1 we use a simple `HemisphericLight` for ambient. */

// Babylon's à-la-carte build needs side-effect imports for components that
// register themselves with the scene at construction time. Without these,
// shadow rendering throws "ShadowGeneratorSceneComponent needs to be imported".
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { SkyMaterial } from '@babylonjs/materials/sky/skyMaterial';
import { getScene } from './scene';

export interface LightingHandles {
  sun: DirectionalLight;
  ambient: HemisphericLight;
  shadow: CascadedShadowGenerator | ShadowGenerator;
}

let lighting: LightingHandles | null = null;

export function createLighting(): LightingHandles {
  if (lighting) return lighting;
  const scene = getScene();

  // Sun direction: midday Dust 2 — overhead and slightly south-west
  // with a near-neutral white cast. Reference shots read almost
  // neutral, with a cool-blue sky fill driving the shadowed wall faces.
  const sunDir = new Vector3(-0.30, -0.85, -0.30).normalize();
  const sun = new DirectionalLight('sun', sunDir, scene);
  sun.intensity = 3.6;
  sun.diffuse = new Color3(1.0, 0.97, 0.92);
  sun.specular = new Color3(1.0, 0.97, 0.92);
  // Tighten the shadow frustum to the play area so shadow resolution is high.
  sun.shadowMinZ = 0.5;
  sun.shadowMaxZ = 220;

  const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
  // Brighter cool-sky fill so shadowed wall faces don't drop into golden
  // gloom — Dust 2 shadows read pale blue-grey, not amber.
  ambient.intensity = 0.65;
  ambient.diffuse = new Color3(0.78, 0.85, 1.0);          // cool sky fill
  ambient.groundColor = new Color3(0.55, 0.46, 0.32);     // sandy bounce

  // Cascaded shadow map (3 cascades). On M1 we keep textures modest.
  let shadow: CascadedShadowGenerator | ShadowGenerator;
  try {
    const csm = new CascadedShadowGenerator(2048, sun);
    csm.numCascades = 3;
    csm.lambda = 0.9;
    csm.cascadeBlendPercentage = 0.05;
    csm.stabilizeCascades = true;
    csm.shadowMaxZ = 220;
    csm.depthClamp = true;
    csm.autoCalcDepthBounds = true;
    csm.usePercentageCloserFiltering = true;
    csm.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    csm.bias = 0.0008;
    csm.normalBias = 0.02;
    shadow = csm;
  } catch {
    // Fallback to single shadow map if CSM is unavailable on this driver.
    const sg = new ShadowGenerator(2048, sun);
    sg.usePercentageCloserFiltering = true;
    sg.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    sg.bias = 0.0008;
    sg.normalBias = 0.02;
    shadow = sg;
  }

  // Sky dome — a clear, slightly hazy desert blue. Lower turbidity and
  // a higher rayleigh than the previous golden-hour preset push the
  // tone away from amber and toward the bright sky in the reference.
  const skyMat = new SkyMaterial('sky-material', scene);
  skyMat.backFaceCulling = false;
  skyMat.luminance = 1.05;
  skyMat.turbidity = 3.0;
  skyMat.rayleigh = 2.2;
  skyMat.mieCoefficient = 0.004;
  skyMat.mieDirectionalG = 0.82;
  // Sun position the sky uses (opposite of light direction).
  skyMat.useSunPosition = true;
  skyMat.sunPosition = sunDir.scale(-1);
  const skyMesh = MeshBuilder.CreateBox('sky', { size: 2000 }, scene);
  skyMesh.material = skyMat;
  skyMesh.infiniteDistance = true;
  skyMesh.isPickable = false;
  skyMesh.receiveShadows = false;
  skyMesh.applyFog = false;

  // Subtle distance haze. Lighter, slightly cooler than before so the
  // horizon reads as a hot summer sky, not a sandstorm.
  scene.fogMode = 2; // FOGMODE_EXP2
  scene.fogDensity = 0.0018;
  scene.fogColor = new Color3(0.85, 0.83, 0.78);

  lighting = { sun, ambient, shadow };
  return lighting;
}

export function getLighting(): LightingHandles {
  if (!lighting) throw new Error('Lighting not initialized — call createLighting() first');
  return lighting;
}

/** Add a mesh as a shadow caster. Receivers are tagged via `mesh.receiveShadows = true`
 *  by the map authoring code. */
export function addShadowCaster(mesh: import('@babylonjs/core/Meshes/abstractMesh').AbstractMesh): void {
  const { shadow } = getLighting();
  shadow.addShadowCaster(mesh);
}
