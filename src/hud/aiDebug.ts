/** F4-toggleable AI debug overlay. Shows two things:
 *
 *    - A text panel (top-right under the killfeed) listing each bot's
 *      brain state, current target, ammo, and known-enemy count.
 *    - Per-bot path lines drawn as world-space `LinesMesh`, colour-coded
 *      by team. Updated in-place each frame so we never allocate per
 *      frame.
 *
 *  Vision cones / LOS rays would be the natural next addition but are
 *  cheaper to read in code than to render — leaving them out keeps Pass
 *  3 lean. */

import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import { CreateLines } from '@babylonjs/core/Meshes/Builders/linesBuilder';
import { getScene } from '../engine/scene';
import type { Bot } from '../entities/bot';

interface PathLine {
  mesh: LinesMesh;
  pointBuffer: Vector3[];
}

const T_COLOR = new Color3(0.85, 0.55, 0.20);
const CT_COLOR = new Color3(0.30, 0.55, 0.95);
/** Maximum waypoints we'll ever draw per path. Babylon's `instance`
 *  update path requires a constant point count, so we always feed exactly
 *  this many — extras collapse to the path's last point so they don't
 *  show as dangling segments. */
const PATH_POINTS_CAP = 64;

export class AiDebugHud {
  private readonly host: HTMLElement;
  private readonly panel: HTMLDivElement;
  private readonly pathLines = new Map<string, PathLine>();
  private enabled = false;

  constructor() {
    const host = document.getElementById('hud-root');
    if (!host) throw new Error('#hud-root not found');
    this.host = host;
    this.panel = document.createElement('div');
    this.panel.className = 'ai-debug-panel hidden';
    this.host.appendChild(this.panel);
  }

  toggle(): void {
    this.enabled = !this.enabled;
    this.panel.classList.toggle('hidden', !this.enabled);
    if (!this.enabled) {
      // Hide path meshes when disabled so they don't render.
      for (const pl of this.pathLines.values()) pl.mesh.setEnabled(false);
    }
  }

  /** Update the panel + path lines. Called once per render frame; cheap
   *  enough that we don't gate on `enabled` for the panel-text update
   *  (it's invisible anyway when disabled). The expensive path-mesh
   *  refresh is gated. */
  update(bots: ReadonlyArray<Bot>): void {
    if (!this.enabled) return;
    this.refreshPanel(bots);
    this.refreshPaths(bots);
  }

  private refreshPanel(bots: ReadonlyArray<Bot>): void {
    const rows: string[] = [];
    rows.push('<div class="ai-debug-title">AI</div>');
    for (const bot of bots) {
      const c = bot.character;
      const inv = c.inventory;
      const inst = inv ? (
        inv.active === 'primary' ? inv.primary :
        inv.active === 'secondary' ? inv.secondary :
        inv.active === 'knife' ? inv.knife :
        inv.c4
      ) : null;
      const ammo = inst && inst.def.magazine > 0 ? `${inst.ammoMag}/${inst.ammoReserve}` : '-';
      const wpn = inst?.def.id ?? '-';
      const known = bot.perception.known.size;
      const status = c.alive ? bot.brain.state : 'DEAD';
      const teamCls = c.team === 'T' ? 't' : 'ct';
      rows.push(`<div class="ai-row ${teamCls}">
        <span class="id">${escape(bot.id)}</span>
        <span class="state">${escape(status)}</span>
        <span class="hp">${c.hp}</span>
        <span class="wpn">${escape(wpn)}</span>
        <span class="ammo">${escape(ammo)}</span>
        <span class="known">k:${known}</span>
      </div>`);
    }
    this.panel.innerHTML = rows.join('');
  }

  private refreshPaths(bots: ReadonlyArray<Bot>): void {
    const scene = getScene();
    for (const bot of bots) {
      let pl = this.pathLines.get(bot.id);
      if (!bot.character.alive || !bot.path || bot.path.length === 0) {
        if (pl) pl.mesh.setEnabled(false);
        continue;
      }
      // Compose the point list: bot's current pos → upcoming waypoints.
      // Pad to PATH_POINTS_CAP by repeating the last point so the in-place
      // update has a fixed buffer length.
      const start = bot.character.pos;
      const remaining = bot.path.slice(bot.pathIdx);
      const totalPoints = Math.min(PATH_POINTS_CAP, 1 + remaining.length);
      if (!pl) {
        const points: Vector3[] = [];
        for (let i = 0; i < PATH_POINTS_CAP; i++) {
          points.push(new Vector3(start.x, start.y + 0.05, start.z));
        }
        const mesh = CreateLines(`ai-path-${bot.id}`, { points, updatable: true }, scene);
        mesh.color = bot.character.team === 'T' ? T_COLOR : CT_COLOR;
        mesh.isPickable = false;
        pl = { mesh, pointBuffer: points };
        this.pathLines.set(bot.id, pl);
      }
      const buf = pl.pointBuffer;
      buf[0]!.set(start.x, start.y + 0.05, start.z);
      for (let i = 1; i < PATH_POINTS_CAP; i++) {
        const wpIdx = i - 1;
        const last = remaining[remaining.length - 1] ?? null;
        const src = wpIdx < remaining.length ? remaining[wpIdx]! : last;
        if (src) buf[i]!.set(src.x, src.y + 0.05, src.z);
        else buf[i]!.copyFrom(buf[i - 1]!);
      }
      // Babylon's CreateLines with `instance` re-uses the existing buffer.
      CreateLines(`ai-path-${bot.id}`, { points: buf, instance: pl.mesh });
      pl.mesh.color = bot.character.team === 'T' ? T_COLOR : CT_COLOR;
      pl.mesh.setEnabled(true);
      void totalPoints;
    }
  }

  dispose(): void {
    for (const pl of this.pathLines.values()) pl.mesh.dispose();
    this.pathLines.clear();
    this.panel.remove();
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;'
  );
}
