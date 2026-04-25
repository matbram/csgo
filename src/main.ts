/** App entry. Boots the engine, builds the map, spawns the local player,
 *  and registers sim/render systems with the loop.
 *
 *  Order of operations is deliberate. Several systems depend on others,
 *  so we initialize them in this order:
 *
 *    1. Babylon Engine + Scene             — needed by everything
 *    2. Lighting (sun, ambient, sky)       — needs Scene
 *    3. Procedural materials               — needs Scene
 *    4. Map build                          — produces World + meshes
 *    5. Local player + controller          — needs World
 *    6. FPS camera                         — needs Scene + player
 *    7. Post-processing pipeline           — needs the camera
 *    8. HUD                                — needs DOM + player + world
 *    9. Input                              — needs canvas
 *   10. Loop register                      — last; runs everything
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { createEngine, getEngine, getScene, getCanvas } from './engine/scene';
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

function bootstrap(): void {
  const canvas = document.getElementById('render-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Render canvas missing');
  }

  // 1) Babylon engine + scene
  createEngine(canvas);
  const engine = getEngine();
  const scene = getScene();

  // 2) Lighting (must happen before map so meshes can be added to shadow casters).
  createLighting();

  // 3) Materials are lazily created on first use; nothing to do here.

  // 4) Build the map.
  const { world, meshes } = buildMap(dust2());
  void meshes; // kept for potential debug toggles
  if (world.spawns.length === 0) {
    console.warn('[map] No spawns authored — placing player at origin.');
  }

  // 5) Local player. Pick a T spawn (the south side per the vision doc).
  const tSpawns = world.spawnsForTeam('T');
  const startSpawn = tSpawns[0] ?? null;
  const startPos = startSpawn?.pos.clone() ?? new Vector3(0, 1, -38);
  // Bump up slightly so the snap-to-ground catches us reliably.
  startPos.y += 0.5;
  const startYaw = startSpawn?.yaw ?? 0;

  const query = new WorldQuery(world);
  const player = new CharacterController(query, startPos, startYaw, DEFAULT_TUNABLES);
  player.snapToGround();

  // 6) FPS camera.
  const fps = new FpsCamera(player);

  // 7) Post-FX (after camera exists).
  createPostFx(fps.camera);

  // 8) HUD.
  ensureCrosshair();
  const debugHud = new DebugHud(player, world);
  const startOverlay = new StartOverlay(canvas);
  startOverlay.bind();

  // 9) Input.
  input.attach(canvas);

  // ---- Sim systems ----

  loop.registerSim((dtMs) => {
    // Mouse look first so this tick's movement uses the latest yaw.
    fps.applyMouseLook();

    // Toggle debug HUD with F3 (one-shot, edge-based).
    if (input.wasPressed('F3')) {
      debugHud.toggle();
    }

    // Build wishX/wishZ from input + player yaw.
    let forward = 0, strafe = 0;
    if (input.isDown('KeyW')) forward += 1;
    if (input.isDown('KeyS')) forward -= 1;
    if (input.isDown('KeyD')) strafe += 1;
    if (input.isDown('KeyA')) strafe -= 1;
    const yaw = player.state.yaw;
    const fX = Math.sin(yaw), fZ = Math.cos(yaw);
    const rX = Math.cos(yaw), rZ = -Math.sin(yaw);
    const wishX = fX * forward + rX * strafe;
    const wishZ = fZ * forward + rZ * strafe;

    const ci = {
      wishX,
      wishZ,
      jump: input.isDown('Space'),
      walk: input.isDown('ShiftLeft') || input.isDown('ShiftRight'),
      crouch: input.isDown('ControlLeft') || input.isDown('ControlRight'),
    };
    player.step(dtMs, ci);
  });

  // ---- Render systems ----
  loop.registerRender((renderDtMs) => {
    fps.syncRender();
    debugHud.update(renderDtMs);
  });

  // ---- Run loop. We drive the loop from Babylon's render loop so that
  //      scene.render() runs after our render systems have updated camera
  //      transforms and HUD state. ----
  loop.bindExternal();
  engine.runRenderLoop(() => {
    loop.step(performance.now());
    scene.render();
  });

  // Resize handling (engine.resize is called inside scene.ts; we also
  // notify any subscribers).
  window.addEventListener('resize', () => {
    events.emit('input:resize', { width: window.innerWidth, height: window.innerHeight });
  });

  // Initial paint: schedule the loop to receive a fresh timestamp.
  void time;

  // Debug exposure for console tinkering during M1 development.
  // (Stripped by minifier in prod builds; harmless in dev.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__game = { engine, scene, world, player, fps, debugHud };
}

bootstrap();
