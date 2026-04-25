/** Per-character inventory and weapon instance state. The character holds
 *  weapon *instances* — copies of the weapon def with mutable state
 *  (magazine, ready/reloading/deploying, spray index, etc.). */

import type { WeaponDef, WeaponId, WeaponSlot } from './definitions';
import { getWeapon } from './definitions';

export type WeaponInstanceState = 'ready' | 'firing' | 'reloading' | 'deploying' | 'empty';

export interface WeaponInstance {
  def: WeaponDef;
  ammoMag: number;
  ammoReserve: number;
  state: WeaponInstanceState;
  /** Wall time (ms) at which the current state ends. For `ready` this is 0. */
  stateUntilMs: number;
  /** Time of last shot (ms). Used for spray decay and fire-rate cap. */
  lastFireMs: number;
  /** Spray index — increments on each shot in a continuous burst,
   *  resets to 0 when (now - lastFireMs) > recoilDecayMs. */
  sprayIndex: number;
}

export function makeInstance(id: WeaponId, opts?: { mag?: number; reserve?: number }): WeaponInstance {
  const def = getWeapon(id);
  return {
    def,
    ammoMag: opts?.mag ?? def.magazine,
    ammoReserve: opts?.reserve ?? def.reserve,
    state: 'ready',
    stateUntilMs: 0,
    lastFireMs: -Infinity,
    sprayIndex: 0,
  };
}

export type InventorySlotKey = 'primary' | 'secondary' | 'knife' | 'c4';

export interface Inventory {
  primary?: WeaponInstance;
  secondary?: WeaponInstance;
  knife: WeaponInstance;
  c4?: WeaponInstance;
  /** Currently-active slot. Always points to a present instance. */
  active: InventorySlotKey;
}

export function defaultInventory(team: 'T' | 'CT'): Inventory {
  const inv: Inventory = {
    knife: makeInstance('knife'),
    secondary: makeInstance(team === 'T' ? 'glock18' : 'usp_s'),
    active: 'secondary',
  };
  return inv;
}

export function activeInstance(inv: Inventory): WeaponInstance {
  switch (inv.active) {
    case 'primary': return inv.primary ?? inv.secondary ?? inv.knife;
    case 'secondary': return inv.secondary ?? inv.knife;
    case 'knife': return inv.knife;
    case 'c4': return inv.c4 ?? inv.knife;
  }
}

/** Best non-knife slot, in priority: primary > secondary > knife. */
export function bestSlot(inv: Inventory): InventorySlotKey {
  if (inv.primary) return 'primary';
  if (inv.secondary) return 'secondary';
  return 'knife';
}

/** Switch to slot if it has an instance, applying deploy delay. */
export function switchTo(inv: Inventory, slot: InventorySlotKey, nowMs: number): boolean {
  let inst: WeaponInstance | undefined;
  switch (slot) {
    case 'primary': inst = inv.primary; break;
    case 'secondary': inst = inv.secondary; break;
    case 'knife': inst = inv.knife; break;
    case 'c4': inst = inv.c4; break;
  }
  if (!inst) return false;
  if (inv.active === slot) return false;
  inv.active = slot;
  inst.state = 'deploying';
  inst.stateUntilMs = nowMs + inst.def.deployMs;
  inst.sprayIndex = 0;
  return true;
}

/** Map slot key to inventory key — separate fns for type help. */
export function slotKeyForDef(def: WeaponDef): InventorySlotKey {
  switch (def.slot) {
    case 'primary': return 'primary';
    case 'secondary': return 'secondary';
    case 'knife': return 'knife';
    case 'c4': return 'c4';
    case 'grenade': return 'secondary'; // M2 doesn't ship grenades; placeholder mapping
  }
}
