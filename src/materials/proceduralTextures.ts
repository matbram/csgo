/** Procedurally generated tileable textures using a pixel array, packed
 *  into a `RawTexture`. We generate once at boot and cache. No external
 *  texture downloads. */

import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Constants } from '@babylonjs/core/Engines/constants';
import { getScene } from '../engine/scene';

const TEX_SIZE = 256;

interface CachedTextures {
  albedo: RawTexture;
  normal: RawTexture;
  roughness: RawTexture;
}

const cache = new Map<string, CachedTextures>();

/** Deterministic value-noise (tileable) */
function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffffff) / 0xffffff;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, freq: number, seed: number): number {
  const fx = (x * freq) % freq;
  const fy = (y * freq) % freq;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = (x0 + 1) % freq;
  const y1 = (y0 + 1) % freq;
  const tx = smooth(fx - x0);
  const ty = smooth(fy - y0);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const ab = a + (b - a) * tx;
  const cd = c + (d - c) * tx;
  return ab + (cd - ab) * ty;
}

function fbm(x: number, y: number, seed: number, octaves: number, baseFreq: number): number {
  let total = 0;
  let amp = 1;
  let max = 0;
  let freq = baseFreq;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise(x, y, freq, seed + i * 17) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total / max;
}

interface MaterialColors {
  base: [number, number, number];
  vary: [number, number, number]; // additive variance
}

const PALETTES: Record<string, MaterialColors> = {
  sand_floor: { base: [0.78, 0.66, 0.45], vary: [0.12, 0.10, 0.06] },
  sand_wall:  { base: [0.82, 0.71, 0.55], vary: [0.10, 0.08, 0.05] },
  wood:       { base: [0.42, 0.27, 0.16], vary: [0.18, 0.12, 0.08] },
  metal:      { base: [0.42, 0.40, 0.38], vary: [0.10, 0.10, 0.10] },
  concrete:   { base: [0.62, 0.60, 0.56], vary: [0.10, 0.10, 0.10] },
  dark_stone: { base: [0.30, 0.27, 0.24], vary: [0.12, 0.10, 0.08] },
  brick:      { base: [0.56, 0.34, 0.26], vary: [0.10, 0.06, 0.04] },
  // The iconic A-site blue car. Slightly desaturated cyan with a hint
  // of variance to look painted, not flat.
  blue_paint: { base: [0.18, 0.34, 0.55], vary: [0.04, 0.04, 0.06] },
  // Palm-frond green; coarser variance fakes leaf clusters.
  palm_leaf:  { base: [0.30, 0.46, 0.18], vary: [0.10, 0.12, 0.08] },
};

function makeAlbedo(name: keyof typeof PALETTES, seed: number): Uint8Array {
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  const pal = PALETTES[name];
  if (!pal) throw new Error(`Unknown material: ${name}`);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const u = x / TEX_SIZE;
      const v = y / TEX_SIZE;
      const n = fbm(u, v, seed, 5, 8);
      const variance = (n - 0.5) * 2;
      const r = pal.base[0] + variance * pal.vary[0];
      const g = pal.base[1] + variance * pal.vary[1];
      const b = pal.base[2] + variance * pal.vary[2];
      const i = (y * TEX_SIZE + x) * 4;
      data[i + 0] = Math.max(0, Math.min(255, Math.round(r * 255)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      data[i + 3] = 255;
    }
  }
  // Material-specific overlay details
  if (name === 'wood') overlayWoodGrain(data, seed);
  if (name === 'brick') overlayBrick(data, seed);
  if (name === 'sand_floor') overlaySandSpeckle(data, seed);
  return data;
}

function overlayWoodGrain(data: Uint8Array, seed: number): void {
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const grain = fbm(x / TEX_SIZE, y / TEX_SIZE * 0.2, seed + 99, 4, 32);
      const dark = grain < 0.42 ? -25 : grain > 0.58 ? 12 : 0;
      const i = (y * TEX_SIZE + x) * 4;
      data[i + 0] = clampByte((data[i + 0] ?? 0) + dark);
      data[i + 1] = clampByte((data[i + 1] ?? 0) + dark * 0.7);
      data[i + 2] = clampByte((data[i + 2] ?? 0) + dark * 0.4);
    }
  }
}

function overlayBrick(data: Uint8Array, seed: number): void {
  const rows = 8, cols = 4;
  const bw = TEX_SIZE / cols;
  const bh = TEX_SIZE / rows;
  for (let y = 0; y < TEX_SIZE; y++) {
    const row = Math.floor(y / bh);
    const offset = (row & 1) ? bw / 2 : 0;
    for (let x = 0; x < TEX_SIZE; x++) {
      const localX = (x + offset) % bw;
      const localY = y % bh;
      const onMortar = localX < 2 || localX > bw - 2 || localY < 2 || localY > bh - 2;
      const i = (y * TEX_SIZE + x) * 4;
      if (onMortar) {
        data[i + 0] = clampByte(((data[i + 0] ?? 0) * 0.55 + 100));
        data[i + 1] = clampByte(((data[i + 1] ?? 0) * 0.55 + 95));
        data[i + 2] = clampByte(((data[i + 2] ?? 0) * 0.55 + 88));
      }
    }
  }
  // Eat the unused arg lint
  void seed;
}

function overlaySandSpeckle(data: Uint8Array, seed: number): void {
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const speckle = hash2(x, y, seed + 7);
      if (speckle > 0.985) {
        const i = (y * TEX_SIZE + x) * 4;
        data[i + 0] = clampByte((data[i + 0] ?? 0) - 25);
        data[i + 1] = clampByte((data[i + 1] ?? 0) - 25);
        data[i + 2] = clampByte((data[i + 2] ?? 0) - 20);
      }
    }
  }
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/** Bump-mapped normal generated from the albedo's luminance derivative. */
function makeNormal(albedo: Uint8Array, strength = 1.0): Uint8Array {
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  const lum = (i: number) =>
    (0.299 * (albedo[i] ?? 0) + 0.587 * (albedo[i + 1] ?? 0) + 0.114 * (albedo[i + 2] ?? 0)) / 255;
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const ix = (y * TEX_SIZE + ((x + 1) % TEX_SIZE)) * 4;
      const ix0 = (y * TEX_SIZE + ((x - 1 + TEX_SIZE) % TEX_SIZE)) * 4;
      const iy = (((y + 1) % TEX_SIZE) * TEX_SIZE + x) * 4;
      const iy0 = (((y - 1 + TEX_SIZE) % TEX_SIZE) * TEX_SIZE + x) * 4;
      const dx = (lum(ix) - lum(ix0)) * strength;
      const dy = (lum(iy) - lum(iy0)) * strength;
      const nx = -dx;
      const ny = -dy;
      const nz = 1.0;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * TEX_SIZE + x) * 4;
      data[i + 0] = Math.round((nx / len * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  return data;
}

/** Roughness in red channel; we vary it with low-freq noise so surfaces
 *  aren't uniformly rough. */
function makeRoughness(seed: number, baseRough: number, roughVar: number): Uint8Array {
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const n = fbm(x / TEX_SIZE, y / TEX_SIZE, seed + 31, 3, 6);
      const r = baseRough + (n - 0.5) * 2 * roughVar;
      const v = clampByte(Math.round(Math.max(0, Math.min(1, r)) * 255));
      const i = (y * TEX_SIZE + x) * 4;
      data[i + 0] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

export interface MaterialTextureSet {
  albedo: RawTexture;
  normal: RawTexture;
  roughness: RawTexture;
}

const ROUGH: Record<string, { base: number; var: number; normalStrength: number }> = {
  sand_floor: { base: 0.92, var: 0.05, normalStrength: 1.5 },
  sand_wall:  { base: 0.88, var: 0.06, normalStrength: 1.8 },
  wood:       { base: 0.78, var: 0.15, normalStrength: 2.0 },
  metal:      { base: 0.42, var: 0.20, normalStrength: 1.2 },
  concrete:   { base: 0.86, var: 0.10, normalStrength: 1.6 },
  dark_stone: { base: 0.84, var: 0.08, normalStrength: 1.6 },
  brick:      { base: 0.85, var: 0.10, normalStrength: 2.4 },
};

export function getMaterialTextures(name: string): MaterialTextureSet {
  const cached = cache.get(name);
  if (cached) return cached;
  const scene = getScene();
  if (!(name in PALETTES)) throw new Error(`Unknown material name: ${name}`);
  const seed = hash2Seed(name);
  const albedoData = makeAlbedo(name as keyof typeof PALETTES, seed);
  const params = ROUGH[name] ?? ROUGH.sand_wall!;
  const normalData = makeNormal(albedoData, params.normalStrength);
  const roughnessData = makeRoughness(seed, params.base, params.var);

  const albedo = RawTexture.CreateRGBATexture(
    albedoData, TEX_SIZE, TEX_SIZE, scene, true, false,
    Engine.TEXTURE_TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
  );
  albedo.name = `${name}-albedo`;
  albedo.wrapU = albedo.wrapV = 1; // CLAMP=0, WRAP=1, MIRROR=2
  albedo.anisotropicFilteringLevel = 8;

  const normal = RawTexture.CreateRGBATexture(
    normalData, TEX_SIZE, TEX_SIZE, scene, true, false,
    Engine.TEXTURE_TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
  );
  normal.name = `${name}-normal`;
  normal.wrapU = normal.wrapV = 1;
  normal.anisotropicFilteringLevel = 8;

  const roughness = RawTexture.CreateRGBATexture(
    roughnessData, TEX_SIZE, TEX_SIZE, scene, true, false,
    Engine.TEXTURE_TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE,
  );
  roughness.name = `${name}-roughness`;
  roughness.wrapU = roughness.wrapV = 1;
  roughness.anisotropicFilteringLevel = 4;

  const set: CachedTextures = { albedo, normal, roughness };
  cache.set(name, set);
  return set;
}

function hash2Seed(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 100000;
}
