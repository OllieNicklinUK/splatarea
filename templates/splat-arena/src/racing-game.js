// racing-game.js
// Arcade drift-style car racing inside a Gaussian splat environment.
// BVH wall collision from the voxel mesh. Chase camera.
//
// Returns { update(dt), setVoxelMesh(mesh), setFloorY(y), dispose() }

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SplatArena } from './shared/SplatArena.js';

const MAX_SPEED     = 16;   // m/s forward
const REV_SPEED     = 6;    // m/s reverse
const ACCEL         = 22;   // m/s² — snappy pickup
const DRAG          = 0.25; // very low — car glides freely over rough ground
const STEER_SPEED   = 2.6;  // rad/s per input unit
const GRIP_NORMAL   = 6.0;  // lateral velocity decay
const GRIP_BRAKE    = 1.2;  // lateral decay when handbraking (drifty)
const CAR_RADIUS    = 0.5;  // small — avoids false hits on floor voxels at 0.3 m ray height

const CAM_BACK      = 7;
const CAM_UP        = 5.5;
const CAM_LERP      = 4.5;

const PROBE_L   = 1.0;  // m — terrain probe distance forward/back for tilt
const PROBE_T   = 0.7;  // m — terrain probe distance left/right for tilt
const TILT_LERP = 8.0;  // how fast the car catches the terrain angle

const SPAWN_CLEARANCE = 1.5; // m above floorY to avoid spawning inside surface
const CAR_BODY_LIFT   = 1.2; // visual-only lift above physics groundY (splat gaussians extend above voxel surface)

export function createRacingGame({ scene, camera, controls, box, floorY: initFloorY, voxelMesh: initVoxel }) {
  let floorY    = initFloorY;
  const arena   = new SplatArena({ box, center: box.getCenter(new THREE.Vector3()), voxelMesh: initVoxel });

  // ── Car state ──────────────────────────────────────────────────────────────
  const pos = new THREE.Vector3(
    (box.min.x + box.max.x) / 2,
    floorY + SPAWN_CLEARANCE,
    (box.min.z + box.max.z) / 2,
  );
  let angle      = 0;   // yaw (radians) — 0 faces +Z
  let speed      = 0;   // m/s
  let lateralVel = 0;   // sideways drift velocity

  // ── Car visual ─────────────────────────────────────────────────────────────
  const carGroup = new THREE.Group();
  carGroup.userData.wheels = [];
  carGroup.position.copy(pos);
  scene.add(carGroup);

  new GLTFLoader().load('/racing/skate.glb', (gltf) => {
    const model = gltf.scene;
    // Auto-scale so longest dimension ≈ 1.5 m
    const bbox = new THREE.Box3().setFromObject(model);
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) model.scale.setScalar(1.5 / maxDim);
    // Re-compute after scale, then center bottom at origin
    bbox.setFromObject(model);
    const center = bbox.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -bbox.min.y, -center.z);
    carGroup.add(model);
  }, undefined, (e) => console.warn('[racing] skate.glb failed to load:', e));

  // ── Input ──────────────────────────────────────────────────────────────────
  controls.enabled = false;
  camera.fov = 65;
  camera.updateProjectionMatrix();

  const keys = {};
  const _onKeyDown = e => { keys[e.code] = true; e.code === 'Space' && e.preventDefault(); };
  const _onKeyUp   = e => { keys[e.code] = false; };
  window.addEventListener('keydown', _onKeyDown);
  window.addEventListener('keyup', _onKeyUp);

  const _camPos     = new THREE.Vector3();
  const _fwdDir     = new THREE.Vector3();
  const _rightDir   = new THREE.Vector3();
  const _climbPos   = new THREE.Vector3(); // reused for step-face vs wall test
  const _txPos      = new THREE.Vector3(); // X-slide test
  const _tzPos      = new THREE.Vector3(); // Z-slide test

  // Terrain-tilt scratch objects
  const _frontProbe = new THREE.Vector3();
  const _backProbe  = new THREE.Vector3();
  const _rSideProbe = new THREE.Vector3();
  const _lSideProbe = new THREE.Vector3();
  const _fSurf      = new THREE.Vector3();
  const _rSurf      = new THREE.Vector3();
  const _surfNorm   = new THREE.Vector3();
  const _carXAxis   = new THREE.Vector3();
  const _worldUp    = new THREE.Vector3(0, 1, 0);
  const _carQ       = new THREE.Quaternion();
  const _carMat     = new THREE.Matrix4();

  // ── HUD ────────────────────────────────────────────────────────────────────
  const hudEl   = document.getElementById('racing-hud');
  const speedEl = document.getElementById('racing-speed');
  if (hudEl) hudEl.style.display = 'flex';

  // ── Update ─────────────────────────────────────────────────────────────────
  function update(dt) {
    const gas       = (keys['KeyW'] || keys['ArrowUp'])   ? 1 : 0;
    const brake     = (keys['KeyS'] || keys['ArrowDown']) ? 1 : 0;
    const steerL    = (keys['KeyA'] || keys['ArrowLeft'])  ? 1 : 0;
    const steerR    = (keys['KeyD'] || keys['ArrowRight']) ? 1 : 0;
    const handbrake = !!(keys['Space'] || keys['ShiftLeft']);

    // Engine — lerp towards target speed
    const targetSpeed = (gas - brake * 0.6) * MAX_SPEED - brake * 0.6 * REV_SPEED * 0.5;
    if (gas > 0 || brake > 0) {
      speed += (targetSpeed - speed) * Math.min(1, ACCEL * dt);
    } else {
      speed *= Math.exp(-DRAG * dt);
    }
    speed = THREE.MathUtils.clamp(speed, -REV_SPEED, MAX_SPEED);

    // Steering — base minimum so car turns from standstill; full at speed ≥ 2 m/s
    const steerFactor = THREE.MathUtils.clamp(0.3 + Math.abs(speed) / 2, 0, 1);
    const steerInput  = steerR - steerL;
    angle -= steerInput * STEER_SPEED * steerFactor * dt;

    // Lateral drift — build up from steering, decay from grip
    const grip = handbrake ? GRIP_BRAKE : GRIP_NORMAL;
    lateralVel += steerInput * Math.abs(speed) * 0.35 * dt;
    lateralVel *= Math.exp(-grip * dt);

    // Direction vectors (angle=0 → facing +Z)
    _fwdDir.set(Math.sin(angle), 0, Math.cos(angle));
    _rightDir.set(Math.cos(angle), 0, -Math.sin(angle));

    // Proposed next position (XZ move)
    const nextPos = pos.clone()
      .addScaledVector(_fwdDir, speed * dt)
      .addScaledVector(_rightDir, lateralVel * dt);

    // Terrain-follow — sample ground under the proposed position
    const groundUnder = arena.groundY(nextPos, pos.y);

    // Smooth vertical snap at 20 m/s
    const yDelta = groundUnder - pos.y;
    nextPos.y = pos.y + Math.sign(yDelta) * Math.min(Math.abs(yDelta), 20 * dt);

    const MAX_STEP   = 1.2;  // metres — handles voxel sizes up to ~1 m
    const MIN_WALL_H = 0.5;  // ignore faces below this height

    if (arena.collides(nextPos, CAR_RADIUS, MIN_WALL_H)) {
      // Re-test at the destination terrain height + a small clearance.
      // Step faces on ramps only exist below that level, so if the collision
      // clears here the obstruction was a traversable step, not a wall.
      const climbY = Math.max(nextPos.y, groundUnder) + 0.15;
      _climbPos.set(nextPos.x, climbY, nextPos.z);
      const isStepFace = (groundUnder - pos.y) <= MAX_STEP
                       && !arena.collides(_climbPos, CAR_RADIUS, MIN_WALL_H);
      if (isStepFace) {
        pos.copy(nextPos);
      } else {
        _txPos.set(nextPos.x, nextPos.y, pos.z);
        _tzPos.set(pos.x, nextPos.y, nextPos.z);
        if (!arena.collides(_txPos, CAR_RADIUS, MIN_WALL_H)) {
          pos.copy(_txPos); lateralVel *= 0.4;
        } else if (!arena.collides(_tzPos, CAR_RADIUS, MIN_WALL_H)) {
          pos.copy(_tzPos); lateralVel *= 0.4;
        } else {
          speed *= -0.35; lateralVel *= -0.3;
        }
      }
    } else {
      pos.copy(nextPos);
    }

    // Clamp to arena bounds; let terrain following own the Y
    arena.clampPosition(pos, CAR_RADIUS);

    // Update car visual — tilt to match terrain slope
    // Lift visually above the physics surface (gaussian splats extend above voxel top)
    carGroup.position.copy(pos);
    carGroup.position.y += CAR_BODY_LIFT;

    // Sample terrain at front/back/left/right to estimate surface normal
    _frontProbe.copy(pos).addScaledVector(_fwdDir,   PROBE_L);  _frontProbe.y = pos.y;
    _backProbe.copy(pos).addScaledVector(_fwdDir,   -PROBE_L);  _backProbe.y  = pos.y;
    _rSideProbe.copy(pos).addScaledVector(_rightDir,  PROBE_T); _rSideProbe.y = pos.y;
    _lSideProbe.copy(pos).addScaledVector(_rightDir, -PROBE_T); _lSideProbe.y = pos.y;

    const frontY = arena.groundY(_frontProbe, pos.y, 3, 2);
    const backY  = arena.groundY(_backProbe,  pos.y, 3, 2);
    const rightY = arena.groundY(_rSideProbe, pos.y, 3, 2);
    const leftY  = arena.groundY(_lSideProbe, pos.y, 3, 2);

    // Surface vectors along the terrain plane
    _fSurf.set(_fwdDir.x * PROBE_L * 2,   frontY - backY,  _fwdDir.z * PROBE_L * 2).normalize();
    _rSurf.set(_rightDir.x * PROBE_T * 2, rightY - leftY,  _rightDir.z * PROBE_T * 2).normalize();
    _surfNorm.crossVectors(_fSurf, _rSurf).normalize();

    if (_surfNorm.y > 0.05) {
      _carXAxis.crossVectors(_surfNorm, _fSurf).normalize();
      _carMat.makeBasis(_carXAxis, _surfNorm, _fSurf);
      _carQ.setFromRotationMatrix(_carMat);
      carGroup.quaternion.slerp(_carQ, Math.min(1, TILT_LERP * dt));
    } else {
      carGroup.rotation.y = angle; // degenerate fallback
    }

    // Wheel spin (cosmetic)
    const rpm = speed / MAX_SPEED;
    carGroup.userData.wheels?.forEach(w => { w.rotation.x += rpm * dt * 12; });

    // Chase camera — follows actual car Y so it tracks up banks
    _camPos.copy(pos)
      .addScaledVector(_fwdDir, -CAM_BACK)
      .setY(pos.y + CAM_UP);
    camera.position.lerp(_camPos, 1 - Math.exp(-CAM_LERP * dt));
    const lookAt = pos.clone().addScaledVector(_fwdDir, 4).setY(pos.y + 0.8);
    camera.lookAt(lookAt);

    // Speedometer
    if (speedEl) speedEl.textContent = `${Math.abs(speed * 3.6).toFixed(0)} km/h`;
  }

  function setVoxelMesh(mesh) { arena.setVoxelMesh(mesh); }
  function setFloorY(y) {
    floorY = y;
    pos.y  = y + SPAWN_CLEARANCE;
    carGroup.position.y = y + SPAWN_CLEARANCE;
  }

  function dispose() {
    window.removeEventListener('keydown', _onKeyDown);
    window.removeEventListener('keyup', _onKeyUp);
    scene.remove(carGroup);
    carGroup.traverse(n => { n.geometry?.dispose(); n.material?.dispose(); });
    controls.enabled = true;
    camera.fov = 60;
    camera.updateProjectionMatrix();
    if (hudEl) hudEl.style.display = 'none';
  }

  return { update, setVoxelMesh, setFloorY, dispose };
}

