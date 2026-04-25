/** Per-bot buy logic. Pass 3: single-bot decisions only — no team-level
 *  coordination (e.g. "the team has 3 AWPs already, this bot picks a
 *  rifle"). The strategist (M5) will handle team-level coordination via
 *  the blackboard.
 *
 *  Decision tree mirrors the design doc:
 *    money >= 4500 → full buy (rifle + helmet)
 *    money >= 2500 → force buy (cheap primary or armor + pistol upgrade)
 *    money <= 1500 → save (keep what you have; armor only if already none)
 *  CT bots prefer kit when money allows. T carrier bots never go without
 *  a primary if affordable, so they aren't trying to plant naked. */

import type { Character } from '../entities/character';
import type { MatchPlayerSlot } from '../match/match';
import { purchaseWeapon, purchaseArmor, purchaseKit } from '../match/purchase';
import { getWeapon } from '../weapons/definitions';

const FULL_BUY_THRESHOLD = 4500;
const FORCE_BUY_THRESHOLD = 2500;
const SAVE_CEILING = 1500;

/** Side-appropriate primary the bot will reach for first. */
function preferredPrimary(side: 'T' | 'CT'): 'ak47' | 'm4a4' {
  return side === 'T' ? 'ak47' : 'm4a4';
}

/** Run a bot's buy plan once. Idempotent: re-running a successful buy
 *  step is a no-op (purchaseWeapon refuses to duplicate the same weapon
 *  in a slot, etc.). The caller should invoke this during freeze, when
 *  the bot is in their team's buy zone. */
export function runBotBuy(slot: MatchPlayerSlot, character: Character): void {
  if (!character.alive) return;
  if (!character.inventory) return;
  const side = slot.currentSide;
  const money = slot.money;

  // Save: only top up armor if we have none, otherwise skip.
  if (money <= SAVE_CEILING) {
    if (character.armor === 0 && money >= 650) {
      purchaseArmor(slot, character, false);
    }
    return;
  }

  const wantPrimary = !character.inventory.primary;

  // Full buy.
  if (money >= FULL_BUY_THRESHOLD) {
    if (wantPrimary) {
      purchaseWeapon(slot, character, preferredPrimary(side));
    }
    if (!character.helmet) {
      purchaseArmor(slot, character, true);
    }
    if (side === 'CT' && !character.hasKit) {
      purchaseKit(slot, character);
    }
    return;
  }

  // Force buy. Prefer the rifle if we can afford it after armor; otherwise
  // armor + pistol stays.
  if (money >= FORCE_BUY_THRESHOLD) {
    const primaryCost = getWeapon(preferredPrimary(side)).cost;
    const armorCost = character.helmet ? 0 : 1000;
    if (wantPrimary && money >= primaryCost) {
      purchaseWeapon(slot, character, preferredPrimary(side));
      if (!character.helmet && slot.money >= armorCost) {
        purchaseArmor(slot, character, true);
      }
    } else if (!character.helmet && money >= 1000) {
      purchaseArmor(slot, character, true);
    } else if (character.armor === 0 && money >= 650) {
      purchaseArmor(slot, character, false);
    }
    if (side === 'CT' && !character.hasKit && slot.money >= 400) {
      purchaseKit(slot, character);
    }
    return;
  }

  // Default: anti-eco. Half-armor if we have none; consider a cheap pistol
  // upgrade in a future pass.
  if (character.armor === 0 && money >= 650) {
    purchaseArmor(slot, character, false);
  }
}
