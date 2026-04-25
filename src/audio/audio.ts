/** Web Audio engine + procedural gunshot SFX. The audio context is created
 *  lazily on first user gesture (browsers require a user gesture before
 *  audio can play). The `installAudio()` function wires up event listeners
 *  for combat events.
 *
 *  Sounds are synthesized in a one-shot OfflineAudioContext at boot and
 *  cached as AudioBuffers, then played through the regular AudioContext.
 *  This keeps fire-time cheap (just buffer source). */

import { events } from '../engine/events';
import type { WeaponId } from '../weapons/definitions';

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
const buffers = new Map<string, AudioBuffer>();
let installed = false;

export function ensureAudioContext(): AudioContext | null {
  if (ctx) {
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    return ctx;
  }
  try {
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctor) return null;
    ctx = new Ctor();
  } catch {
    return null;
  }
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.55;
  masterGain.connect(ctx.destination);
  // Pre-generate all gunshot sounds once the context exists.
  generateAllSounds();
  return ctx;
}

function generateAllSounds(): void {
  if (!ctx) return;
  const ids: WeaponId[] = ['ak47', 'm4a4', 'usp_s', 'glock18', 'awp', 'knife'];
  for (const id of ids) {
    const fire = synthesizeGunshot(id);
    if (fire) buffers.set(`${id}_fire`, fire);
  }
  const click = synthesizeClick();
  if (click) buffers.set('dryfire', click);
  const reload = synthesizeReload();
  if (reload) buffers.set('reload', reload);
  const knife = synthesizeKnife();
  if (knife) buffers.set('knife_swing', knife);
}

function synthesizeGunshot(id: WeaponId): AudioBuffer | null {
  if (!ctx) return null;
  const sampleRate = ctx.sampleRate;
  const duration = id === 'awp' ? 0.50 : id === 'ak47' ? 0.30 : id === 'm4a4' ? 0.27 : 0.20;
  const length = Math.floor(sampleRate * duration);
  const buf = ctx.createBuffer(2, length, sampleRate);
  const params = paramsFor(id);

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let lpState = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      // Initial impulse (white noise burst with rapid decay).
      const env = Math.exp(-t * params.decay);
      // Tail noise (lower amplitude, slower decay).
      const tailEnv = Math.exp(-t * params.tailDecay) * params.tailAmp;
      const noise = (Math.random() * 2 - 1);
      let s = noise * (env + tailEnv);
      // Body resonance (sine at low freq + cosine at higher) for "thump".
      s += Math.sin(2 * Math.PI * params.bodyHz * t) * env * 0.5;
      s += Math.sin(2 * Math.PI * params.bodyHz * 2 * t) * env * 0.3;
      // One-pole lowpass for warmth (channel-dependent for stereo width).
      const cutoff = params.cutoff * (ch === 0 ? 1.0 : 1.05);
      const a = 1 - Math.exp(-2 * Math.PI * cutoff / sampleRate);
      lpState += a * (s - lpState);
      data[i] = clip(lpState * params.gain);
    }
  }
  return buf;
}

interface ShotParams {
  decay: number; tailDecay: number; tailAmp: number;
  bodyHz: number; cutoff: number; gain: number;
}

function paramsFor(id: WeaponId): ShotParams {
  switch (id) {
    case 'ak47':    return { decay: 22, tailDecay: 6,  tailAmp: 0.45, bodyHz: 70,  cutoff: 1900, gain: 1.4 };
    case 'm4a4':    return { decay: 25, tailDecay: 7,  tailAmp: 0.40, bodyHz: 90,  cutoff: 2300, gain: 1.3 };
    case 'usp_s':   return { decay: 30, tailDecay: 14, tailAmp: 0.20, bodyHz: 110, cutoff: 1700, gain: 0.7 };
    case 'glock18': return { decay: 32, tailDecay: 16, tailAmp: 0.18, bodyHz: 130, cutoff: 1900, gain: 0.7 };
    case 'awp':     return { decay: 8,  tailDecay: 3,  tailAmp: 0.55, bodyHz: 55,  cutoff: 1500, gain: 1.6 };
    default:        return { decay: 28, tailDecay: 10, tailAmp: 0.30, bodyHz: 100, cutoff: 2000, gain: 1.0 };
  }
}

function synthesizeClick(): AudioBuffer | null {
  if (!ctx) return null;
  const length = Math.floor(ctx.sampleRate * 0.06);
  const buf = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / ctx.sampleRate;
    data[i] = clip((Math.random() * 2 - 1) * Math.exp(-t * 80) * 0.4);
  }
  return buf;
}

function synthesizeReload(): AudioBuffer | null {
  if (!ctx) return null;
  // Three-part reload: clip out, click, clip in.
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.9);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    let s = 0;
    if (t < 0.06) s = (Math.random() * 2 - 1) * Math.exp(-(t) * 60) * 0.5;
    else if (t > 0.40 && t < 0.46) s = (Math.random() * 2 - 1) * Math.exp(-(t - 0.40) * 90) * 0.45;
    else if (t > 0.78 && t < 0.86) s = (Math.random() * 2 - 1) * Math.exp(-(t - 0.78) * 70) * 0.6;
    data[i] = clip(s);
  }
  return buf;
}

function synthesizeKnife(): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.15);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 30);
    data[i] = clip((Math.random() * 2 - 1) * env * 0.4 + Math.sin(2 * Math.PI * 600 * t) * env * 0.2);
  }
  return buf;
}

function clip(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

export function playSound(id: string, opts?: { volume?: number; pitch?: number }): void {
  const c = ensureAudioContext();
  if (!c || !masterGain) return;
  const buf = buffers.get(id);
  if (!buf) return;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = opts?.pitch ?? 1;
  const g = c.createGain();
  g.gain.value = opts?.volume ?? 1;
  src.connect(g).connect(masterGain);
  src.start();
}

export function playSoundAt(id: string, x: number, y: number, z: number, opts?: { volume?: number; pitch?: number; maxDistance?: number }): void {
  const c = ensureAudioContext();
  if (!c || !masterGain) return;
  const buf = buffers.get(id);
  if (!buf) return;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = opts?.pitch ?? 1;
  const g = c.createGain();
  g.gain.value = opts?.volume ?? 1;
  const panner = c.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 3;
  panner.maxDistance = opts?.maxDistance ?? 200;
  panner.rolloffFactor = 1.2;
  panner.positionX.setValueAtTime(x, c.currentTime);
  panner.positionY.setValueAtTime(y, c.currentTime);
  panner.positionZ.setValueAtTime(z, c.currentTime);
  src.connect(g).connect(panner).connect(masterGain);
  src.start();
}

export function setListenerPose(
  x: number, y: number, z: number,
  fx: number, fy: number, fz: number,
  ux: number, uy: number, uz: number,
): void {
  const c = ctx;
  if (!c) return;
  const L = c.listener;
  if (L.positionX) {
    L.positionX.setValueAtTime(x, c.currentTime);
    L.positionY.setValueAtTime(y, c.currentTime);
    L.positionZ.setValueAtTime(z, c.currentTime);
    L.forwardX.setValueAtTime(fx, c.currentTime);
    L.forwardY.setValueAtTime(fy, c.currentTime);
    L.forwardZ.setValueAtTime(fz, c.currentTime);
    L.upX.setValueAtTime(ux, c.currentTime);
    L.upY.setValueAtTime(uy, c.currentTime);
    L.upZ.setValueAtTime(uz, c.currentTime);
  } else {
    // Older Safari fallback
    (L as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition?.(x, y, z);
    (L as unknown as { setOrientation: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void }).setOrientation?.(fx, fy, fz, ux, uy, uz);
  }
}

export function installAudio(): void {
  if (installed) return;
  installed = true;

  events.on('combat:fire', ({ shooterId, weapon, ox, oy, oz }) => {
    const id = `${weapon}_fire`;
    if (shooterId === 'local') {
      playSound(id, { volume: 0.9 });
    } else {
      playSoundAt(id, ox, oy, oz, { volume: 1.0, maxDistance: 250 });
    }
  });

  events.on('combat:reload', ({ shooterId }) => {
    if (shooterId === 'local') {
      playSound('reload', { volume: 0.6 });
    }
  });
}
