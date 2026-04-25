/** Pure economy logic. Given a per-player money snapshot, a per-team
 *  loss streak, and a list of round events, compute the new money state.
 *
 *  This module has no Babylon dependencies. Tests live in economy.test.ts.
 */

import type { WeaponId } from '../weapons/definitions';

export type Side = 'T' | 'CT';

export const STARTING_MONEY = 800;
export const MAX_MONEY = 16_000;

export interface PerPlayerMoney {
  /** Stable id (e.g. 'local', 'bot-3'). */
  id: string;
  /** Side at the time of the round. */
  side: Side;
  /** Money before round-end rewards are applied. */
  money: number;
  /** Whether the player was alive at round end (matters for some bonuses). */
  aliveAtEnd: boolean;
  /** Whether the player planted the bomb this round. */
  planted: boolean;
  /** Whether the player defused the bomb this round (CT only). */
  defused: boolean;
  /** Per-kill weapon IDs this player got this round. Used for kill rewards. */
  killWeapons: WeaponId[];
}

export interface LossStreaks {
  T: number;   // number of consecutive losses going INTO this round
  CT: number;
}

export type RoundReason =
  | 'ct_time'           // round time expired, bomb not planted, CTs win
  | 'ct_eliminate'      // all Ts dead (and no plant) → CTs win
  | 'ct_defuse'         // bomb defused
  | 't_eliminate'       // all CTs dead → Ts win
  | 't_explode';        // bomb exploded

export interface RoundOutcome {
  winner: Side;
  reason: RoundReason;
  /** Did the bomb get planted at any point this round? */
  bombPlanted: boolean;
}

export interface ApplyResult {
  players: PerPlayerMoney[];      // updated money capped at MAX_MONEY
  newStreaks: LossStreaks;
  /** Diagnostic per-player diffs. */
  rewards: Map<string, RewardBreakdown>;
}

export interface RewardBreakdown {
  base: number;            // round outcome reward
  lossBonus: number;       // loss streak reward (0 for winners)
  killReward: number;      // sum of per-kill rewards
  plantBonus: number;      // +300 if planter
  defuseBonus: number;     // +300 if defuser
  bombLossBonus: number;   // +800 if T side loses but bomb was planted
  total: number;
  newMoney: number;
}

const KILL_REWARDS: Record<string, number> = {
  // Rifles, pistols, sniper non-AWP, SMG, shotgun, etc.
  ak47: 300,
  m4a4: 300,
  usp_s: 300,
  glock18: 300,
  awp: 100,
  knife: 1500,
  c4: 0,
};

const LOSS_BONUS_TABLE = [1400, 1900, 2400, 2900, 3400] as const;

const ROUND_BASE_WIN_T_BOMB = 3500;        // T win via bomb explosion
const ROUND_BASE_WIN_CT_DEFUSE = 3500;     // CT win via defuse
const ROUND_BASE_WIN_DEFAULT = 3250;       // any other win

const PLANT_BONUS = 300;
const DEFUSE_BONUS = 300;
const T_LOSS_PLANTED_BONUS = 800;          // T side bomb-planted-but-lost adds this on top of loss bonus

export function computeKillReward(weapon: WeaponId): number {
  return KILL_REWARDS[weapon] ?? 300;
}

export function lossBonusFor(streak: number): number {
  if (streak <= 0) return 0;
  const idx = Math.min(streak - 1, LOSS_BONUS_TABLE.length - 1);
  return LOSS_BONUS_TABLE[idx]!;
}

/** Apply round-end economy. Pure: returns new state, does not mutate input. */
export function applyRoundEnd(
  players: ReadonlyArray<PerPlayerMoney>,
  streaks: LossStreaks,
  outcome: RoundOutcome,
): ApplyResult {
  const winner = outcome.winner;
  const newPlayers: PerPlayerMoney[] = [];
  const rewards = new Map<string, RewardBreakdown>();

  // Compute base reward for winners.
  let winBase = ROUND_BASE_WIN_DEFAULT;
  if (winner === 'T' && outcome.reason === 't_explode') winBase = ROUND_BASE_WIN_T_BOMB;
  if (winner === 'CT' && outcome.reason === 'ct_defuse') winBase = ROUND_BASE_WIN_CT_DEFUSE;

  // Update streaks: winner resets, loser increments.
  const newStreaks: LossStreaks = {
    T: winner === 'T' ? 0 : streaks.T + 1,
    CT: winner === 'CT' ? 0 : streaks.CT + 1,
  };

  for (const p of players) {
    const isWinner = p.side === winner;
    const breakdown: RewardBreakdown = {
      base: 0, lossBonus: 0, killReward: 0,
      plantBonus: 0, defuseBonus: 0, bombLossBonus: 0,
      total: 0, newMoney: 0,
    };

    if (isWinner) {
      breakdown.base = winBase;
    } else {
      breakdown.lossBonus = lossBonusFor(newStreaks[p.side]);
      // T side bonus when bomb was planted but they still lost.
      if (p.side === 'T' && outcome.bombPlanted && !isWinner) {
        breakdown.bombLossBonus = T_LOSS_PLANTED_BONUS;
      }
    }

    // Kill rewards (apply regardless of round outcome).
    let killTotal = 0;
    for (const w of p.killWeapons) killTotal += computeKillReward(w);
    breakdown.killReward = killTotal;

    if (p.planted) breakdown.plantBonus = PLANT_BONUS;
    if (p.defused) breakdown.defuseBonus = DEFUSE_BONUS;

    breakdown.total =
      breakdown.base +
      breakdown.lossBonus +
      breakdown.killReward +
      breakdown.plantBonus +
      breakdown.defuseBonus +
      breakdown.bombLossBonus;
    breakdown.newMoney = clampMoney(p.money + breakdown.total);

    newPlayers.push({
      ...p,
      money: breakdown.newMoney,
      // Reset round-scoped flags so callers can reuse.
      planted: false,
      defused: false,
      killWeapons: [],
    });
    rewards.set(p.id, breakdown);
  }

  return { players: newPlayers, newStreaks, rewards };
}

export function clampMoney(m: number): number {
  if (m < 0) return 0;
  if (m > MAX_MONEY) return MAX_MONEY;
  return Math.floor(m);
}

/** Reset all per-player money to STARTING_MONEY (used at halftime / new match). */
export function resetMoneyForHalftime(players: ReadonlyArray<PerPlayerMoney>): PerPlayerMoney[] {
  return players.map((p) => ({
    ...p,
    money: STARTING_MONEY,
    planted: false,
    defused: false,
    killWeapons: [],
  }));
}
