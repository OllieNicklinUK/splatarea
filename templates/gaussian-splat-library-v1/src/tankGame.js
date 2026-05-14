import * as THREE from 'three';
import { Tank } from './game/Tank.js';
import { ProjectileSystem } from './game/ProjectileSystem.js';
import { GameState } from './game/GameState.js';
import { SplatArena } from './game/SplatArena.js';

// Start a two-player tank game (player vs bot) layered over a Gaussian splat.
//
// Options:
//   scene, camera, controls   — shared Three.js objects
//   box         THREE.Box3    — splat world bounding box (for arena sizing)
//   center      THREE.Vector3 — confirmed player position (arena centre)
//   voxelMesh   Object3D|null — BVH-accelerated collision mesh (may arrive later via setVoxelMesh)
//
// Returns { update(dt), setVoxelMesh(mesh), dispose() }
export function createTankGame({ scene, camera, controls, box, center, voxelMesh = null }) {
  // ── Arena ──────────────────────────────────────────────────────────────────
  const arena = new SplatArena({ box, center, voxelMesh });

  // ── Spawn positions — opposite corners relative to arena centre ───────────
  const rx = (arena.maxX - arena.minX) * 0.32;
  const rz = (arena.maxZ - arena.minZ) * 0.32;
  const fy = arena.floorY;

  const p1Start = new THREE.Vector3(arena.cx - rx, fy, arena.cz - rz);
  const p2Start = new THREE.Vector3(arena.cx + rx, fy, arena.cz + rz);

  // ── Tanks ──────────────────────────────────────────────────────────────────
  const tanks = [
    new Tank({ id: 'p1', color: '#38bdf8', position: p1Start, scene }),
    new Tank({ id: 'p2', color: '#fb7185', position: p2Start, scene }),
  ];
  tanks[0].bodyAngle   = Math.PI * 0.25;
  tanks[0].turretAngle = Math.PI * 0.25;
  tanks[1].bodyAngle   = -Math.PI * 0.75;
  tanks[1].turretAngle = -Math.PI * 0.75;

  // ── Systems ────────────────────────────────────────────────────────────────
  const projectiles = new ProjectileSystem(scene);
  const state = new GameState();
  state.resetRound();

  // ── Camera ─────────────────────────────────────────────────────────────────
  const camTarget = new THREE.Vector3(arena.cx, fy, arena.cz);
  controls.enabled = false;
  camera.fov = 60;
  camera.updateProjectionMatrix();

  // Camera sits at a fixed height above the configured floor so it stays
  // inside the splat regardless of how large the scene is. Horizontal offset
  // tracks tank spread but is capped so the tanks stay visible.
  const CAM_HEIGHT   = 5;   // metres above arena floor
  const CAM_H_MIN    = 7;   // minimum horizontal offset
  const CAM_H_MAX    = 13;  // maximum horizontal offset

  function updateCamera() {
    const mid = tanks[0].position.clone().add(tanks[1].position).multiplyScalar(0.5);
    camTarget.lerp(mid, 0.08);
    const spread = tanks[0].position.distanceTo(tanks[1].position);
    const h = Math.max(CAM_H_MIN, Math.min(CAM_H_MAX, spread * 0.45 + 5));
    camera.position.lerp(
      new THREE.Vector3(camTarget.x + h, arena.floorY + CAM_HEIGHT, camTarget.z + h),
      0.08
    );
    camera.lookAt(camTarget.x, arena.floorY + 0.5, camTarget.z);
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  const pressed = new Set();
  let firing = false;
  let heavyFire = false;

  const onKeyDown = (e) => {
    pressed.add(e.code);
    if (e.code === 'Space') { e.preventDefault(); firing = true; }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') heavyFire = true;
  };
  const onKeyUp = (e) => {
    pressed.delete(e.code);
    if (e.code === 'Space') firing = false;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') heavyFire = false;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // ── HUD ────────────────────────────────────────────────────────────────────
  const hud        = document.getElementById('tank-hud');
  const p1HpBar    = document.getElementById('tank-p1-hp');
  const p2HpBar    = document.getElementById('tank-p2-hp');
  const timerEl    = document.getElementById('tank-timer');
  const statusEl   = document.getElementById('tank-status');
  const restartBtn = document.getElementById('tank-restart-btn');

  if (hud) hud.style.display = 'flex';

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

  function syncHud() {
    const p1 = state.getPlayer('p1');
    const p2 = state.getPlayer('p2');
    if (p1HpBar) p1HpBar.style.width = `${p1?.hp ?? 0}%`;
    if (p2HpBar) p2HpBar.style.width = `${p2?.hp ?? 0}%`;
    const left = Math.max(0, state.roundTime - state.elapsed);
    if (timerEl) timerEl.textContent = `${Math.ceil(left)}s`;
  }

  // ── Round restart ──────────────────────────────────────────────────────────
  function startRound() {
    state.resetRound();
    const resetTank = (t, pos, angle) => {
      t.position.copy(pos);
      t.group.position.copy(pos);
      t.bodyAngle = angle;
      t.turretAngle = angle;
      t.cooldown = 0;
    };
    resetTank(tanks[0], p1Start,  Math.PI * 0.25);
    resetTank(tanks[1], p2Start, -Math.PI * 0.75);
    projectiles.dispose();
    setStatus('W/A/S/D move  ·  Arrow keys aim  ·  Space fire  ·  Shift heavy');
  }

  restartBtn?.addEventListener('click', startRound);
  setStatus('W/A/S/D move  ·  Arrow keys aim  ·  Space fire  ·  Shift heavy');

  // ── Player update ──────────────────────────────────────────────────────────
  function updatePlayer(dt) {
    if (!state.running) return;
    const player = tanks[0];
    const throttle = (pressed.has('KeyW') ? 1 : 0) + (pressed.has('KeyS') ? -1 : 0);
    const turn     = (pressed.has('KeyA') ? 1 : 0) + (pressed.has('KeyD') ? -1 : 0);
    player.drive({ throttle, turn }, dt, arena);

    const turretTurn =
      (pressed.has('ArrowLeft')  || pressed.has('KeyJ') ?  1 : 0) +
      (pressed.has('ArrowRight') || pressed.has('KeyL') ? -1 : 0);
    if (turretTurn !== 0) player.rotateTurret(turretTurn, dt);

    if (heavyFire && state.consumeHeavyShot('p1')) {
      player.tryFire(projectiles, { heavy: true });
      heavyFire = false;
      setStatus('Heavy round fired!');
    } else if (firing) {
      player.tryFire(projectiles);
    }
  }

  // ── Bot AI ─────────────────────────────────────────────────────────────────
  function updateBot(dt) {
    if (!state.running) return;
    const bot    = tanks[1];
    const player = tanks[0];
    const t = performance.now() * 0.001;
    const wobble = new THREE.Vector3(
      Math.sin(t * 0.62), 0, Math.cos(t * 0.48)
    ).multiplyScalar(2.8);
    const target   = player.position.clone().add(wobble);
    const toPlayer = target.clone().sub(bot.position);
    const pref = Math.min(12.5, arena.arenaRadius * 0.55);
    const move = new THREE.Vector3();

    if (toPlayer.length() > pref + 3.2) {
      move.copy(toPlayer.normalize());
    } else if (toPlayer.length() < pref - 3.2) {
      move.copy(toPlayer.normalize().negate());
    } else {
      move.set(Math.sin(t * 0.38), 0, Math.cos(t * 0.5)).normalize();
    }

    bot.driveToward(move, dt, arena);
    bot.aimAt(target);

    const botState = state.getPlayer('p2');
    if (botState?.heavyReady && Math.random() < dt * 0.16) {
      if (state.consumeHeavyShot('p2')) bot.tryFire(projectiles, { heavy: true });
    }
    if (Math.random() < dt * 0.45) bot.tryFire(projectiles);
  }

  // ── Hit handler ────────────────────────────────────────────────────────────
  function onHit(targetId, projectile) {
    state.applyDamage(targetId, projectile?.damage ?? 18);
    if (!state.running) {
      if (state.winner === 'draw') {
        setStatus('Draw! Click Restart to play again.');
      } else {
        const winner = state.getPlayer(state.winner);
        setStatus(`${winner?.name ?? 'Winner'} wins! Click Restart to play again.`);
      }
    }
  }

  // ── Main update (called from animate loop) ─────────────────────────────────
  function update(dt) {
    tanks[0].update(dt);
    tanks[1].update(dt);
    updatePlayer(dt);
    updateBot(dt);
    projectiles.update(dt, arena, tanks, onHit);
    state.tick(dt);
    updateCamera();
    syncHud();
  }

  // ── Late-arriving voxel mesh ───────────────────────────────────────────────
  function setVoxelMesh(mesh) {
    arena.setVoxelMesh(mesh);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    restartBtn?.removeEventListener('click', startRound);
    for (const tank of tanks) scene.remove(tank.group);
    projectiles.dispose();
    if (hud) hud.style.display = 'none';
    controls.enabled = true;
  }

  return { update, setVoxelMesh, dispose };
}
