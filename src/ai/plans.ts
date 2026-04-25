/** M5 plan library. A "plan" is a side-specific strategy with five
 *  callout-anchored objective slots and a per-slot role tag. The
 *  strategist (src/ai/strategist.ts) picks one plan per side per round
 *  and hands its slots out 1:1 to the team's bots.
 *
 *  Slot order matters — slot 0 is treated as the "lead" position by some
 *  plans (entry on T side, AWP anchor on CT side). Roles are mostly for
 *  display + future use (per-role buy preferences when we add nades).
 *
 *  Callouts referenced here must exist in the live world (see dust2.ts).
 *  At plan apply time the strategist resolves each callout to its
 *  centroid via `world.callouts.get(id).centroid`. Unknown callouts fall
 *  back to the bombsite centroid so a typo never strands a bot. */

import type { CalloutId } from '../map/types';

export type Side = 'T' | 'CT';

export type Role =
  // T-side roles
  | 't_entry' | 't_support' | 't_lurker' | 't_igl' | 't_awper'
  // CT-side roles
  | 'ct_anchor_a' | 'ct_anchor_b' | 'ct_mid' | 'ct_rotator' | 'ct_awper';

export type StrategyId =
  // T pre-plant
  | 't_rush_a' | 't_rush_b'
  | 't_default_a' | 't_default_b'
  | 't_split_a'
  | 't_eco_save'
  // T post-plant (defending the planted bomb)
  | 't_post_plant_a' | 't_post_plant_b'
  // CT pre-plant
  | 'ct_default' | 'ct_stack_a' | 'ct_stack_b'
  | 'ct_aggro_mid' | 'ct_eco_save'
  // CT post-plant
  | 'ct_retake_a' | 'ct_retake_b';

/** Bucket names for matchmaking plans to economy state. The strategist
 *  computes the team's mean money and asks for plans in that bucket. */
export type EcoTier = 'eco' | 'normal' | 'force';

export interface PlanSlot {
  role: Role;
  /** Where the bot should go. */
  callout: CalloutId;
  /** Optional callout to face once on station — converts to a yaw at
   *  apply time so the bot pre-aims at the typical threat direction. */
  facingCallout?: CalloutId;
}

export interface PlanDef {
  id: StrategyId;
  side: Side;
  ecoTier: EcoTier;
  /** Plans tagged 'post_plant' are only chosen via the explicit
   *  post-plant trigger, not the round-start picker. */
  phase: 'pre_plant' | 'post_plant';
  /** Five slots, one per bot. Plans with fewer entries are not allowed
   *  — a five-bot team always gets five objectives. */
  slots: [PlanSlot, PlanSlot, PlanSlot, PlanSlot, PlanSlot];
  /** Free-form description for the debug HUD. */
  description: string;
}

// ============================================================
//  T side
// ============================================================

const T_RUSH_A: PlanDef = {
  id: 't_rush_a', side: 'T', ecoTier: 'normal', phase: 'pre_plant',
  description: 'All-in long onto A.',
  slots: [
    { role: 't_entry',   callout: 'A_LONG',  facingCallout: 'A_SITE' },
    { role: 't_support', callout: 'A_LONG',  facingCallout: 'A_SITE' },
    { role: 't_support', callout: 'A_SITE',  facingCallout: 'A_CROSS' },
    { role: 't_igl',     callout: 'A_SHORT', facingCallout: 'A_SITE' },
    { role: 't_lurker',  callout: 'CATWALK', facingCallout: 'A_SITE' },
  ],
};

const T_RUSH_B: PlanDef = {
  id: 't_rush_b', side: 'T', ecoTier: 'normal', phase: 'pre_plant',
  description: 'All-in tunnels onto B.',
  slots: [
    { role: 't_entry',   callout: 'B_SITE',           facingCallout: 'B_DOORS' },
    { role: 't_support', callout: 'B_SITE',           facingCallout: 'B_DOORS' },
    { role: 't_support', callout: 'B_TUNNELS_UPPER',  facingCallout: 'B_SITE' },
    { role: 't_igl',     callout: 'B_SITE',           facingCallout: 'BACK_PLAT' },
    { role: 't_lurker',  callout: 'B_TUNNELS_LOWER',  facingCallout: 'B_SITE' },
  ],
};

const T_DEFAULT_A: PlanDef = {
  id: 't_default_a', side: 'T', ecoTier: 'normal', phase: 'pre_plant',
  description: 'Slow play A — long control then execute.',
  slots: [
    { role: 't_awper',   callout: 'A_LONG',         facingCallout: 'A_SITE' },
    { role: 't_entry',   callout: 'OUTSIDE_LONG',   facingCallout: 'A_LONG' },
    { role: 't_support', callout: 'OUTSIDE_LONG',   facingCallout: 'A_LONG' },
    { role: 't_lurker',  callout: 'MID',            facingCallout: 'CT_MID' },
    { role: 't_igl',     callout: 'A_SHORT',        facingCallout: 'A_SITE' },
  ],
};

const T_DEFAULT_B: PlanDef = {
  id: 't_default_b', side: 'T', ecoTier: 'normal', phase: 'pre_plant',
  description: 'Slow play B — tunnels control then execute.',
  slots: [
    { role: 't_entry',   callout: 'B_TUNNELS_UPPER', facingCallout: 'B_SITE' },
    { role: 't_support', callout: 'B_TUNNELS_UPPER', facingCallout: 'B_SITE' },
    { role: 't_awper',   callout: 'B_TUNNELS_LOWER', facingCallout: 'B_SITE' },
    { role: 't_lurker',  callout: 'MID',             facingCallout: 'CT_MID' },
    { role: 't_igl',     callout: 'B_TUNNELS_LOWER', facingCallout: 'B_SITE' },
  ],
};

const T_SPLIT_A: PlanDef = {
  id: 't_split_a', side: 'T', ecoTier: 'normal', phase: 'pre_plant',
  description: 'Pinch A from long + cat.',
  slots: [
    { role: 't_entry',   callout: 'A_LONG',  facingCallout: 'A_SITE' },
    { role: 't_support', callout: 'A_LONG',  facingCallout: 'A_SITE' },
    { role: 't_support', callout: 'CATWALK', facingCallout: 'A_SITE' },
    { role: 't_lurker',  callout: 'CATWALK', facingCallout: 'A_SITE' },
    { role: 't_igl',     callout: 'MID',     facingCallout: 'CT_MID' },
  ],
};

const T_ECO_SAVE: PlanDef = {
  id: 't_eco_save', side: 'T', ecoTier: 'eco', phase: 'pre_plant',
  description: 'Eco — hold spawn, force CTs to come.',
  slots: [
    { role: 't_entry',   callout: 'T_SPAWN', facingCallout: 'OUTSIDE_LONG' },
    { role: 't_support', callout: 'T_SPAWN', facingCallout: 'T_RAMP' },
    { role: 't_support', callout: 'T_SPAWN', facingCallout: 'OUTSIDE_LONG' },
    { role: 't_lurker',  callout: 'T_SPAWN', facingCallout: 'B_TUNNELS_LOWER' },
    { role: 't_igl',     callout: 'T_SPAWN', facingCallout: 'T_RAMP' },
  ],
};

const T_POST_PLANT_A: PlanDef = {
  id: 't_post_plant_a', side: 'T', ecoTier: 'normal', phase: 'post_plant',
  description: 'Defend A plant — cover common defuse angles.',
  slots: [
    { role: 't_support', callout: 'A_LONG',  facingCallout: 'OUTSIDE_LONG' },
    { role: 't_support', callout: 'CATWALK', facingCallout: 'A_SHORT' },
    { role: 't_support', callout: 'A_SITE',  facingCallout: 'A_CROSS' },
    { role: 't_lurker',  callout: 'A_SHORT', facingCallout: 'CT_MID' },
    { role: 't_igl',     callout: 'PIT',     facingCallout: 'A_LONG' },
  ],
};

const T_POST_PLANT_B: PlanDef = {
  id: 't_post_plant_b', side: 'T', ecoTier: 'normal', phase: 'post_plant',
  description: 'Defend B plant — cover doors, plat, and tunnels.',
  slots: [
    { role: 't_support', callout: 'B_DOORS',          facingCallout: 'B_SITE' },
    { role: 't_support', callout: 'B_PLAT',           facingCallout: 'B_DOORS' },
    { role: 't_support', callout: 'B_SITE',           facingCallout: 'B_DOORS' },
    { role: 't_lurker',  callout: 'BACK_PLAT',        facingCallout: 'B_DOORS' },
    { role: 't_igl',     callout: 'B_TUNNELS_UPPER',  facingCallout: 'B_DOORS' },
  ],
};

// ============================================================
//  CT side
// ============================================================

const CT_DEFAULT: PlanDef = {
  id: 'ct_default', side: 'CT', ecoTier: 'normal', phase: 'pre_plant',
  description: 'Default 2A 2B 1mid setup.',
  slots: [
    { role: 'ct_anchor_a', callout: 'A_SITE',  facingCallout: 'A_LONG' },
    { role: 'ct_anchor_a', callout: 'A_CROSS', facingCallout: 'A_LONG' },
    { role: 'ct_anchor_b', callout: 'B_SITE',  facingCallout: 'B_DOORS' },
    { role: 'ct_anchor_b', callout: 'B_DOORS', facingCallout: 'B_TUNNELS_UPPER' },
    { role: 'ct_mid',      callout: 'CT_MID',  facingCallout: 'MID' },
  ],
};

const CT_STACK_A: PlanDef = {
  id: 'ct_stack_a', side: 'CT', ecoTier: 'normal', phase: 'pre_plant',
  description: 'Stack A — 3A 1B 1mid.',
  slots: [
    { role: 'ct_anchor_a', callout: 'A_SITE',  facingCallout: 'A_LONG' },
    { role: 'ct_anchor_a', callout: 'A_CROSS', facingCallout: 'A_LONG' },
    { role: 'ct_anchor_a', callout: 'CATWALK', facingCallout: 'A_SHORT' },
    { role: 'ct_anchor_b', callout: 'B_SITE',  facingCallout: 'B_DOORS' },
    { role: 'ct_mid',      callout: 'CT_MID',  facingCallout: 'MID' },
  ],
};

const CT_STACK_B: PlanDef = {
  id: 'ct_stack_b', side: 'CT', ecoTier: 'normal', phase: 'pre_plant',
  description: 'Stack B — 3B 1A 1mid.',
  slots: [
    { role: 'ct_anchor_a', callout: 'A_SITE',  facingCallout: 'A_LONG' },
    { role: 'ct_anchor_b', callout: 'B_SITE',  facingCallout: 'B_DOORS' },
    { role: 'ct_anchor_b', callout: 'B_DOORS', facingCallout: 'B_TUNNELS_UPPER' },
    { role: 'ct_anchor_b', callout: 'B_PLAT',  facingCallout: 'B_DOORS' },
    { role: 'ct_mid',      callout: 'CT_MID',  facingCallout: 'MID' },
  ],
};

const CT_AGGRO_MID: PlanDef = {
  id: 'ct_aggro_mid', side: 'CT', ecoTier: 'normal', phase: 'pre_plant',
  description: 'Push mid early to deny T crossing.',
  slots: [
    { role: 'ct_anchor_a', callout: 'A_SITE',  facingCallout: 'A_LONG' },
    { role: 'ct_anchor_b', callout: 'B_SITE',  facingCallout: 'B_DOORS' },
    { role: 'ct_mid',      callout: 'MID',     facingCallout: 'T_RAMP' },
    { role: 'ct_mid',      callout: 'MID_DOORS', facingCallout: 'T_RAMP' },
    { role: 'ct_anchor_a', callout: 'CATWALK', facingCallout: 'A_SHORT' },
  ],
};

const CT_ECO_SAVE: PlanDef = {
  id: 'ct_eco_save', side: 'CT', ecoTier: 'eco', phase: 'pre_plant',
  description: 'Eco — passive hold near spawn, save kit.',
  slots: [
    { role: 'ct_anchor_a', callout: 'A_SITE',   facingCallout: 'A_LONG' },
    { role: 'ct_anchor_b', callout: 'B_SITE',   facingCallout: 'B_DOORS' },
    { role: 'ct_anchor_a', callout: 'CT_SPAWN', facingCallout: 'A_CROSS' },
    { role: 'ct_anchor_b', callout: 'CT_SPAWN', facingCallout: 'B_DOORS' },
    { role: 'ct_mid',      callout: 'CT_MID',   facingCallout: 'MID' },
  ],
};

const CT_RETAKE_A: PlanDef = {
  id: 'ct_retake_a', side: 'CT', ecoTier: 'normal', phase: 'post_plant',
  description: 'Retake A — converge from cross + long + cat.',
  slots: [
    { role: 'ct_rotator', callout: 'A_SITE',  facingCallout: 'A_LONG' },
    { role: 'ct_rotator', callout: 'A_SITE',  facingCallout: 'A_SHORT' },
    { role: 'ct_rotator', callout: 'A_CROSS', facingCallout: 'A_SITE' },
    { role: 'ct_rotator', callout: 'A_LONG',  facingCallout: 'A_SITE' },
    { role: 'ct_rotator', callout: 'CATWALK', facingCallout: 'A_SITE' },
  ],
};

const CT_RETAKE_B: PlanDef = {
  id: 'ct_retake_b', side: 'CT', ecoTier: 'normal', phase: 'post_plant',
  description: 'Retake B — converge from doors + plat + tuns.',
  slots: [
    { role: 'ct_rotator', callout: 'B_SITE',           facingCallout: 'B_DOORS' },
    { role: 'ct_rotator', callout: 'B_SITE',           facingCallout: 'BACK_PLAT' },
    { role: 'ct_rotator', callout: 'B_DOORS',          facingCallout: 'B_SITE' },
    { role: 'ct_rotator', callout: 'B_TUNNELS_UPPER',  facingCallout: 'B_SITE' },
    { role: 'ct_rotator', callout: 'BACK_PLAT',        facingCallout: 'B_SITE' },
  ],
};

export const PLANS: Record<StrategyId, PlanDef> = {
  t_rush_a: T_RUSH_A,
  t_rush_b: T_RUSH_B,
  t_default_a: T_DEFAULT_A,
  t_default_b: T_DEFAULT_B,
  t_split_a: T_SPLIT_A,
  t_eco_save: T_ECO_SAVE,
  t_post_plant_a: T_POST_PLANT_A,
  t_post_plant_b: T_POST_PLANT_B,
  ct_default: CT_DEFAULT,
  ct_stack_a: CT_STACK_A,
  ct_stack_b: CT_STACK_B,
  ct_aggro_mid: CT_AGGRO_MID,
  ct_eco_save: CT_ECO_SAVE,
  ct_retake_a: CT_RETAKE_A,
  ct_retake_b: CT_RETAKE_B,
};

export function plansForSide(side: Side): PlanDef[] {
  return Object.values(PLANS).filter(p => p.side === side);
}
