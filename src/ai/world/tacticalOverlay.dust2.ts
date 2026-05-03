/** Hand-tuned tactical overlay for Dust 2.
 *
 *  This file is the per-map "human pass" the auto-derivation can't
 *  reach. Auto-derivation gets us cover representatives, peek nodes,
 *  hold angles, and pre-aim spots from the map geometry alone. The
 *  overlay adds:
 *    - Head-glitch tags on cover nodes whose top edge sits at eye
 *      height (`pit-head-glitch`, `b-default-box`, etc.).
 *    - Authored hold angles for spots auto-derivation underweights —
 *      the canonical AWP positions, awkward off-angles, etc.
 *    - Pre-aim overrides for the handful of pairs where the centroid-
 *      to-centroid heuristic points the wrong way (e.g. CT mid into
 *      MID_DOORS doesn't actually want the door centroid; it wants
 *      the head-glitch corner).
 *
 *  Coordinates are world-space and are SNAPPED to the closest matching
 *  cover node within the cluster radius — exact precision isn't
 *  required. Updating a value here reloads the whole tactical graph
 *  next world build.
 *
 *  ──────────────────────────────────────────────────────────────────
 *  Adding a new entry:
 *    1. Toggle F4 to see auto-detected cover nodes (cyan dots).
 *    2. Note the world XZ of the spot (debug HUD's `pos` line).
 *    3. Drop in an entry below; reload.
 *
 *  Keep this file small and considered. The planner is most affected
 *  by the head-glitch and AWP-anchor entries — everything else is
 *  cosmetic until the planner factors them in. */

import type { TacticalOverlay } from './tacticalGraph';

export const dust2Overlay: TacticalOverlay = {
  // PIT (A long) is the iconic head-glitch spot — the box edge sits
  // right at standing eye height. World position: long route group
  // origin (22, 0, 0) + pit subgroup (-7, 0, 6) ≈ (15, 0, 6).
  headGlitchAt: [
    { x: 15.0, z: 6.0, callout: 'PIT' },
  ],
  // No extra hold angles in the starter set — auto-derivation covers
  // the obvious ones (CT cross facing A long, B doors facing tunnels).
  // Add a `{ callout: 'PIT', fromX: 15, fromZ: 6, yawDeg: 180,
  // exposes: 'A_LONG' }` entry here when an authored AWP angle
  // becomes important.
  extraHoldAngles: [],
  // No overrides yet. Add a `{ callout: 'CT_MID', targetCallout:
  // 'MID_DOORS', yawDeg: -90 }` here if a specific pre-aim heading
  // matters more than the centroid heuristic.
  preAimOverride: [],
};
