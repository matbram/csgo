/** App entry. Boots the engine, builds the map, runs a 5v5 match.
 *
 *  Init order:
 *    1.  Engine + scene
 *    2.  Lighting + sky
 *    3.  Map build (world + meshes)
 *    4.  Local controller + camera + post-FX
 *    5.  Local player wrapper + view model
 *    6.  Combat + audio + visuals
 *    7.  Roster (4 T dummies + 5 CT dummies + local)
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
import { activeInstance, switchTo, makeInstance } from './weapons/inventory';
import type { WeaponInstance } from './weapons/inventory';
import { installCombatVisuals } from './combat/visuals';
import { installAudio, ensureAudioContext, setListenerPose, playSound } from './audio/audio';
import { CombatHud } from './hud/combatHud';
import { createDummy, syncDummy, type Dummy } from './entities/dummy';
import type { Character } from './entities/character';
import { pointInPolygon2D } from './map/world';
import { makeMatch, beginRound, endRound, applyHalftime, stepMatch, type MatchState } from './match/match';
import { resetRoster, assignBomb } from './match/roster';
import { isBuyPhase, isMovementLocked } from './match/round';
import { RoundHud } from './hud/roundHud';
import { Scoreboard } from './hud/scoreboard';
import { BuyMenu } from './hud/buyMenu';
import { C4Entity } from './entities/c4';
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

  // 7) Roster: 4 more T dummies (teammates), 5 CT dummies (enemies).
  const dummies: Dummy[] = [];
  let dummyIdx = 0;
  for (let i = 0; i < 4; i++) {
    const sp = tSpawns[(i + 1) % Math.max(1, tSpawns.length)] ?? startSpawn!;
    const d = createDummy('T', sp.pos.x, sp.pos.y, sp.pos.z, sp.yaw);
    d.character.id = `t-bot-${++dummyIdx}`;
    dummies.push(d);
    characters.push(d.character);
  }
  const ctSpawns = world.spawnsForTeam('CT');
  for (let i = 0; i < 5; i++) {
    const sp = ctSpawns[i % Math.max(1, ctSpawns.length)] ?? ctSpawns[0]!;
    if (!sp) throw new Error('No CT spawns authored');
    const d = createDummy('CT', sp.pos.x, sp.pos.y, sp.pos.z, sp.yaw);
    d.character.id = `ct-bot-${i + 1}`;
    dummies.push(d);
    characters.push(d.character);
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
  const roundHud = new RoundHud(hudRoot);
  const scoreboard = new Scoreboard(hudRoot);
  const c4Entity = new C4Entity();
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

  // 9) Input
  canvas.addEventListener('click', () => ensureAudioContext());
  input.attach(canvas);

  // First round. Reset everyone first so beginRound's carrier pick sees
  // alive characters; then begin the round; then assign the C4 to the carrier.
  resetRoster(characters, localPlayer, world, match, /* localSurvived */ true);
  match = beginRound(match, time.simMs, characters);
  if (match.round?.bomb?.carrierId) {
    assignBomb(characters, match.round.bomb.carrierId);
  }
  events.emit('match:roundStart', { number: match.round!.number, tMs: time.simMs });
  lastRoundNumber = match.round!.number;

  // ---- Sim systems ----
  loop.registerSim((dtMs) => {
    const nowMs = time.simMs + dtMs; // step time updates AFTER sim systems run, so use computed
    fps.applyMouseLook();

    if (input.wasPressed('F3')) debugHud.toggle();

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
    const speedScale = inst?.def.moveSpeedScale ?? 1.0;
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

    // Weapon switching.
    const invObj = localPlayer.character.inventory;
    if (invObj && !movementLocked) {
      let switched = false;
      if (input.wasPressed('Digit1') && invObj.primary) switched = switchTo(invObj, 'primary', time.simMs);
      else if (input.wasPressed('Digit2') && invObj.secondary) switched = switchTo(invObj, 'secondary', time.simMs);
      else if (input.wasPressed('Digit3')) switched = switchTo(invObj, 'knife', time.simMs);
      else if (input.wasPressed('Digit5') && invObj.c4) switched = switchTo(invObj, 'c4', time.simMs);
      if (switched) viewModel.setWeapon(activeInstance(invObj));
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

      const fired = firing.step(time.simMs, localPlayer.character, activeInst, {
        ox: eyeX, oy: eyeY, oz: eyeZ,
        fwdX, fwdY, fwdZ,
      }, {
        triggerHeld: input.isMouseDown(0),
        triggerEdge: input.wasMousePressed(0),
        reloadEdge: input.wasPressed('KeyR'),
      });
      if (fired) {
        viewModel.addKick(activeInst.def.cameraKickDeg.x * 0.05, activeInst.def.cameraKickDeg.y * 0.05, 0.04);
      }
      viewModel.setReloading(activeInst.state === 'reloading');
    }

    // Plant / defuse intent — read from the same E key.
    const eHeld = input.isDown('KeyE') && !buyMenu.isOpen() && localPlayer.character.alive;
    const planterIntent = (() => {
      const inv = localPlayer.character.inventory;
      const hasC4 = !!inv?.c4;
      if (!hasC4) return null;
      if (localPlayer.character.team !== 'T') return null;
      return {
        id: 'local',
        pos: localPlayer.character.pos,
        holdingPlant: eHeld,
        alive: localPlayer.character.alive,
      };
    })();
    const defuserIntents = localPlayer.character.team === 'CT' && match.round?.bomb && match.round.bomb.phase === 'planted'
      ? [{
          id: 'local',
          pos: localPlayer.character.pos,
          holdingDefuse: eHeld,
          hasKit: localPlayer.character.hasKit,
          alive: localPlayer.character.alive,
        }]
      : [];

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
        // pick sees alive characters.
        const localSurvived = localPlayer.character.alive;
        resetRoster(characters, localPlayer, world, match, localSurvived);
        match = beginRound(match, time.simMs, characters);
        if (match.round?.bomb?.carrierId) {
          assignBomb(characters, match.round.bomb.carrierId);
        }
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
      resetRoster(characters, localPlayer, world, match, /* localSurvived */ false);
      match = beginRound(match, time.simMs, characters);
      if (match.round?.bomb?.carrierId) {
        assignBomb(characters, match.round.bomb.carrierId);
      }
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
    fps.syncRender();
    viewModel.update(controller.state.speed, renderDtMs);
    for (const d of dummies) syncDummy(d);
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
    combatHud.update(localPlayer.character, performance.now());
    roundHud.update(match, characters, time.simMs);
    scoreboard.update(match, characters);
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
  (globalThis as any).__game = { engine, scene, world, controller, localPlayer, fps, debugHud, dummies, characters, get match() { return match; } };
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
