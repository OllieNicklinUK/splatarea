import * as THREE from 'three';

// Flight physics constants (from flight-simulator-v1)
const SPEED        = 16;    // m/s forward — slower = tighter radius
const PITCH_SPEED  = 2.2;
const ROLL_SPEED   = 3.5;
const ROLL_DAMPING = 0.92;
const YAW_FROM_ROLL= 3.5;   // high = tight turns; radius ≈ speed / (max_roll * yaw_factor)
const MAX_PITCH    = Math.PI / 3;

const CAM_BACK     = 12;
const CAM_UP       = 3.5;
const CAM_LERP     = 3.0;
const CAM_LOOKAHEAD= 20;

const RING_COUNT   = 12;
const RING_RADIUS  = 3.5;
const RING_TUBE    = 0.28;
const RING_COLLECT = 5;    // collection distance

// ─── Aircraft geometry ────────────────────────────────────────────────────────
function buildAircraft() {
  const group = new THREE.Group();

  const fuse = new THREE.Mesh(
    Object.assign(new THREE.CylinderGeometry(0.18, 0.3, 2.0, 8), { rotated: true }),
    new THREE.MeshLambertMaterial({ color: 0xe8e0d4 })
  );
  fuse.geometry.rotateX(Math.PI / 2);
  group.add(fuse);

  const cockpit = new THREE.Mesh(
    new THREE.SphereGeometry(0.165, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x2288cc })
  );
  cockpit.position.set(0, 0.09, -0.4);
  group.add(cockpit);

  const wings = new THREE.Mesh(
    new THREE.BoxGeometry(4.0, 0.08, 1.0),
    new THREE.MeshLambertMaterial({ color: 0xd4cdc0 })
  );
  group.add(wings);

  const hTail = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.06, 0.6),
    new THREE.MeshLambertMaterial({ color: 0xcc3333 })
  );
  hTail.position.set(0, 0, 0.9);
  group.add(hTail);

  const vTail = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.8, 0.6),
    new THREE.MeshLambertMaterial({ color: 0xcc3333 })
  );
  vTail.position.set(0, 0.32, 0.9);
  group.add(vTail);

  return group;
}

// ─── Rings ────────────────────────────────────────────────────────────────────
function spawnRings(scene, box, floorY) {
  const rings = [];
  const xRange = box.max.x - box.min.x;
  const zRange = box.max.z - box.min.z;
  const yMin = floorY + 3;
  const yMax = Math.min(box.max.y - 2, floorY + Math.max(8, (box.max.y - floorY) * 0.6));
  const pad = 4;

  for (let i = 0; i < RING_COUNT; i++) {
    const geo = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 8, 24);
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffcc00, emissive: 0xffee44, emissiveIntensity: 0.3, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.position.set(
      box.min.x + pad + Math.random() * (xRange - pad * 2),
      yMin + Math.random() * (yMax - yMin),
      box.min.z + pad + Math.random() * (zRange - pad * 2),
    );
    ring.rotation.y = Math.random() * Math.PI;
    ring.userData.baseY = ring.position.y;
    ring.userData.bobOff = Math.random() * Math.PI * 2;
    ring.userData.collected = false;
    scene.add(ring);
    rings.push(ring);
  }
  return rings;
}

function respawnRings(rings, box, floorY) {
  const xRange = box.max.x - box.min.x;
  const zRange = box.max.z - box.min.z;
  const yMin = floorY + 3;
  const yMax = Math.min(box.max.y - 2, floorY + Math.max(8, (box.max.y - floorY) * 0.6));
  const pad = 4;
  for (const ring of rings) {
    ring.position.set(
      box.min.x + pad + Math.random() * (xRange - pad * 2),
      yMin + Math.random() * (yMax - yMin),
      box.min.z + pad + Math.random() * (zRange - pad * 2),
    );
    ring.userData.baseY = ring.position.y;
    ring.userData.bobOff = Math.random() * Math.PI * 2;
    ring.userData.collected = false;
    ring.material.color.setHex(0xffcc00);
    ring.material.emissive.setHex(0xffee44);
    ring.material.transparent = false;
    ring.material.opacity = 1;
  }
}

// ─── Main factory ─────────────────────────────────────────────────────────────
export function createFlightGame({ scene, camera, controls, box, floorY }) {
  controls.enabled = false;

  // ── Plane ────────────────────────────────────────────────────────────────
  const cx  = (box.min.x + box.max.x) / 2;
  const cz  = (box.min.z + box.max.z) / 2;
  const arenaH = Math.max(box.max.y - floorY, 10);
  const startY = Math.min(floorY + Math.max(15, arenaH * 0.55), box.max.y - 3);
  const minY   = floorY + 0.8;
  const maxY   = box.max.y - 1.5;

  const plane = buildAircraft();
  plane.position.set(cx, startY, cz);
  scene.add(plane);

  let pitch = 0, roll = 0, yaw = 0;
  const _euler   = new THREE.Euler(0, 0, 0, 'YXZ');
  const _forward = new THREE.Vector3();
  const _camPos  = new THREE.Vector3();

  // ── Input ────────────────────────────────────────────────────────────────
  const keys = {};
  const onKeyDown = e => {
    keys[e.code] = true;
    if (e.code === 'KeyR' && gameOver) restart();
  };
  const onKeyUp = e => { keys[e.code] = false; };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // ── Rings ────────────────────────────────────────────────────────────────
  const rings = spawnRings(scene, box, floorY);

  // ── Camera ───────────────────────────────────────────────────────────────
  camera.fov = 70;
  camera.updateProjectionMatrix();
  // Snap camera behind plane at start
  camera.position.set(cx, startY + CAM_UP, cz + CAM_BACK);
  camera.lookAt(cx, startY, cz - CAM_LOOKAHEAD);

  // ── HUD ──────────────────────────────────────────────────────────────────
  const hudEl    = document.getElementById('flight-hud');
  const scoreEl  = document.getElementById('flight-score');
  const altEl    = document.getElementById('flight-alt');
  const goEl     = document.getElementById('flight-gameover');
  const goScore  = document.getElementById('flight-go-score');
  if (hudEl) hudEl.style.display = 'flex';

  // ── State ────────────────────────────────────────────────────────────────
  let score    = 0;
  let elapsed  = 0;
  let gameOver = false;

  function setScore(s) {
    score = s;
    if (scoreEl) scoreEl.textContent = `${score} rings`;
  }
  setScore(0);

  function crash() {
    if (gameOver) return;
    gameOver = true;
    if (goScore) goScore.textContent = `${score} ring${score !== 1 ? 's' : ''}`;
    if (goEl) goEl.style.display = 'flex';
  }

  function restart() {
    gameOver = false;
    pitch = 0; roll = 0; yaw = 0;
    plane.position.set(cx, startY, cz);
    plane.rotation.set(0, 0, 0);
    setScore(0);
    respawnRings(rings, box, floorY);
    if (goEl) goEl.style.display = 'none';
  }

  // ── Update ───────────────────────────────────────────────────────────────
  function update(dt) {
    elapsed += dt;

    if (!gameOver) {
      // Flight physics
      if (keys['KeyW'] || keys['ArrowUp'])   pitch -= PITCH_SPEED * dt;
      if (keys['KeyS'] || keys['ArrowDown']) pitch += PITCH_SPEED * dt;
      pitch = THREE.MathUtils.clamp(pitch, -MAX_PITCH, MAX_PITCH);

      if (keys['KeyA'] || keys['ArrowLeft'])  roll += ROLL_SPEED * dt;
      if (keys['KeyD'] || keys['ArrowRight']) roll -= ROLL_SPEED * dt;
      roll *= ROLL_DAMPING;
      yaw  += roll * YAW_FROM_ROLL * dt;

      _euler.set(pitch, yaw, roll);
      plane.setRotationFromEuler(_euler);

      _forward.set(0, 0, -1).applyEuler(_euler);
      plane.position.addScaledVector(_forward, SPEED * dt);

      // Altitude clamp
      // Soft clamp — no crash while testing
      if (plane.position.y < minY) { plane.position.y = minY; pitch = Math.min(pitch, 0); }
      if (plane.position.y > maxY) { plane.position.y = maxY; pitch = Math.max(pitch, 0); }

      // Ring collection
      let allCollected = true;
      for (const ring of rings) {
        if (ring.userData.collected) continue;
        allCollected = false;
        ring.rotation.x += dt;
        ring.position.y = ring.userData.baseY +
          Math.sin(elapsed * 1.5 + ring.userData.bobOff) * 0.5;
        ring.material.emissiveIntensity = 0.2 + Math.sin(elapsed * 3 + ring.userData.bobOff) * 0.15;

        if (plane.position.distanceTo(ring.position) < RING_COLLECT) {
          ring.userData.collected = true;
          ring.material.color.setHex(0x44ff44);
          ring.material.emissive.setHex(0x000000);
          ring.material.transparent = true;
          ring.material.opacity = 0.2;
          setScore(score + 1);
        }
      }
      if (allCollected) respawnRings(rings, box, floorY);

      // HUD altitude
      if (altEl) altEl.textContent = `${(plane.position.y - floorY).toFixed(1)}m`;
    }

    // Chase camera (always follows even on game over for cinematic)
    const fwd = _forward.set(0, 0, -1).applyEuler(plane.rotation);
    _camPos.copy(plane.position)
      .addScaledVector(fwd, -CAM_BACK)
      .add(new THREE.Vector3(0, CAM_UP, 0));
    camera.position.lerp(_camPos, 1 - Math.exp(-CAM_LERP * dt));
    const lookAt = plane.position.clone().addScaledVector(fwd, CAM_LOOKAHEAD);
    camera.lookAt(lookAt);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    scene.remove(plane);
    plane.traverse(n => { if (n.isMesh) { n.geometry.dispose(); n.material.dispose(); } });
    for (const ring of rings) {
      ring.geometry.dispose(); ring.material.dispose(); scene.remove(ring);
    }
    if (hudEl) hudEl.style.display = 'none';
    if (goEl)  goEl.style.display  = 'none';
    controls.enabled = true;
    camera.fov = 45;
    camera.updateProjectionMatrix();
  }

  return { update, dispose };
}
