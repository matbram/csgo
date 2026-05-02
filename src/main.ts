/** App entry. Boots the engine, builds the map, runs a 5v5 match.
 *
 *  Init order:
 *    1.  Engine + scene
 *    2.  Lighting + sky
 *    3.  Map build (world + meshes)
 *    4.  Local controller + camera + post-FX
 *    5.  Local player wrapper + view model
 *    6.  Combat + audio + visuals
 *    7.  Roster (4 T bots + 5 CT bots + local)
 *    8.  Match state, HUDs (round, combat, scoreboard, buy menu)
 *    9.  Input
 *   10.  Loop
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { createEngine, getEngine, getScene } from './engine/scene';
import { createLighting } from './engine/lighting';
import { createPostFx } from './engine/postfx';
import { adaptiveQuality } from './engine/adaptiveQuality';
import { input } from './engine/input';
import { loop } from './engine/loop';
import { time } from './engine/time';
import { events } from './engine/events';
import { debugLog } from './engine/debugLog';
import { buildMap } from './map/builder';
import { dust2 } from './map/dust2';
import { CharacterController, DEFAULT_TUNABLES } from './player/controller';
import { WorldQuery } from './player/physics';
import { FpsCamera } from './player/fpsCamera';
import { StartOverlay, ensureCrosshair } from './hud/overlay';
import { SettingsHud } from './hud/settingsHud';
import { settings } from './engine/settings';
import { DebugHud } from './hud/debugHud';
import { LocalPlayer } from './player/localPlayer';
import { legSpeedScale } from './entities/character';
import { ViewModel } from './player/viewModel';
import { CombatSystem } from './combat/combat';
import { FiringController } from './combat/firing';
import { activeInstance, switchTo, makeInstance, cycleScope, nextScrollSlot, consumeActiveGrenade } from './weapons/inventory';
import { runBotBuy } from './ai/buy';
import type { WeaponInstance } from './weapons/inventory';
import { installCombatVisuals } from './combat/visuals';
import { installAudio, ensureAudioContext, setListenerPose, playSound } from './audio/audio';
import { CombatHud } from './hud/combatHud';
import { ScopeHud } from './hud/scopeHud';
import { AiDebugHud } from './hud/aiDebug';
import { FlashOverlay } from './hud/flashOverlay';
import { SpectatorHud } from './hud/spectatorHud';
import { MatchEndHud } from './hud/matchEndHud';
import { Spectator } from './player/spectator';
import { GrenadeSystem } from './grenades/system';
import { installGrenadeVisuals } from './grenades/visuals';
import { createBot, snapBotToCharacterPose, setBotObjective, stepBot, syncBotMesh, type Bot } from './entities/bot';
import { NavGrid } from './nav/grid';
import { PathService } from './nav/pathService';
import { makeBlackboard, aggregateKnown, refreshTeamRoster, aliveCount } from './ai/blackboard';
import { planRoundStart, reactToBombPlanted } from './ai/strategist';
import { setMatchSeed } from './ai/rng';
import { buildWorldStateView, type WorldStateView } from './ai/world/state';
import { buildTacticalGraph, type TacticalGraph } from './ai/world/tacticalGraph';
import { dust2Overlay } from './ai/world/tacticalOverlay.dust2';
import { installCommsTriggers, tickComms, setCommsSimNow, applyCommsIntel } from './ai/comms/triggers';
import { resetComms } from './ai/comms/callouts';
import { CalloutFeedHud } from './hud/calloutFeed';
import type { Character } from './entities/character';
import { pointInPolygon2D } from './map/world';
import { makeMatch, beginRound, endRound, applyHalftime, stepMatch, type MatchState } from './match/match';
import { resetRoster, assignBomb } from './match/roster';
import { isBuyPhase, isMovementLocked } from './match/round';
import { RoundHud } from './hud/roundHud';
import { Scoreboard } from './hud/scoreboard';
import { BuyMenu } from './hud/buyMenu';
import { C4Entity } from './entities/c4';
import { BombHud } from './hud/bombHud';
import { purchaseWeapon, purchaseArmor, purchaseKit } from './match/purchase';
import type { Side } from './match/economy';

/** Camera-local forward axis. Babylon's `getDirectionToRef` transforms
 *  this through the camera's world matrix, giving us the exact view ray
 *  the player sees down the crosshair. We allocate it once and reuse it
 *  to avoid per-shot garbage. */
const BABYLON_FORWARD = new Vector3(0, 0, 1);
const camForward = new Vector3(0, 0, 0);

function bootstrap(): void {
  const canvas = document.getElementById('render-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Render canvas missing');
  }
  const hudRoot = document.getElementById('hud-root');
  if (!(hudRoot instanceof HTMLDivElement)) {
    throw new Error('HUD root missing');
  }

  // 1) Engine + scene
  createEngine(canvas);
  const engine = getEngine();
  const scene = getScene();

  // 2) Lighting
  createLighting();

  // 3) Map
  const { world } = buildMap(dust2());

  // 4) Local controller + camera + post-FX
  const tSpawns = world.spawnsForTeam('T');
  const startSpawn = tSpawns[0] ?? null;
  const startPos = startSpawn?.pos.clone() ?? new Vector3(0, 1, -38);
  startPos.y += 0.5;
  const startYaw = startSpawn?.yaw ?? 0;

  const query = new WorldQuery(world);
  const controller = new CharacterController(query, startPos, startYaw, DEFAULT_TUNABLES);
  controller.snapToGround();
  const fps = new FpsCamera(controller);
  createPostFx(fps.camera);
  adaptiveQuality.start();

  // 5) Local player + view model
  const localPlayer = new LocalPlayer(controller, 'T');
  const viewModel = new ViewModel(fps.camera);
  viewModel.setWeapon(currentInstance(localPlayer));

  // 6) Combat + audio + visuals
  const characters: Character[] = [localPlayer.character];
  // Grenade system + smoke field. The smoke field doubles as a vision
  // occluder for combat hits and bot perception, so we instantiate it
  // BEFORE the combat system / before bot brains tick.
  const grenadeSystem = new GrenadeSystem(world, query, () => characters);
  const combatSystem = new CombatSystem(query, () => characters, grenadeSystem.smoke);
  const firing = new FiringController(combatSystem);
  installAudio();
  // Pass the world query (for wall-blood ray casts) and a humanoid
  // lookup (so the visuals layer can rip a body part off the bot that
  // just died) into the combat visuals install. The local player has
  // no humanoid mesh — `partsForId('local')` returns null and the
  // dismemberment step silently skips for them.
  installCombatVisuals({
    worldQuery: query,
    partsForId: (id) => bots.find(b => b.id === id)?.parts ?? null,
  });
  installGrenadeVisuals(grenadeSystem);

  // 6.5) Nav grid + path service. Built once at boot — Dust 2 is static
  // and the grid is small enough to bake synchronously (<200 ms).
  const navGrid = NavGrid.build(world, query);
  const pathService = new PathService(navGrid, { maxRequestsPerFrame: 2, cacheSize: 32 });
  // Tactical graph — cover/peek/hold/pre-aim derived from the nav grid +
  // world geometry, with a per-map hand-tune overlay. Phase 1: built
  // once at boot, only the F4 overlay reads it. Phase 3 cuts the GOAP
  // planner over to it for cost overlays + action targeting.
  const tacticalGraph: TacticalGraph = buildTacticalGraph(world, navGrid, query, dust2Overlay);

  // 7) Roster: 4 T bots (teammates of local), 5 CT bots (enemies).
  // Seed the AI RNG before bots are constructed so each Brain forks a
  // stable per-bot stream from the match seed. A `?seed=N` URL param
  // overrides the wall-clock default — used for replaying a specific
  // round during debugging.
  const seedParam = new URLSearchParams(window.location.search).get('seed');
  if (seedParam) {
    const n = Number.parseInt(seedParam, 10);
    if (Number.isFinite(n)) setMatchSeed(n);
  }
  const bots: Bot[] = [];
  for (let i = 0; i < 4; i++) {
    const sp = tSpawns[(i + 1) % Math.max(1, tSpawns.length)] ?? startSpawn!;
    const bot = createBot('T', sp.pos.x, sp.pos.y, sp.pos.z, sp.yaw, query, {
      id: `t-bot-${i + 1}`,
      teamIndex: i,
      difficulty: settings.get().difficulty,
    });
    bots.push(bot);
    characters.push(bot.character);
  }
  const ctSpawns = world.spawnsForTeam('CT');
  for (let i = 0; i < 5; i++) {
    const sp = ctSpawns[i % Math.max(1, ctSpawns.length)] ?? ctSpawns[0]!;
    if (!sp) throw new Error('No CT spawns authored');
    const bot = createBot('CT', sp.pos.x, sp.pos.y, sp.pos.z, sp.yaw, query, {
      id: `ct-bot-${i + 1}`,
      teamIndex: i,
      difficulty: settings.get().difficulty,
    });
    bots.push(bot);
    characters.push(bot.character);
  }

  // 7.5) Per-team blackboards. The strategist writes plans into these
  // each round; bot brains read objectives + role + shared intel from
  // them every tick. The local player belongs to the T side after the
  // halftime swap may flip — we don't mutate the local player's brain
  // (they don't have one) but we still let them be tracked as alive in
  // the T blackboard so the bot save heuristic counts correctly.
  const tBoard = makeBlackboard('T');
  const ctBoard = makeBlackboard('CT');

  // Comms triggers — wired once. Listens to combat/match/grenade events
  // on the typed bus and synthesises player-style callouts onto the
  // per-team blackboards. The lookup map is rebuilt on roster changes
  // (only at boot today; per-round respawn keeps the same ids).
  const botById = new Map<string, Bot>();
  for (const b of bots) botById.set(b.id, b);
  installCommsTriggers({ botById, tBoard, ctBoard, world });

  // Compute spawn centroids once — used by the bot Save state to pick
  // a retreat target. Spawn polygons aren't authored separately, so we
  // average the spawn points for each team.
  const spawnCentroid = (side: 'T' | 'CT'): { x: number; z: number } => {
    const sps = world.spawnsForTeam(side);
    if (sps.length === 0) return { x: 0, z: side === 'T' ? -38 : 28 };
    let sx = 0, sz = 0;
    for (const s of sps) { sx += s.pos.x; sz += s.pos.z; }
    return { x: sx / sps.length, z: sz / sps.length };
  };
  const tSpawnCentroid = spawnCentroid('T');
  const ctSpawnCentroid = spawnCentroid('CT');

  // 8) Match state
  let match: MatchState = makeMatch({
    players: [
      { id: 'local', side: 'T' },
      ...[1, 2, 3, 4].map((n) => ({ id: `t-bot-${n}`, side: 'T' as Side })),
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `ct-bot-${n}`, side: 'CT' as Side })),
    ],
  });

  // HUDs
  ensureCrosshair();
  const settingsHud = new SettingsHud(hudRoot);
  const debugHud = new DebugHud(controller, world);
  const combatHud = new CombatHud();
  const scopeHud = new ScopeHud();
  const aiDebugHud = new AiDebugHud();
  const calloutFeedHud = new CalloutFeedHud();
  const flashOverlay = new FlashOverlay();
  const spectatorHud = new SpectatorHud();
  const matchEndHud = new MatchEndHud();
  const spectator = new Spectator();
  const roundHud = new RoundHud(hudRoot);
  const scoreboard = new Scoreboard(hudRoot);
  const c4Entity = new C4Entity();
  const bombHud = new BombHud(hudRoot);
  const buyMenu = new BuyMenu(hudRoot, (req) => {
    const slot = match.players.get('local');
    if (!slot) return { ok: false, reason: 'No slot' };
    const c = localPlayer.character;
    switch (req.kind) {
      case 'weapon':
        if (!req.weapon) return { ok: false, reason: 'no weapon id' };
        return purchaseWeapon(slot, c, req.weapon);
      case 'armor':  return purchaseArmor(slot, c, false);
      case 'helmet': return purchaseArmor(slot, c, true);
      case 'kit':    return purchaseKit(slot, c);
    }
  });

  const startOverlay = new StartOverlay(canvas);
  startOverlay.bind();

  // Round-end → next round transition handled in sim loop.
  let roundEndApplied = false;
  let lastRoundNumber = 0;
  // Per-bot transition tracking for the 'bots' debug channel — log a
  // single line on transitions in/out of "stuck", not every frame.
  const wasStuck = new Set<string>();
  // Sim ms when the current round entered live phase (post-freeze).
  // Used by the bot brain's grenade-lineup trigger windows.
  let liveStartedAtMs = 0;
  let lastSeenPhase: 'freeze' | 'live' | 'end' | null = null;
  /** Last-built AI world view. Rebuilt every live tick; held across
   *  freeze/end so the debug HUD has something to render. */
  let worldView: WorldStateView | null = null;

  // Track local-player kills/deaths for scoreboard + economy.
  events.on('combat:kill', ({ attackerId, victimId, weapon }) => {
    const atk = match.players.get(attackerId);
    const vic = match.players.get(victimId);
    if (atk) {
      atk.kills += 1;
      atk.killWeapons.push(weapon as never);
    }
    if (vic) vic.deaths += 1;
    // If the possessed bot just died, drop possession so the player
    // re-enters spectator mode and can pick a different teammate to
    // take over (rather than getting stuck inside a corpse).
    if (localPlayer.possessedBotId && localPlayer.possessedBotId === victimId) {
      const possessed = bots.find(b => b.id === localPlayer.possessedBotId);
      if (possessed) possessed.aiDisabled = false;
      localPlayer.releasePossession();
      fps.bindController(localPlayer.controller);
    }
  });

  // Bomb plant → both strategists re-plan: T defends the planted site,
  // CT swings into a retake formation. The bot brains pick up the new
  // objectives via the per-tick blackboard read.
  events.on('match:bombPlanted', () => {
    const bombInfo = mirrorBomb(match.round?.bomb);
    if (bombInfo.site && bombInfo.pos) {
      reactToBombPlanted(tBoard, bots, bombInfo, world, navGrid, time.simMs);
      reactToBombPlanted(ctBoard, bots, bombInfo, world, navGrid, time.simMs);
    }
  });

  // Gunshot → sound perception. Every bot on the opposing team within
  // hearing range gets a 'sound' confidence ping at the shooter's
  // position. Bots already in 'visible' state on the same shooter keep
  // their higher-confidence intel — `reportSound` won't downgrade.
  const HEARING_RANGE_M = 35;
  events.on('combat:fire', ({ shooterId, ox, oy, oz, tMs }) => {
    const shooter = characters.find(c => c.id === shooterId);
    if (!shooter) return;
    for (const bot of bots) {
      if (!bot.character.alive) continue;
      if (bot.character.team === shooter.team) continue;
      const dx = bot.character.pos.x - ox;
      const dz = bot.character.pos.z - oz;
      if (dx * dx + dz * dz > HEARING_RANGE_M * HEARING_RANGE_M) continue;
      bot.perception.reportSound(shooterId, ox, oy, oz, tMs);
    }
  });

  // Footstep perception: enemy bots hear running steps within a
  // shorter range than gunfire. Footsteps degrade to 'sound'
  // confidence in perception — the bot turns to face the noise but
  // won't blind-fire through walls. Same-team steps are ignored so a
  // friendly running past doesn't drag attention onto a teammate.
  const FOOTSTEP_HEARING_M = 22;
  events.on('character:footstep', ({ id, x, y, z, tMs }) => {
    const stepper = characters.find(c => c.id === id);
    if (!stepper) return;
    for (const bot of bots) {
      if (!bot.character.alive) continue;
      if (bot.character.team === stepper.team) continue;
      const dx = bot.character.pos.x - x;
      const dz = bot.character.pos.z - z;
      if (dx * dx + dz * dz > FOOTSTEP_HEARING_M * FOOTSTEP_HEARING_M) continue;
      bot.perception.reportSound(id, x, y, z, tMs);
    }
  });

  // 9) Input
  canvas.addEventListener('click', () => ensureAudioContext());
  input.attach(canvas);

  // After each roster reset we re-snap every bot to its new spawn pose
  // (the controller state doesn't follow the Character record on its own)
  // and hand out fresh objectives. Path requests are deferred to the
  // first sim tick so the path service's per-frame budget applies.
  const refreshBotsForNewRound = (): void => {
    if (!match.round) return;
    // Drop any in-flight grenades / smokes / fire patches from the
    // previous round — none of that should bleed into the new round.
    grenadeSystem.reset();
    // The local player respawns in their own body next round, so release
    // any active possession before we reset bot state. The previously-
    // possessed bot regains its AI for the new round.
    if (localPlayer.possessedBotId) {
      const possessed = bots.find(b => b.id === localPlayer.possessedBotId);
      if (possessed) possessed.aiDisabled = false;
      localPlayer.releasePossession();
      fps.bindController(localPlayer.controller);
    }
    const tBots: Bot[] = [];
    const ctBots: Bot[] = [];
    for (const bot of bots) {
      snapBotToCharacterPose(bot);
      // Run each bot's buy plan once the new round's loadout is settled.
      // Bots that survived already have their primary thanks to the
      // roster's carry-over rule, so runBotBuy is a no-op for them
      // beyond a possible armor top-up.
      const slot = match.players.get(bot.id);
      if (slot) runBotBuy(slot, bot.character);
      if (bot.character.team === 'T') tBots.push(bot);
      else ctBots.push(bot);
    }
    // Strategists pick a plan, assign roles, write objectives. Bots then
    // pull their objective from their team's blackboard. Pass navGrid so
    // each plan slot's callout centroid gets snapped to a walkable cell
    // before storing — otherwise a centroid in a wall column strands the
    // assigned bot at spawn.
    const round = match.round.number;
    planRoundStart(tBoard, tBots, match.players, world, navGrid, round, time.simMs);
    planRoundStart(ctBoard, ctBots, match.players, world, navGrid, round, time.simMs);
    applyBlackboardObjectives(tBoard, tBots);
    applyBlackboardObjectives(ctBoard, ctBots);
    debugLog.round('refreshBots', {
      t: time.simMs,
      round,
      tStrat: tBoard.strategy,
      ctStrat: ctBoard.strategy,
      tWithObj: tBots.filter(b => b.objective !== null).length + '/' + tBots.length,
      ctWithObj: ctBots.filter(b => b.objective !== null).length + '/' + ctBots.length,
    });
    // Per-bot one-liners so the team's full assignment is visible
    // without 9 nested objects in a single dump.
    if (debugLog.isEnabled('round')) {
      for (const b of [...tBots, ...ctBots]) {
        debugLog.round('  bot', {
          t: time.simMs,
          id: b.id,
          team: b.character.team,
          obj: b.objective ?? '-',
          pos: { x: b.character.pos.x, z: b.character.pos.z },
        });
      }
    }
  };

  const applyBlackboardObjectives = (
    bb: ReturnType<typeof makeBlackboard>,
    teamBots: Bot[],
  ): void => {
    for (const bot of teamBots) {
      const obj = bb.objectiveByBot.get(bot.id);
      if (!obj) continue;
      setBotObjective(bot, obj.x, obj.z);
    }
  };

  /** Per-tick helper: keep `bot.objective` in sync with the strategist's
   *  current assignment, except when the brain is in Save mode — then
   *  the retreat target wins. We re-apply on every tick so a state
   *  transition out of Save automatically restores the team plan
   *  without a separate "exit save" hook. */
  const applyBotObjectiveFromBoard = (
    bot: Bot,
    bb: ReturnType<typeof makeBlackboard>,
    spawnPos: { x: number; z: number },
  ): void => {
    if (bot.brain.state === 'save') {
      // Retreat to spawn. setBotObjective is idempotent if the target
      // matches — but it clears the path each call, so guard on a small
      // epsilon to avoid replanning every frame.
      const cur = bot.objective;
      if (!cur || Math.abs(cur.x - spawnPos.x) > 0.5 || Math.abs(cur.z - spawnPos.z) > 0.5) {
        setBotObjective(bot, spawnPos.x, spawnPos.z);
      }
      return;
    }
    const obj = bb.objectiveByBot.get(bot.id);
    if (!obj) return;
    const cur = bot.objective;
    if (!cur || Math.abs(cur.x - obj.x) > 0.5 || Math.abs(cur.z - obj.z) > 0.5) {
      setBotObjective(bot, obj.x, obj.z);
    }
  };

  /** Adapt the match's BombState into the blackboard's BombInfo shape.
   *  Returns the "no bomb" sentinel when there's no live bomb state. */
  const mirrorBomb = (b: import('./match/bomb').BombState | null | undefined): import('./ai/blackboard').BombInfo => {
    if (!b) return { phase: 'carried', carrierId: null, site: null, pos: null };
    return { phase: b.phase, carrierId: b.carrierId, site: b.site, pos: b.pos };
  };

  const buyMenuCtx = (
    slot: import('./match/match').MatchPlayerSlot,
    inBuyZone: boolean,
    buyPhase: boolean,
  ): import('./hud/buyMenu').BuyContext => {
    const inv = localPlayer.character.inventory;
    const grenades = { he: 0, flashbang: 0, smoke: 0, molotov: 0, decoy: 0, total: 0 };
    if (inv) {
      for (const g of inv.grenades) {
        if (g.def.id === 'he' || g.def.id === 'flashbang' || g.def.id === 'smoke' || g.def.id === 'molotov' || g.def.id === 'decoy') {
          grenades[g.def.id] += 1;
        }
      }
      grenades.total = inv.grenades.length;
    }
    return {
      side: slot.currentSide,
      money: slot.money,
      inBuyZone, buyPhase,
      helmet: localPlayer.character.helmet,
      armor: localPlayer.character.armor,
      hasKit: localPlayer.character.hasKit,
      hasPrimary: inv?.primary?.def.id ?? null,
      hasSecondary: inv?.secondary?.def.id ?? null,
      grenades,
    };
  };


  /** Capture every alive character id BEFORE resetCharacterForRound flips
   *  alive back to true, so resetRoster can carry over the surviving
   *  loadouts. The local player is always treated as a survivor on the
   *  very first round (they spawn alive with their default kit). */
  const snapshotSurvivors = (alwaysIncludeLocal = false): Set<string> => {
    const out = new Set<string>();
    for (const c of characters) {
      if (c.alive) out.add(c.id);
    }
    if (alwaysIncludeLocal) out.add('local');
    return out;
  };

  // Defer the very first round until the user actually clicks "Play"
  // and acquires pointer lock. The render loop is already engaged by
  // Babylon, so the freeze timer would otherwise tick down silently
  // while the start overlay is still on screen — by the time the user
  // clicked through, freeze had ended and bots had already pathed to
  // their callouts, making it look like both teams were frozen on the
  // map. Holding off the begin call keeps the round phase 'pre' (bots
  // and player both stationary) until input is live.
  let firstRoundStarted = false;
  const startFirstRound = (): void => {
    if (firstRoundStarted) return;
    firstRoundStarted = true;
    debugLog.round('startFirstRound', { simMs: time.simMs });
    // Reset everyone first so beginRound's carrier pick sees alive
    // characters; then begin the round; then assign the C4 to the
    // carrier. We use the current simMs so the freeze window starts
    // counting from "right now", not from 0.
    resetRoster(characters, localPlayer, world, match, snapshotSurvivors(/* alwaysIncludeLocal */ true));
    match = beginRound(match, time.simMs, characters);
    if (match.round?.bomb?.carrierId) {
      assignBomb(characters, match.round.bomb.carrierId);
    }
    refreshBotsForNewRound();
    if (match.round) {
      events.emit('match:roundStart', { number: match.round.number, tMs: time.simMs });
      lastRoundNumber = match.round.number;
    }
  };
  // Kick off the round on the first pointer-lock acquisition. Subsequent
  // lock events (e.g. after a buy menu / settings dialog) are ignored —
  // by then the match is already running.
  events.on('input:pointerLockChanged', ({ locked }) => {
    if (locked) startFirstRound();
  });

  // Footstep emission. We track a per-character distance accumulator
  // and emit one event each time it exceeds STRIDE_M, but only while
  // the character is running on solid ground (Shift-walk and crouch
  // are intentionally silent so players can flank). Crouch-only
  // characters never reach the speed threshold either; the explicit
  // walking flag covers the player. Bots never set `walking`, so they
  // make footsteps whenever they're on the move.
  const STRIDE_M = 1.6;
  const RUN_SPEED_THRESHOLD = 2.5;     // m/s — above walk pace
  const stepAccum = new Map<string, number>();
  const tickFootstep = (
    id: string,
    state: { onGround: boolean; crouching: boolean; forcedCrouch?: boolean; walking: boolean; speed: number; groundSurface: 'sand' | 'wood' | 'metal' | 'concrete' | 'stone' },
    dtMs: number,
    pos: { x: number; y: number; z: number },
  ): void => {
    if (!state.onGround || state.crouching || state.walking || state.speed < RUN_SPEED_THRESHOLD) {
      stepAccum.set(id, 0);
      return;
    }
    let acc = stepAccum.get(id) ?? 0;
    acc += state.speed * (dtMs / 1000);
    if (acc >= STRIDE_M) {
      acc -= STRIDE_M;
      events.emit('character:footstep', {
        id, x: pos.x, y: pos.y, z: pos.z,
        surface: state.groundSurface,
        tMs: time.simMs,
      });
    }
    stepAccum.set(id, acc);
  };

  // ---- Sim systems ----
  loop.registerSim((dtMs) => {
    const nowMs = time.simMs + dtMs; // step time updates AFTER sim systems run, so use computed
    // Resolve the active controller this tick — flips to a possessed
    // bot's controller while the player is dead and driving a teammate.
    const ctrl = localPlayer.controller;
    pathService.beginFrame();
    fps.applyMouseLook();

    if (input.wasPressed('F3')) debugHud.toggle();
    if (input.wasPressed('F4')) aiDebugHud.toggle();

    // Tab → scoreboard. Press / release edges; we also keep it sticky during round end.
    const tabHeld = input.isDown('Tab');
    scoreboard.setVisible(tabHeld || match.round?.phase === 'end' || match.phase === 'matchEnd' || match.phase === 'halftime');

    // Movement input (locked during freeze/end).
    let forward = 0, strafe = 0;
    if (!isMovementLocked(match.round) && input.pointerLocked && !buyMenu.isOpen()) {
      if (input.isDown('KeyW')) forward += 1;
      if (input.isDown('KeyS')) forward -= 1;
      if (input.isDown('KeyD')) strafe += 1;
      if (input.isDown('KeyA')) strafe -= 1;
    }
    const yaw = ctrl.state.yaw;
    const fX = Math.sin(yaw), fZ = Math.cos(yaw);
    const rX = Math.cos(yaw), rZ = -Math.sin(yaw);

    const inst = currentInstance(localPlayer);
    let speedScale = (inst && inst.scopeLevel > 0 && inst.def.scopedMoveSpeedScale !== undefined)
      ? inst.def.scopedMoveSpeedScale
      : (inst?.def.moveSpeedScale ?? 1.0);
    // Lost-segment impairment. Speed scales by anatomical loss: a
    // missing foot is a noticeable limp, a missing shin is much
    // worse, a missing whole leg drags. Both legs gone bottoms out
    // near a crab-shuffle. Stacks multiplicatively with the weapon-
    // driven scale.
    speedScale *= legSpeedScale(localPlayer.character);
    const wishX = fX * forward + rX * strafe;
    const wishZ = fZ * forward + rZ * strafe;

    const movementLocked = isMovementLocked(match.round);
    ctrl.step(dtMs, {
      wishX: movementLocked ? 0 : wishX,
      wishZ: movementLocked ? 0 : wishZ,
      jump: !movementLocked && input.isDown('Space'),
      walk: input.isDown('ShiftLeft') || input.isDown('ShiftRight'),
      crouch: input.isDown('ControlLeft') || input.isDown('ControlRight'),
      speedScale,
    });
    localPlayer.syncFromController();
    tickFootstep('local', ctrl.state, dtMs, localPlayer.character.pos);

    // Buy menu toggling — only if buy phase + in buy zone.
    const slot = match.players.get('local');
    if (slot) {
      const inBuyZone = isInBuyZoneForLocal(localPlayer, match, world);
      const buyPhase = isBuyPhase(match.round, time.simMs);
      const allowBuy = inBuyZone && buyPhase && localPlayer.character.alive;

      if (input.wasPressed('KeyB')) {
        if (buyMenu.isOpen()) {
          buyMenu.close();
          input.requestPointerLock();
        } else if (allowBuy) {
          buyMenu.open(buyMenuCtx(slot, inBuyZone, buyPhase));
          input.releasePointerLock();
        }
      }
      // Refresh content / auto-close on lost eligibility.
      if (buyMenu.isOpen()) {
        buyMenu.refresh(buyMenuCtx(slot, inBuyZone, buyPhase));
      }
    }

    // Esc opens (or closes) the settings menu. The buy menu wins
    // priority — pressing Esc with the buy menu open just closes it.
    // The browser releases pointer lock on Esc; consumeEscape() latches
    // the edge so a delayed sim tick still sees it.
    if (input.consumeEscape()) {
      if (buyMenu.isOpen()) {
        buyMenu.close();
        input.requestPointerLock();
      } else {
        settingsHud.toggle();
      }
    }

    // Weapon switching — number keys for direct slot access, scroll wheel
    // to cycle through owned slots in primary→secondary→knife→c4 order.
    // Always drain the wheel buffer, even when ineligible, so scroll
    // motion during freeze/menu/dead doesn't queue up surprise switches.
    const invObj = localPlayer.character.inventory;
    const wheelTicks = input.consumeWheelTicks();
    const wheelEligible = !!invObj && !movementLocked && input.pointerLocked
      && !buyMenu.isOpen() && localPlayer.character.alive;
    if (invObj && !movementLocked) {
      let switched = false;
      if (input.wasPressed('Digit1') && invObj.primary) switched = switchTo(invObj, 'primary', time.simMs);
      else if (input.wasPressed('Digit2') && invObj.secondary) switched = switchTo(invObj, 'secondary', time.simMs);
      else if (input.wasPressed('Digit3')) switched = switchTo(invObj, 'knife', time.simMs);
      else if (input.wasPressed('Digit4') && invObj.grenades.length > 0) switched = switchTo(invObj, 'grenade', time.simMs);
      else if (input.wasPressed('Digit5') && invObj.c4) switched = switchTo(invObj, 'c4', time.simMs);
      else if (wheelEligible && wheelTicks !== 0) {
        // Each tick is one slot step. Wheel-down (positive) goes forward,
        // wheel-up (negative) goes backward. Cap so a fling doesn't loop.
        const dir: 1 | -1 = wheelTicks > 0 ? 1 : -1;
        const steps = Math.min(Math.abs(wheelTicks), 4);
        for (let i = 0; i < steps; i++) {
          const target = nextScrollSlot(invObj, dir);
          if (!target) break;
          if (switchTo(invObj, target, time.simMs)) switched = true;
        }
      }
      if (switched) viewModel.setWeapon(activeInstance(invObj));
    }

    // RMB has two roles: scope toggle on scoped weapons, and the heavier
    // attack on melee. The two are mutually exclusive — no weapon both
    // scopes and stabs — so we dispatch on fire mode here. The melee path
    // is consumed via `secondaryEdge` in `firing.step` below; the scope
    // path runs immediately.
    const rmbEdge = input.wasMousePressed(2);
    const rmbAvailable = rmbEdge
      && input.pointerLocked
      && !buyMenu.isOpen()
      && localPlayer.character.alive
      && inst !== null;
    if (rmbAvailable && inst && inst.def.fireMode !== 'melee' && (inst.def.scopeLevels ?? 0) > 0) {
      cycleScope(inst);
    }
    // If the player died this tick (or any time their inventory is in a
    // dead state), drop scope so the camera/HUD can return to default.
    // Also intercept LMB/RMB while dead to drive spectator cycling — we
    // run this BEFORE the firing block, which gates on `alive`, so the
    // same edge isn't double-consumed as a misfire.
    if (!localPlayer.character.alive && input.pointerLocked && !buyMenu.isOpen()) {
      if (input.wasMousePressed(0)) spectator.next();
      if (input.wasMousePressed(2)) spectator.prev();
      // F takes over the currently-spectated teammate. The spectator's
      // `currentTarget()` is refreshed each render frame against the
      // alive roster, so this picks the bot the camera is already
      // following. We don't allow re-possessing — once the player is
      // controlling a bot they're "alive" in that bot's body.
      if (input.wasPressed('KeyF')) {
        const target = spectator.currentTarget();
        if (target && target.character.alive && !target.aiDisabled) {
          target.aiDisabled = true;
          // Wipe any stale brain/path state so the bot doesn't keep
          // chasing its old objective once we release possession later.
          target.brain.state = 'idle';
          target.path = null;
          target.pathIdx = 0;
          localPlayer.possess(target);
          fps.bindController(target.controller);
          if (target.character.inventory) {
            viewModel.setWeapon(activeInstance(target.character.inventory));
          }
          // Keep the input layer locked so WASD/mouse start driving the
          // new body immediately on the next sim tick.
        }
      }
    }
    if (!localPlayer.character.alive && inst && inst.scopeLevel > 0) {
      inst.scopeLevel = 0;
    }

    // Firing — disabled during freeze/end and while buy menu open.
    const activeInst = currentInstance(localPlayer);
    if (
      activeInst &&
      input.pointerLocked &&
      !buyMenu.isOpen() &&
      match.round?.phase === 'live' &&
      localPlayer.character.alive &&
      activeInst.def.slot !== 'c4'
    ) {
      // Fire from the camera's actual world position + forward vector
      // so the bullet path is exactly the player's view ray. Reading
      // ctrl.state.pos / pitch / yaw and reconstructing fwd works in
      // most cases but can drift from what the camera actually shows
      // (FOV lerp during scope, bob offsets, etc.) — using the camera
      // pose guarantees crosshair-aligned shots.
      const fwdRef = camForward;
      fps.camera.getDirectionToRef(BABYLON_FORWARD, fwdRef);
      const eyeX = fps.camera.position.x;
      const eyeY = fps.camera.position.y;
      const eyeZ = fps.camera.position.z;
      const fwdX = fwdRef.x;
      const fwdY = fwdRef.y;
      const fwdZ = fwdRef.z;

      // Grenades are thrown, not hitscan-fired. LMB = full throw, RMB =
      // underhand. After a successful throw the consumed instance is
      // popped; if no grenades remain we fall back to the player's
      // primary or secondary so the next click does the expected thing.
      if (activeInst.def.slot === 'grenade') {
        // Grenades don't go through firing.step (which advances the
        // 'deploying' → 'ready' transition for guns). Advance it
        // inline so the throw can fire once the deploy timer elapses.
        if (activeInst.state === 'deploying' && time.simMs >= activeInst.stateUntilMs) {
          activeInst.state = 'ready';
          activeInst.stateUntilMs = 0;
        }
        const lmb = input.wasMousePressed(0);
        const rmb = input.wasMousePressed(2);
        if ((lmb || rmb) && activeInst.state === 'ready') {
          grenadeSystem.throw_(
            activeInst.def.id as 'he' | 'flashbang' | 'smoke' | 'molotov' | 'decoy',
            'local',
            { ox: eyeX, oy: eyeY, oz: eyeZ, fwdX, fwdY, fwdZ, power: lmb ? 'full' : 'underhand' },
            time.simMs,
          );
          const inv = localPlayer.character.inventory!;
          consumeActiveGrenade(inv);
          viewModel.setWeapon(activeInstance(inv));
        }
      } else {

      // Only forward RMB to firing for melee weapons — for scoped guns
      // RMB is already consumed by the scope toggle above.
      const meleeSecondaryEdge = rmbEdge && activeInst.def.fireMode === 'melee';
      const fired = firing.step(time.simMs, localPlayer.character, activeInst, {
        ox: eyeX, oy: eyeY, oz: eyeZ,
        fwdX, fwdY, fwdZ,
      }, {
        triggerHeld: input.isMouseDown(0),
        triggerEdge: input.wasMousePressed(0),
        reloadEdge: input.wasPressed('KeyR'),
        secondaryEdge: meleeSecondaryEdge,
      });
      if (fired !== 'none') {
        if (activeInst.def.fireMode === 'melee') {
          viewModel.triggerSwing(fired === 'secondary' ? 'stab' : 'slash');
        } else {
          viewModel.addKick(activeInst.def.cameraKickDeg.x * 0.05, activeInst.def.cameraKickDeg.y * 0.05, 0.04);
        }
      }
      viewModel.setReloading(activeInst.state === 'reloading');
      }   // end of non-grenade else
    }

    // Step bot AI: perception → decision → aim/fire → movement. Gated on
    // round phase: during freeze they stand at spawn; during the live
    // phase they engage and path. Brain.step decides if the bot wants to
    // hold ground (engage / reload) or follow its path; we surface that
    // decision into stepBot so the controller stays the single source of
    // truth for movement.
    // Track the freeze→live transition so lineup triggers know when
    // "opening" actually starts.
    const curPhase = match.round?.phase ?? null;
    if (curPhase === 'live' && lastSeenPhase !== 'live') {
      liveStartedAtMs = time.simMs;
      // New round entered live phase — clear the per-team comms log so
      // the HUD doesn't carry over chatter from the previous round.
      resetComms(tBoard.comms);
      resetComms(ctBoard.comms);
      debugLog.round('phase.freeze→live', {
        round: match.round?.number,
        simMs: time.simMs,
        botsAlive: bots.filter(b => b.character.alive).length,
        botsWithObjective: bots.filter(b => b.objective !== null).length,
      });
    }
    if (curPhase !== lastSeenPhase) {
      debugLog.round('phase.transition', {
        from: lastSeenPhase, to: curPhase,
        round: match.round?.number, simMs: time.simMs,
      });
    }
    lastSeenPhase = curPhase;
    // Pin the comms layer's "now" before any bus listener fires this
    // frame — combat/grenade emissions in stepRound resolve through the
    // event bus, and tryEmit needs a stable simMs to gate cooldowns.
    setCommsSimNow(time.simMs);

    if (match.round?.phase === 'live') {
      // Blackboard refresh once per tick: aggregate per-bot KnownEnemies
      // into the team map, mirror the bomb FSM, and prune stale role
      // entries. This is cheap (a handful of map ops over 9 bots) and
      // gives every brain a consistent view this tick.
      const bombInfo = mirrorBomb(match.round?.bomb);
      refreshTeamRoster(tBoard, bots, bombInfo);
      refreshTeamRoster(ctBoard, bots, bombInfo);
      aggregateKnown(tBoard, bots, time.simMs);
      aggregateKnown(ctBoard, bots, time.simMs);

      // Local player counts toward the alive total for save heuristics.
      const localT = localPlayer.character.team === 'T' && localPlayer.character.alive ? 1 : 0;
      const localCT = localPlayer.character.team === 'CT' && localPlayer.character.alive ? 1 : 0;
      const tAlive = aliveCount(tBoard, bots) + localT;
      const ctAlive = aliveCount(ctBoard, bots) + localCT;

      // Per-tick comms: edge triggers (visible-enemy spotted, flashed)
      // that the event bus doesn't surface as discrete events.
      tickComms(bots, time.simMs);
      // Push delivered teammate callouts into receiver perception as
      // 'sound'-confidence intel — a bot that hears a teammate call
      // "spotted A long" turns to face the angle, but won't fire
      // blind into it (LOS still required for visible).
      applyCommsIntel(bots, time.simMs);

      // Build the AI world view once per tick. Phase 0: only the debug
      // HUD reads it; brain decisions still flow through the legacy
      // BrainContext fields. Phase 3 cuts the planner over to reading
      // here directly.
      worldView = buildWorldStateView({
        simMs: time.simMs,
        liveSinceMs: liveStartedAtMs,
        phase: 'live',
        bomb: bombInfo,
        bots,
        tBoard, ctBoard,
        localAlive: { T: localT, CT: localCT },
      });

      for (const bot of bots) {
        if (!bot.character.alive) continue;
        // Skip the AI tick entirely while the local player is in this
        // body — the loop below feeds the bot's controller from input
        // (via localPlayer.controller) and the brain would otherwise
        // overwrite yaw/pitch and try to drive movement.
        if (bot.aiDisabled) continue;
        const prevState = bot.brain.state;
        const prevSpeed = bot.character.speed;
        bot.perception.maybeStep(bot.character, characters, query, time.simMs, grenadeSystem.smoke);
        const isT = bot.character.team === 'T';
        const board = isT ? tBoard : ctBoard;
        const teammates = (isT ? tAlive : ctAlive) - 1;   // exclude self
        const enemies = isT ? ctAlive : tAlive;
        const spawnPos = isT ? tSpawnCentroid : ctSpawnCentroid;
        const brainCtx = {
          characters,
          bomb: match.round?.bomb ?? null,
          world,
          blackboard: board,
          teammatesAlive: teammates,
          enemiesAlive: enemies,
          spawnX: spawnPos.x,
          spawnZ: spawnPos.z,
          grenades: grenadeSystem,
          liveSinceMs: liveStartedAtMs,
          view: worldView!,
        };
        // Save state retargets the bot's path to spawn. We re-apply here
        // each tick so a transition out of save restores the strategist's
        // original objective even if the brain didn't write it back.
        applyBotObjectiveFromBoard(bot, board, spawnPos);
        const decision = bot.brain.step(bot, bot.perception, brainCtx, firing, dtMs, time.simMs);
        stepBot(bot, dtMs, time.simMs, pathService, {
          followPath: decision.followPath,
          // While engaging the brain owns yaw; let it through unmodified.
          faceMovement: decision.followPath,
        });
        tickFootstep(bot.id, bot.controller.state, dtMs, bot.character.pos);
        // Per-bot trace, gated on the 'bots' channel. We log only on
        // transitions: a brain state change, OR the moment a bot
        // crosses into / out of "stuck" (followPath but ~0 speed for
        // two ticks while an objective is set). Continuous spam from a
        // bot anchored at its callout would otherwise bury the buffer.
        if (debugLog.isEnabled('bots')) {
          const stateChanged = prevState !== bot.brain.state;
          const isStuck = decision.followPath
            && bot.character.speed < 0.1
            && prevSpeed < 0.1
            && bot.objective !== null;
          const stuckEdge = isStuck !== wasStuck.has(bot.id);
          if (stateChanged || stuckEdge) {
            if (isStuck) wasStuck.add(bot.id);
            else wasStuck.delete(bot.id);
            debugLog.bots(
              stateChanged ? `state ${prevState}→${bot.brain.state}` :
                isStuck ? 'stuck' : 'unstuck',
              {
                t: time.simMs,
                id: bot.id,
                team: bot.character.team,
                follow: decision.followPath,
                obj: bot.objective ?? '-',
                path: bot.path ? `${bot.pathIdx}/${bot.path.length}` : '-',
                pos: bot.character.pos,
                spd: bot.character.speed,
              },
            );
          }
        }
      }
    } else {
      // Freeze / round-end: still tick perception so KnownEnemies decay
      // and bots are ready to engage the moment freeze ends.
      for (const bot of bots) {
        if (!bot.character.alive) continue;
        if (bot.aiDisabled) continue;
        bot.perception.maybeStep(bot.character, characters, query, time.simMs, grenadeSystem.smoke);
      }
      // Keep the world view fresh during freeze/end so the debug HUD
      // reflects the current roster, strategy, and known-enemy decay.
      const localT2 = localPlayer.character.team === 'T' && localPlayer.character.alive ? 1 : 0;
      const localCT2 = localPlayer.character.team === 'CT' && localPlayer.character.alive ? 1 : 0;
      worldView = buildWorldStateView({
        simMs: time.simMs,
        liveSinceMs: liveStartedAtMs,
        phase: curPhase === 'end' ? 'end' : 'freeze',
        bomb: mirrorBomb(match.round?.bomb),
        bots,
        tBoard, ctBoard,
        localAlive: { T: localT2, CT: localCT2 },
      });
    }

    // Plant / defuse intent — read from the same E key. We assemble
    // exactly one PlanterIntent (the bomb FSM only acts on the carrier)
    // and a list of defuser intents (the FSM picks the closest). Bots
    // surface their wants via `brain.wantsPlant` / `brain.wantsDefuse`
    // and we paper that onto the same struct shape the local player
    // produces — the FSM doesn't need to know who's a bot.
    const eHeld = input.isDown('KeyE') && !buyMenu.isOpen() && localPlayer.character.alive;
    const carrierId = match.round?.bomb?.carrierId ?? null;
    let planterIntent: { id: string; pos: import('@babylonjs/core/Maths/math.vector').Vector3; holdingPlant: boolean; alive: boolean } | null = null;
    if (carrierId === 'local') {
      const inv = localPlayer.character.inventory;
      if (inv?.c4 && localPlayer.character.team === 'T') {
        planterIntent = {
          id: 'local',
          pos: localPlayer.character.pos,
          holdingPlant: eHeld,
          alive: localPlayer.character.alive,
        };
      }
    } else if (carrierId) {
      const carrier = bots.find(b => b.id === carrierId);
      if (carrier) {
        planterIntent = {
          id: carrier.id,
          pos: carrier.character.pos,
          holdingPlant: carrier.brain.wantsPlant,
          alive: carrier.character.alive,
        };
      }
    }

    const defuserIntents: Array<{ id: string; pos: import('@babylonjs/core/Maths/math.vector').Vector3; holdingDefuse: boolean; hasKit: boolean; alive: boolean }> = [];
    if (match.round?.bomb && (match.round.bomb.phase === 'planted' || match.round.bomb.phase === 'defusing')) {
      if (localPlayer.character.team === 'CT') {
        defuserIntents.push({
          id: 'local',
          pos: localPlayer.character.pos,
          holdingDefuse: eHeld,
          hasKit: localPlayer.character.hasKit,
          alive: localPlayer.character.alive,
        });
      }
      for (const bot of bots) {
        if (bot.character.team !== 'CT') continue;
        if (!bot.character.alive) continue;
        defuserIntents.push({
          id: bot.id,
          pos: bot.character.pos,
          holdingDefuse: bot.brain.wantsDefuse,
          hasKit: bot.character.hasKit,
          alive: true,
        });
      }
    }

    // Grenade physics. Runs every sim tick regardless of phase so an
    // already-thrown grenade still detonates if the round ends mid-air;
    // the system clears itself on round reset.
    grenadeSystem.step(dtMs, time.simMs);

    // Step the match.
    match = stepMatch(match, {
      world,
      characters,
      planter: planterIntent,
      defusers: defuserIntents,
      nowMs: time.simMs,
      dtMs,
    });

    // Round transitions.
    const r = match.round;
    if (r && r.phase === 'end' && !roundEndApplied) {
      // Apply round-end economy, scores, etc.
      const localWon = match.players.get('local')?.currentSide === r.outcome?.winner;
      events.emit('match:roundEnd', {
        number: r.number,
        winner: r.outcome!.winner,
        reason: r.outcome!.reason,
        playerWon: localWon ?? false,
        tMs: time.simMs,
      });
      match = endRound(match, time.simMs);
      roundEndApplied = true;
    }
    if (r && r.phase === 'end' && time.simMs >= r.phaseEndMs && roundEndApplied) {
      // Move to next phase.
      if (match.phase === 'halftime') {
        // Halftime period now begins; wait it out, then swap and start round 16.
      } else if (match.phase === 'matchEnd') {
        // Match over — sit here forever.
      } else {
        // Start the next round. Reset before beginRound so the carrier
        // pick sees alive characters. snapshotSurvivors() runs before
        // resetRoster so carry-over reflects who actually survived.
        const survivors = snapshotSurvivors();
        resetRoster(characters, localPlayer, world, match, survivors);
        match = beginRound(match, time.simMs, characters);
        if (match.round?.bomb?.carrierId) {
          assignBomb(characters, match.round.bomb.carrierId);
        }
        refreshBotsForNewRound();
        if (match.round && match.round.number !== lastRoundNumber) {
          events.emit('match:roundStart', { number: match.round.number, tMs: time.simMs });
          lastRoundNumber = match.round.number;
          // Refresh view model in case the player got the C4 or lost their primary.
          if (localPlayer.character.inventory) {
            viewModel.setWeapon(activeInstance(localPlayer.character.inventory));
          }
        }
        roundEndApplied = false;
      }
    }

    // Halftime expiry → swap sides + first second-half round.
    if (match.phase === 'halftime' && time.simMs >= match.phaseEndMs) {
      match = applyHalftime(match);
      events.emit('match:halftime', { tMs: time.simMs });
      // Switch the local player's side & refresh inventory + roster.
      const localSlot = match.players.get('local');
      if (localSlot) {
        localPlayer.character.team = localSlot.currentSide;
      }
      // Halftime: nobody carries over — fresh defaults for everyone.
      resetRoster(characters, localPlayer, world, match, new Set<string>());
      match = beginRound(match, time.simMs, characters);
      if (match.round?.bomb?.carrierId) {
        assignBomb(characters, match.round.bomb.carrierId);
      }
      refreshBotsForNewRound();
      if (localPlayer.character.inventory) {
        viewModel.setWeapon(activeInstance(localPlayer.character.inventory));
      }
      roundEndApplied = false;
      if (match.round) {
        events.emit('match:roundStart', { number: match.round.number, tMs: time.simMs });
        lastRoundNumber = match.round.number;
      }
    }

    // Match end audio cue.
    void nowMs;
  });

  // ---- Render systems ----
  loop.registerRender((renderDtMs) => {
    adaptiveQuality.step(renderDtMs);
    // Drive scope-related state BEFORE syncRender so the FOV lerp uses the
    // latest target this frame.
    const renderInst = currentInstance(localPlayer);
    const buyOpen = buyMenu.isOpen();
    const effectiveScopeLevel =
      (localPlayer.character.alive && !buyOpen && renderInst && renderInst.scopeLevel > 0)
        ? renderInst.scopeLevel
        : 0;
    if (effectiveScopeLevel > 0 && renderInst?.def.scopeFovDeg) {
      const fovDeg = renderInst.def.scopeFovDeg[effectiveScopeLevel - 1] ?? renderInst.def.scopeFovDeg[0]!;
      fps.setTargetFovRad((fovDeg * Math.PI) / 180);
    } else {
      fps.resetFov();
    }
    scopeHud.setLevel(effectiveScopeLevel, renderInst?.def.scopeStyle ?? 'sniper');
    // ADS view-model raise: only for "ads"-style scopes (rifles, pistols).
    // Sniper scopes hide the view model entirely so the raise has no
    // visual effect there.
    const isAdsActive =
      effectiveScopeLevel > 0 && (renderInst?.def.scopeStyle ?? 'sniper') === 'ads';
    viewModel.setAds(isAdsActive);

    fps.syncRender();
    // Spectator override: while the local player is dead, refresh the
    // candidate roster and snap the camera to a teammate's eye. Hide
    // the view model so a "ghost knife" doesn't float across the screen
    // while spectating.
    const isDead = !localPlayer.character.alive;
    if (isDead) {
      spectator.refresh(bots, localPlayer.character.team);
      spectator.applyToCamera(fps.camera);
      viewModel.setVisible(false);
    } else {
      // Hide the view model only when a sniper-style scope is up — for
      // ADS-style aim-down-sights we keep the gun on screen so the player
      // still sees the iron-sight silhouette.
      const sniperScoped =
        effectiveScopeLevel > 0 && (renderInst?.def.scopeStyle ?? 'sniper') === 'sniper';
      viewModel.setVisible(!sniperScoped);
    }
    spectatorHud.setActive(isDead, spectator.currentTarget()?.id ?? null);
    // Keep the view model in sync with whatever weapon is currently active.
    // This catches purchases (which auto-switch the active slot) without
    // requiring an explicit setWeapon call from every code path.
    viewModel.setWeapon(renderInst);
    const renderCtrl = localPlayer.controller;
    viewModel.update(renderCtrl.state.speed, renderDtMs);
    for (const b of bots) syncBotMesh(b);
    c4Entity.update(match.round?.bomb ?? null, time.simMs);

    const cam = fps.camera;
    const yaw = renderCtrl.state.yaw;
    const py = renderCtrl.state.pitch;
    const cosP = Math.cos(py);
    setListenerPose(
      cam.position.x, cam.position.y, cam.position.z,
      Math.sin(yaw) * cosP, Math.sin(py), Math.cos(yaw) * cosP,
      0, 1, 0,
    );

    debugHud.update(renderDtMs);
    aiDebugHud.update(bots, tBoard, ctBoard, worldView, tacticalGraph);
    // Local team's comms feed. Local player is always on T at boot
    // (and may swap at halftime); we follow `localPlayer.character.team`.
    const localTeamBoard = localPlayer.character.team === 'T' ? tBoard : ctBoard;
    calloutFeedHud.update(time.simMs, localTeamBoard, bots);
    combatHud.update(localPlayer.character, performance.now());
    flashOverlay.update(localPlayer.character, time.simMs);
    matchEndHud.update(match);
    roundHud.update(match, characters, time.simMs);
    scoreboard.update(match, characters);
    bombHud.update(localPlayer.character, match.round?.bomb ?? null, world);
  });

  // ---- Run loop ----
  loop.bindExternal();
  engine.runRenderLoop(() => {
    loop.step(performance.now());
    scene.render();
  });

  window.addEventListener('resize', () => {
    events.emit('input:resize', { width: window.innerWidth, height: window.innerHeight });
  });

  // Quiet a couple of unused-ish references for the linter.
  void engine; void scene; void makeInstance; void playSound;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__game = { engine, scene, world, controller, localPlayer, fps, debugHud, bots, navGrid, pathService, characters, debugLog, get match() { return match; } };
}

function currentInstance(p: LocalPlayer): WeaponInstance | null {
  const inv = p.character.inventory;
  if (!inv) return null;
  switch (inv.active) {
    case 'primary': return inv.primary ?? null;
    case 'secondary': return inv.secondary ?? null;
    case 'knife': return inv.knife;
    case 'c4': return inv.c4 ?? null;
    case 'grenade': return inv.grenades[inv.activeGrenadeIdx] ?? null;
  }
}

function isInBuyZoneForLocal(p: LocalPlayer, match: MatchState, world: import('./map/world').World): boolean {
  const slot = match.players.get('local');
  if (!slot) return false;
  const c = p.character;
  for (const z of world.buyZones) {
    if (z.team !== slot.currentSide) continue;
    if (c.pos.y < z.yMin - 0.2 || c.pos.y > z.yMax + 0.2) continue;
    if (pointInPolygon2D(c.pos.x, c.pos.z, z.polygon)) return true;
  }
  return false;
}

bootstrap();
