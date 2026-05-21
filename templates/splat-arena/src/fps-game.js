// fps-game.js
// First-person arena: terrain-walking navigation + physics ball shooter.
// Player walks on voxel terrain, blocked by walls.  Balls bounce off geometry.
//
// Returns { update(dt), setVoxelMesh(mesh), setFloorY(y), dispose() }

import * as THREE from 'three';
import { SplatArena } from './shared/SplatArena.js';

const WALK_SPEED  = 8;    // m/s
const BALL_SPEED  = 28;   // m/s
const BALL_GRAV   = 16;   // m/s² ball gravity
const BALL_R      = 0.12; // radius
const MAX_BALLS   = 40;

const PLAYER_R    = 0.35; // player collision radius
const PLAYER_H    = 1.7;  // eye height above terrain
const PLAYER_GRAV = 20;   // player gravity
const JUMP_VEL    = 7;    // initial jump velocity
const MIN_WALL_H  = 0.6;  // ignore collider faces below this height

export function createFPSGame({ scene, camera, canvas, box, floorY: initFloorY, voxelMesh: initVoxel }) {
  let voxelMesh = initVoxel;
  let floorY    = initFloorY;

  const center = box.getCenter(new THREE.Vector3());
  const arena  = new SplatArena({ box, center, voxelMesh: initVoxel });

  // Player physics state
  let velY     = 0;
  let onGround = false;

  // ── Camera setup ──────────────────────────────────────────────────────────
  camera.fov = 75;
  camera.updateProjectionMatrix();
  camera.rotation.order = 'YXZ';

  camera.position.set(center.x, floorY + PLAYER_H, center.z);
  camera.rotation.set(0, 0, 0);

  // ── Pointer lock ──────────────────────────────────────────────────────────
  const _onClick = () => {
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
  };
  canvas.addEventListener('click', _onClick);

  // ── Input ──────────────────────────────────────────────────────────────────
  const keys = {};
  const _onKeyDown = e => { keys[e.code] = true; };
  const _onKeyUp   = e => { keys[e.code] = false; };
  const _onMouseMove = e => {
    if (document.pointerLockElement !== canvas) return;
    camera.rotation.y -= e.movementX * 0.0022;
    camera.rotation.x -= e.movementY * 0.0022;
    camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x, -Math.PI / 2, Math.PI / 2);
  };
  window.addEventListener('keydown', _onKeyDown);
  window.addEventListener('keyup', _onKeyUp);
  document.addEventListener('mousemove', _onMouseMove);

  // ── Balls ─────────────────────────────────────────────────────────────────
  const _ballGeo = new THREE.SphereGeometry(BALL_R, 8, 6);
  const balls = [];
  const _rc    = new THREE.Raycaster();
  const _dir   = new THREE.Vector3();
  const _fwd   = new THREE.Vector3();
  const _nextXZ = new THREE.Vector3();
  const _testX  = new THREE.Vector3();
  const _testZ  = new THREE.Vector3();

  function _shoot() {
    if (balls.length >= MAX_BALLS) {
      const old = balls.shift();
      scene.remove(old.mesh);
      old.mesh.material.dispose();
    }
    camera.getWorldDirection(_fwd);
    const b = {
      mesh: new THREE.Mesh(_ballGeo, new THREE.MeshLambertMaterial({ color: _randomColor() })),
      vel:  _fwd.clone().multiplyScalar(BALL_SPEED),
      life: 12,
    };
    b.mesh.position.copy(camera.position);
    scene.add(b.mesh);
    balls.push(b);
  }

  function _clearBalls() {
    for (const b of balls) { scene.remove(b.mesh); b.mesh.material.dispose(); }
    balls.length = 0;
  }

  const _onMouseDown = e => {
    if (document.pointerLockElement !== canvas || e.button !== 0) return;
    _shoot();
  };
  const _onKeyAction = e => { if (e.code === 'KeyB') _clearBalls(); };
  canvas.addEventListener('mousedown', _onMouseDown);
  document.addEventListener('keydown', _onKeyAction);

  // ── HUD ───────────────────────────────────────────────────────────────────
  const hudEl       = document.getElementById('fps-hud');
  const crossEl     = document.getElementById('crosshair');
  if (hudEl)   hudEl.style.display    = 'block';
  if (crossEl) crossEl.style.display  = 'block';

  // ── Update ────────────────────────────────────────────────────────────────
  function update(dt) {
    // ── Horizontal movement with wall collision ────────────────────────────
    if (document.pointerLockElement === canvas) {
      _dir.set(0, 0, 0);
      if (keys['KeyW'] || keys['ArrowUp'])    _dir.z -= 1;
      if (keys['KeyS'] || keys['ArrowDown'])  _dir.z += 1;
      if (keys['KeyA'] || keys['ArrowLeft'])  _dir.x -= 1;
      if (keys['KeyD'] || keys['ArrowRight']) _dir.x += 1;
      if (_dir.lengthSq() > 0) {
        _dir.normalize().applyEuler(new THREE.Euler(0, camera.rotation.y, 0));
        _dir.y = 0;
        const step = WALK_SPEED * dt;
        // Use floor-level Y so collision heights [0.3, 0.85, 1.5] map to
        // ankle/waist/chest — not 2–3 m above the scene geometry.
        const playerFloorY = camera.position.y - PLAYER_H;
        _nextXZ.set(
          camera.position.x + _dir.x * step,
          playerFloorY,
          camera.position.z + _dir.z * step,
        );
        if (!arena.collides(_nextXZ, PLAYER_R, MIN_WALL_H)) {
          camera.position.x = _nextXZ.x;
          camera.position.z = _nextXZ.z;
        } else {
          _testX.set(_nextXZ.x, playerFloorY, camera.position.z);
          _testZ.set(camera.position.x, playerFloorY, _nextXZ.z);
          if (!arena.collides(_testX, PLAYER_R, MIN_WALL_H)) camera.position.x = _nextXZ.x;
          else if (!arena.collides(_testZ, PLAYER_R, MIN_WALL_H)) camera.position.z = _nextXZ.z;
        }
      }
      if (keys['Space'] && onGround) { velY = JUMP_VEL; onGround = false; }
    }

    // ── Gravity + terrain follow ───────────────────────────────────────────
    velY -= PLAYER_GRAV * dt;
    camera.position.y += velY * dt;

    const groundSurface = arena.groundY(camera.position, floorY, 4, 2) + PLAYER_H;
    if (camera.position.y <= groundSurface) {
      camera.position.y = groundSurface;
      if (velY < 0) { velY = 0; onGround = true; }
    } else {
      onGround = false;
    }
    arena.clampPosition(camera.position, PLAYER_R);

    // Ball physics
    const collidables = [];
    if (voxelMesh) collidables.push(voxelMesh);

    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      b.life -= dt;
      if (b.life <= 0 || b.mesh.position.y < floorY - 10) {
        scene.remove(b.mesh); b.mesh.material.dispose(); balls.splice(i, 1); continue;
      }

      b.vel.y -= BALL_GRAV * dt;
      const speed = b.vel.length();
      const step  = speed * dt;

      if (collidables.length && step > 0.001) {
        _rc.set(b.mesh.position, b.vel.clone().normalize());
        _rc.far = step + BALL_R * 2;
        const hits = _rc.intersectObjects(collidables, true);
        if (hits.length && hits[0].distance <= step + BALL_R * 2 && hits[0].face) {
          const n = hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld);
          if (n.dot(b.vel) < 0) b.vel.reflect(n);
          b.vel.multiplyScalar(0.55);
          b.mesh.position.copy(hits[0].point).addScaledVector(n, BALL_R * 1.5);
          continue;
        }
      }
      b.mesh.position.addScaledVector(b.vel, dt);
    }
  }

  function setVoxelMesh(mesh) { voxelMesh = mesh; arena.setVoxelMesh(mesh); }
  function setFloorY(y)        { floorY = y; camera.position.y = y + PLAYER_H; velY = 0; }

  function dispose() {
    window.removeEventListener('keydown', _onKeyDown);
    window.removeEventListener('keyup', _onKeyUp);
    document.removeEventListener('mousemove', _onMouseMove);
    canvas.removeEventListener('click', _onClick);
    canvas.removeEventListener('mousedown', _onMouseDown);
    document.removeEventListener('keydown', _onKeyAction);
    _clearBalls();
    _ballGeo.dispose();
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    if (hudEl)   hudEl.style.display   = 'none';
    if (crossEl) crossEl.style.display = 'none';
  }

  return { update, setVoxelMesh, setFloorY, dispose };
}

function _randomColor() {
  const hue = Math.random() * 360;
  return new THREE.Color().setHSL(hue / 360, 0.9, 0.55);
}
