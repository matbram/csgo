/** Buy menu — DOM modal with grid of weapons/equipment. Closes when:
 *  - the player walks out of their buy zone
 *  - buy phase ends
 *  - the player presses B / Esc
 *
 *  Calls a `purchase()` callback when an item is clicked; the callback is
 *  responsible for affordability/eligibility checks and inventory mutation.
 *  This keeps the HUD pure presentation. */

import type { WeaponDef, WeaponId } from '../weapons/definitions';
import { WEAPONS } from '../weapons/definitions';

export interface BuyContext {
  side: 'T' | 'CT';
  money: number;
  inBuyZone: boolean;
  buyPhase: boolean;
  helmet: boolean;
  armor: number;
  hasKit: boolean;
  hasPrimary: WeaponId | null;
  hasSecondary: WeaponId | null;
  /** Per-grenade counts so the buy tiles can show "x1 / x2" and grey
   *  out when the carry cap is reached. */
  grenades: { he: number; flashbang: number; smoke: number; molotov: number; total: number };
}

export interface PurchaseRequest {
  kind: 'weapon' | 'armor' | 'helmet' | 'kit';
  weapon?: WeaponId;
}

export type PurchaseHandler = (req: PurchaseRequest) => { ok: boolean; reason?: string };

export class BuyMenu {
  private readonly host: HTMLElement;
  private readonly root: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private visible = false;
  private ctx: BuyContext | null = null;
  private readonly handler: PurchaseHandler;
  /** Cached fingerprint of the last-rendered context. We only rebuild the
   *  grid when this changes, so per-tick refreshes don't destroy buttons
   *  mid-click. */
  private lastRenderHash = '';

  constructor(host: HTMLElement, handler: PurchaseHandler) {
    this.host = host;
    this.handler = handler;
    this.root = document.createElement('div');
    this.root.className = 'buy-menu hidden';
    this.root.innerHTML = `
      <div class="buy-card">
        <div class="buy-header">
          <div class="buy-title">BUY MENU</div>
          <div class="buy-money" id="buy-money">$0</div>
        </div>
        <div class="buy-grid" id="buy-grid"></div>
        <div class="buy-hint" id="buy-hint"></div>
        <div class="buy-footer">B to close · 1–9 hotkeys not yet wired · Press B again or step out of buy zone</div>
      </div>
    `;
    this.grid = this.root.querySelector('#buy-grid') as HTMLDivElement;
    this.hint = this.root.querySelector('#buy-hint') as HTMLDivElement;
    this.host.appendChild(this.root);
  }

  open(ctx: BuyContext): void {
    this.ctx = ctx;
    this.visible = true;
    this.lastRenderHash = '';        // force first render
    this.render();
    this.root.classList.remove('hidden');
  }

  close(): void {
    this.visible = false;
    this.root.classList.add('hidden');
  }

  toggle(ctx: BuyContext): void {
    if (this.visible) this.close();
    else this.open(ctx);
  }

  isOpen(): boolean { return this.visible; }

  /** Caller polls this each sim tick to keep the menu live. We only
   *  rebuild the DOM if the relevant context changed, so buttons aren't
   *  recreated mid-click. */
  refresh(ctx: BuyContext): void {
    this.ctx = ctx;
    if (!this.visible) return;
    if (!ctx.buyPhase || !ctx.inBuyZone) {
      this.close();
      return;
    }
    const hash = hashCtx(ctx);
    if (hash === this.lastRenderHash) return;
    this.lastRenderHash = hash;
    this.render();
  }

  private render(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    (this.root.querySelector('#buy-money') as HTMLDivElement).textContent = `$${ctx.money}`;

    const groups: Array<{ title: string; items: BuyItem[] }> = [
      { title: 'Pistols', items: pistolItems(ctx) },
      { title: 'Rifles & Sniper', items: rifleItems(ctx) },
      { title: 'Grenades', items: grenadeItems(ctx) },
      { title: 'Equipment', items: equipmentItems(ctx) },
    ];

    this.grid.innerHTML = '';
    for (const g of groups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'buy-group';
      const title = document.createElement('div');
      title.className = 'buy-group-title';
      title.textContent = g.title;
      groupEl.appendChild(title);
      const list = document.createElement('div');
      list.className = 'buy-list';
      for (const it of g.items) {
        const tile = document.createElement('button');
        tile.className = 'buy-tile' + (it.available ? '' : ' unavailable');
        // Note: not using `disabled` so the click handler still fires and
        // can surface the reason ("Need $X more", "Not on your side", etc.)
        // — silently dead buttons are bad UX.
        tile.title = it.note ?? '';
        const subline = it.available
          ? (it.cost === 0 ? 'OWNED' : `$${it.cost}`)
          : (it.note ? it.note : `$${it.cost}`);
        tile.innerHTML = `
          <div class="buy-tile-name">${escapeHtml(it.label)}</div>
          <div class="buy-tile-cost">${escapeHtml(subline)}</div>
        `;
        tile.addEventListener('click', () => this.handle(it));
        list.appendChild(tile);
      }
      groupEl.appendChild(list);
      this.grid.appendChild(groupEl);
    }
    this.hint.textContent = '';
  }

  private handle(it: BuyItem): void {
    const result = this.handler(it.req);
    if (!result.ok) {
      this.hint.textContent = result.reason ?? 'Cannot purchase.';
      return;
    }
    this.hint.textContent = `Purchased ${it.label}.`;
    // Force a fresh render so the new state (lower money, owned weapon,
    // etc.) shows immediately rather than waiting for the next refresh().
    this.lastRenderHash = '';
  }
}

function hashCtx(c: BuyContext): string {
  return [
    c.side, c.money, c.inBuyZone ? 1 : 0, c.buyPhase ? 1 : 0,
    c.helmet ? 1 : 0, c.armor, c.hasKit ? 1 : 0,
    c.hasPrimary ?? '-', c.hasSecondary ?? '-',
    c.grenades.he, c.grenades.flashbang, c.grenades.smoke, c.grenades.molotov,
  ].join('|');
}

interface BuyItem {
  id: string;
  label: string;
  cost: number;
  available: boolean;
  note?: string;
  req: PurchaseRequest;
}

function eligible(def: WeaponDef, ctx: BuyContext): boolean {
  if (def.team !== 'both' && def.team !== ctx.side) return false;
  return true;
}

function buyItem(def: WeaponDef, ctx: BuyContext): BuyItem {
  const eligibleSide = eligible(def, ctx);
  const affordable = ctx.money >= def.cost;
  const owned =
    (def.slot === 'primary' && ctx.hasPrimary === def.id) ||
    (def.slot === 'secondary' && ctx.hasSecondary === def.id);
  const note = !eligibleSide ? 'Not available on your side' :
    !affordable ? `Need $${def.cost - ctx.money} more` :
    owned ? 'Already owned' : '';
  return {
    id: def.id, label: def.displayName, cost: def.cost,
    available: eligibleSide && affordable && !owned,
    note,
    req: { kind: 'weapon', weapon: def.id },
  };
}

function pistolItems(ctx: BuyContext): BuyItem[] {
  return (['glock18', 'usp_s'] as WeaponId[])
    .map(id => buyItem(WEAPONS[id], ctx));
}

function rifleItems(ctx: BuyContext): BuyItem[] {
  return (['ak47', 'm4a4', 'awp'] as WeaponId[])
    .map(id => buyItem(WEAPONS[id], ctx));
}

function grenadeItems(ctx: BuyContext): BuyItem[] {
  const out: BuyItem[] = [];
  const kinds: Array<{ id: 'he' | 'flashbang' | 'smoke' | 'molotov'; cap: number }> = [
    { id: 'he', cap: 1 },
    { id: 'flashbang', cap: 2 },
    { id: 'smoke', cap: 1 },
    { id: 'molotov', cap: 1 },
  ];
  const hitTotal = ctx.grenades.total >= 4;
  for (const k of kinds) {
    const def = WEAPONS[k.id];
    const owned = ctx.grenades[k.id];
    const atKindCap = owned >= k.cap;
    const affordable = ctx.money >= def.cost;
    const eligibleSide = eligible(def, ctx);
    const note = !eligibleSide ? 'Not available on your side' :
      atKindCap ? `Carry cap (x${k.cap})` :
      hitTotal ? 'Carry cap (4 total)' :
      !affordable ? `Need $${def.cost - ctx.money} more` : '';
    const labelSuffix = owned > 0 ? `  ×${owned}` : '';
    out.push({
      id: def.id, label: def.displayName + labelSuffix, cost: def.cost,
      available: eligibleSide && affordable && !atKindCap && !hitTotal,
      note,
      req: { kind: 'weapon', weapon: def.id },
    });
  }
  return out;
}

function equipmentItems(ctx: BuyContext): BuyItem[] {
  const items: BuyItem[] = [];
  // Kevlar
  items.push({
    id: 'armor', label: ctx.helmet ? 'Kevlar (full set owned)' : 'Kevlar Vest',
    cost: 650,
    available: !ctx.helmet && ctx.armor < 100 && ctx.money >= 650,
    note: ctx.helmet ? 'Already owned with helmet' :
      ctx.armor >= 100 ? 'Already at max armor' :
      ctx.money < 650 ? `Need $${650 - ctx.money} more` : '',
    req: { kind: 'armor' },
  });
  // Kevlar + Helmet
  items.push({
    id: 'helmet', label: 'Kevlar + Helmet',
    cost: 1000,
    available: !ctx.helmet && ctx.money >= 1000,
    note: ctx.helmet ? 'Already owned' :
      ctx.money < 1000 ? `Need $${1000 - ctx.money} more` : '',
    req: { kind: 'helmet' },
  });
  // Defuse kit (CT only)
  if (ctx.side === 'CT') {
    items.push({
      id: 'kit', label: 'Defuse Kit',
      cost: 400,
      available: !ctx.hasKit && ctx.money >= 400,
      note: ctx.hasKit ? 'Already owned' :
        ctx.money < 400 ? `Need $${400 - ctx.money} more` : '',
      req: { kind: 'kit' },
    });
  }
  return items;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;'
  );
}
