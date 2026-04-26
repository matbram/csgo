/** Per-strategy grenade lineups. A "lineup" is a single throw a bot
 *  performs once per round, at a particular trigger moment, from a
 *  callout to land on a target callout. The strategist hands these out
 *  along with the role; the brain executes them when its `throwGrenade`
 *  state activates.
 *
 *  Authoring grenade lineups by hand for one map costs the project a
 *  few hours and produces dramatically better-feeling AI than runtime
 *  search. We deliberately keep the table small — just enough so each
 *  plan has at least one signature throw. Adding more is pure data.
 *
 *  The trajectory math is "throw-from-feet at upward angle"; the
 *  GrenadeSystem's physics handles the bounce. We don't model lineups
 *  as exact velocity vectors — instead a bot that picks up a lineup
 *  walks to `fromCallout`, faces `targetCallout`, and throws full power.
 *  That's good enough on Dust 2 because most useful nades are flat-arc
 *  smokes / flashes from open ground. */

import type { CalloutId } from '../map/types';
import type { GrenadeKind } from '../grenades/system';
import type { StrategyId } from './plans';

export interface GrenadeLineup {
  kind: GrenadeKind;
  /** Where the bot should stand to throw. */
  fromCallout: CalloutId;
  /** Where the throw should land — converted to a yaw at brain time. */
  targetCallout: CalloutId;
  /** Trigger moment within a round:
   *   - 'opening'  immediately after freeze (bots typically still in
   *                their staging callout)
   *   - 'pre_push' when a teammate enters the contested area, used for
   *                flashbangs that support an entry
   *   - 'on_plant' once the bomb is planted (smokes + molotov for
   *                post-plant hold)
   */
  trigger: 'opening' | 'pre_push' | 'on_plant';
}

const LINEUPS: Partial<Record<StrategyId, GrenadeLineup[]>> = {
  // T plans — flash + smoke for the entry, molotov on default plant.
  t_rush_a: [
    { kind: 'flashbang', fromCallout: 'A_LONG',  targetCallout: 'A_SITE', trigger: 'pre_push' },
    { kind: 'smoke',     fromCallout: 'A_LONG',  targetCallout: 'A_CROSS', trigger: 'opening' },
  ],
  t_rush_b: [
    { kind: 'flashbang', fromCallout: 'B_TUNNELS_UPPER', targetCallout: 'B_SITE',  trigger: 'pre_push' },
    { kind: 'smoke',     fromCallout: 'B_TUNNELS_UPPER', targetCallout: 'B_DOORS', trigger: 'opening' },
  ],
  t_default_a: [
    { kind: 'smoke',     fromCallout: 'OUTSIDE_LONG', targetCallout: 'A_LONG', trigger: 'opening' },
    { kind: 'flashbang', fromCallout: 'A_LONG',       targetCallout: 'A_SITE', trigger: 'pre_push' },
  ],
  t_default_b: [
    { kind: 'smoke',     fromCallout: 'B_TUNNELS_LOWER', targetCallout: 'B_DOORS', trigger: 'opening' },
    { kind: 'flashbang', fromCallout: 'B_TUNNELS_UPPER', targetCallout: 'B_SITE',  trigger: 'pre_push' },
  ],
  t_split_a: [
    { kind: 'flashbang', fromCallout: 'CATWALK', targetCallout: 'A_SITE', trigger: 'pre_push' },
    { kind: 'smoke',     fromCallout: 'A_LONG',  targetCallout: 'A_CROSS', trigger: 'opening' },
  ],
  // Post-plant Ts often molotov default plant spots to deny defuse.
  t_post_plant_a: [
    { kind: 'molotov',   fromCallout: 'A_LONG',  targetCallout: 'A_SITE', trigger: 'on_plant' },
  ],
  t_post_plant_b: [
    { kind: 'molotov',   fromCallout: 'B_DOORS', targetCallout: 'B_SITE', trigger: 'on_plant' },
  ],
  // CT plans — smoke off the most aggressive T peeks.
  ct_default: [
    { kind: 'smoke',     fromCallout: 'CT_MID',  targetCallout: 'MID_DOORS', trigger: 'opening' },
  ],
  ct_stack_a: [
    { kind: 'smoke',     fromCallout: 'A_CROSS', targetCallout: 'A_LONG',    trigger: 'opening' },
    { kind: 'molotov',   fromCallout: 'A_SITE',  targetCallout: 'A_LONG',    trigger: 'opening' },
  ],
  ct_stack_b: [
    { kind: 'smoke',     fromCallout: 'B_DOORS', targetCallout: 'B_TUNNELS_UPPER', trigger: 'opening' },
    { kind: 'molotov',   fromCallout: 'B_SITE',  targetCallout: 'B_TUNNELS_UPPER', trigger: 'opening' },
  ],
  ct_aggro_mid: [
    { kind: 'flashbang', fromCallout: 'MID',     targetCallout: 'T_RAMP',    trigger: 'opening' },
  ],
  // Retake nades — flash to peek the planted site.
  ct_retake_a: [
    { kind: 'flashbang', fromCallout: 'A_CROSS', targetCallout: 'A_SITE',    trigger: 'on_plant' },
  ],
  ct_retake_b: [
    { kind: 'flashbang', fromCallout: 'B_DOORS', targetCallout: 'B_SITE',    trigger: 'on_plant' },
  ],
};

export function lineupsFor(strategy: StrategyId): ReadonlyArray<GrenadeLineup> {
  return LINEUPS[strategy] ?? [];
}

/** All trigger phases a brain might want to filter on. Exported so the
 *  brain doesn't repeat the literal type. */
export type LineupTrigger = GrenadeLineup['trigger'];
