/** Dust 2 — pass 1 blockout.
 *
 *  Coordinate convention used throughout this map:
 *    +X = east, -X = west
 *    +Z = north, -Z = south
 *    +Y = up
 *
 *  Approximate plan:
 *
 *      W                                                        E
 *      ─────────────────────────────────────────────────────────
 *  N   |                                                       |
 *      |   B_SITE          CT_SPAWN          A_SITE            |
 *      |   FENCE/WIN       (north)            PLAT/CROSS       |
 *      |   B_DOORS  ←─── CT_MID ────→ A_SHORT/CATWALK          |
 *      |              MID_DOORS                                |
 *      |                  MID                                  |
 *      |   B_TUNNELS_UPPER      |        A_LONG                |
 *      |       │                |          │                   |
 *      |   B_TUNNELS_LOWER  SUICIDE   LONG_DOORS               |
 *      |       │                │          │                   |
 *      |       └────── T_SPAWN ─┴── OUTSIDE_LONG ──────────────|
 *  S   |                                                       |
 *      ─────────────────────────────────────────────────────────
 *
 *  Wall thickness: 0.6m. Standard ceiling height: 5m. Floor: y=0 mostly,
 *  with a few raised platforms inside A and B sites.
 */

import { box, group, ramp, spawn, zone, bombsite, buyzone } from './types';
import type { Block } from './types';

const FLOOR_THICK = 0.4;
const WALL_THICK = 0.6;
const WALL_HEIGHT = 5.0;
const SKY_FLOOR_OFFSET = -FLOOR_THICK; // floors sit so their top is at y=0

// A solid floor patch with top surface at y=0.
function floor(name: string, cx: number, cz: number, sx: number, sz: number, mat: 'sand_floor' | 'concrete' | 'dark_stone' = 'sand_floor'): Block {
  return box({
    name, size: [sx, FLOOR_THICK, sz], at: [cx, SKY_FLOOR_OFFSET, cz],
    material: mat, surface: 'sand', walkable: true,
  });
}

// A wall (axis-aligned along x by default; pass yaw=90 to rotate).
function wall(
  name: string,
  cx: number, cz: number,
  length: number,
  yawDeg = 0,
  mat: 'sand_wall' | 'brick' | 'concrete' = 'sand_wall',
  height = WALL_HEIGHT,
): Block {
  return box({
    name, size: [length, height, WALL_THICK], at: [cx, 0, cz], yawDeg,
    material: mat, surface: 'sand', walkable: false,
  });
}

// Raised platform — usable as cover or step-up.
function platform(name: string, cx: number, cz: number, sx: number, sy: number, sz: number, mat: 'wood' | 'sand_floor' | 'concrete' = 'wood'): Block {
  return box({
    name, size: [sx, sy, sz], at: [cx, 0, cz],
    material: mat, surface: mat === 'wood' ? 'wood' : 'concrete', walkable: true,
  });
}

// A crate — chest-high cover.
function crate(cx: number, cz: number, size = 1.6): Block {
  return box({
    name: 'crate',
    size: [size, size, size], at: [cx, 0, cz],
    material: 'wood', surface: 'wood', walkable: true,
  });
}

// Palm tree — thin trunk plus a wider, flatter "crown" of fronds. The
// crown is solid (you can't walk through it) but only the trunk fills
// the ground footprint; the crown floats above. Trees are skip-render
// at long range via Babylon's frustum culling — `alwaysSelectAsActiveMesh`
// is false in builder.ts.
function palmTree(cx: number, cz: number, height = 5.0, yawDeg = 0): Block {
  return group(`palm-${cx.toFixed(0)}-${cz.toFixed(0)}`, [cx, 0, cz], [
    box({
      name: 'palm-trunk',
      size: [0.45, height, 0.45], at: [0, 0, 0], yawDeg,
      material: 'wood', surface: 'wood', walkable: false,
    }),
    box({
      name: 'palm-crown',
      size: [3.0, 0.8, 3.0], at: [0, height - 0.2, 0], yawDeg,
      material: 'palm_leaf', surface: 'wood', solid: false,
    }),
    box({
      name: 'palm-crown-2',
      size: [2.2, 0.5, 2.2], at: [0, height + 0.4, 0], yawDeg: yawDeg + 30,
      material: 'palm_leaf', surface: 'wood', solid: false,
    }),
  ]);
}

// The iconic A-site blue car. Body + cabin + wheel arches. Modeled as
// a static obstacle (chest-high cover, walkable on top so you can perch).
function blueCar(cx: number, cz: number, yawDeg = 0): Block {
  return group(`blue-car-${cx.toFixed(0)}-${cz.toFixed(0)}`, [cx, 0, cz], [
    // Lower body
    box({
      name: 'car-body',
      size: [1.7, 0.9, 4.0], at: [0, 0.30, 0], yawDeg,
      material: 'blue_paint', surface: 'metal', walkable: true,
    }),
    // Cabin (greenhouse) — slightly narrower, sits on top
    box({
      name: 'car-cabin',
      size: [1.55, 0.6, 2.0], at: [0, 1.20, -0.15], yawDeg,
      material: 'blue_paint', surface: 'metal', walkable: true,
    }),
    // Front bumper
    box({
      name: 'car-bumper-f',
      size: [1.7, 0.18, 0.20], at: [0, 0.18, 1.95], yawDeg,
      material: 'metal', surface: 'metal', walkable: false,
    }),
    // Rear bumper
    box({
      name: 'car-bumper-r',
      size: [1.7, 0.18, 0.20], at: [0, 0.18, -1.95], yawDeg,
      material: 'metal', surface: 'metal', walkable: false,
    }),
  ]);
}

// B-site truck — taller and longer. Cargo bed walls so the truck reads
// as something distinct from the car.
function truck(cx: number, cz: number, yawDeg = 0): Block {
  return group(`truck-${cx.toFixed(0)}-${cz.toFixed(0)}`, [cx, 0, cz], [
    // Chassis / cargo floor
    box({
      name: 'truck-bed',
      size: [2.2, 1.10, 5.0], at: [0, 0.40, 0], yawDeg,
      material: 'metal', surface: 'metal', walkable: true,
    }),
    // Cabin
    box({
      name: 'truck-cab',
      size: [2.2, 1.30, 1.6], at: [0, 1.50, 1.6], yawDeg,
      material: 'metal', surface: 'metal', walkable: true,
    }),
    // Cargo bed sides (left/right walls of the bed)
    box({
      name: 'truck-bed-l',
      size: [0.10, 0.8, 3.2], at: [-1.05, 1.40, -0.6], yawDeg,
      material: 'wood', surface: 'wood', walkable: false,
    }),
    box({
      name: 'truck-bed-r',
      size: [0.10, 0.8, 3.2], at: [ 1.05, 1.40, -0.6], yawDeg,
      material: 'wood', surface: 'wood', walkable: false,
    }),
    // Tailgate
    box({
      name: 'truck-tailgate',
      size: [2.2, 0.8, 0.10], at: [0, 1.40, -2.20], yawDeg,
      material: 'wood', surface: 'wood', walkable: false,
    }),
  ]);
}

export function dust2(): Block {
  return group('dust2', [0, 0, 0], [
    // ---------------------------------------------------------------
    // Outer perimeter (so the player can't fall off the world).
    // Big floor stretches across the play area; walls form perimeter.
    // ---------------------------------------------------------------
    floor('world-floor', 0, 0, 110, 110, 'sand_floor'),

    // Outer walls (bound the playable region loosely).
    wall('outer-S', 0, -50, 110, 0, 'sand_wall'),
    wall('outer-N', 0,  50, 110, 0, 'sand_wall'),
    wall('outer-W', -55, 0, 100, 90, 'sand_wall'),
    wall('outer-E',  55, 0, 100, 90, 'sand_wall'),

    // ===============================================================
    // T SPAWN  (south-center, open area with elevated sniper platform)
    // ===============================================================
    group('t-spawn', [0, 0, -38], [
      // Snipers' platform (elevated)
      platform('t-snipe', -6, -2, 6, 1.6, 4, 'wood'),
      // Decorative palms in the south corners — read as a hot,
      // bombed-out outdoor square.
      palmTree(-9, -8, 5.5),
      palmTree(8, -7, 5.0, 40),
      // Boxes for cover
      crate(2, 4),
      crate(4, 2),
      // Backside wall (already covered by outer-S)
      // Side walls of T spawn corridor opening north
      wall('t-spawn-w-1', -8, 6, 6, 0, 'sand_wall'),  // west chunk
      wall('t-spawn-e-1',  8, 6, 6, 0, 'sand_wall'),  // east chunk
      // Two openings: one to OUTSIDE_LONG (east) one to T_RAMP/SUICIDE (north)
      // and one to B_TUNNELS (west).
      // Spawns + zones
      spawn({ team: 'T', at: [-3, 0, -1], yawDeg: 0 }),
      spawn({ team: 'T', at: [-1, 0, -2], yawDeg: 0 }),
      spawn({ team: 'T', at: [ 1, 0, -2], yawDeg: 0 }),
      spawn({ team: 'T', at: [ 3, 0, -1], yawDeg: 0 }),
      spawn({ team: 'T', at: [ 0, 0,  0], yawDeg: 0 }),
      zone({
        callout: 'T_SPAWN',
        polygon: [[-9, -10], [9, -10], [9, 7], [-9, 7]],
        adjacent: ['OUTSIDE_LONG', 'T_RAMP', 'B_TUNNELS_LOWER'],
      }),
      buyzone({ team: 'T', polygon: [[-9, -10], [9, -10], [9, 7], [-9, 7]] }),
    ]),

    // ===============================================================
    // OUTSIDE_LONG / LONG_DOORS / A_LONG  (east side T-route to A)
    // Corridor running north from T spawn east edge to A site.
    // ===============================================================
    group('long-route', [22, 0, 0], [
      // Outside Long — open area between T spawn and Long Doors
      group('outside-long', [0, 0, -28], [
        // Corridor walls
        wall('ol-w', -5, 0, 12, 90, 'sand_wall'),  // west
        wall('ol-e',  5, 0, 12, 90, 'sand_wall'),  // east
        zone({ callout: 'OUTSIDE_LONG', polygon: [[-5, -6], [5, -6], [5, 6], [-5, 6]],
               adjacent: ['T_SPAWN', 'LONG_DOORS'] }),
      ]),
      // Long Doors — chokepoint
      group('long-doors', [0, 0, -16], [
        wall('ld-w', -3, 0, 4, 90, 'sand_wall'),
        wall('ld-e',  3, 0, 4, 90, 'sand_wall'),
        // Door columns (visual)
        box({ name: 'ld-col-w', size: [0.8, WALL_HEIGHT, 0.8], at: [-2.5, 0, 0], material: 'brick' }),
        box({ name: 'ld-col-e', size: [0.8, WALL_HEIGHT, 0.8], at: [ 2.5, 0, 0], material: 'brick' }),
        zone({ callout: 'LONG_DOORS', polygon: [[-3, -2], [3, -2], [3, 2], [-3, 2]],
               adjacent: ['OUTSIDE_LONG', 'A_LONG', 'PIT'] }),
      ]),
      // A Long — long corridor
      group('a-long', [0, 0, 0], [
        wall('al-w', -5, 0, 24, 90, 'sand_wall'),
        wall('al-e',  5, 0, 24, 90, 'sand_wall'),
        zone({ callout: 'A_LONG', polygon: [[-5, -12], [5, -12], [5, 12], [-5, 12]],
               adjacent: ['LONG_DOORS', 'A_CROSS', 'PIT'] }),
      ]),
      // Pit — small alcove off A Long
      group('pit', [-7, 0, 6], [
        floor('pit-floor', 0, 0, 5, 5, 'concrete'),
        wall('pit-w', -2.5, 0, 5, 90, 'sand_wall'),
        wall('pit-s', 0, -2.5, 5, 0, 'sand_wall'),
        zone({ callout: 'PIT', polygon: [[-2.5, -2.5], [2.5, -2.5], [2.5, 2.5], [-2.5, 2.5]],
               adjacent: ['A_LONG', 'A_CROSS'] }),
      ]),
    ]),

    // ===============================================================
    // A_CROSS / A_SITE / A_SHORT / CATWALK
    // ===============================================================
    group('a-area', [16, 0, 16], [
      // A Cross — exposed open ground
      zone({ callout: 'A_CROSS', polygon: [[-6, -4], [10, -4], [10, 4], [-6, 4]],
             adjacent: ['A_LONG', 'PIT', 'A_SITE', 'CATWALK'] }),
      // A Site — main bomb plant zone, with raised platform and boxes
      group('a-site', [4, 0, 6], [
        // Site fence/wall on north & east
        wall('asite-n', 0, 6, 16, 0, 'sand_wall'),
        wall('asite-e', 8, 0, 12, 90, 'sand_wall'),
        // Site platform
        platform('a-platform', -3, 2, 4, 1.2, 4, 'wood'),
        // Default-plant boxes
        crate(2, 0, 1.4),
        crate(2, 1.5, 1.4),
        crate(0, 4, 1.6),
        // The iconic A-site blue car. Sits east of the default plant
        // along Goose, providing chest-high cover from CT spawn /
        // catwalk angles.
        blueCar(4, -1, 90),
        // Palm trees flanking the back of A site — visible from Long
        // and CT spawn angles.
        palmTree(-6, 5, 5.5),
        palmTree(7, 5, 5.0, 25),
        // Goose (eastern alcove)
        wall('goose-w', 5, -2, 4, 90, 'sand_wall'),
        zone({ callout: 'A_SITE', polygon: [[-7, -4], [8, -4], [8, 6], [-7, 6]],
               adjacent: ['A_CROSS', 'A_SHORT', 'CT_MID'] }),
        bombsite({ site: 'A', polygon: [[-5, -2], [6, -2], [6, 4], [-5, 4]] }),
      ]),
      // A Short / Catwalk — leads west to mid
      group('catwalk', [-10, 0, 0], [
        platform('catwalk-floor', 0, 0, 10, 1.0, 3, 'wood'),
        wall('cat-n', 0, 1.5, 10, 0, 'sand_wall', 4.0),
        wall('cat-s', 0, -1.5, 10, 0, 'sand_wall', 4.0),
        zone({ callout: 'CATWALK', polygon: [[-5, -1.5], [5, -1.5], [5, 1.5], [-5, 1.5]],
               adjacent: ['A_CROSS', 'A_SHORT', 'MID'] }),
      ]),
      group('a-short', [-3, 0, -2], [
        zone({ callout: 'A_SHORT', polygon: [[-2, -3], [2, -3], [2, 3], [-2, 3]],
               adjacent: ['CATWALK', 'A_SITE'] }),
      ]),
    ]),

    // ===============================================================
    // MID  (central spine running roughly N-S)
    // ===============================================================
    group('mid', [0, 0, 0], [
      // T_RAMP — short ramp from T spawn floor (y=0) up to mid floor (y=0)
      // (kept flat in pass 1 — placeholder ramp for visual interest)
      group('t-ramp', [0, 0, -22], [
        ramp({ name: 't-ramp', size: [4, 1.2, 4], at: [-2, 0, -2], yawDeg: 0,
               material: 'sand_floor', surface: 'sand' }),
        zone({ callout: 'T_RAMP', polygon: [[-3, -3], [3, -3], [3, 3], [-3, 3]],
               adjacent: ['T_SPAWN', 'MID', 'SUICIDE'] }),
      ]),
      // Suicide — risky drop into mid (we keep it flat in pass 1)
      group('suicide', [-4, 0, -18], [
        zone({ callout: 'SUICIDE', polygon: [[-3, -4], [3, -4], [3, 4], [-3, 4]],
               adjacent: ['T_SPAWN', 'MID'] }),
      ]),
      // Mid corridor itself — runs from z=-15 to z=+5
      group('mid-floor', [0, 0, -5], [
        wall('mid-e',  4, 0, 22, 90, 'sand_wall'),
        wall('mid-w', -4, 0, 22, 90, 'sand_wall'),
        zone({ callout: 'MID', polygon: [[-4, -11], [4, -11], [4, 11], [-4, 11]],
               adjacent: ['SUICIDE', 'T_RAMP', 'MID_DOORS', 'CATWALK', 'B_DOORS'] }),
      ]),
      // Mid Doors — choke at the north end of mid
      group('mid-doors', [0, 0, 6], [
        wall('md-w', -2, 0, 4, 90, 'sand_wall'),
        wall('md-e',  2, 0, 4, 90, 'sand_wall'),
        zone({ callout: 'MID_DOORS', polygon: [[-2, -2], [2, -2], [2, 2], [-2, 2]],
               adjacent: ['MID', 'CT_MID'] }),
      ]),
      // CT Mid — north
      group('ct-mid', [0, 0, 12], [
        wall('ctm-w', -5, 0, 8, 90, 'sand_wall'),
        wall('ctm-e',  5, 0, 8, 90, 'sand_wall'),
        zone({ callout: 'CT_MID', polygon: [[-5, -4], [5, -4], [5, 4], [-5, 4]],
               adjacent: ['MID_DOORS', 'CT_SPAWN', 'B_DOORS', 'A_SITE'] }),
      ]),
    ]),

    // ===============================================================
    // CT SPAWN  (north)
    // ===============================================================
    group('ct-spawn', [0, 0, 28], [
      wall('ct-w', -10, 0, 12, 90, 'sand_wall'),
      wall('ct-e',  10, 0, 12, 90, 'sand_wall'),
      // Atmosphere palms in the back of CT spawn.
      palmTree(-8, 6, 5.5),
      palmTree(8, 6, 5.0, 60),
      crate(-4, 2),
      crate(4, -2),
      spawn({ team: 'CT', at: [-3, 0,  1], yawDeg: 180 }),
      spawn({ team: 'CT', at: [-1, 0,  2], yawDeg: 180 }),
      spawn({ team: 'CT', at: [ 1, 0,  2], yawDeg: 180 }),
      spawn({ team: 'CT', at: [ 3, 0,  1], yawDeg: 180 }),
      spawn({ team: 'CT', at: [ 0, 0,  0], yawDeg: 180 }),
      zone({
        callout: 'CT_SPAWN',
        polygon: [[-10, -7], [10, -7], [10, 7], [-10, 7]],
        adjacent: ['CT_MID', 'B_DOORS'],
      }),
      buyzone({ team: 'CT', polygon: [[-10, -7], [10, -7], [10, 7], [-10, 7]] }),
    ]),

    // ===============================================================
    // B  (west side: B_DOORS → B_SITE → BACK_PLAT, B_WINDOW, FENCE)
    // ===============================================================
    group('b-area', [-22, 0, 18], [
      // B Doors — connection from CT spawn / mid to B
      group('b-doors', [10, 0, -2], [
        wall('bd-n', 0, 2, 4, 0, 'sand_wall'),
        wall('bd-s', 0, -2, 4, 0, 'sand_wall'),
        zone({ callout: 'B_DOORS', polygon: [[-2, -2], [2, -2], [2, 2], [-2, 2]],
               adjacent: ['CT_MID', 'CT_SPAWN', 'B_SITE'] }),
      ]),
      // B Site
      group('b-site', [0, 0, 0], [
        wall('bs-n', 0, 6, 16, 0, 'sand_wall'),
        wall('bs-w', -8, 0, 12, 90, 'sand_wall'),
        // B platform (raised)
        platform('b-plat', -3, 2, 4, 1.0, 4, 'wood'),
        // Back plat
        platform('back-plat', -5, 4, 3, 1.5, 3, 'concrete'),
        // Window
        box({ name: 'b-window', size: [3, 1.4, 0.4], at: [4, 1.0, 4], material: 'sand_wall' }),
        // Fence (low cover)
        box({ name: 'b-fence', size: [4, 1.2, 0.3], at: [3, 0, -2], material: 'wood' }),
        // The B-site truck — sits in the south-east of the site as a
        // big piece of cover for defenders coming from B doors.
        truck(3, -1, 0),
        // Palm tree near the back wall, visible from tunnels.
        palmTree(-6, 5, 5.0),
        // Crates
        crate(0, -2, 1.4),
        crate(2, 0, 1.4),
        zone({ callout: 'B_SITE', polygon: [[-8, -4], [6, -4], [6, 6], [-8, 6]],
               adjacent: ['B_DOORS', 'B_TUNNELS_UPPER', 'B_PLAT', 'BACK_PLAT', 'B_WINDOW', 'FENCE'] }),
        zone({ callout: 'B_PLAT', polygon: [[-5, 0], [-1, 0], [-1, 4], [-5, 4]], adjacent: ['B_SITE', 'BACK_PLAT'] }),
        zone({ callout: 'BACK_PLAT', polygon: [[-7, 2], [-3, 2], [-3, 6], [-7, 6]], adjacent: ['B_PLAT', 'B_SITE'] }),
        zone({ callout: 'B_WINDOW', polygon: [[2, 3], [6, 3], [6, 5], [2, 5]], adjacent: ['B_SITE'] }),
        zone({ callout: 'FENCE', polygon: [[1, -3], [5, -3], [5, -1], [1, -1]], adjacent: ['B_SITE'] }),
        bombsite({ site: 'B', polygon: [[-5, -2], [4, -2], [4, 4], [-5, 4]] }),
      ]),
    ]),

    // ===============================================================
    // B TUNNELS  (T-side approach to B)
    // ===============================================================
    group('b-tunnels', [-18, 0, -8], [
      // Lower tunnel
      group('b-tun-lower', [0, 0, -6], [
        wall('btl-n', 0, 3, 8, 0, 'sand_wall'),
        wall('btl-s', 0, -3, 8, 0, 'sand_wall'),
        zone({ callout: 'B_TUNNELS_LOWER',
               polygon: [[-4, -3], [4, -3], [4, 3], [-4, 3]],
               adjacent: ['T_SPAWN', 'B_TUNNELS_UPPER'] }),
      ]),
      // Upper tunnel — for M1 we'll skip the actual height change; same y
      group('b-tun-upper', [0, 0, 6], [
        wall('btu-n', 0, 3, 8, 0, 'sand_wall'),
        wall('btu-s', 0, -3, 8, 0, 'sand_wall'),
        zone({ callout: 'B_TUNNELS_UPPER',
               polygon: [[-4, -3], [4, -3], [4, 3], [-4, 3]],
               adjacent: ['B_TUNNELS_LOWER', 'B_SITE'] }),
      ]),
    ]),
  ]);
}
