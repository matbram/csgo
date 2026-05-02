/** Recipe-based GOAP planner — phase 3 v1.
 *
 *  Picks the highest-urgency goal whose preconditions can be made true
 *  by a short action sequence. The "search" is a fixed table of
 *  recipes keyed by goal kind; this is equivalent to depth-≤3 forward
 *  BFS for the current six actions but easier to read, easier to
 *  debug, and faster (no branching). When the action library grows
 *  (Phase 5), swap the body for a real BFS keeping the same input +
 *  output types.
 *
 *  Personality bias enters via goal urgency:
 *    - aggression scales 'eliminate' urgency UP
 *    - patience scales 'eliminate' urgency DOWN; 'reachCallout' UP
 *    - riskAversion scales 'survive' threshold DOWN (cautious bots
 *      survive earlier)
 *
 *  Cost weights aren't used in v1 since we have one recipe per goal.
 *  Phase 3 v2 (or Phase 5) will introduce alternative recipes per
 *  goal (e.g. flank vs. swing-wide for 'eliminate') and pick by cost. */

import type { PlanInputs, PlannedAction, Goal } from './types';
import type { PersonalityProfile } from '../personality';

/** Plan toward the highest-urgency satisfiable goal.
 *  Returns null when no goal applies (idle bot waiting for orders). */
export function planFor(input: PlanInputs, personality: PersonalityProfile): { goal: Goal; plan: PlannedAction[] } | null {
  const goals = enumerateGoals(input, personality);
  if (goals.length === 0) return null;
  goals.sort((a, b) => b.urgency - a.urgency);
  for (const goal of goals) {
    const plan = recipeFor(goal, input);
    if (plan && plan.length > 0) return { goal, plan };
  }
  return null;
}

/** Build all goals applicable to the current state, with urgency
 *  numbers that already include personality bias. */
function enumerateGoals(s: PlanInputs, p: PersonalityProfile): Goal[] {
  const goals: Goal[] = [];

  // ── 'eliminate' — there's a known enemy worth shooting at.
  if (s.visibleEnemyId) {
    const base = 100;
    const bias = (p.aggression - p.patience) * 30;
    goals.push({ kind: 'eliminate', enemyId: s.visibleEnemyId, urgency: base + bias });
  } else if (s.recentEnemyId) {
    // Recent intel — lower urgency; lurkers reposition rather than
    // chase, aggressive bots commit.
    const base = 35;
    const bias = (p.aggression - p.patience * 0.5) * 25;
    goals.push({ kind: 'eliminate', enemyId: s.recentEnemyId, urgency: base + bias });
  }

  // ── 'plant' — T carrier on (or near) a bombsite.
  if (s.side === 'T' && s.hasC4 &&
      (s.bomb.phase === 'carried' || s.bomb.phase === 'planting')) {
    // Always urgent for the carrier — planting is the round.
    goals.push({ kind: 'plant', urgency: 110 });
  }

  // ── 'defuse' — CT near a planted bomb.
  if (s.side === 'CT' && s.bomb.phase === 'planted' && s.bomb.pos) {
    const dx = s.bomb.pos.x - s.pos.x;
    const dz = s.bomb.pos.z - s.pos.z;
    const dist = Math.hypot(dx, dz);
    // Within a sensible defuse approach window — let the planner queue
    // a MoveToCallout if not in range.
    if (dist < 25) {
      goals.push({ kind: 'defuse', urgency: 105 });
    }
  }

  // ── 'reachCallout' — strategist's objective.
  if (s.objective) {
    const base = 40;
    const bias = p.patience * 15;       // patient bots commit to anchors
    goals.push({ kind: 'reachCallout', callout: s.objective.callout, urgency: base + bias });
  }

  // ── 'survive' — outnumbered + low HP. RiskAversion lifts the
  //    threshold; aggressive bots fight to the last point of HP.
  const survivalThreshold = 25 + p.riskAversion * 30;
  if (s.hp <= survivalThreshold && s.enemiesAlive >= s.teammatesAlive + 1) {
    const urgency = 70 + (survivalThreshold - s.hp);
    goals.push({ kind: 'survive', urgency });
  }
  return goals;
}

/** Translate a goal into an ordered action sequence. v1 has one recipe
 *  per goal; phase 3 v2 will return multiple candidates and pick by
 *  cost. Returning null means "the planner has no idea" — caller
 *  should fall through to the legacy brain. */
function recipeFor(goal: Goal, s: PlanInputs): PlannedAction[] | null {
  switch (goal.kind) {
    case 'eliminate': {
      // Visible: shoot. Recent: walk toward last-known + then engage.
      if (s.visibleEnemyId === goal.enemyId && s.visibleEnemyPos) {
        return [
          {
            kind: 'engage', targetId: goal.enemyId,
            label: `engage ${shortId(goal.enemyId!)}`,
          },
        ];
      }
      if (s.recentEnemyPos) {
        return [
          {
            kind: 'moveToCallout',
            x: s.recentEnemyPos.x, z: s.recentEnemyPos.z,
            callout: undefined,
            label: `chase to ${fmtXZ(s.recentEnemyPos)}`,
          },
          {
            kind: 'engage', targetId: goal.enemyId,
            label: `engage ${shortId(goal.enemyId!)}`,
          },
        ];
      }
      return null;
    }

    case 'plant': {
      if (!s.bomb.site && !s.objective) return null;
      // If the strategist sent the carrier toward a site, use that
      // callout. Otherwise the bomb's own site (when carrying mid-
      // plant) or fall through to objective.
      const target = s.objective;
      if (target) {
        const onSite = s.bomb.phase === 'planting' || s.bomb.phase === 'carried';
        return onSite
          ? [{ kind: 'plant', label: 'plant' }]
          : [
              {
                kind: 'moveToCallout', callout: target.callout,
                x: target.x, z: target.z,
                label: `move to ${target.callout.toLowerCase()}`,
              },
              { kind: 'plant', label: 'plant' },
            ];
      }
      return [{ kind: 'plant', label: 'plant' }];
    }

    case 'defuse': {
      const bomb = s.bomb.pos!;
      const dx = bomb.x - s.pos.x;
      const dz = bomb.z - s.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= 1.4) return [{ kind: 'defuse', label: 'defuse' }];
      return [
        {
          kind: 'moveToCallout',
          x: bomb.x, z: bomb.z,
          callout: undefined,
          label: 'move to bomb',
        },
        { kind: 'defuse', label: 'defuse' },
      ];
    }

    case 'reachCallout': {
      if (!s.objective) return null;
      // Reload mid-rotate when low — the planner gets to pre-stage it
      // rather than the brain reactively interrupting movement.
      const reloadStep: PlannedAction[] = (s.ammoFraction !== null && s.ammoFraction < 0.3)
        ? [{ kind: 'reload', label: 'reload' }] : [];
      return [
        ...reloadStep,
        {
          kind: 'moveToCallout', callout: s.objective.callout,
          x: s.objective.x, z: s.objective.z,
          label: `move to ${s.objective.callout.toLowerCase()}`,
        },
        {
          kind: 'holdAngle', callout: s.objective.callout,
          facingYaw: s.objective.facingYaw,
          label: `hold ${s.objective.callout.toLowerCase()}`,
        },
      ];
    }

    case 'survive': {
      // Retreat toward the strategist's spawn-side objective if any,
      // otherwise rely on the legacy brain (Save state). For v1 we
      // surface this as a single "moveToCallout" toward the bot's
      // current objective when there is one — otherwise fall through.
      if (!s.objective) return null;
      return [
        {
          kind: 'moveToCallout', callout: s.objective.callout,
          x: s.objective.x, z: s.objective.z,
          label: `retreat to ${s.objective.callout.toLowerCase()}`,
        },
      ];
    }
  }
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(-6);
}

function fmtXZ(p: { x: number; z: number }): string {
  return `${p.x.toFixed(0)},${p.z.toFixed(0)}`;
}
