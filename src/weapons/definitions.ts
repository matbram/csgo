/** Weapon definitions. Pure data, no behavior. The combat system reads
 *  these at fire time. Numbers are calibrated to feel close to CS:GO; we
 *  intentionally do not aim for byte-identical replication.
 *
 *  All distances are meters. Damage is per-shot to chest with no armor at
 *  point-blank; the combat system applies multipliers for hitbox, armor,
 *  and falloff. */

export type WeaponId =
  | 'ak47' | 'm4a4' | 'usp_s' | 'glock18' | 'awp' | 'knife' | 'c4'
  | 'he' | 'flashbang' | 'smoke' | 'molotov' | 'decoy';

export type WeaponSlot = 'primary' | 'secondary' | 'knife' | 'grenade' | 'c4';
export type WeaponCategory = 'rifle' | 'smg' | 'pistol' | 'sniper' | 'shotgun' | 'lmg' | 'knife' | 'bomb' | 'grenade';
export type FireMode = 'auto' | 'semi' | 'burst' | 'bolt' | 'melee' | 'planted' | 'thrown';
export type WeaponTeam = 'T' | 'CT' | 'both';

export interface WeaponDef {
  id: WeaponId;
  displayName: string;
  slot: WeaponSlot;
  category: WeaponCategory;
  team: WeaponTeam;
  cost: number;
  fireMode: FireMode;
  /** Rounds per minute for auto/semi; for bolt, the inverse of bolt cycle. */
  rpm: number;
  magazine: number;
  reserve: number;
  reloadMs: number;
  deployMs: number;
  /** Base damage to chest, no armor, point blank. */
  baseDamage: number;
  /** Penetration factor 0..1 — fraction of damage retained through armor. */
  armorPenetration: number;
  /** Distance falloff curve: damage scale = (1 - t/falloffRange) clamped 0..1
   *  at distances beyond falloffStart. */
  falloffStartM: number;
  falloffRangeM: number;
  /** Inaccuracy parameters — see combat/inaccuracy.ts */
  baseInaccuracyDeg: number;
  movingInaccuracyMul: number;
  jumpingInaccuracyMul: number;
  crouchInaccuracyMul: number;
  /** Per-shot recoil decay half-life (ms). */
  recoilDecayMs: number;
  /** Spray pattern — visual + aim offsets in degrees per consecutive shot.
   *  Index 0 is shot #1 (no recoil). After the array, additional shots
   *  use the last entry plus randomized scatter. */
  sprayPattern: ReadonlyArray<readonly [xDeg: number, yDeg: number]>;
  /** Camera kick per shot (degrees). Visual; does not influence aim
   *  beyond what spray already does. */
  cameraKickDeg: { x: number; y: number };
  /** Movement speed scale (1.0 = base run). */
  moveSpeedScale: number;
  /** Per-kill reward in dollars. */
  killReward: number;
  /** Sound IDs (used by audio module). */
  fireSound: string;
  reloadSound: string;
  /** Number of scope zoom levels (0 = no scope). For the AWP this is 2:
   *  one mid-zoom and one tight zoom, cycling 0→1→2→0 on RMB. */
  scopeLevels?: number;
  /** Camera vertical FOV (degrees) per scope level. Index 0 corresponds
   *  to scopeLevel=1, index 1 to scopeLevel=2, etc. Required when
   *  `scopeLevels > 0`. */
  scopeFovDeg?: ReadonlyArray<number>;
  /** Inaccuracy multiplier while scoped (any level). 0..1. */
  scopedInaccuracyMul?: number;
  /** Movement speed scale while scoped (any level). Replaces moveSpeedScale. */
  scopedMoveSpeedScale?: number;
  /** How the scope behaves visually + on fire.
   *   - 'sniper' (AWP-style): heavy black-bar overlay; firing drops scope.
   *   - 'ads'    (rifle/pistol-style): subtle FOV change, no overlay,
   *     scope persists across shots so the player can keep aiming down sights.
   *  Defaults to 'sniper' when omitted, for backward compat with the AWP. */
  scopeStyle?: 'sniper' | 'ads';
  /** Optional alternate fire (RMB) for melee weapons: a heavier, slower
   *  attack. The base attack stays on LMB and uses the top-level rpm /
   *  baseDamage / falloff fields. */
  secondaryAttack?: {
    /** Damage multiplier applied on top of baseDamage. */
    damageMul: number;
    /** Rate cap for the secondary attack (rounds per minute). */
    rpm: number;
    /** Hint for the view model — selects the right animation curve. */
    animation: 'stab';
  };
}

/** AK-47 spray pattern (degrees). Approximation of the real pattern:
 *  bullets 1-2 are accurate, then sharp upward through ~bullet 7,
 *  then drift left, then right. */
const AK_SPRAY: Array<[number, number]> = [
  [ 0.0,  0.0],
  [ 0.05, 0.5],
  [-0.10, 1.6],
  [-0.10, 2.7],
  [ 0.20, 3.6],
  [ 0.30, 4.4],
  [ 0.50, 5.0],
  [ 0.70, 5.4],
  [ 0.50, 5.6],
  [ 0.10, 5.6],
  [-0.50, 5.6],
  [-1.00, 5.6],
  [-1.40, 5.6],
  [-1.30, 5.6],
  [-0.80, 5.6],
  [-0.20, 5.6],
  [ 0.40, 5.6],
  [ 0.90, 5.6],
  [ 1.30, 5.6],
  [ 1.50, 5.6],
  [ 1.40, 5.6],
  [ 1.10, 5.6],
  [ 0.70, 5.6],
  [ 0.20, 5.6],
  [-0.30, 5.6],
  [-0.70, 5.6],
  [-0.90, 5.6],
  [-0.90, 5.6],
  [-0.70, 5.6],
  [-0.40, 5.6],
];

/** M4A4 spray pattern (degrees). Initial up-right, then arcs left,
 *  then back right. */
const M4_SPRAY: Array<[number, number]> = [
  [ 0.0,  0.0],
  [ 0.10, 0.5],
  [ 0.20, 1.2],
  [ 0.40, 2.0],
  [ 0.55, 2.7],
  [ 0.70, 3.3],
  [ 0.70, 3.8],
  [ 0.50, 4.1],
  [ 0.10, 4.3],
  [-0.30, 4.4],
  [-0.70, 4.4],
  [-1.10, 4.4],
  [-1.40, 4.4],
  [-1.50, 4.4],
  [-1.30, 4.4],
  [-0.90, 4.4],
  [-0.30, 4.4],
  [ 0.30, 4.4],
  [ 0.80, 4.4],
  [ 1.20, 4.4],
  [ 1.40, 4.4],
  [ 1.40, 4.4],
  [ 1.20, 4.4],
  [ 0.80, 4.4],
  [ 0.30, 4.4],
  [-0.20, 4.4],
  [-0.60, 4.4],
  [-0.80, 4.4],
  [-0.80, 4.4],
  [-0.60, 4.4],
];

/** Pistol spray — light, mostly first-shot accurate. */
const PISTOL_SPRAY: Array<[number, number]> = [
  [0.0, 0.0],
  [0.0, 0.5],
  [0.0, 1.0],
  [0.0, 1.4],
  [0.0, 1.7],
  [0.0, 2.0],
  [0.0, 2.2],
  [0.0, 2.4],
];

/** Bolt-action sniper — no recoil pattern (one shot per bolt). */
const BOLT_SPRAY: Array<[number, number]> = [[0.0, 0.0]];

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  ak47: {
    id: 'ak47',
    displayName: 'AK-47',
    slot: 'primary',
    category: 'rifle',
    team: 'T',
    cost: 2700,
    fireMode: 'auto',
    rpm: 600,
    magazine: 30,
    reserve: 90,
    reloadMs: 2400,
    deployMs: 800,
    baseDamage: 36,           // chest, no armor — 1 headshot kill, 3 chest kill (NA)
    armorPenetration: 0.775,
    falloffStartM: 30,
    falloffRangeM: 50,
    baseInaccuracyDeg: 0.20,
    movingInaccuracyMul: 14.0,
    jumpingInaccuracyMul: 28.0,
    crouchInaccuracyMul: 0.65,
    recoilDecayMs: 220,
    sprayPattern: AK_SPRAY,
    cameraKickDeg: { x: 0.4, y: 1.2 },
    moveSpeedScale: 0.85,
    killReward: 300,
    fireSound: 'ak47_fire',
    reloadSound: 'ak47_reload',
    scopeLevels: 1,
    scopeFovDeg: [55],
    scopedInaccuracyMul: 0.7,
    scopedMoveSpeedScale: 0.55,
    scopeStyle: 'ads',
  },
  m4a4: {
    id: 'm4a4',
    displayName: 'M4A4',
    slot: 'primary',
    category: 'rifle',
    team: 'CT',
    cost: 3100,
    fireMode: 'auto',
    rpm: 666,
    magazine: 30,
    reserve: 90,
    reloadMs: 3100,
    deployMs: 800,
    baseDamage: 33,
    armorPenetration: 0.70,
    falloffStartM: 30,
    falloffRangeM: 50,
    baseInaccuracyDeg: 0.18,
    movingInaccuracyMul: 13.0,
    jumpingInaccuracyMul: 28.0,
    crouchInaccuracyMul: 0.65,
    recoilDecayMs: 220,
    sprayPattern: M4_SPRAY,
    cameraKickDeg: { x: 0.35, y: 1.0 },
    moveSpeedScale: 0.85,
    killReward: 300,
    fireSound: 'm4a4_fire',
    reloadSound: 'm4a4_reload',
    scopeLevels: 1,
    scopeFovDeg: [55],
    scopedInaccuracyMul: 0.7,
    scopedMoveSpeedScale: 0.55,
    scopeStyle: 'ads',
  },
  usp_s: {
    id: 'usp_s',
    displayName: 'USP-S',
    slot: 'secondary',
    category: 'pistol',
    team: 'CT',
    cost: 0,
    fireMode: 'semi',
    rpm: 360,
    magazine: 12,
    reserve: 24,
    reloadMs: 2200,
    deployMs: 400,
    baseDamage: 35,
    armorPenetration: 0.50,
    falloffStartM: 22,
    falloffRangeM: 42,
    baseInaccuracyDeg: 0.30,
    movingInaccuracyMul: 8.0,
    jumpingInaccuracyMul: 20.0,
    crouchInaccuracyMul: 0.7,
    recoilDecayMs: 180,
    sprayPattern: PISTOL_SPRAY,
    cameraKickDeg: { x: 0.15, y: 0.6 },
    moveSpeedScale: 1.0,
    killReward: 300,
    fireSound: 'usp_fire',
    reloadSound: 'usp_reload',
    scopeLevels: 1,
    scopeFovDeg: [62],
    scopedInaccuracyMul: 0.65,
    scopedMoveSpeedScale: 0.7,
    scopeStyle: 'ads',
  },
  glock18: {
    id: 'glock18',
    displayName: 'Glock-18',
    slot: 'secondary',
    category: 'pistol',
    team: 'T',
    cost: 0,
    fireMode: 'semi',
    rpm: 400,
    magazine: 20,
    reserve: 120,
    reloadMs: 2200,
    deployMs: 400,
    baseDamage: 28,
    armorPenetration: 0.47,
    falloffStartM: 22,
    falloffRangeM: 42,
    baseInaccuracyDeg: 0.34,
    movingInaccuracyMul: 8.0,
    jumpingInaccuracyMul: 20.0,
    crouchInaccuracyMul: 0.7,
    recoilDecayMs: 180,
    sprayPattern: PISTOL_SPRAY,
    cameraKickDeg: { x: 0.15, y: 0.55 },
    moveSpeedScale: 1.0,
    killReward: 300,
    fireSound: 'glock_fire',
    reloadSound: 'glock_reload',
    scopeLevels: 1,
    scopeFovDeg: [65],
    scopedInaccuracyMul: 0.75,
    scopedMoveSpeedScale: 0.75,
    scopeStyle: 'ads',
  },
  awp: {
    id: 'awp',
    displayName: 'AWP',
    slot: 'primary',
    category: 'sniper',
    team: 'both',
    cost: 4750,
    fireMode: 'bolt',
    rpm: 41,
    magazine: 10,
    reserve: 30,
    reloadMs: 3700,
    deployMs: 1300,
    baseDamage: 115,
    armorPenetration: 0.975,
    falloffStartM: 80,
    falloffRangeM: 200,
    baseInaccuracyDeg: 0.10,
    movingInaccuracyMul: 70.0,
    jumpingInaccuracyMul: 80.0,
    crouchInaccuracyMul: 0.5,
    recoilDecayMs: 600,
    sprayPattern: BOLT_SPRAY,
    cameraKickDeg: { x: 0.6, y: 4.5 },
    moveSpeedScale: 0.65,
    killReward: 100,
    fireSound: 'awp_fire',
    reloadSound: 'awp_reload',
    scopeLevels: 2,
    scopeFovDeg: [40, 10],
    scopedInaccuracyMul: 0.05,
    scopedMoveSpeedScale: 0.30,
    scopeStyle: 'sniper',
  },
  knife: {
    id: 'knife',
    displayName: 'Knife',
    slot: 'knife',
    category: 'knife',
    team: 'both',
    cost: 0,
    fireMode: 'melee',
    rpm: 90,
    magazine: 0,
    reserve: 0,
    reloadMs: 0,
    deployMs: 250,
    baseDamage: 65,
    armorPenetration: 0.85,
    falloffStartM: 1.5,
    falloffRangeM: 0.1,
    baseInaccuracyDeg: 0,
    movingInaccuracyMul: 1,
    jumpingInaccuracyMul: 1,
    crouchInaccuracyMul: 1,
    recoilDecayMs: 0,
    sprayPattern: [[0, 0]],
    cameraKickDeg: { x: 0, y: 0 },
    moveSpeedScale: 1.15,
    killReward: 1500,
    fireSound: 'knife_swing',
    reloadSound: 'knife_swing',
    secondaryAttack: {
      damageMul: 1.55,    // 65 → ~101 chest, no-armor
      rpm: 50,            // ~1.2 s between stabs
      animation: 'stab',
    },
  },
  c4: {
    id: 'c4',
    displayName: 'C4',
    slot: 'c4',
    category: 'bomb',
    team: 'T',
    cost: 0,
    fireMode: 'planted',
    rpm: 0,
    magazine: 0,
    reserve: 0,
    reloadMs: 0,
    deployMs: 1000,
    baseDamage: 0,
    armorPenetration: 0,
    falloffStartM: 0,
    falloffRangeM: 0,
    baseInaccuracyDeg: 0,
    movingInaccuracyMul: 1,
    jumpingInaccuracyMul: 1,
    crouchInaccuracyMul: 1,
    recoilDecayMs: 0,
    sprayPattern: [[0, 0]],
    cameraKickDeg: { x: 0, y: 0 },
    moveSpeedScale: 1.0,
    killReward: 0,
    fireSound: 'c4_beep',
    reloadSound: 'c4_beep',
  },
  he: makeGrenadeDef({
    id: 'he', displayName: 'HE Grenade', cost: 300, killReward: 300,
    fireSound: 'grenade_throw',
  }),
  flashbang: makeGrenadeDef({
    id: 'flashbang', displayName: 'Flashbang', cost: 200, killReward: 0,
    fireSound: 'grenade_throw',
  }),
  smoke: makeGrenadeDef({
    id: 'smoke', displayName: 'Smoke', cost: 300, killReward: 0,
    fireSound: 'grenade_throw',
  }),
  molotov: makeGrenadeDef({
    id: 'molotov', displayName: 'Molotov', cost: 400, killReward: 100,
    fireSound: 'grenade_throw',
  }),
  decoy: makeGrenadeDef({
    id: 'decoy', displayName: 'Decoy', cost: 50, killReward: 0,
    fireSound: 'grenade_throw',
  }),
};

interface GrenadeFactoryArgs {
  id: 'he' | 'flashbang' | 'smoke' | 'molotov' | 'decoy';
  displayName: string;
  cost: number;
  killReward: number;
  fireSound: string;
}
function makeGrenadeDef(a: GrenadeFactoryArgs): WeaponDef {
  return {
    id: a.id,
    displayName: a.displayName,
    slot: 'grenade',
    category: 'grenade',
    team: 'both',
    cost: a.cost,
    fireMode: 'thrown',
    rpm: 0,
    // Grenades use ammoMag = "in your hand" (1) and ammoReserve = 0:
    // each instance is a single grenade. Multiple instances stack in
    // the inventory's grenade slot.
    magazine: 1,
    reserve: 0,
    reloadMs: 0,
    deployMs: 250,
    baseDamage: 0,
    armorPenetration: 0,
    falloffStartM: 0,
    falloffRangeM: 0,
    baseInaccuracyDeg: 0,
    movingInaccuracyMul: 1,
    jumpingInaccuracyMul: 1,
    crouchInaccuracyMul: 1,
    recoilDecayMs: 0,
    sprayPattern: [[0, 0]],
    cameraKickDeg: { x: 0, y: 0 },
    moveSpeedScale: 1.0,
    killReward: a.killReward,
    fireSound: a.fireSound,
    reloadSound: a.fireSound,
  };
}

export function getWeapon(id: WeaponId): WeaponDef {
  const w = WEAPONS[id];
  if (!w) throw new Error(`Unknown weapon: ${id}`);
  return w;
}
