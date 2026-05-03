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
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { getScene } from '../engine/scene';
import type { Bot } from '../entities/bot';
import type { TeamBlackboard } from '../ai/blackboard';
import type { WorldStateView } from '../ai/world/state';
import type { TacticalGraph } from '../ai/world/tacticalGraph';

interface PathLine {
  mesh: LinesMesh;
  pointBuffer: Vector3[];
}

const T_COLOR = new Color3(0.85, 0.55, 0.20);
const CT_COLOR = new Color3(0.30, 0.55, 0.95);
const COVER_COLOR = new Color3(0.20, 0.85, 0.95);
const COVER_HEAD_GLITCH_COLOR = new Color3(0.95, 0.65, 0.30);
const PEEK_COLOR = new Color3(0.85, 0.95, 0.40);
const HOLD_COLOR = new Color3(0.95, 0.30, 0.55);
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
  /** One-shot built-and-cached tactical visuals — created the first
   *  time we render with a graph; toggled on/off when the F4 overlay
   *  flips. Rebuilds are not supported (the graph is per-map, baked at
   *  boot — no runtime re-derivation). */
  private tacticalMeshes: Mesh[] = [];
  private tacticalLines: LinesMesh[] = [];
  private tacticalBuiltForGraph: TacticalGraph | null = null;

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
      // Hide path + tactical meshes when disabled so they don't render.
      for (const pl of this.pathLines.values()) pl.mesh.setEnabled(false);
      for (const m of this.tacticalMeshes) m.setEnabled(false);
      for (const l of this.tacticalLines) l.setEnabled(false);
    } else {
      for (const m of this.tacticalMeshes) m.setEnabled(true);
      for (const l of this.tacticalLines) l.setEnabled(true);
    }
  }

  /** Update the panel + path lines. Called once per render frame; cheap
   *  enough that we don't gate on `enabled` for the panel-text update
   *  (it's invisible anyway when disabled). The expensive path-mesh
   *  refresh is gated.
   *
   *  Phase 0: `view` is the new WorldStateView projection; when supplied
   *  the panel renders from it (so the future planner / GOAP layers and
   *  the HUD see the exact same data). Falls back to the legacy bot +
   *  blackboard read when view is omitted. */
  update(
    bots: ReadonlyArray<Bot>,
    tBoard?: TeamBlackboard,
    ctBoard?: TeamBlackboard,
    view?: WorldStateView | null,
    tactical?: TacticalGraph | null,
  ): void {
    if (!this.enabled) return;
    this.refreshPanel(bots, tBoard, ctBoard, view ?? null);
    this.refreshPaths(bots);
    if (tactical && this.tacticalBuiltForGraph !== tactical) {
      this.buildTacticalVisuals(tactical);
      this.tacticalBuiltForGraph = tactical;
    }
  }

  /** Build the tactical-graph visualisation once. Cover nodes are
   *  small spheres at the cover position; head-glitches use a hotter
   *  colour so they stand out. Hold angles are short lines from the
   *  cover toward the angle's facing yaw. Peek nodes are dashed lines
   *  from cover to peek cell. Pre-aim spots are not rendered (too
   *  many pairs, low signal — read the graph in code if you need them). */
  private buildTacticalVisuals(graph: TacticalGraph): void {
    const scene = getScene();
    // Dispose any previous run (e.g. HMR re-init).
    for (const m of this.tacticalMeshes) m.dispose();
    for (const l of this.tacticalLines) l.dispose();
    this.tacticalMeshes = [];
    this.tacticalLines = [];

    const coverMat = new StandardMaterial('tactical-cover-mat', scene);
    coverMat.emissiveColor = COVER_COLOR;
    coverMat.disableLighting = true;
    const headMat = new StandardMaterial('tactical-cover-head-mat', scene);
    headMat.emissiveColor = COVER_HEAD_GLITCH_COLOR;
    headMat.disableLighting = true;

    // Cover nodes: small spheres just above the floor.
    for (const c of graph.cover) {
      const m = MeshBuilder.CreateSphere(`tactical-cover-${c.id}`,
        { diameter: 0.18, segments: 4 }, scene);
      m.position.set(c.x, c.y + 0.10, c.z);
      m.material = c.headGlitch ? headMat : coverMat;
      m.isPickable = false;
      this.tacticalMeshes.push(m);
      // Normal indicator: a 0.5m line from the cover into the threat
      // direction so we can eyeball "is the bot facing the right way".
      const lineEnd = new Vector3(
        c.x + c.normalX * 0.5,
        c.y + 0.10,
        c.z + c.normalZ * 0.5,
      );
      const line = CreateLines(`tactical-cover-norm-${c.id}`, {
        points: [new Vector3(c.x, c.y + 0.10, c.z), lineEnd],
      }, scene);
      line.color = c.headGlitch ? COVER_HEAD_GLITCH_COLOR : COVER_COLOR;
      line.isPickable = false;
      this.tacticalLines.push(line);
    }

    // Peek nodes: line from cover to peek cell.
    for (const p of graph.peeks) {
      const cover = graph.cover.find(c => c.id === p.coverId);
      if (!cover) continue;
      const line = CreateLines(`tactical-peek-${p.id}`, {
        points: [
          new Vector3(cover.x, cover.y + 0.05, cover.z),
          new Vector3(p.peekX, p.peekY + 0.05, p.peekZ),
        ],
      }, scene);
      line.color = PEEK_COLOR;
      line.isPickable = false;
      this.tacticalLines.push(line);
    }

    // Hold angles: 1 m line in the facing direction.
    for (const h of graph.holdAngles) {
      const cover = graph.cover.find(c => c.id === h.coverId);
      if (!cover) continue;
      const fwdX = Math.sin(h.yaw);
      const fwdZ = Math.cos(h.yaw);
      const line = CreateLines(`tactical-hold-${cover.id}-${h.exposes ?? 'free'}`, {
        points: [
          new Vector3(cover.x, cover.y + 1.4, cover.z),
          new Vector3(cover.x + fwdX * 1.0, cover.y + 1.4, cover.z + fwdZ * 1.0),
        ],
      }, scene);
      line.color = HOLD_COLOR;
      line.isPickable = false;
      this.tacticalLines.push(line);
    }
  }

  private refreshPanel(
    bots: ReadonlyArray<Bot>,
    tBoard?: TeamBlackboard,
    ctBoard?: TeamBlackboard,
    view?: WorldStateView | null,
  ): void {
    const rows: string[] = [];
    rows.push('<div class="ai-debug-title">AI</div>');
    if (view) {
      // Phase 0 view-derived header: confirms the WorldStateView is
      // flowing (visible heartbeat: simMs / phase / per-side alive).
      rows.push(`<div class="ai-strategy">
        <span class="t">T(${view.teams.T.aliveCount}): ${escape(view.teams.T.strategy)}</span>
        <span class="ct">CT(${view.teams.CT.aliveCount}): ${escape(view.teams.CT.strategy)}</span>
        <span class="phase">${escape(view.phase)} t:${(view.simMs / 1000).toFixed(1)}s</span>
      </div>`);
    } else if (tBoard || ctBoard) {
      const tStrat = tBoard?.strategy ?? '-';
      const ctStrat = ctBoard?.strategy ?? '-';
      rows.push(`<div class="ai-strategy">
        <span class="t">T: ${escape(tStrat)}</span>
        <span class="ct">CT: ${escape(ctStrat)}</span>
      </div>`);
    }
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
      const bv = view?.bots.get(bot.id);
      const known = bv?.knownEnemyCount ?? bot.perception.known.size;
      const status = c.alive ? (bv?.brainState ?? bot.brain.state) : 'DEAD';
      const teamCls = c.team === 'T' ? 't' : 'ct';
      const board = c.team === 'T' ? tBoard : ctBoard;
      const role = bv?.role ?? board?.roleByBot.get(bot.id) ?? '-';
      const target = bv?.objectiveCallout ?? board?.objectiveByBot.get(bot.id)?.callout ?? '-';
      // Phase 0: action / threat columns are placeholders surfaced from
      // the view so phase 3+ can fill them without HUD changes.
      const action = bv?.currentAction ?? '-';
      const threat = bv ? bv.threatLevel.toFixed(2) : '-';
      rows.push(`<div class="ai-row ${teamCls}">
        <span class="id">${escape(bot.id)}</span>
        <span class="role">${escape(role)}</span>
        <span class="state">${escape(status)}</span>
        <span class="hp">${c.hp}</span>
        <span class="wpn">${escape(wpn)}</span>
        <span class="ammo">${escape(ammo)}</span>
        <span class="target">${escape(target)}</span>
        <span class="known">k:${known}</span>
        <span class="action">${escape(action)}</span>
        <span class="threat">th:${escape(threat)}</span>
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
    for (const m of this.tacticalMeshes) m.dispose();
    for (const l of this.tacticalLines) l.dispose();
    this.tacticalMeshes = [];
    this.tacticalLines = [];
    this.tacticalBuiltForGraph = null;
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
