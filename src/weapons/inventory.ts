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
  /** Current scope zoom level. 0 = unscoped; 1..def.scopeLevels = zoom step.
   *  Always 0 for weapons without a scope. Reset to 0 on weapon switch,
   *  reload, fire (for sniper-style weapons), and round/death. */
  scopeLevel: number;
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
    scopeLevel: 0,
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

/** Canonical scroll-wheel cycle order. Matches CS:GO: primary, secondary,
 *  knife, c4. Slots without an instance are skipped at cycle time. */
const SCROLL_ORDER: ReadonlyArray<InventorySlotKey> = ['primary', 'secondary', 'knife', 'c4'];

function slotInstance(inv: Inventory, slot: InventorySlotKey): WeaponInstance | undefined {
  switch (slot) {
    case 'primary': return inv.primary;
    case 'secondary': return inv.secondary;
    case 'knife': return inv.knife;
    case 'c4': return inv.c4;
  }
}

/** Return the next inventory slot the wheel should land on, given a step
 *  direction (+1 = next, -1 = previous). Skips empty slots. Returns null
 *  if there's only one owned slot (nothing else to switch to). */
export function nextScrollSlot(inv: Inventory, dir: 1 | -1): InventorySlotKey | null {
  const startIdx = SCROLL_ORDER.indexOf(inv.active);
  if (startIdx < 0) return null;
  const n = SCROLL_ORDER.length;
  for (let step = 1; step <= n; step++) {
    const idx = (startIdx + dir * step + n * n) % n;
    const slot = SCROLL_ORDER[idx]!;
    if (slotInstance(inv, slot)) return slot;
  }
  return null;
}

/** Switch to slot if it has an instance, applying deploy delay. The
 *  outgoing instance loses its scope, so coming back to it doesn't
 *  surprise the player with stale zoom. */
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
  // Drop scope on the outgoing weapon.
  const outgoing = activeInstance(inv);
  if (outgoing) outgoing.scopeLevel = 0;
  inv.active = slot;
  inst.state = 'deploying';
  inst.stateUntilMs = nowMs + inst.def.deployMs;
  inst.sprayIndex = 0;
  inst.scopeLevel = 0;
  return true;
}

/** Cycle the scope on the given instance: 0 → 1 → … → max → 0. Returns the
 *  new scope level. No-op for weapons without a scope. */
export function cycleScope(inst: WeaponInstance): number {
  const max = inst.def.scopeLevels ?? 0;
  if (max <= 0) return 0;
  // Don't allow scoping while still deploying or reloading — feels jarring
  // and would let the player hide their reload tell.
  if (inst.state === 'deploying' || inst.state === 'reloading') return inst.scopeLevel;
  inst.scopeLevel = (inst.scopeLevel + 1) % (max + 1);
  return inst.scopeLevel;
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
