/** Phase 3 GOAP — types only. The planner consumes a `WorldStateView`
 *  + per-bot personality and produces a `PlannedAction[]` queue.
 *
 *  We intentionally start with a *recipe-based* planner (small explicit
 *  rule set per Goal) rather than full regressive search. Reasoning:
 *    1. With six action kinds, search and recipes produce the same
 *       output; recipes are clearer to read and debug.
 *    2. The data shape is what the GOAP search would consume too
 *       (Goal, PlannedAction, ActionKind), so swapping the planner
 *       implementation later doesn't ripple through call sites.
 *    3. Phase 5 (utility actions, sync barriers) is when search starts
 *       paying for itself; we can graduate then. */

import type { CalloutId } from '../../map/types';

/** What the bot wants to accomplish, in priority order. The planner
 *  picks the highest-urgency unsatisfied goal and produces a plan
 *  toward it. */
export type GoalKind =
  | 'eliminate'        // a known enemy
  | 'plant'            // T carrier
  | 'defuse'           // CT near planted bomb
  | 'reachCallout'     // strategist objective
  | 'survive';         // low HP fallback (panic + retreat)

export interface Goal {
  kind: GoalKind;
  /** For 'eliminate': the enemy id we're hunting. */
  enemyId?: string;
  /** For 'reachCallout': the destination. */
  callout?: CalloutId;
  /** Higher = more urgent. The planner picks the highest urgency
   *  whose preconditions are satisfiable. */
  urgency: number;
}

export type ActionKind =
  | 'moveToCallout'
  | 'engage'
  | 'reload'
  | 'holdAngle'
  | 'plant'
  | 'defuse';

/** One step in a plan. Everything the action runner needs to execute
 *  is on the action; we don't carry references back to the planner. */
export interface PlannedAction {
  kind: ActionKind;
  /** For moveToCallout / holdAngle: destination callout. */
  callout?: CalloutId;
  /** For moveToCallout: world XZ to walk to (callout centroid by
   *  default; planner can override with a tactical-graph cover node). */
  x?: number;
  z?: number;
  /** For holdAngle: facing yaw in radians. */
  facingYaw?: number;
  /** For engage: target id. */
  targetId?: string;
  /** Human-readable label for the F4 HUD. */
  label: string;
}

/** Shape the planner consumes. Built per planning tick from
 *  WorldStateView + bot identity. Keeping this thin keeps the planner
 *  easy to unit-test on synthetic state. */
export interface PlanInputs {
  /** Self bot's id. */
  selfId: string;
  /** Self team. */
  side: 'T' | 'CT';
  /** Self position. */
  pos: { x: number; y: number; z: number };
  /** Self HP — drives 'survive' goal urgency. */
  hp: number;
  /** Has the C4 (only T carrier; null otherwise). */
  hasC4: boolean;
  /** Magazine fraction; planner uses this to decide reload urgency. */
  ammoFraction: number | null;
  /** Bomb mirror — phase + position when relevant. */
  bomb: {
    phase: 'carried' | 'planting' | 'planted' | 'defusing' | 'finished';
    site: 'A' | 'B' | null;
    pos: { x: number; y: number; z: number } | null;
  };
  /** Best visible enemy id + last-known position (or null). */
  visibleEnemyId: string | null;
  visibleEnemyPos: { x: number; y: number; z: number } | null;
  /** Recently spotted enemy (lower confidence) and its position. */
  recentEnemyId: string | null;
  recentEnemyPos: { x: number; y: number; z: number } | null;
  /** Strategist objective — callout id + world XZ + facing yaw. Null
   *  when no plan has been installed yet (early boot). */
  objective: { callout: CalloutId; x: number; z: number; facingYaw?: number } | null;
  /** Team alive count from this bot's perspective. */
  teammatesAlive: number;
  enemiesAlive: number;
  /** Side spawn centroid — the survive recipe retreats here. Filled
   *  from the brain's BrainContext.spawnX/Z. */
  spawnPos: { x: number; z: number };
}
