/** Web Audio engine + procedural gunshot SFX. The audio context is created
 *  lazily on first user gesture (browsers require a user gesture before
 *  audio can play). The `installAudio()` function wires up event listeners
 *  for combat events.
 *
 *  Sounds are synthesized in a one-shot OfflineAudioContext at boot and
 *  cached as AudioBuffers, then played through the regular AudioContext.
 *  This keeps fire-time cheap (just buffer source). */

import { events } from '../engine/events';
import { settings } from '../engine/settings';
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
  masterGain.gain.value = settings.get().masterVolume;
  masterGain.connect(ctx.destination);
  // Pre-generate all gunshot sounds once the context exists.
  generateAllSounds();
  // Subscribe AFTER first resolve so we don't fire setMasterVolume on a
  // null gain node. Fires once with current state too.
  settings.subscribe((s) => {
    if (masterGain) masterGain.gain.value = s.masterVolume;
  });
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
  const beep = synthesizeBomb();
  if (beep) buffers.set('c4_beep', beep);
  const plant = synthesizePlant();
  if (plant) buffers.set('c4_plant', plant);
  const defuse = synthesizeDefuse();
  if (defuse) buffers.set('c4_defuse', defuse);
  const explode = synthesizeExplode();
  if (explode) buffers.set('c4_explode', explode);
  const win = synthesizeWin();
  if (win) buffers.set('round_win', win);
  const lose = synthesizeLose();
  if (lose) buffers.set('round_lose', lose);
  // Grenade SFX. Detonations reuse the bomb explosion synth where the
  // physics fits (HE) and add a few cheap ones for the rest. Throw +
  // bounce are short transients.
  const throwS = synthesizeThrow();
  if (throwS) buffers.set('grenade_throw', throwS);
  const bounce = synthesizeBounce();
  if (bounce) buffers.set('grenade_bounce', bounce);
  const flashPop = synthesizeFlashPop();
  if (flashPop) buffers.set('grenade_flash', flashPop);
  const smokeHiss = synthesizeSmokeHiss();
  if (smokeHiss) buffers.set('grenade_smoke', smokeHiss);
  const fireWhoosh = synthesizeFireWhoosh();
  if (fireWhoosh) buffers.set('grenade_molotov', fireWhoosh);

  // Footstep variants — four per surface so consecutive steps don't
  // sound identical. Each one is a short scuff/thud rendered at boot.
  // Walking and crouching are intentionally not given a sound (the
  // emitter in main.ts doesn't fire those), so the synth set only
  // covers running steps.
  for (let i = 0; i < 4; i++) {
    const s = synthesizeFootstep('sand', i);
    if (s) buffers.set(`footstep_sand_${i}`, s);
    const c = synthesizeFootstep('concrete', i);
    if (c) buffers.set(`footstep_concrete_${i}`, c);
  }
}

/** A short, punchy run-step. Sand reads as a low rumble + a noisy
 *  scuff; concrete adds a sharper tonal click for the heel strike. */
function synthesizeFootstep(surface: 'sand' | 'concrete', variant: number): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.18);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  // Slight per-variant tuning so the four steps feel like a stride.
  const seed = (variant + 1) * 2.7;
  const baseFreq = surface === 'concrete' ? 80 + variant * 6 : 55 + variant * 4;
  const noiseCutoff = surface === 'concrete' ? 2400 : 1600;
  let lp = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    // Two-stage envelope: sharp impact, slower scrape decay.
    const impact = Math.exp(-t * 60);
    const scrape = Math.exp(-t * 9) - Math.exp(-t * 60);
    // Filtered noise — the body of the step.
    const noise = Math.random() * 2 - 1;
    const a = 1 - Math.exp(-2 * Math.PI * noiseCutoff / sr);
    lp += a * (noise - lp);
    const noiseBody = lp * (impact * 0.7 + Math.max(0, scrape) * 0.4);
    // Tonal heel hit — short low sine for sand, slightly brighter for concrete.
    const tone = Math.sin(2 * Math.PI * baseFreq * (1 + seed * 0.01) * t) * impact * 0.3;
    data[i] = clip((noiseBody + tone) * 0.55);
  }
  return buf;
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

function synthesizeBomb(): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.10);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 35);
    data[i] = clip(Math.sin(2 * Math.PI * 1500 * t) * env * 0.5);
  }
  return buf;
}

function synthesizePlant(): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.4);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 6);
    const tone = Math.sin(2 * Math.PI * 800 * t) * 0.3 + Math.sin(2 * Math.PI * 1200 * t) * 0.2;
    data[i] = clip(tone * env);
  }
  return buf;
}

function synthesizeDefuse(): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.6);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 4);
    const tone = Math.sin(2 * Math.PI * 700 * t) * 0.3 + Math.sin(2 * Math.PI * 1050 * t) * 0.2;
    data[i] = clip(tone * env);
  }
  return buf;
}

function synthesizeExplode(): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 1.6);
  const buf = ctx.createBuffer(2, length, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sr;
      const initialBoom = Math.exp(-t * 5);
      const tail = Math.exp(-t * 1.0) * 0.5;
      const noise = Math.random() * 2 - 1;
      let s = noise * (initialBoom + tail) * 1.0;
      s += Math.sin(2 * Math.PI * 60 * t) * initialBoom * 0.6;
      s += Math.sin(2 * Math.PI * 35 * t) * initialBoom * 0.8;
      const cutoff = 1200;
      const a = 1 - Math.exp(-2 * Math.PI * cutoff / sr);
      lp += a * (s - lp);
      data[i] = clip(lp * 1.5);
    }
  }
  return buf;
}

function synthesizeThrow(): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.18);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 18);
    // Filtered noise + low rumble — the swish + the shoulder roll.
    const noise = (Math.random() * 2 - 1) * env * 0.45;
    const tone = Math.sin(2 * Math.PI * 200 * t) * env * 0.15;
    data[i] = clip(noise + tone);
  }
  return buf;
}

function synthesizeBounce(): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.10);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 60);
    const tap = Math.sin(2 * Math.PI * 320 * t) * env * 0.55;
    const click = (Math.random() * 2 - 1) * Math.exp(-t * 200) * 0.35;
    data[i] = clip(tap + click);
  }
  return buf;
}

function synthesizeFlashPop(): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.5);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 9);
    const burst = (Math.random() * 2 - 1) * env;
    const ring = Math.sin(2 * Math.PI * 1200 * t) * Math.exp(-t * 4) * 0.35;
    data[i] = clip(burst * 0.9 + ring);
  }
  return buf;
}

function synthesizeSmokeHiss(): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 1.4);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    // Long exhale that ramps in then fades out.
    const env = Math.min(1, t * 6) * Math.exp(-t * 1.2);
    const noise = Math.random() * 2 - 1;
    // Lowpass for the airy "hiss" character.
    const a = 1 - Math.exp(-2 * Math.PI * 1800 / sr);
    lp += a * (noise - lp);
    data[i] = clip(lp * env * 0.65);
  }
  return buf;
}

function synthesizeFireWhoosh(): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.9);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 3) + 0.15;
    const noise = (Math.random() * 2 - 1);
    const a = 1 - Math.exp(-2 * Math.PI * 900 / sr);
    lp += a * (noise - lp);
    const lowRumble = Math.sin(2 * Math.PI * 80 * t) * Math.exp(-t * 5) * 0.35;
    data[i] = clip(lp * env * 0.6 + lowRumble);
  }
  return buf;
}

function synthesizeWin(): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.6);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 2);
    const f = 440 + 120 * t;
    data[i] = clip(Math.sin(2 * Math.PI * f * t) * env * 0.4);
  }
  return buf;
}

function synthesizeLose(): AudioBuffer | null {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * 0.7);
  const buf = ctx.createBuffer(1, length, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 2);
    const f = 280 - 60 * t;
    data[i] = clip(Math.sin(2 * Math.PI * f * t) * env * 0.4);
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
    // The knife uses a swing whoosh, not a gunshot. Other weapons use the
    // synthesized `<id>_fire` buffer keyed off the WeaponDef.
    const id = weapon === 'knife' ? 'knife_swing' : `${weapon}_fire`;
    if (shooterId === 'local') {
      playSound(id, { volume: 0.9 });
    } else {
      playSoundAt(id, ox, oy, oz, { volume: 1.0, maxDistance: 250 });
    }
  });

  // Footsteps. Local player gets non-positional playback (their own
  // steps shouldn't pan in 3D — jarring); everyone else's footsteps
  // are 3D so the player can locate enemies behind walls. Variant
  // index cycles per character so consecutive steps feel like a
  // stride rather than four identical thuds.
  const stepVariant = new Map<string, number>();
  events.on('character:footstep', ({ id, x, y, z, surface }) => {
    const family = surface === 'concrete' || surface === 'stone' || surface === 'metal'
      ? 'concrete'
      : 'sand';
    const next = ((stepVariant.get(id) ?? -1) + 1) & 3;
    stepVariant.set(id, next);
    const soundId = `footstep_${family}_${next}`;
    if (id === 'local') {
      playSound(soundId, { volume: 0.55 });
    } else {
      // Range tuned so a sprint at 6.5 m/s is audible at ~30 m
      // (you'll hear them before they round the corner) and inaudible
      // past 40 m. Lower volume than gunshots so they don't dominate.
      playSoundAt(soundId, x, y, z, { volume: 0.85, maxDistance: 40 });
    }
  });

  events.on('combat:reload', ({ shooterId }) => {
    if (shooterId === 'local') {
      playSound('reload', { volume: 0.6 });
    }
  });

  events.on('match:bombPlanted', ({ x, y, z }) => {
    playSoundAt('c4_plant', x, y, z, { volume: 0.9, maxDistance: 200 });
  });
  events.on('match:bombDefused', ({ x, y, z }) => {
    playSoundAt('c4_defuse', x, y, z, { volume: 0.9, maxDistance: 200 });
  });
  events.on('match:bombExploded', ({ x, y, z }) => {
    playSoundAt('c4_explode', x, y, z, { volume: 1.5, maxDistance: 300 });
  });
  events.on('match:roundEnd', ({ playerWon }) => {
    playSound(playerWon ? 'round_win' : 'round_lose', { volume: 0.5 });
  });

  // Grenade SFX. Throw + bounce + per-kind detonation. Decoys aren't
  // audible per detonation — instead the decoy entity emits a fake
  // 'combat:fire' so the existing gunshot listener handles it.
  events.on('grenade:thrown', ({ throwerId, ox, oy, oz }) => {
    if (throwerId === 'local') {
      playSound('grenade_throw', { volume: 0.6 });
    } else {
      playSoundAt('grenade_throw', ox, oy, oz, { volume: 0.7, maxDistance: 30 });
    }
  });
  events.on('grenade:bounce', ({ x, y, z }) => {
    playSoundAt('grenade_bounce', x, y, z, { volume: 0.6, maxDistance: 25 });
  });
  events.on('grenade:detonated', ({ kind, x, y, z }) => {
    switch (kind) {
      case 'he':        playSoundAt('c4_explode',   x, y, z, { volume: 1.2, maxDistance: 250 }); break;
      case 'flashbang': playSoundAt('grenade_flash', x, y, z, { volume: 1.0, maxDistance: 200 }); break;
      case 'smoke':     playSoundAt('grenade_smoke', x, y, z, { volume: 0.7, maxDistance: 60 });  break;
      case 'molotov':   playSoundAt('grenade_molotov', x, y, z, { volume: 0.8, maxDistance: 80 }); break;
    }
  });
}
