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
import { input } from './engine/input';
import { loop } from './engine/loop';
import { time } from './engine/time';
import { events } from './engine/events';
import { buildMap } from './map/builder';
import { dust2 } from './map/dust2';
import { CharacterController, DEFAULT_TUNABLES } from './player/controller';
import { WorldQuery } from './player/physics';
import { FpsCamera } from './player/fpsCamera';
import { StartOverlay, ensureCrosshair } from './hud/overlay';
import { DebugHud } from './hud/debugHud';
import { LocalPlayer } from './player/localPlayer';
import { ViewModel } from './player/viewModel';
import { CombatSystem } from './combat/combat';
import { FiringController } from './combat/firing';
import { activeInstance, switchTo, makeInstance, cycleScope, nextScrollSlot } from './weapons/inventory';
import { runBotBuy } from './ai/buy';
import type { WeaponInstance } from './weapons/inventory';
import { installCombatVisuals } from './combat/visuals';
import { installAudio, ensureAudioContext, setListenerPose, playSound } from './audio/audio';
import { CombatHud } from './hud/combatHud';
import { ScopeHud } from './hud/scopeHud';
import { AiDebugHud } from './hud/aiDebug';
import { createBot, snapBotToCharacterPose, setBotObjective, stepBot, syncBotMesh, type Bot } from './entities/bot';
import { NavGrid } from './nav/grid';
import { PathService } from './nav/pathService';
import { pickTeamObjectives } from './ai/objective';
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

  // 5) Local player + view model
  const localPlayer = new LocalPlayer(controller, 'T');
  const viewModel = new ViewModel(fps.camera);
  viewModel.setWeapon(currentInstance(localPlayer));

  // 6) Combat + audio + visuals
  const characters: Character[] = [localPlayer.character];
  const combatSystem = new CombatSystem(query, () => characters);
  const firing = new FiringController(combatSystem);
  installAudio();
  installCombatVisuals();

  // 6.5) Nav grid + path service. Built once at boot — Dust 2 is static
  // and the grid is small enough to bake synchronously (<200 ms).
  const navGrid = NavGrid.build(world, query);
  const pathService = new PathService(navGrid, { maxRequestsPerFrame: 2, cacheSize: 32 });

  // 7) Roster: 4 T bots (teammates of local), 5 CT bots (enemies).
  const bots: Bot[] = [];
  for (let i = 0; i < 4; i++) {
    const sp = tSpawns[(i + 1) % Math.max(1, tSpawns.length)] ?? startSpawn!;
    const bot = createBot('T', sp.pos.x, sp.pos.y, sp.pos.z, sp.yaw, query, {
      id: `t-bot-${i + 1}`,
      teamIndex: i,
      difficulty: 'medium',
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
      difficulty: 'medium',
    });
    bots.push(bot);
    characters.push(bot.character);
  }

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
  const debugHud = new DebugHud(controller, world);
  const combatHud = new CombatHud();
  const scopeHud = new ScopeHud();
  const aiDebugHud = new AiDebugHud();
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

  // Track local-player kills/deaths for scoreboard + economy.
  events.on('combat:kill', ({ attackerId, victimId, weapon }) => {
    const atk = match.players.get(attackerId);
    const vic = match.players.get(victimId);
    if (atk) {
      atk.kills += 1;
      atk.killWeapons.push(weapon as never);
    }
    if (vic) vic.deaths += 1;
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

  // 9) Input
  canvas.addEventListener('click', () => ensureAudioContext());
  input.attach(canvas);

  // After each roster reset we re-snap every bot to its new spawn pose
  // (the controller state doesn't follow the Character record on its own)
  // and hand out fresh objectives. Path requests are deferred to the
  // first sim tick so the path service's per-frame budget applies.
  const refreshBotsForNewRound = (): void => {
    if (!match.round) return;
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
    const tObj = pickTeamObjectives('T', tBots.map(b => b.id), world, match.round.number);
    const ctObj = pickTeamObjectives('CT', ctBots.map(b => b.id), world, match.round.number);
    for (let i = 0; i < tBots.length; i++) {
      const o = tObj[i]!;
      setBotObjective(tBots[i]!, o.x, o.z);
    }
    for (let i = 0; i < ctBots.length; i++) {
      const o = ctObj[i]!;
      setBotObjective(ctBots[i]!, o.x, o.z);
    }
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

  // First round. Reset everyone first so beginRound's carrier pick sees
  // alive characters; then begin the round; then assign the C4 to the carrier.
  resetRoster(characters, localPlayer, world, match, snapshotSurvivors(/* alwaysIncludeLocal */ true));
  match = beginRound(match, time.simMs, characters);
  if (match.round?.bomb?.carrierId) {
    assignBomb(characters, match.round.bomb.carrierId);
  }
  refreshBotsForNewRound();
  events.emit('match:roundStart', { number: match.round!.number, tMs: time.simMs });
  lastRoundNumber = match.round!.number;

  // ---- Sim systems ----
  loop.registerSim((dtMs) => {
    const nowMs = time.simMs + dtMs; // step time updates AFTER sim systems run, so use computed
    pathService.beginFrame();
    fps.applyMouseLook();

    if (input.wasPressed('F3')) debugHud.toggle();
    if (input.wasPressed('F4')) aiDebugHud.toggle();

    // Tab → scoreboard. Press / release edges; we also keep it sticky during round end.
    const tabHeld = input.isDown('Tab');
    scoreboard.setVisible(tabHeld || match.round?.phase === 'end' || match.phase === 'matchEnd' || match.phase === 'halftime');

    // Movement input (locked during freeze/end).
    let forward = 0, strafe = 0;
    if (!isMovementLocked(match.round!) && input.pointerLocked && !buyMenu.isOpen()) {
      if (input.isDown('KeyW')) forward += 1;
      if (input.isDown('KeyS')) forward -= 1;
      if (input.isDown('KeyD')) strafe += 1;
      if (input.isDown('KeyA')) strafe -= 1;
    }
    const yaw = controller.state.yaw;
    const fX = Math.sin(yaw), fZ = Math.cos(yaw);
    const rX = Math.cos(yaw), rZ = -Math.sin(yaw);

    const inst = currentInstance(localPlayer);
    const speedScale = (inst && inst.scopeLevel > 0 && inst.def.scopedMoveSpeedScale !== undefined)
      ? inst.def.scopedMoveSpeedScale
      : (inst?.def.moveSpeedScale ?? 1.0);
    const wishX = fX * forward + rX * strafe;
    const wishZ = fZ * forward + rZ * strafe;

    const movementLocked = isMovementLocked(match.round!);
    controller.step(dtMs, {
      wishX: movementLocked ? 0 : wishX,
      wishZ: movementLocked ? 0 : wishZ,
      jump: !movementLocked && input.isDown('Space'),
      walk: input.isDown('ShiftLeft') || input.isDown('ShiftRight'),
      crouch: input.isDown('ControlLeft') || input.isDown('ControlRight'),
      speedScale,
    });
    localPlayer.syncFromController();

    // Buy menu toggling — only if buy phase + in buy zone.
    const slot = match.players.get('local');
    if (slot) {
      const inBuyZone = isInBuyZoneForLocal(localPlayer, match, world);
      const buyPhase = isBuyPhase(match.round!, time.simMs);
      const allowBuy = inBuyZone && buyPhase && localPlayer.character.alive;

      if (input.wasPressed('KeyB')) {
        if (buyMenu.isOpen()) {
          buyMenu.close();
          input.requestPointerLock();
        } else if (allowBuy) {
          buyMenu.open({
            side: slot.currentSide,
            money: slot.money,
            inBuyZone, buyPhase,
            helmet: localPlayer.character.helmet,
            armor: localPlayer.character.armor,
            hasKit: localPlayer.character.hasKit,
            hasPrimary: localPlayer.character.inventory?.primary?.def.id ?? null,
            hasSecondary: localPlayer.character.inventory?.secondary?.def.id ?? null,
          });
          input.releasePointerLock();
        }
      }
      if (input.wasPressed('Escape') && buyMenu.isOpen()) {
        buyMenu.close();
        input.requestPointerLock();
      }
      // Refresh content / auto-close on lost eligibility.
      if (buyMenu.isOpen()) {
        buyMenu.refresh({
          side: slot.currentSide,
          money: slot.money,
          inBuyZone, buyPhase,
          helmet: localPlayer.character.helmet,
          armor: localPlayer.character.armor,
          hasKit: localPlayer.character.hasKit,
          hasPrimary: localPlayer.character.inventory?.primary?.def.id ?? null,
          hasSecondary: localPlayer.character.inventory?.secondary?.def.id ?? null,
        });
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
      const eyeX = controller.state.pos.x;
      const eyeY = controller.state.pos.y + controller.state.currentEye;
      const eyeZ = controller.state.pos.z;
      const py = controller.state.pitch;
      const cosP = Math.cos(py);
      const fwdX = Math.sin(yaw) * cosP;
      const fwdY = Math.sin(py);
      const fwdZ = Math.cos(yaw) * cosP;

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
    }

    // Step bot AI: perception → decision → aim/fire → movement. Gated on
    // round phase: during freeze they stand at spawn; during the live
    // phase they engage and path. Brain.step decides if the bot wants to
    // hold ground (engage / reload) or follow its path; we surface that
    // decision into stepBot so the controller stays the single source of
    // truth for movement.
    if (match.round?.phase === 'live') {
      const brainCtx = { characters, bomb: match.round?.bomb ?? null, world };
      for (const bot of bots) {
        if (!bot.character.alive) continue;
        bot.perception.maybeStep(bot.character, characters, query, time.simMs);
        const decision = bot.brain.step(bot, bot.perception, brainCtx, firing, dtMs, time.simMs);
        stepBot(bot, dtMs, time.simMs, pathService, {
          followPath: decision.followPath,
          // While engaging the brain owns yaw; let it through unmodified.
          faceMovement: decision.followPath,
        });
      }
    } else {
      // Freeze / round-end: still tick perception so KnownEnemies decay
      // and bots are ready to engage the moment freeze ends.
      for (const bot of bots) {
        if (!bot.character.alive) continue;
        bot.perception.maybeStep(bot.character, characters, query, time.simMs);
      }
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
        if (match.round!.number !== lastRoundNumber) {
          events.emit('match:roundStart', { number: match.round!.number, tMs: time.simMs });
          lastRoundNumber = match.round!.number;
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
      events.emit('match:roundStart', { number: match.round!.number, tMs: time.simMs });
      lastRoundNumber = match.round!.number;
    }

    // Match end audio cue.
    void nowMs;
  });

  // ---- Render systems ----
  loop.registerRender((renderDtMs) => {
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
    viewModel.setVisible(effectiveScopeLevel === 0);
    scopeHud.setLevel(effectiveScopeLevel);

    fps.syncRender();
    // Keep the view model in sync with whatever weapon is currently active.
    // This catches purchases (which auto-switch the active slot) without
    // requiring an explicit setWeapon call from every code path.
    viewModel.setWeapon(renderInst);
    viewModel.update(controller.state.speed, renderDtMs);
    for (const b of bots) syncBotMesh(b);
    c4Entity.update(match.round?.bomb ?? null, time.simMs);

    const cam = fps.camera;
    const yaw = controller.state.yaw;
    const py = controller.state.pitch;
    const cosP = Math.cos(py);
    setListenerPose(
      cam.position.x, cam.position.y, cam.position.z,
      Math.sin(yaw) * cosP, Math.sin(py), Math.cos(yaw) * cosP,
      0, 1, 0,
    );

    debugHud.update(renderDtMs);
    aiDebugHud.update(bots);
    combatHud.update(localPlayer.character, performance.now());
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
  (globalThis as any).__game = { engine, scene, world, controller, localPlayer, fps, debugHud, bots, navGrid, pathService, characters, get match() { return match; } };
}

function currentInstance(p: LocalPlayer): WeaponInstance | null {
  const inv = p.character.inventory;
  if (!inv) return null;
  switch (inv.active) {
    case 'primary': return inv.primary ?? null;
    case 'secondary': return inv.secondary ?? null;
    case 'knife': return inv.knife;
    case 'c4': return inv.c4 ?? null;
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
