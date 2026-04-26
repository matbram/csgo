/** Named PBR materials. Created lazily on first request and cached. All
 *  materials share the same texture set per name; UV scaling is per-mesh
 *  (set during geometry authoring so a 4×4m floor doesn't tile 1× — it
 *  should tile multiple times). */

import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { getScene } from '../engine/scene';
import { getMaterialTextures } from './proceduralTextures';

export type MaterialName =
  | 'sand_floor'
  | 'sand_wall'
  | 'wood'
  | 'metal'
  | 'concrete'
  | 'dark_stone'
  | 'brick'
  | 'blue_paint'
  | 'palm_leaf'
  | 'plaster_cream'
  | 'red_brick'
  | 'road_concrete'
  | 'curb_stone'
  | 'parapet';

const cache = new Map<MaterialName, PBRMaterial>();

export function getMaterial(name: MaterialName): PBRMaterial {
  const hit = cache.get(name);
  if (hit) return hit;
  const scene = getScene();
  const tex = getMaterialTextures(name);
  const mat = new PBRMaterial(`mat-${name}`, scene);
  mat.albedoTexture = tex.albedo;
  mat.bumpTexture = tex.normal;
  mat.useParallax = false;
  // The "roughness" texture has roughness packed identically into r/g/b.
  // PBRMaterial reads roughness from the green channel of metallicTexture
  // when this flag is set; metallic falls back to the scalar `metallic`.
  mat.metallicTexture = tex.roughness;
  mat.useRoughnessFromMetallicTextureGreen = true;
  mat.useRoughnessFromMetallicTextureAlpha = false;
  mat.useMetallnessFromMetallicTextureBlue = false;
  mat.metallic = name === 'metal' ? 0.7 : 0.0;
  // Scalar fallback when no texture present (won't be used here).
  mat.roughness = 0.85;
  mat.environmentIntensity = 0.65;
  mat.directIntensity = 1.0;
  mat.ambientColor = new Color3(0.6, 0.55, 0.45);
  mat.invertNormalMapX = false;
  mat.invertNormalMapY = false;
  mat.backFaceCulling = true;
  mat.maxSimultaneousLights = 4;
  cache.set(name, mat);
  return mat;
}
