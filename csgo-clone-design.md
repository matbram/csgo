# CS:GO Clone — Technical Design Document

> Companion to `csgo-clone-vision.md`. The vision doc says **what** we're building. This doc says **how**.

This is a living document. It will be updated as we discover things during implementation. When the doc and the code disagree, the code wins — but the doc is updated to match.

---

## 1. Goals

1. **Feels like CS:GO.** Movement, shooting, round flow, economy, and bot behavior should be recognizable to anyone who has played the real game. "Recognizable" is the bar — not "byte-identical."
2. **Looks pretty from day one.** Not a programmer-art prototype. Stylized desert realism with good lighting, materials, and post-processing from the first playable build.
3. **Runs at 60 fps in a desktop browser** with 10 active players, full AI, and grenades on screen. Stretch: 120 fps on a modern machine.
4. **Single-page app, no backend.** Loads from a static host. No sign-in, no networking, no persistence beyond `localStorage` for settings.
5. **Bots that play CS, not bots that play deathmatch.** Strategic round play, rotations, economy awareness, utility usage.

## 2. Non-Goals

- Multiplayer of any form. No netcode, no lockstep, no rollback.
- Map editor / mod support. The map is hardcoded.
- Cosmetics, skins, progression, persistent stats.
- Mobile or touch controls. Desktop keyboard + mouse only.
- Console support.
- Anti-cheat. There's no one to cheat against.
- Localization. English only.

## 3. Visual Direction

The vision doc says "no Valve assets." We need a coherent style that looks polished without licensed content.

**Chosen direction: stylized desert realism.**

- Warm desert palette — sandstone, terracotta, sun-bleached white, faded blue accents.
- Simplified geometry — fewer polygons than real CS:GO maps, but composition reads as Dust 2.
- **Lighting carries the look.** Strong directional sun, warm hemispheric ambient, baked or real-time shadows, atmospheric haze. Good lighting on simple geometry beats bad lighting on complex geometry.
- PBR materials, all procedural or generated from noise — no texture downloads required at start.
- Post-processing stack: tone mapping (ACES), bloom, subtle vignette, color grading toward warm.
- Volumetric god-rays through doorways and windows where the budget allows.
- First-person view model is detailed (it's on screen most of the time). World models on other players can be lower fidelity.

**Character look:** stylized humanoid built from primitives — torso, head, limbs as boxes/capsules with slightly tapered proportions. Team-colored uniforms (orange/tan for T, navy/black for CT). Simple but readable silhouettes. Not capsules.

**Weapon look:** procedural box assemblies styled per class (rifle profile, pistol profile, sniper profile). Detail comes from material zones (metal vs polymer vs wood) and lighting.

**What we are explicitly avoiding:**
- Photorealistic ambition we can't deliver.
- Flat-shaded low-poly aesthetic — wrong tone for a tactical shooter.
- Heavy texture downloads at boot. Procedural-first; we add CC0 textures only if a specific surface needs them and only with explicit approval.

**Asset policy:** No third-party assets are added to the repo or fetched at runtime without an explicit decision recorded in this document. If we later decide to use a CC0 character model or texture set, that decision goes here under "Asset additions."

## 4. Tech Stack (Locked Decisions)

| Concern | Choice | Why |
|---|---|---|
| Language | **TypeScript** (strict) | Project is too stateful for vanilla JS. Strict null checks save us from a category of bugs. |
| Build tool | **Vite** | Fast HMR, ES modules, zero-config TS. |
| 3D engine | **Babylon.js 7+** | Mature, batteries-included PBR/IBL/post, good docs, WebGL2/WebGPU dual support. |
| Physics | **Havok via Babylon plugin** | For grenades and dropped weapons only. Not for character movement. |
| Character movement | **Custom kinematic capsule controller** | Tight FPS feel requires direct velocity control. Covered in §7. |
| Bullets | **Hitscan raycasts** | Matches CS:GO behavior. No projectile travel time. |
| Navmesh | **RecastJS via Babylon plugin** | Bake against simplified collision mesh. |
| AI scaffolding | **Custom behavior trees + utility selectors** on top of a small steering library | Yuka.js is lightly maintained; we use ideas from it but write our own. Keeps us in control of tactical logic. |
| HUD | **DOM + CSS** with one small `<canvas>` for the radar | Cheaper, easier to author, doesn't fight the 3D canvas. |
| Audio | **Web Audio API** directly | Spatialized sound, low latency. Howler is unnecessary. |
| State | Module-scoped singletons + an event bus | Project is a single client; no need for Redux/Zustand machinery. |
| Tests | **Vitest** for pure-logic units (economy, round state, recoil tables) | Skip tests for rendering and AI behavior — verify those by play. |
| Linter / formatter | **ESLint + Prettier** | Standard. |

**Browser target:** latest Chrome, Edge, Firefox on desktop. Safari best-effort. WebGL2 required. WebGPU detected and used if available (Babylon handles this via engine selection).

## 5. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Match (FSM)                           │
│  Warmup → Round × N (Buy → Live → End) → Halftime → ...     │
└──────────────┬──────────────────────────┬───────────────────┘
               │                          │
        ┌──────▼──────┐            ┌──────▼──────┐
        │  Economy    │            │  Bomb       │
        │  (per team) │            │  (plant/    │
        │             │            │   defuse)   │
        └─────────────┘            └─────────────┘
                                          │
┌─────────────────────────────────────────▼───────────────────┐
│                     World (per round)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Local Player │  │  Bots × 9    │  │  Grenades, drops │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                   │             │
│         └────────┬────────┴─────────┬─────────┘             │
│                  │                  │                       │
│         ┌────────▼────────┐  ┌──────▼────────┐              │
│         │  Combat System  │  │ Physics (Havok)│             │
│         │  (hitscan,      │  │ + Kinematic    │             │
│         │   damage, hit)  │  │ Char Controller│             │
│         └─────────────────┘  └────────────────┘             │
└─────────────────────────────────────────────────────────────┘
                                          │
                          ┌───────────────▼───────────────┐
                          │  Map (Dust 2 geometry,        │
                          │   navmesh, callout zones,     │
                          │   cover graph, spawn data)    │
                          └───────────────────────────────┘
                                          │
                                ┌─────────▼─────────┐
                                │   HUD + Audio     │
                                └───────────────────┘
```

**Tick model:**

- **Render tick** (`requestAnimationFrame`, ~60 Hz): camera, animation, particles, HUD redraw.
- **Simulation tick** (fixed 60 Hz, accumulator pattern): movement, hitscan, damage, grenades, bomb timer, round timer.
- **AI perception tick** (10 Hz, staggered across bots): vision cones, LOS raycasts, sound event consumption.
- **AI decision tick** (5 Hz, staggered): behavior tree evaluation, strategist updates.

Decoupling these is the single most important performance decision. Without it, AI cost grows with player count and frame rate.

---

## 6. Engine Layer

The engine layer wraps Babylon.js and exposes the rest of the game from a stable internal API. We don't sprinkle Babylon types across the gameplay code — gameplay imports from `engine/`, not from `@babylonjs/core` directly. This keeps the door open for a renderer swap and makes mocking in tests trivial.

**Modules:**

- `engine/app.ts` — boots the Babylon engine, picks WebGL2/WebGPU, owns the main loop.
- `engine/scene.ts` — single Babylon `Scene`, exposes the active camera, sun, environment.
- `engine/loop.ts` — fixed-timestep accumulator. Drives sim ticks at 60 Hz independent of render rate. Calls registered systems in a deterministic order.
- `engine/input.ts` — pointer lock, key state, mouse delta. Configurable bindings stored in `localStorage`. Exposes "this frame pressed / released" edges, not just "is held."
- `engine/audio.ts` — single `AudioContext`, listener follows the camera, helpers for spatialized one-shots and looped sounds.
- `engine/time.ts` — wall clock, sim clock, slow-mo factor (for debug only). Round timer reads from sim clock.
- `engine/events.ts` — typed event bus. One global bus is fine for a project this size; keys are string-literal-typed so the compiler catches typos.
- `engine/debug.ts` — F-key togglable overlays (FPS, AI debug, navmesh, hitscan rays). Stripped from production builds via Vite define.

**Render setup (chosen for "pretty from day one"):**

- `Engine` with antialiasing + adaptToDeviceRatio, capped at 1.5× DPI to protect perf on retina screens.
- One `Scene`, one `DirectionalLight` (sun) with cascaded shadow maps (3 cascades), one `HemisphericLight` for ambient sky/ground gradient.
- HDR environment from a procedurally generated sky (no external HDRI download). Babylon's `SkyMaterial` gives us a believable atmospheric sky cheaply; we capture it once into an environment texture for IBL.
- Default rendering pipeline with: tone mapping (ACES), bloom (subtle), MSAA 4× when WebGL2 supports it, FXAA fallback, sharpen pass, vignette, color grading LUT toward warm/desaturated.
- SSAO2 enabled on desktop, off on lower-end machines (auto-detected from initial frame timing).
- One scene clear color matching the haze color so distant geometry blends naturally.

**Why no SSR, no DOF, no motion blur:** they cost frames and don't improve readability in a competitive shooter. Aesthetic decisions chosen to *help* the gameplay, not fight it.

---

## 7. Map: Dust 2

The map is the largest static asset in the project. How we author it determines how easy it is to iterate on layout, lighting, and bot tactical data.

### 7.1 Authoring approach

The map is **defined in code as a hierarchy of named blocks**, not loaded from a file format. This sounds primitive but it's right for our scale:

- We hit "save" and the map updates on HMR.
- Geometry, collision, navmesh hints, and tactical metadata live next to each other in the same source.
- No editor to build, no `.glb` to maintain, no proprietary format.

A `Block` is a primitive: `Box`, `Ramp`, `Cylinder`, `Arch`, or `Prefab` (a named group of blocks — e.g., `Crate`, `Barrel`, `Doorway`, `WindowFrame`). Each block has a transform, a material reference, and optional flags (`solid`, `climbable`, `visible`, `castsShadow`, `walkable`).

```ts
// Sketch — actual API will refine.
const aSite = group('a_site', { origin: v3(40, 0, -25) }, [
  box({ size: [12, 0.2, 10], material: 'sand_floor', tag: 'walkable' }),
  prefab('crate_stack', { at: [4, 0, 2] }),
  ramp({ size: [6, 2, 4], at: [-3, 0, -1], material: 'wood' }),
  zone('a_site',  { polygon: [[0,0],[12,0],[12,10],[0,10]] }), // callout zone
  spawn('plant_default', { at: [0, 0, 3] }),
]);
```

Composing Dust 2 takes patience but no special tooling. We get HMR for free.

### 7.2 Geometry organization

- **Static world geometry** is merged into a small number of meshes per material at boot. Babylon's `Mesh.MergeMeshes` is fine here. One mesh per material → minimum draw calls.
- **Decorative props** (barrels, signs, sandbags) are instanced (`InstancedMesh`) so duplicates are nearly free.
- **Skybox** is its own mesh at scene root.
- **Lights:** one sun, one ambient. No point lights in the static map (they'd cost too much). Faked with emissive materials and bloom for any "lit" objects.
- **Collision geometry is separate from visual geometry.** The visual mesh has bevels, trim, decoration. The collision mesh is a coarser version — boxes and ramps only — used for character sweeps, hitscan, and navmesh baking. This is the standard shooter pattern and keeps both correct and fast.

### 7.3 Layout fidelity

We won't nail Dust 2 on pass one. Three iterations:

1. **Blockout:** rough proportions, all callouts present, you can walk T spawn → mid → A site → B site → CT spawn. Looks bad. Plays *almost* right.
2. **Proportion pass:** correct distances, correct cover heights (so peeker's advantage and head-glitch spots match). Add real angles (long doors, mid doors, B doors). Plays *right*. Still looks plain.
3. **Aesthetic pass:** trim, archways, broken walls, palm trees, the iconic blue car, the truck on B. Now it looks like Dust 2.

Tactical bot data is added during pass 2 so AI development can begin in parallel with the aesthetic pass.

### 7.4 Callout zones

Bots reason about the world in **callout space**, not coordinates. A callout is a named 2D polygon at floor level (with a vertical range so multi-floor maps work — B tunnels lower vs upper).

```
T_SPAWN, OUTSIDE_LONG, LONG_DOORS, A_LONG, PIT, A_CROSS, A_SITE, A_SHORT,
CATWALK, MID, MID_DOORS, SUICIDE, T_RAMP, B_TUNNELS_UPPER,
B_TUNNELS_LOWER, B_SITE, B_PLAT, BACK_PLAT, B_WINDOW, FENCE,
B_DOORS, CT_MID, CT_SPAWN
```

Each callout exposes:
- centroid + bounding polygon
- adjacent callouts (graph edge)
- "default" facing direction (where you face when defending it)
- typical cover spots inside it (see §7.6)

This graph is the single source of truth for "how the map connects" from the AI's perspective. The strategist plans rotations as paths in this graph.

### 7.5 Spawns and bomb sites

Each side has 5 spawn points authored in the map. Spawns are randomized within a small radius at round start (CS:GO-style) so bots don't always start in identical positions. Bomb sites A and B are polygons; the bomb can be planted anywhere inside.

### 7.6 Cover graph

For bots to "use cover" they need to know where cover *is*. We pre-author named cover spots:

```ts
cover('a_site/long_box', {
  at: [...],
  facing: 'A_LONG',
  height: 'crouch' | 'stand',  // dictates when we have to crouch to be hidden
  exposed_to: ['CATWALK'],     // angles still visible from this spot
});
```

Authoring these takes hours, not days, and produces *vastly* better-feeling AI than runtime cover detection. A few hundred cover spots across Dust 2 is enough.

### 7.7 Navmesh

- Built once at boot from the **collision mesh** using RecastJS.
- Agent radius = capsule radius. Agent height = standing capsule height. We bake one navmesh; crouching is handled by the controller, not the navmesh.
- Off-mesh links for jump-up spots (boxes at A site, the small jump in B tunnels). Hand-authored in the map data.
- Navmesh is serialized and cached in `localStorage` so reloads skip the bake.

### 7.8 Lightmap (later)

In M7 polish, we bake static lighting into a lightmap with `Babylon.js`'s built-in baker (or generate it offline and ship it). Until then, real-time directional light + ambient + SSAO is enough.

---

## 8. Character Controller

The controller is shared by the local player and bots. Bots feed it the same kind of input the player provides (move vector, want-to-jump, want-to-crouch). This guarantees bots can't do anything the player can't.

### 8.1 State

Per character:

```
position:        Vector3 (capsule base)
velocity:        Vector3
yaw, pitch:      number (radians)
crouching:       bool
walking:         bool   (shift / silent)
onGround:        bool
groundNormal:    Vector3
ladder:          Ladder | null
lastFootstepDist: number
```

Capsule: radius 0.36 m, standing height 1.80 m, crouch height 1.30 m. Eye height: standing 1.65 m, crouch 1.15 m.

### 8.2 Movement model

Source-engine inspired but simplified:

- **Acceleration** is per-tick: `velocity += wishDirection * accel * dt`, then clamped against `maxSpeed`.
- **Friction** on the ground subtracts from horizontal velocity each tick. In the air, friction is zero — this is what enables air strafing.
- **Counter-strafing** falls out for free when accel and friction values are tuned correctly. Pressing the opposite key applies opposite acceleration; with a tuned friction value, velocity drops to ~zero in 1–2 ticks. We do not need a separate "snap to stop" branch.
- **Jump** is a fixed vertical impulse (`+5.4 m/s`) applied once per landing. Auto-bhop is **off** by default (matches modern CS:GO).
- **Crouch** is a smooth height interpolation (~150 ms). Eye height interpolates with it.
- **Speeds** (m/s, calibrated to feel like CS:GO):
  - Run: 6.5
  - Walk (shift): 3.4
  - Crouch: 2.3
  - Knife out / unarmed: 7.5
  - With AWP: 5.7
  - Speed scale per weapon comes from the weapon table (§10).

### 8.3 Collision: swept capsule

Per tick, for each character:

1. Apply gravity to vertical velocity if not on ground.
2. Compute the desired position: `pos + velocity * dt`.
3. Sweep the capsule from `pos` to desired position against the **collision mesh**. Use Babylon's swept ray tools or a custom capsule-vs-triangle sweep (we'll likely write our own — Babylon's character helpers have caveats).
4. On hit: place the capsule at the hit position, project remaining motion onto the surface plane, recurse up to 3 times to slide along corners.
5. After horizontal resolution, do a downward probe to detect ground contact. If the surface normal's vertical component > 0.7, set `onGround = true` and snap to surface.

We're not using Havok for any of this. We're calling its raycast/sweep utilities (cheap) but not its rigid body simulation.

### 8.4 Stairs and small ledges

Auto-step: if a horizontal sweep hits a wall and there's open space within a small vertical range (≤ 0.4 m), retry the sweep from a slightly higher origin. This is the standard "step up" trick. Without it, stairs feel terrible.

### 8.5 Ladders

Dust 2 has none. Skipping. (Note here so we don't reintroduce the assumption later.)

### 8.6 Hitboxes

Characters have a multi-segment hitbox attached to the capsule:

| Segment | Bounds | Damage multiplier |
|---|---|---|
| Head | small sphere at top | 4.0× |
| Chest | upper torso box | 1.0× |
| Stomach | lower torso box | 1.25× |
| Legs | lower body box | 0.75× |
| Arms | thin boxes alongside torso | 1.0× |

Multipliers reproduce CS:GO's damage zones approximately. The hitbox capsule moves with the character; we don't simulate per-bone animation for hit detection — the head box is at the eye height position, the chest box is centered on the capsule, etc. This loses some realism (you can't shoot a leaning bot's leg sticking out of cover) but is appropriate for our scope.

A future improvement: align hitboxes to a simple skeleton so animations affect them. Out of scope for M1–M5.

### 8.7 Footsteps and noise

Movement emits **sound events** (see §16) — these are the audio system input *and* the bot perception input. The character controller emits one of:

- `footstep_run` (loud) — emitted every ~1.0 m of running movement.
- `footstep_walk` (silent) — emitted but flagged silent so bots don't hear it.
- `footstep_crouch` (silent).
- `jump` / `land` — short impulses.
- `ladder` — n/a.

Surface type modulates the sound clip (`sand`, `wood`, `metal`, `concrete`) — surface is read from the collision triangle's material tag.

---

## 9. Combat: Bullets, Damage, Recoil

### 9.1 Hitscan model

When a weapon fires:

1. Compute the shot direction from the camera/eye forward, perturbed by **inaccuracy** (§9.3).
2. Raycast against the collision mesh + character hitboxes. Max range ~120 m.
3. First hit determines outcome:
   - Hitbox hit → apply damage to the owner of that hitbox.
   - World hit → spawn a bullet impact decal/particle at the contact point.
4. Apply **damage falloff** based on weapon's range curve and distance. Most CS:GO weapons retain near-full damage to ~30 m, falling off after.
5. Apply **wallbang**: if the hit is on a penetrable material (wood, drywall — tagged in the collision mesh), continue the ray with reduced damage and a per-material penetration cost. AK and AWP penetrate; pistols mostly don't.

### 9.2 Damage model

```
dmg = base_damage(weapon)
    * hitbox_multiplier
    * falloff(distance, weapon.range_curve)
    * (armored ? armor_reduction(weapon, hitbox) : 1.0)
    * (wallbang ? penetration_factor(material, weapon) : 1.0)
```

Armor:
- `kevlar` reduces body damage by ~50% for most weapons (weapon-specific).
- `helmet` reduces head damage; first head shot is absorbed, helmet is destroyed for that target.
- Some weapons ignore armor (AWP, headshots from AK at any range).

When damage is applied, victim's health drops; armor takes a portion of incoming damage too. This is per-CS:GO formula: `armor_dmg = floor(dmg * armor_ratio / 2)` or similar; we'll calibrate to match in-game numbers documented in the vision doc.

### 9.3 Accuracy and inaccuracy

Each weapon has an inaccuracy state evolving per shot:

```
inaccuracy = base_inaccuracy
           + movement_term(speed, in_air, crouching)
           + recoil_term(consecutive_shots_in_burst)
```

- `base_inaccuracy` is small (degrees) when standing still.
- `movement_term` scales hard with speed. Running + shooting = useless at range, by design.
- `in_air` = very large penalty.
- `crouching` reduces base by ~30%.
- `recoil_term` grows with each shot in a burst, decays toward zero when not firing for ~150 ms.

The actual shot direction picks a random offset within a cone of half-angle `inaccuracy`.

### 9.4 Recoil and spray patterns

Recoil is *visual* — it kicks the camera up and to the side after each shot. Spray pattern is *aim* — it deterministically shifts where the bullet *goes*, reproduced from CS:GO's known patterns.

Each weapon has a `spray_pattern: Vector2[]` of offsets (in degrees) for shots 1..N of a continuous burst. After N shots, additional shots use the last entry plus randomized scatter. Releasing the trigger for ≥150 ms resets the spray to shot 1.

For the player, we apply the spray offset to the bullet trajectory and a matching kick to the camera. The player learning the pattern then "pulls down" with the mouse to compensate — this is the canonical CS:GO mechanic.

For bots, see §14 — bots compensate spray imperfectly based on difficulty, which lets them whiff like real players.

### 9.5 Weapon firing modes

- **Auto** (rifles, SMGs): fires while held, governed by fire rate.
- **Semi** (pistols, deagle): one shot per click.
- **Burst** (FAMAS burst, Glock burst): 3-round burst with fixed inter-bullet delay.
- **Bolt** (AWP, scout): one shot per click + bolt recovery delay where movement is enabled but firing is locked.

### 9.6 Reload, switch, deploy

Each weapon defines a `reload_time` and a `deploy_time` (how long after switching to it you can fire). The view model plays a procedural reload animation (we won't author per-weapon animation rigs in M2; we'll do a generic "lower the gun and raise it" tween until M7 polish). Firing is locked during reload and during the first `deploy_time` ms after switch.

### 9.7 Damage model summary table

The combat module is a pure-functional core: given (weapon, distance, hitbox, victim_armor) → damage. This is the most-tested module in the project — Vitest covers every weapon × hitbox × armor combination against expected damage from the vision doc.

---

## 10. Weapons

### 10.1 Data-driven definitions

Every weapon is a record. No per-weapon classes or inheritance. The combat system reads the record at fire time.

```ts
type WeaponDef = {
  id: 'ak47' | 'm4a4' | 'm4a1s' | 'awp' | 'usp_s' | 'glock' | ...;
  slot: 'primary' | 'secondary' | 'knife' | 'grenade' | 'c4';
  category: 'rifle' | 'smg' | 'pistol' | 'sniper' | 'shotgun' | 'lmg' | 'knife';
  cost: number;                  // buy-menu price
  team: 'T' | 'CT' | 'both';
  fireMode: 'auto' | 'semi' | 'burst' | 'bolt';
  rpm: number;                   // rounds per minute
  magazine: number;
  reserve: number;
  reloadMs: number;
  deployMs: number;
  baseDamage: number;
  armorPenetration: number;      // 0..1
  rangeCurve: { full: number, half: number };  // distance for full and half damage
  baseInaccuracyDeg: number;
  movingInaccuracyMul: number;
  jumpingInaccuracyMul: number;
  crouchInaccuracyMul: number;
  recoilDecayMs: number;
  sprayPattern: Array<[xDeg: number, yDeg: number]>;
  moveSpeedScale: number;        // 1.0 = base run speed, AWP ~0.84
  killReward: number;            // dollars per kill
  viewModelMesh: 'rifle_a' | 'pistol_a' | 'sniper_a' | ...;
  worldModelMesh: 'rifle_a_world' | ...;
  fireSound: SoundId;
  reloadSound: SoundId;
};
```

This shape supports M2's two-weapon prototype (AK + USP) and scales straight to the full vision-doc arsenal without code changes — we add records.

### 10.2 Initial arsenal

For M2 we ship: AK-47, M4A4, USP-S, Glock-18, AWP, Knife, C4. That's enough for a real round of play. Other weapons added in subsequent milestones, prioritized by economy importance: Deagle, P250, FAMAS, Galil, MP9, MAC-10, then nice-to-haves.

### 10.3 View models

The view model (your weapon, seen first-person) is its own mesh, parented to the camera with a small offset. It bobs subtly with movement (low-frequency sine modulated by velocity), kicks back on fire, lowers when sprinting (we don't have sprint, so this just applies during fast directional changes), and dips during reload.

For "pretty from day one," the view model gets the most material attention: separate metal/polymer/wood material zones, clean normals, slight bevels. World models on other players are simpler — at distance the player won't see the difference.

### 10.4 Buy menu

The buy menu is a DOM panel triggered by `B`. It's only interactive while the player is in their team's buy zone *and* within freeze + buy phase time window. Clicking an item:

1. Validates affordability and team eligibility.
2. Deducts cost from `Economy.player[id].money`.
3. Adds weapon to inventory; if a slot is occupied, the previous weapon is dropped (becomes a pickup-able world entity for ~30 s).
4. Updates HUD.

Bots use the same purchase function via a programmatic API — no UI involved.

---

## 11. Round and Match State

### 11.1 Match-level FSM

```
Warmup
  → RoundStart(roundNumber=1)
  → ... rounds 1..15 ...
  → Halftime (sides swap, money reset to $800)
  → ... rounds 16..30 ...
  → MatchEnd
```

Match ends when a team reaches 16 round wins. Overtime is out of scope (vision doc says first to 16; we implement that exactly).

### 11.2 Round-level FSM

```
Freeze (15 s) → BuyAndLive (1:55 max)
                 ↳ BombPlanted (40 s) → ...
              → RoundEnd (5 s) → next round
```

Substates of `BuyAndLive` track "is buy menu still open?" — yes during freeze + the first 20 seconds, no after. `BombPlanted` overrides the round timer with the bomb timer. Win conditions are checked every sim tick.

**Win conditions** (checked in order):

1. If round time expired and bomb is not planted: CT wins (time).
2. If bomb has detonated: T wins.
3. If bomb has been defused: CT wins.
4. If all CTs dead: T wins.
5. If all Ts dead and bomb not planted: CT wins.
6. If all Ts dead and bomb planted: continue — bomb still ticks. Either CTs defuse (CT wins) or it explodes (T wins).

Rule 6 is the subtle case the vision doc implies but doesn't spell out; the implementation must get this right.

### 11.3 Side switch (halftime)

After round 15:
- Identities swap: previous Ts become CTs and vice versa.
- All money resets to $800 (CS:GO competitive default).
- Spawn assignments use the new side's spawn points.
- Loss bonus counters reset.

### 11.4 Economy

Per-player state: `money: number`, `lossStreak: number`. Per-team aggregate is derived.

Reward function is a pure mapping from `(roundOutcome, playerEvents) → moneyDelta`, applied once at round end:

- Round-end team rewards from the vision doc (win: $3250; T win via bomb: $3500; CT win via defuse: $3500; defuser bonus +$300).
- Loss bonus by streak: $1400, $1900, $2400, $2900, $3400.
- T-side loss with bomb planted: loss bonus + $800.
- Per-kill rewards by weapon class.
- Bomb plant: +$300 to planter.
- Cap: $16,000.

Implemented as a pure function over an event log produced during the round, then applied at `RoundEnd`. This means there's no risk of double-rewarding from network flapping — and economy bugs are easy to test.

---

## 12. The Bomb (C4)

### 12.1 Carrier assignment

At round start, exactly one alive T is assigned the bomb. Preference: the one closest to T spawn center, but randomized within ties so it's not always the same bot. The player gets the bomb if the player is on T side and is the chosen one (tunable rule — for now, a player-side T is *more* likely than uniform, so the player can plant if they want).

### 12.2 Plant

Conditions: alive T, holding C4, standing inside an `A_SITE` or `B_SITE` polygon, holding the **plant key** (default `E`). Plant takes 3.0 seconds; movement or losing line of sight to the floor cancels and resets the timer. On completion:

- C4 entity placed at planter's feet, oriented to ground.
- Bomb timer starts at 40 s.
- Round timer hidden, bomb timer shown.
- All players see/hear the plant beep.
- Sound event emitted that bots subscribe to ("bomb planted at A_SITE/B_SITE").
- `Economy.eventLog.push({ kind: 'plant', playerId, site })`.

### 12.3 Defuse

Conditions: alive CT, within ~1 m of the planted C4, holding **defuse key** (default `E`). Defuse takes 10 s without kit, 5 s with kit. Movement cancels but does not reset the timer (CS:GO behavior — you can re-press and continue). On completion:

- Bomb is disarmed.
- Round ends in CT victory.
- Defuser is granted +$300 in the round-end reward.

### 12.4 Detonation

When bomb timer reaches zero:

- HE-style explosion at C4 location with large radius and high damage falloff.
- All players within radius take damage scaled by distance and line-of-sight (full damage with LoS, partial through cover).
- Round ends in T victory.

### 12.5 Drop and pickup

If the C4 carrier dies, the C4 drops at their position. Other Ts can pick it up by walking over it. CTs cannot pick it up. The drop persists indefinitely within the round.

### 12.6 Visuals

C4 is a small green box with a blinking LED and a beep tied to its remaining time (faster beeps as time runs out — the iconic sound). Worth getting right; it's part of the CS:GO identity.

---

## 13. Grenades

Grenades are the most physics-touching part of the game. They live in their own module on top of Havok.

### 13.1 Throw mechanics

When a player presses the grenade primary, the grenade is "primed" — held in the hand. Releasing throws it. Right-click does a soft underhand toss; both held does a low lob. The throw direction is the camera forward; the speed varies by toss type.

A grenade entity is a Havok-driven rigid body — a sphere collider with mass, restitution (bounciness), and friction. Havok handles bouncing off walls and floors. When it comes to rest (or its fuse expires) the grenade detonates.

### 13.2 Grenade types

| Type | Fuse | Effect |
|---|---|---|
| Flashbang | 1.5 s | Detonates with a bright flash. Players within radius and with LoS to the detonation point are blinded for a duration scaled by angle and proximity (full duration if facing it directly). |
| HE | 1.5 s | Explosion damage in radius with falloff. LoS-checked: full damage with LoS, partial through cover. |
| Smoke | 1.5 s | Spawns a smoke cloud volume that lasts ~18 s. The cloud is both a visual effect *and* an opaque region for vision raycasts. |
| Molotov / Incendiary | 0.7 s after impact | Spreads a fire patch on the surface it lands on; deals tick damage to anyone inside; lasts ~7 s. |
| Decoy | 1.5 s | Plays gunfire sound effects from random nearby weapons. Real CS uses this for misdirection — bots will treat decoy sounds as low-confidence intel. |

### 13.3 Smoke (the hard one)

CS:GO's volumetric smoke is a sim. We approximate:

- Visual: a sphere of stacked particle billboards with depth-aware soft edges. Babylon's `ParticleSystem` with manual velocity dampening looks good.
- Vision occlusion: an invisible sphere collider tagged `smoke`. When a hitscan or LoS raycast intersects it, the ray's effective max range is reduced by the chord length × an "obscurity" factor. Bullets still penetrate (CS:GO behavior — you can spray through smoke), with damage decay. Vision is fully blocked beyond a few tenths of a second of smoke chord.
- The cloud is anchored at the grenade's resting position and dissipates over time (sphere shrinks and particles fade).

Importantly, **bots respect smoke for vision**. Their LOS raycast goes through the smoke region with the same obscurity rule, so a bot can't see through smoke any better than the player.

### 13.4 Molotov / Incendiary

When the grenade lands, we spawn a `FirePatch` — a flat polygon on the ground with a fire particle effect. Damage applies to characters whose capsule center is inside the polygon, ticked every 250 ms. Polygon shape is a slightly noisy circle (a few sampled points around the impact); bots and the player avoid stepping into it.

### 13.5 HE

Explosion is a single event:

1. Find all characters within max radius.
2. For each, raycast from explosion center to character chest. If hit a wall first, scale damage by penetration; if smoke, partial scale.
3. Apply damage scaled by inverse-square distance (clamped).

### 13.6 Flash

Flash is the most visually involved:

- On detonation, find all characters with LoS to the detonation.
- Compute alignment: dot product between character's forward and detonation direction.
- Compute distance attenuation.
- Final blind duration = base duration × alignment × distance factor.
- For the local player, render a bright white full-screen overlay that fades over the blind duration.
- For bots, set a `flashed_until` timestamp; while flashed, perception is severely degraded (vision range reduced, accuracy spiked).

### 13.7 Grenade pooling

Each grenade type has a small pool of pre-allocated rigid bodies and particle systems. We never `new()` a grenade during a round — `pool.acquire()` and `pool.release()`. Same for fire patches and smoke clouds. Garbage-free at runtime.

---

## 14. Bot AI

This is the largest and most consequential subsystem. The other 9 players in every match are bots; they decide whether the game feels like CS:GO or like a tech demo.

The design is **layered** — each layer can be developed and tested in isolation, and lower layers don't know the higher layers exist. This is the key reason the project is tractable.

### 14.1 Layers

```
┌──────────────────────────────────────────────────────┐
│  Strategist (one per team)                           │
│  - picks round plan, role per bot, calls rotations   │
│  - reads/writes Team Blackboard                      │
└─────────────────────┬────────────────────────────────┘
                      │ assigns role + objective
┌─────────────────────▼────────────────────────────────┐
│  Bot Brain (one per bot)                             │
│  - behavior tree + utility scorer                    │
│  - selects micro action: hold, peek, push, throw,    │
│    plant, defuse, retreat                            │
└─────────────────────┬────────────────────────────────┘
                      │ produces concrete intent
┌─────────────────────▼────────────────────────────────┐
│  Controller Adapter                                  │
│  - converts intent into character controller input   │
│  - handles aim tracking, recoil compensation, fire   │
└──────────────────────────────────────────────────────┘
                      │
┌──────────────────────────────────────────────────────┐
│  Perception (per bot)                                │
│  - vision cone, LOS raycasts, sound event memory     │
│  - maintains Known Enemies list with TTL             │
└──────────────────────────────────────────────────────┘
                      │
┌──────────────────────────────────────────────────────┐
│  Team Blackboard (shared per team)                   │
│  - last-known enemy positions per callout            │
│  - bomb info (planted, where, defusing)              │
│  - role assignments, current strategy                │
│  - alive/dead counts, casualty list                  │
└──────────────────────────────────────────────────────┘
```

### 14.2 Perception

Each bot ticks perception at 10 Hz. Updates are **staggered**: with 9 bots and 10 Hz, only ~1–2 bots tick per simulation frame at 60 Hz. Stagger is computed once per round (`offset = botIndex / 10 / 9`), so the load is even.

Per perception tick, for one bot:

1. **Vision cone test:** for each opponent, fast cone test (angle to opponent vs FOV; squared distance vs vision range). FOV ~110° horizontal. Vision range ~50 m clear, less in smoke.
2. **LOS raycast:** if cone test passes, raycast from bot eye to opponent's chest hitbox. If hit lands on opponent: visible. If hit lands on world: occluded; no intel.
3. **Smoke handling:** raycast considers smoke chord length and applies an obscurity threshold. Past the threshold = no visibility.
4. **Sound events:** consume the per-bot inbox of sound events (footsteps, gunshots, explosions, bomb beeps) emitted since the last tick. Sound events older than ~3 s are forgotten.

The result is an updated **Known Enemies** list:

```ts
type KnownEnemy = {
  id: BotId | 'player';
  lastSeenPos: Vector3;
  lastSeenAtMs: number;
  lastSeenCallout: CalloutId;
  confidence: 'visible' | 'recent' | 'sound' | 'reported';
  velocity?: Vector3;       // if visible, last observed velocity for prediction
};
```

A bot **reports** their known enemies to the team blackboard each perception tick — but with degraded confidence ("reported"). This is how teammates "communicate" — no voice, just shared state with confidence labels. The strategist reads this aggregate to decide rotations.

### 14.3 Bot Brain — behavior tree + utility scoring

Each bot's high-level action is selected each decision tick (5 Hz). The action space is small:

| Action | When | Outputs |
|---|---|---|
| `Engage` | Visible enemy in effective weapon range | aim target, fire intent |
| `HoldAngle` | Defending an objective with no enemy seen | crosshair pre-aim, walk silently |
| `Peek` | Suspect enemy at known angle | brief lateral motion + aim |
| `PushTo(callout)` | Macro objective requires entering callout | path to callout |
| `Reposition(coverSpot)` | Need a better angle / heard a flank | path to cover |
| `Retreat(callout)` | Outnumbered, at low HP, or strategist calls save | path away from threat |
| `Plant` | Holding C4, on site, no immediate threat | initiate plant |
| `Defuse` | CT, near bomb, threat manageable | initiate defuse |
| `ThrowUtility(grenade, target)` | Strategist suggests or behavior tree decides | aim throw, prime, release |
| `Reload` | Magazine low and not in immediate combat | start reload |
| `BuyLoadout` | Buy phase | call buy menu API |

The selector is **utility-based**: each action computes a score; the highest scoring action is chosen, with hysteresis (a small bonus for the currently-running action to prevent flip-flopping). Scoring functions consider HP, ammo, role, distance to objective, current threat, and team status.

A behavior tree wraps individual actions where sequencing matters (e.g., `Plant` is `MoveToSite → CheckSafe → Plant → Defend`). The tree-vs-utility split:

- **Utility selector** picks the *high-level intent*.
- **Behavior tree** sequences the *steps within an intent*.

This combo is well-trodden in commercial AI and avoids each pattern's weaknesses.

### 14.4 Controller adapter — making bots play like humans

This is the layer that makes bots *feel* human. Even with perfect strategy, if a bot snaps to enemies and fires on frame one, it feels like an aimbot.

Per-bot tunables (per difficulty level):

| Tunable | Easy | Med | Hard | Expert |
|---|---|---|---|---|
| Reaction time (sight → fire start) | 600 ms | 350 ms | 200 ms | 110 ms |
| Aim error stddev (deg) | 4.0 | 2.0 | 1.0 | 0.4 |
| Aim tracking lag | 220 ms | 120 ms | 70 ms | 40 ms |
| Spray compensation skill | 0.2 | 0.5 | 0.8 | 0.95 |
| Pre-aim correctness | 0.3 | 0.6 | 0.85 | 0.95 |
| Use of utility | 0.2 | 0.5 | 0.8 | 0.9 |
| Walk-when-close probability | 0.3 | 0.7 | 0.9 | 0.95 |

Aim is modeled as a **target point with noise**, smoothed toward by an exponential filter. Bots don't snap; they swing. They miss the first shot more often than they hit. They lose track when an enemy strafes hard. This is intentional.

Recoil compensation: bots predict the spray pattern and pull "down" by `pattern_offset * compensation_skill`. At Expert, they're near-perfect. At Easy, they let the gun fly upward and miss after the third bullet.

### 14.5 Strategist — round-level planning

One strategist per team. Runs at round start and on key events (teammate down, bomb planted, enemy spotted on a critical callout). It does *not* tick every frame — it's event-driven.

**At round start (post-buy):**

1. Survey the team's economy to choose buy archetype (full / force / eco / pistol).
2. Pick a round plan from a small library, weighted by current map state and recent rounds:
   - **T-side plans:** `rush_a`, `rush_b`, `default_a` (slow play towards A), `default_b`, `split_a` (pinch from long + cat), `split_b` (pinch from tunnels + window), `fake_a` (false push A then rotate to B), `eco_save`.
   - **CT-side plans:** `default_setup` (2 A, 2 B, 1 mid), `stack_a`, `stack_b`, `aggro_mid`, `eco_save_retake`.
3. Assign roles to bots: `entry`, `support`, `awper`, `lurker`, `igl` (T side); `anchor_a`, `anchor_b`, `mid_control`, `rotator`, `awper` (CT side).
4. Compute objective per bot — a callout to occupy and a default facing.

**During round:**

- On bomb plant: strategist re-plans CT side as a retake; pulls anchors from non-plant site to plant site via the callout graph.
- On confirmed kill: strategist updates the team's expected enemy count, may switch from defense to push if numbers favor it.
- On teammate down on a callout: nearby teammate is reassigned to investigate / hold.

The strategist avoids micro-management. It sets objectives; the bot brains figure out how to achieve them.

### 14.6 Team blackboard

```ts
type TeamBlackboard = {
  side: 'T' | 'CT';
  strategy: StrategyId;
  roleByBot: Record<BotId, Role>;
  objectiveByBot: Record<BotId, { callout: CalloutId, facing: CalloutId }>;
  knownEnemies: Map<EnemyId, KnownEnemy>;
  bomb: { state: 'carried' | 'planted' | 'defused' | 'exploded';
          carrier?: BotId; site?: 'A' | 'B'; pos?: Vector3; plantedAtMs?: number };
  alive: BotId[];
  dead: BotId[];
  events: TeamEvent[];     // recent events (capped, time-windowed)
};
```

Bots write to and read from the blackboard. Reads are cheap (it's a plain object). Writes happen at perception ticks and on bot events (death, plant, etc.).

### 14.7 Pathing

- Bots request a path from current position to a target callout/spot via a small **path service**.
- The service rate-limits: max 2 path requests per simulation frame across all bots. Excess requests are queued and served on later frames.
- Paths are computed on the navmesh; the result is cached per (start, end) pair with a TTL.
- Bots follow paths via a steering controller that produces a `wishDir` for the kinematic controller. They check progress every few ticks and replan if blocked or off-path.

### 14.8 Cover queries

When a bot wants cover, it queries the **cover graph** (§7.6) for the best authored cover spot near its position that:
- Is reachable on the navmesh.
- Faces the threat direction (the spot's `facing` aligns with the enemy callout).
- Is not currently occupied by a teammate.

If no good spot exists, the bot falls back to "nearest navmesh point with line of cover" — a runtime check using occlusion raycasts. Authored spots are preferred because they encode tactical knowledge that's expensive to discover at runtime.

### 14.9 Buy logic

Bots use a simple decision tree per role and economy state:

```
if money >= 4500: full buy (rifle + armor + helmet + nades + maybe kit)
elif money >= 2500 and roundType == 'force':
    pistol upgrade + armor + maybe nade
elif money <= 1500 or strategy == 'eco_save':
    save: maybe cheap pistol if 0 weapon, no armor, no nades
else:
    force buy with whatever fits
```

CTs prioritize defuse kits when money allows. Bots don't buy AWPs unless their role is `awper` — at most one per team. A team-level economy check ensures at most one AWP, at most one of each grenade per bot, etc.

### 14.10 Save logic

When a bot's team is clearly losing the round (e.g., 1v3 with bomb not planted, 5+ seconds left), valuable weapons should not die for free:

- Bot retreats toward spawn, hugging walls, checking corners but not engaging.
- If forced into combat, will fight with whatever they have but won't push.
- The save behavior is a high-utility action that overrides `Engage` when survival probability is low. Survival probability is a heuristic from HP, ammo, distance to enemies, distance to safety, and teammate count.

### 14.11 Communication (without voice)

The vision doc says "communicate bomb location with teammates." We do this through the blackboard:

- When a bot sees an enemy or hears a clear sound, the bot writes a `KnownEnemy` to the team blackboard with a degraded "reported" confidence flag.
- The strategist's plans use blackboard knowledge — so a CT bot hearing footsteps on Long causes the strategist to consider a Long push and reposition rotators.

This is more reliable than simulating voice channels and produces the same behavior the player observes ("the bots seem to know things they shouldn't if they hadn't called it out").

### 14.12 Difficulty

A single difficulty slider (Easy / Medium / Hard / Expert) on the start menu sets the per-bot tunables in §14.4 and the strategist aggressiveness. We do *not* expose individual tunables to the user. We *do* allow per-bot variance: even at Hard, one of the five bots is a notch weaker, one a notch stronger, so the team isn't a uniform wall.

### 14.13 Debug visualization

Critical to building this. Toggleable overlays:

- Vision cones drawn per bot.
- LOS rays from each bot to each known enemy.
- Path lines for bots currently navigating.
- Strategist's chosen plan + role assignments printed in a corner panel.
- Sound events as expanding circles at their origin.
- Cover graph drawn on the floor.

We build this *before* M5 starts. AI without a debug view is effectively undebuggable.

---

## 15. HUD

DOM-based, layered above the canvas. CSS grid for layout. One small `<canvas>` for the radar.

### 15.1 Components

| Component | Position | Updated when |
|---|---|---|
| Health + armor | bottom-left | hp/armor changes |
| Helmet icon | bottom-left | helmet bought / lost |
| Ammo (mag/reserve) | bottom-right | fire / reload |
| Active weapon name + icon | bottom-right | weapon switch |
| Money | bottom-right above ammo | economy updates |
| Round timer | top-center | every sim tick (text formatted from seconds) |
| Bomb timer | top-center, replaces round timer | bomb planted |
| Players-alive counter | top-center, beside timer | death events |
| Killfeed | top-right | kill events, fades after 6 s |
| Crosshair | center | always |
| Hit marker | center | applied damage, fades 200 ms |
| Damage flash | full-screen overlay | took damage |
| Flash overlay | full-screen white | flashbang |
| Smoke fade-in | full-screen tint | inside smoke volume |
| Buy menu | full-screen modal | `B` while eligible |
| Scoreboard | center modal | `Tab` while held |
| Radar | top-left, 200×200 canvas | every sim tick |
| Spec mode banner | top-center | dead, watching teammate |

### 15.2 Update strategy

- Numbers (HP, money, ammo) bind to a small reactive store (a custom `subscribe`/`set` with no framework). Components re-render on changes; nothing redraws every frame.
- Radar redraws on its own canvas at 20 Hz; it's small enough that perf isn't a concern.
- Killfeed entries are `<div>` elements with a CSS animation. JavaScript adds them; CSS handles fade-out and removal via `animationend`.

### 15.3 Crosshair

A small, configurable crosshair overlay (scriptable for "static" or "dynamic" mode). Static is the competitive default — does *not* expand with inaccuracy. Dynamic shows current inaccuracy as crosshair gap. Player setting; stored in `localStorage`.

### 15.4 Buy menu

Grid of weapon tiles, grouped by slot (pistols, smgs, rifles, snipers, gear). Hover shows price and stat preview. Click buys. Hotkeys (number keys) for fast purchase. Menu closes on `B` toggle, `Esc`, or buy phase end.

### 15.5 Scoreboard

`Tab` overlay listing both teams. Per row: name, kills, assists, deaths, money, ping (ping is fake — we'll show "0" or hide it). Sort by score descending. Player's row highlighted.

### 15.6 Radar

Top-down render of the map's callout polygons in soft gray fill. Overlays:
- Team dots colored by team (own team only — no wallhacks).
- Player as a triangle pointing in their facing direction.
- Bomb icon when carried by a teammate or planted.
- Sound pings for footsteps from the player's team's heard sources (CS:GO behavior — the radar shows what your *team* hears, not what's actually there).

Drawn at 20 Hz, deterministically — same dot stays the same dot.

### 15.7 Visual style

Match the desert palette. Translucent panels with subtle dark backgrounds and warm-cream text. Don't ape CS:GO's exact colors and avoid trademark visual marks; the layout language should be familiar (clean, functional) without being a literal copy.

---

## 16. Audio

Audio is half the game in a shooter. CS:GO is famous for its sound design. We need to take this seriously from M2 onward.

### 16.1 Audio context and listener

A single `AudioContext`, panner model `HRTF` for positional realism. The listener follows the camera each render frame. We use the Web Audio API directly — Howler.js etc. are unnecessary and add weight.

### 16.2 Sound events

Game systems emit `SoundEvent` records:

```ts
type SoundEvent = {
  kind: 'footstep' | 'gunshot' | 'reload' | 'explosion'
      | 'bomb_beep' | 'plant_complete' | 'defuse_start' | 'defuse_complete'
      | 'flash_detonate' | 'smoke_pop' | 'molotov_ignite'
      | 'hit_marker' | 'death' | 'voice_callout';
  origin: Vector3;
  emitterId?: string;
  loudness: number;          // 0..1, used for falloff and bot perception
  silent?: boolean;          // walked / crouched footsteps; not heard but still emitted
};
```

The audio system plays them spatialized. **The bot perception system also subscribes** — sound events are how bots "hear." A `silent` event is not played and not heard.

### 16.3 Asset acquisition

We need sound assets. Options:

1. Procedurally generate (synth gunshots, footsteps) — possible with `OfflineAudioContext` but quality is mediocre.
2. CC0 sound libraries (Freesound.org `Creative Commons 0` filter, BBC Sound Effects, OpenGameArt) — genuinely free for any use.
3. Record/foley our own — out of scope.

**Decision:** ship M2 with procedurally synthesized placeholders (single-cycle noise burst for gunshots, filtered click for footsteps). Replace with CC0 assets in M7 polish, after explicit user approval per asset. **No third-party audio is added without explicit decision recorded in this doc.**

### 16.4 Mixing

A small bus structure: `master → [sfx, music, ui]`. SFX bus has subbuses for `weapons`, `footsteps`, `voice`, `world`. Volumes are user-tunable (settings panel) and stored in `localStorage`.

### 16.5 Footstep variation

Each surface type (`sand`, `wood`, `metal`, `concrete`) has 4–8 sample variations. We pick a random one per step, with a "no-repeat" buffer of the last 2 to avoid identical-sound runs. Pitch is randomized ±5%.

### 16.6 Distance falloff

Linear distance attenuation with a max distance (~50 m for footsteps, ~200 m for gunshots). Below ~3 m, use a near-field exponential curve to give close sounds proper presence without clipping.

### 16.7 Occlusion (light)

A simple low-pass filter applied to sounds whose path to the listener is blocked by world geometry (one raycast per audible event). Cheap, sounds great. Reverb is out of scope.

---

## 17. Performance Plan

### 17.1 Frame budget at 60 fps (16.6 ms)

| System | Budget | Notes |
|---|---|---|
| Render | 6.0 ms | Single scene, merged geometry, MSAA, post-FX |
| Physics step (Havok) | 0.5 ms | Only ticks when grenades / drops exist |
| Character controllers (10) | 0.8 ms | Custom kinematic; mostly capsule sweeps |
| Hitscan + damage | 0.2 ms | Spike on burst fire; amortized very low |
| AI perception | 1.0 ms | 10 Hz, staggered → ~1–2 bots/frame |
| AI decisions | 0.5 ms | 5 Hz, staggered |
| Pathing | 0.5 ms | 1 path/frame ceiling, cached |
| HUD updates | 0.3 ms | DOM, event-driven |
| Audio | 0.2 ms | Web Audio is offloaded |
| Misc | 0.5 ms | Event bus, accumulator, debug |
| **Total** | **10.5 ms** | ~6 ms headroom |

Headroom is intentional. Worst-case spikes (grenade explosions, multiple bots seeing each other simultaneously after a smoke pops) should still fit in 16.6 ms.

### 17.2 Memory plan

- All transient game objects are pooled: bullets (impact decals), particle emitters, sound nodes, grenades, fire patches, smoke clouds.
- Vector math uses scratch buffers (Babylon's `Vector3.TmpVectors`). No `new Vector3` in hot paths.
- AI scratch state (path nodes, perception results) reused frame-to-frame.
- Garbage collection should not run during a round under normal load. We profile with Chrome DevTools Memory tab to confirm.

### 17.3 GPU plan

- All static geometry merged per material → 5–10 draw calls for the world.
- Player meshes are one mesh per character with a 2K-or-smaller skin texture; instanced where identical (T uniforms × 5).
- View model is its own mesh, rendered to a separate render layer with a different camera FOV (so it doesn't z-fight at edge cases). Standard FPS technique.
- Shadow map: one cascade for near (6 m), one for mid (20 m), one for far (60 m). Resolution 2048 each on desktop.
- Post-processing: keep the chain short. ACES + bloom + FXAA + sharpen + vignette + LUT. SSAO conditional.

### 17.4 Performance HUD

Always-visible-when-debug overlay shows: FPS, frame time, draw calls, triangles rendered, GC events (last 10 s), AI ticks/sec, navmesh queries/sec, active grenade count. Toggled with a key.

### 17.5 Adaptive quality

If we detect frame time consistently > 18 ms over a 5-second window, we automatically downgrade:

1. Drop SSAO.
2. Drop shadow cascade resolution.
3. Drop bloom quality.
4. Drop MSAA to FXAA only.
5. Drop render scale to 0.85.

Each step is reversible if the user later opens settings and forces it. The point is to keep the *game* smooth even on weaker hardware.

---

## 18. Data Schemas

A consolidated reference for the shapes that flow between modules. Names and exact fields will refine during implementation; the structure is what matters here.

### 18.1 PlayerState

```ts
type PlayerId = string;
type Team = 'T' | 'CT';

type PlayerState = {
  id: PlayerId;
  isLocal: boolean;       // true for the human, false for bots
  team: Team;
  side: 'T' | 'CT';       // current side (flips at halftime)
  alive: boolean;
  hp: number;             // 0..100
  armor: number;          // 0..100
  helmet: boolean;
  hasKit: boolean;        // CT defuse kit
  money: number;
  inventory: Inventory;
  position: Vector3;
  velocity: Vector3;
  yaw: number;
  pitch: number;
  crouching: boolean;
  walking: boolean;
  flashedUntilMs?: number;
  bot?: BotState;         // if isLocal === false
};
```

### 18.2 Inventory

```ts
type Inventory = {
  primary?: WeaponInstance;
  secondary?: WeaponInstance;
  knife: WeaponInstance;
  grenades: WeaponInstance[];   // up to 4 total, max 1 of each non-flash, 2 flashes
  c4?: WeaponInstance;          // T side, only one in the team
  active: 'primary' | 'secondary' | 'knife' | 'grenade' | 'c4';
};

type WeaponInstance = {
  def: WeaponDef;
  ammoMag: number;
  ammoReserve: number;
  state: 'ready' | 'firing' | 'reloading' | 'deploying';
  stateUntilMs: number;
  spraySinceMs: number;     // tracks recoil decay
};
```

### 18.3 RoundState

```ts
type RoundState = {
  number: number;            // 1..30
  half: 1 | 2;
  phase: 'freeze' | 'live' | 'planted' | 'end';
  phaseEndMs: number;        // wall time when current phase ends
  scoreT: number;
  scoreCT: number;
  bomb: BombState;
  events: RoundEvent[];      // append-only log used for economy + killfeed
};

type BombState =
  | { state: 'carried'; carrier: PlayerId }
  | { state: 'planted'; pos: Vector3; site: 'A' | 'B'; plantedAtMs: number; defuser?: PlayerId }
  | { state: 'defused' | 'exploded' };
```

### 18.4 RoundEvent

```ts
type RoundEvent =
  | { kind: 'kill'; attacker: PlayerId; victim: PlayerId; weapon: WeaponId; headshot: boolean; tMs: number }
  | { kind: 'damage'; attacker: PlayerId; victim: PlayerId; amount: number; tMs: number }
  | { kind: 'plant'; planter: PlayerId; site: 'A' | 'B'; tMs: number }
  | { kind: 'defuse'; defuser: PlayerId; tMs: number }
  | { kind: 'explode'; tMs: number }
  | { kind: 'roundEnd'; winner: Team; reason: WinReason; tMs: number };
```

### 18.5 BotState

```ts
type BotState = {
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  role: 'entry' | 'support' | 'awper' | 'lurker' | 'igl' | 'anchor_a' | 'anchor_b' | 'mid_control' | 'rotator';
  objective: { callout: CalloutId; facing: CalloutId } | null;
  perception: {
    knownEnemies: Map<PlayerId, KnownEnemy>;
    soundInbox: SoundEvent[];
    nextTickMs: number;
  };
  tunables: BotTunables;     // reaction, aim error, etc.
  currentAction: ActionId | null;
  actionState: object;       // per-action working memory
};
```

### 18.6 MapData

```ts
type MapData = {
  visualMeshes: BabylonMesh[];
  collisionMesh: BabylonMesh;
  navmesh: NavmeshHandle;
  callouts: Map<CalloutId, Callout>;
  coverSpots: Map<string, CoverSpot>;
  spawns: { T: Vector3[]; CT: Vector3[] };
  bombSites: { A: Polygon; B: Polygon };
  buyZones: { T: Polygon; CT: Polygon };
};
```

### 18.7 Sound and Perception (defined inline above; cross-references)

`SoundEvent` defined in §16.2. `KnownEnemy` defined in §14.2. `WeaponDef` defined in §10.1. `TeamBlackboard` defined in §14.6.

---

## 19. Phased Roadmap

Each milestone ends with a playable demo. We don't move on until the demo runs. Estimates are scope, not calendar — they assume one focused implementer and AI assistance.

### M1 — Walk the Map

**Demo:** Boot in browser, pretty desert scene, walk T spawn → mid → A site → B site. No combat.

- Vite + TypeScript + Babylon scaffold; project structure per §5.
- Engine layer: scene, fixed-timestep loop, input, time, event bus.
- Procedural sky, sun + ambient, post-processing pipeline (ACES, bloom, FXAA, vignette, LUT).
- Procedural materials: sand_floor, sand_wall, wood, metal, concrete (PBR with noise-driven normal/roughness).
- Map data structure (`Block`, `group`, `prefab`, `zone`).
- Dust 2 blockout — pass 1 (rough proportions, all callouts present, walkable).
- Custom kinematic capsule controller with run/walk/crouch/jump and counter-strafe.
- FPS camera with view bobbing.
- Debug HUD (FPS, position, callout under cursor).

### M2 — Shoot Something

**Demo:** Stand in T spawn, walk to A site, shoot a stationary dummy with AK and USP. Spray pattern visible on a wall. Dummy dies.

- Weapon data table for AK, M4A4, USP-S, Glock, AWP, Knife, C4 (data only — only AK + USP usable in M2).
- Hitscan combat module with damage, falloff, armor, hitbox multipliers, wallbang.
- Recoil and spray pattern lookup; camera kick.
- Inaccuracy state machine (still / moving / jumping / crouched).
- View model rendering (rifle and pistol primitives), reload tween, deploy delay.
- Bullet impact decals, muzzle flash, shell ejection (particle).
- Procedural placeholder gunshot sounds (synth-generated).
- Stationary "dummies" with hitboxes for testing.
- Vitest suite for damage formulas vs vision-doc numbers.

### M3 — One Round

**Demo:** Round timer counts down, you can buy weapons, plant the bomb, and the round ends correctly. Halftime swaps sides.

- Match and round FSMs.
- Buy menu (DOM) with affordability, team eligibility, slot replacement.
- Economy module with all reward rules and loss bonus.
- Bomb plant and defuse mechanics, bomb timer, beep audio.
- HUD: round timer, bomb timer, players-alive counter, money, hp/armor, ammo, helmet, kit indicator.
- Killfeed, hit marker, damage flash, scoreboard (Tab).
- Halftime side swap with money reset.
- "Dummy bots" that just stand at random spawn points so the round can technically end (one team eliminated when shot).
- Vitest suite for economy and round transitions.

### M4 — Bots That Move and Shoot

**Demo:** Real 5v5 round. Bots path through the map, see each other, shoot, and trade kills. Bot tactical play is shallow (no team plans yet) but combat works.

- Navmesh baking (RecastJS) on collision mesh; off-mesh links for jump-up spots.
- Path service with caching and per-frame budget.
- Bot perception: vision cone + LOS raycasts at 10 Hz, staggered.
- Sound event subscription per bot.
- Per-bot Known Enemies map.
- Controller adapter: aim with reaction delay, tracking lag, and noise.
- Recoil compensation per difficulty.
- Behavior tree leaves: `Engage`, `Reload`, `MoveTo(callout)`, `Idle`, `Plant`, `Defuse`.
- Crude utility selector (no strategist yet).
- Bot buy logic (single-bot, no team coordination).
- Debug overlays: vision cones, LOS rays, bot paths.

### M5 — Bots That Play CS

**Demo:** Match feels like CS:GO. T executes a strategy, CTs hold positions, rotations happen on plant, retake works.

- Strategist per team with plan library (rush_a, rush_b, default_a, default_b, split_a, split_b, fake_a, eco_save; CT: default_setup, stack_a, stack_b, retake).
- Role assignments per bot.
- Team blackboard with shared knowledge and event log.
- Rotation logic (CT pulls anchors to plant site).
- Retake plans on bomb plant.
- Save logic.
- Cover graph authored on the map; bots prefer authored cover.
- Per-bot variance within difficulty.
- Strategist debug panel.

### M6 — Grenades

**Demo:** Bots flash before peeking long, smoke off CT crossing, molotov default plant. Player can buy and throw all grenades.

- Throw mechanics (full and underhand toss).
- Havok rigid bodies for grenades, pooled.
- Flashbang detonation with LoS-based blind durations.
- Smoke cloud spawning, vision occlusion volume, particle visuals.
- Molotov fire patches with tick damage.
- HE explosion damage with LoS.
- Decoy gunfire spoof.
- Bot grenade usage hooks: per-strategy nade lineups (a curated list of "throw smoke X to land at Y" entries authored on the map).

### M7 — Polish

**Demo:** Full match, all rounds, beautiful and tuned.

- Lightmap baking pass.
- Replace placeholder audio with curated CC0 assets (with explicit approval per asset).
- Replace primitive view models with detailed procedural meshes.
- Detailed character models (still procedural; better proportions, secondary materials).
- Settings menu (volume mixers, sensitivity, crosshair, difficulty, graphics presets).
- Adaptive quality detector wired in.
- Final aesthetic pass on Dust 2 (pass 3 — trim, props, palm trees, blue car, B truck).
- Performance profiling, GC audit, memory pool sizing review.
- Difficulty tuning playtest pass.

### Estimated effort split

If the total project is 100%:
- Map and rendering: 20%
- Player controls + combat + weapons: 20%
- Round / economy / bomb / HUD: 15%
- Bot AI: 35%
- Audio + grenades + polish: 10%

Bot AI is the dominant cost. Plan accordingly.

---

## 20. Risks and Open Questions

### 20.1 Top risks

**R1 — Bot tactical quality.** The biggest unknown. Mitigation: ship M4 fast and play it; iterate on M5 by playing rounds, not by reading specs. Authored cover and authored grenade lineups buy us a lot of "smart" behavior cheaply.

**R2 — Movement feel.** Cloning Source-style movement on the first try is unlikely. Mitigation: build M1 with the controller params surfaced as live-tunable values (debug panel). Iterate by feel until it's right before M2.

**R3 — Dust 2 fidelity.** The map has a lot of subtle angles. Mitigation: three explicit iteration passes (§7.3), with the second pass freezing tactical metadata so AI can be developed against a stable spatial model.

**R4 — Performance under worst case.** 9 bots seeing each other after a smoke pops is a spike scenario. Mitigation: stagger AI work, cap per-frame work (e.g., pathing budget), and the perf HUD watches for frame stalls during M4 onward.

**R5 — Browser memory.** Babylon + Havok + lots of textures can balloon. Mitigation: procedural materials reduce texture memory; pool everything; profile before M7.

**R6 — Animation quality.** Without proper character animation, players walk like statues sliding around. Mitigation: procedural locomotion (IK-style leg planting + simple bobbing) is feasible with Babylon's animation system; alternatively, very light bone-animated walk/run/idle on a simple rig in M7.

**R7 — Audio asset pipeline.** Synth audio is fine for placeholder but not for shipping. Mitigation: M7 polish replaces with curated CC0 assets, recorded as additions in this doc.

### 20.2 Open questions

- **Q1 — Animation rig:** procedural-only, or import a CC0 humanoid rig in M7? Decision deferred to M5 retrospective; will record the choice here when made.
- **Q2 — Lightmap vs realtime shadows long-term:** if performance is good with realtime, we may skip the bake. Decided after M5 perf measurement.
- **Q3 — WebGPU:** auto-prefer if available, but does it materially help us? Babylon supports both transparently. We default WebGL2 and revisit if WebGPU shows wins on representative hardware.
- **Q4 — Difficulty curve:** the four-tier table in §14.4 is a starting point. Numbers will move during playtests.
- **Q5 — Buy zone behavior:** CS:GO lets you buy from spawn for the first ~20 s. We're matching that. Confirming: if a player walks out of buy zone, the menu closes — they can re-enter. Yes, that's the rule.

### 20.3 Asset additions

This section is updated whenever a third-party asset is added to the project. **Empty at design time.** If we add a CC0 audio sample, character mesh, texture, etc., it gets a row here with source URL, license, and the date/decision that approved it.

| Asset | Type | Source | License | Approved | Notes |
|---|---|---|---|---|---|
| *(none yet)* | | | | | |

### 20.4 Out of scope reaffirmed

To resist scope creep mid-project, these are explicitly *not* in scope (echoes vision doc + this doc's non-goals):

- Networking, matchmaking, online play
- Map editor, level packs, mod support
- Skins, cosmetics, progression, persistent stats
- Voice chat or voice synthesis
- Mobile, console, or VR
- Localization beyond English
- Anti-cheat
- Overtime rules; first to 16 ends the match

---

## 21. Implementation Notes for Build Time

A few practical notes the implementation will care about:

- **Strict TypeScript.** `strict: true`, `noImplicitAny`, `noUncheckedIndexedAccess`. Catch the errors at compile time.
- **No `any`.** If a Babylon API requires it, isolate it in the `engine/` layer.
- **No DOM access outside `hud/` and `engine/input.ts`.** Keep gameplay code engine-agnostic.
- **Public/internal split.** Each module exports a small public surface; internals are not re-exported from `index.ts`.
- **Hot module reload friendly.** Singletons keep their state across module reloads where feasible. Map definition is HMR-able so layout iteration is fast.
- **Dependency graph rule:** dependencies flow downward (`match → world → physics → engine`). No upward imports. Lint via `eslint-plugin-import`.

---

## 22. Definition of Done (per milestone)

A milestone is "done" when:

1. The demo described for that milestone runs without console errors in a fresh Chrome tab.
2. Frame time stays at < 18 ms in average gameplay on a modern desktop browser.
3. Vitest passes.
4. The design doc is updated to reflect any decisions changed during implementation.
5. A short note is added to the milestone's section recording what shipped and what slipped.

A "playable" project is more important than a "complete" one. Cut features before cutting milestones.

---

## End of design doc

This document is the source of truth for design decisions. When implementation reveals something the design got wrong, **update the doc in the same commit as the fix.** Don't let drift accumulate.

