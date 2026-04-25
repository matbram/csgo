/** Tiny objective picker for Pass 1 of M4. Returns a world XZ point per
 *  bot per round.
 *
 *  This is intentionally dumb: T bots are dispatched toward a bombsite
 *  centroid; CT bots are dispatched toward a defensive offset near the
 *  same site. The strategist (M5) will replace all of this with proper
 *  team plans, role assignments, and per-callout objectives. */

import type { World, BombSiteRegion } from '../map/world';
import { polygonCentroid } from '../map/world';

export interface Objective {
  x: number;
  z: number;
  /** Which bombsite this objective is associated with — used downstream
   *  for HUD/AI debug, and so the rest of M4 can group bots by site. */
  site: 'A' | 'B';
}

/** Cheap deterministic RNG so two bots given the same `seed` make the
 *  same call. We deliberately avoid Math.random so reset behaviour is
 *  stable across rounds. */
function lcg(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** Pick objectives for an entire team in one call so we can spread bots
 *  across A and B instead of stacking everyone on the same site.
 *
 *  Returns an array the same length as `botIds`, in the same order. */
export function pickTeamObjectives(
  team: 'T' | 'CT',
  botIds: string[],
  world: World,
  roundNumber: number,
): Objective[] {
  const sites = world.bombSites;
  if (sites.length === 0) return botIds.map(() => ({ x: 0, z: 0, site: 'A' as const }));

  const rng = lcg(roundNumber * 31 + (team === 'T' ? 7 : 13));
  // Decide a 60/40-ish A/B split for variety. The exact split rotates
  // with the round number so consecutive rounds don't always go A.
  const aBias = 0.55 + 0.20 * Math.sin(roundNumber * 1.3);
  const out: Objective[] = [];
  for (let i = 0; i < botIds.length; i++) {
    const goA = rng() < aBias;
    const site = goA ? findSite(sites, 'A') : findSite(sites, 'B');
    const region = site ?? sites[0]!;
    const [cx, cz] = polygonCentroid(region.polygon);
    if (team === 'T') {
      // Ts walk straight onto the site centroid.
      out.push({ x: cx, z: cz, site: region.site });
    } else {
      // CTs hold a small offset just outside the centroid so they're
      // "defending the site" rather than crowding the plant spot.
      const offsetMag = 4.0;
      const angle = (i * 0.9 + roundNumber * 0.7) % (Math.PI * 2);
      out.push({
        x: cx + Math.cos(angle) * offsetMag,
        z: cz + Math.sin(angle) * offsetMag,
        site: region.site,
      });
    }
  }
  return out;
}

function findSite(sites: ReadonlyArray<BombSiteRegion>, which: 'A' | 'B'): BombSiteRegion | null {
  for (const s of sites) if (s.site === which) return s;
  return null;
}
