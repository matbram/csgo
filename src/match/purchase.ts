/** Buy menu purchase application. Validates affordability and team
 *  eligibility, mutates the player's inventory + money. Pure-ish:
 *  no DOM, no Babylon. */

import type { Character } from '../entities/character';
import type { MatchPlayerSlot } from './match';
import { getWeapon, type WeaponId } from '../weapons/definitions';
import { makeInstance } from '../weapons/inventory';

export interface PurchaseResult {
  ok: boolean;
  reason?: string;
}

export function purchaseWeapon(
  slot: MatchPlayerSlot,
  character: Character,
  weaponId: WeaponId,
): PurchaseResult {
  const def = getWeapon(weaponId);
  if (def.team !== 'both' && def.team !== slot.currentSide) {
    return { ok: false, reason: 'Not available on your side.' };
  }
  if (slot.money < def.cost) {
    return { ok: false, reason: `Need $${def.cost - slot.money} more.` };
  }
  if (!character.inventory) {
    return { ok: false, reason: 'No inventory slot.' };
  }
  const inv = character.inventory;
  const slotKey: 'primary' | 'secondary' | 'knife' | 'c4' =
    def.slot === 'primary' ? 'primary' :
    def.slot === 'secondary' ? 'secondary' :
    def.slot === 'knife' ? 'knife' :
    def.slot === 'c4' ? 'c4' :
    'secondary';

  // Don't allow re-buying the exact same weapon already in slot.
  const existing = inv[slotKey];
  if (existing && existing.def.id === weaponId) {
    return { ok: false, reason: 'Already owned.' };
  }

  inv[slotKey] = makeInstance(weaponId);
  slot.money -= def.cost;
  // Auto-switch to the new weapon for primary/secondary.
  if (slotKey === 'primary' || slotKey === 'secondary') {
    inv.active = slotKey;
  }
  return { ok: true };
}

export function purchaseArmor(
  slot: MatchPlayerSlot,
  character: Character,
  withHelmet: boolean,
): PurchaseResult {
  if (character.helmet) {
    return { ok: false, reason: 'Already have a helmet.' };
  }
  const cost = withHelmet ? 1000 : 650;
  if (slot.money < cost) {
    return { ok: false, reason: `Need $${cost - slot.money} more.` };
  }
  if (!withHelmet && character.armor >= 100) {
    return { ok: false, reason: 'Already have full armor.' };
  }
  slot.money -= cost;
  character.armor = 100;
  if (withHelmet) character.helmet = true;
  return { ok: true };
}

export function purchaseKit(
  slot: MatchPlayerSlot,
  character: Character,
): PurchaseResult {
  if (slot.currentSide !== 'CT') return { ok: false, reason: 'CT only.' };
  if (character.hasKit) return { ok: false, reason: 'Already have a kit.' };
  if (slot.money < 400) return { ok: false, reason: `Need $${400 - slot.money} more.` };
  slot.money -= 400;
  character.hasKit = true;
  return { ok: true };
}
