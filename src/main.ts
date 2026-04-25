/** App entry. Boots the engine, builds the map, spawns the local player,
 *  and registers sim/render systems with the loop.
 *
 *  Order of operations is deliberate. Several systems depend on others,
 *  so we initialize them in this order:
 *
 *    1. Babylon Engine + Scene             — needed by everything
 *    2. Lighting (sun, ambient, sky)       — needs Scene
 *    3. Materials / textures               — needs Scene
 *    4. Map build                          — produces World + meshes
 *    5. Local player + controller          — needs World
 *    6. FPS camera                         — needs Scene + player
 *    7. Post-processing pipeline           — needs the camera
 *    8. View model + inventory             — needs camera
 *    9. Combat system + firing             — needs World + character list
 *   10. Audio                              — uses combat events
 *   11. Visuals (decals, tracers)          — uses combat events
 *   12. HUD                                — needs DOM + player + world
 *   13. Dummies                            — testing targets
 *   14. Input                              — needs canvas
 *   15. Loop register                      — last; runs everything
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
import { installAudio, ensureAudioContext, setListenerPose } from './audio/audio';
import { CombatHud } from './hud/combatHud';
import { createDummy, syncDummy, type Dummy } from './entities/dummy';
import type { Character } from './entities/character';

function bootstrap(): void {
  const canvas = document.getElementById('render-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Render canvas missing');
  }

  // 1) Babylon engine + scene
  createEngine(canvas);
  const engine = getEngine();
  const scene = getScene();

  // 2) Lighting
  createLighting();

  // 4) Build the map.
  const { world } = buildMap(dust2());

  // 5) Local player.
  const tSpawns = world.spawnsForTeam('T');
  const startSpawn = tSpawns[0] ?? null;
  const startPos = startSpawn?.pos.clone() ?? new Vector3(0, 1, -38);
  startPos.y += 0.5;
  const startYaw = startSpawn?.yaw ?? 0;

  const query = new WorldQuery(world);
  const controller = new CharacterController(query, startPos, startYaw, DEFAULT_TUNABLES);
  controller.snapToGround();

  // 6) FPS camera
  const fps = new FpsCamera(controller);

  // 7) Post-FX
  createPostFx(fps.camera);

  // 8) Local player wrapper + view model + starter loadout
  const localPlayer = new LocalPlayer(controller, 'T');
  const viewModel = new ViewModel(fps.camera);

  // For M2 demo: give the player a rifle on top of the starter pistol.
  // T side gets AK; CT side would get M4. (We're T here.)
  if (localPlayer.character.inventory) {
    const ak = makeInstance('ak47');
    localPlayer.character.inventory.primary = ak;
    localPlayer.character.inventory.active = 'primary';
  }
  // Initialize view model to current weapon.
  viewModel.setWeapon(currentInstance(localPlayer));

  // 9) Combat
  const characters: Character[] = [localPlayer.character];
  const combatSystem = new CombatSystem(query, () => characters);
  const firing = new FiringController(combatSystem);

  // 10) Audio + 11) Visuals
  installAudio();
  installCombatVisuals();

  // 12) HUD
  ensureCrosshair();
  const debugHud = new DebugHud(controller, world);
  const combatHud = new CombatHud();
  const startOverlay = new StartOverlay(canvas);
  startOverlay.bind();

  // 13) Dummies — five stationary CT bots inside T spawn line-of-sight
  // (~12m north of T spawn so the player can practice).
  const dummies: Dummy[] = [];
  const tCenter = startSpawn?.pos ?? new Vector3(0, 0, -38);
  const dummyOffsets: Array<[number, number]> = [[-6, 14], [-3, 16], [0, 18], [3, 16], [6, 14]];
  for (let i = 0; i < dummyOffsets.length; i++) {
    const off = dummyOffsets[i]!;
    const armor = i % 2 === 0 ? 100 : 0;
    const helmet = i === 1 || i === 3;
    const d = createDummy('CT', tCenter.x + off[0], 0, tCenter.z + off[1], Math.PI, { armor, helmet });
    dummies.push(d);
    characters.push(d.character);
  }

  // Click on canvas inside the game requests pointer lock; that's also the
  // user gesture we need to unlock audio context.
  canvas.addEventListener('click', () => ensureAudioContext());

  // 14) Input
  input.attach(canvas);

  // ---- Sim systems ----
  loop.registerSim((dtMs) => {
    // 1. Mouse look.
    fps.applyMouseLook();

    // 2. Debug toggle.
    if (input.wasPressed('F3')) debugHud.toggle();

    // 3. Build wishDir from WASD + yaw.
    let forward = 0, strafe = 0;
    if (input.isDown('KeyW')) forward += 1;
    if (input.isDown('KeyS')) forward -= 1;
    if (input.isDown('KeyD')) strafe += 1;
    if (input.isDown('KeyA')) strafe -= 1;
    const yaw = controller.state.yaw;
    const fX = Math.sin(yaw), fZ = Math.cos(yaw);
    const rX = Math.cos(yaw), rZ = -Math.sin(yaw);

    // Speed scale based on active weapon (heavier weapons slow you down).
    const inst = currentInstance(localPlayer);
    const speedScale = inst?.def.moveSpeedScale ?? 1.0;
    const wishX = fX * forward + rX * strafe;
    const wishZ = fZ * forward + rZ * strafe;

    controller.step(dtMs, {
      wishX, wishZ,
      jump: input.isDown('Space'),
      walk: input.isDown('ShiftLeft') || input.isDown('ShiftRight'),
      crouch: input.isDown('ControlLeft') || input.isDown('ControlRight'),
      speedScale,
    });
    localPlayer.syncFromController();

    // 4. Weapon switching (1 = primary, 2 = secondary, 3 = knife).
    const invObj = localPlayer.character.inventory;
    if (invObj) {
      let switched = false;
      if (input.wasPressed('Digit1') && invObj.primary) switched = switchTo(invObj, 'primary', time.simMs);
      else if (input.wasPressed('Digit2') && invObj.secondary) switched = switchTo(invObj, 'secondary', time.simMs);
      else if (input.wasPressed('Digit3')) switched = switchTo(invObj, 'knife', time.simMs);
      if (switched) {
        viewModel.setWeapon(activeInstance(invObj));
      }
    }

    // 5. Firing.
    const activeInst = currentInstance(localPlayer);
    if (activeInst && input.pointerLocked) {
      // Eye position from controller state (sim authoritative; not the
      // bob-offset camera which is only updated each render frame).
      const eyeX = controller.state.pos.x;
      const eyeY = controller.state.pos.y + controller.state.currentEye;
      const eyeZ = controller.state.pos.z;
      // Forward from yaw + pitch.
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
  });

  // ---- Render systems ----
  loop.registerRender((renderDtMs) => {
    fps.syncRender();

    // Update view model bob/kick/reload.
    viewModel.update(controller.state.speed, renderDtMs);

    // Sync dummies.
    for (const d of dummies) syncDummy(d);

    // Audio listener follows camera.
    const cam = fps.camera;
    const yaw = controller.state.yaw;
    const py = controller.state.pitch;
    const cosP = Math.cos(py);
    setListenerPose(
      cam.position.x, cam.position.y, cam.position.z,
      Math.sin(yaw) * cosP, Math.sin(py), Math.cos(yaw) * cosP,
      0, 1, 0,
    );

    // HUDs.
    debugHud.update(renderDtMs);
    combatHud.update(localPlayer.character, performance.now());
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

  // Debug exposure
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__game = { engine, scene, world, controller, localPlayer, fps, debugHud, dummies, characters };
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

bootstrap();
