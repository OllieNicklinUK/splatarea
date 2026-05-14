import * as THREE from 'three';
import { SplatCrowd } from './people/SplatCrowd.js';

const CAM_BEHIND = 3.8;   // metres behind NPC
const CAM_UP     = 2.2;   // metres above NPC root
const CAM_LERP   = 6.0;   // camera position lerp speed
const CAM_FOV_FOLLOW   = 65;
const CAM_FOV_OVERVIEW = 55;

export function createPeopleGame({
  scene, camera, controls, box, floorY,
  voxelMesh = null, spawnCenter = null, spawnRadius = null,
}) {
  // ── Overview camera ────────────────────────────────────────────────────────
  controls.enabled = true;
  camera.fov = CAM_FOV_OVERVIEW;
  camera.updateProjectionMatrix();

  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  const d = span * 0.55;
  camera.position.set(cx + d, floorY + d * 0.8, cz + d);
  camera.lookAt(cx, floorY, cz);
  controls.target.set(cx, floorY, cz);
  controls.update();

  // ── NPC crowd ──────────────────────────────────────────────────────────────
  const crowd = new SplatCrowd(scene, box, floorY, voxelMesh, spawnCenter, spawnRadius);

  // ── Follow-mode state ──────────────────────────────────────────────────────
  let followMode  = false;
  let followIndex = 0;
  const _camPos   = new THREE.Vector3();
  const _backDir  = new THREE.Vector3();

  // Highlight ring shown under the tracked NPC
  const _highlightRing = new THREE.Mesh(
    new THREE.RingGeometry(0.38, 0.46, 32),
    new THREE.MeshBasicMaterial({ color: 0xfbbf24, side: THREE.DoubleSide, depthWrite: false }),
  );
  _highlightRing.rotation.x = -Math.PI / 2;
  _highlightRing.visible = false;
  scene.add(_highlightRing);

  // ── UI refs ────────────────────────────────────────────────────────────────
  const hudEl    = document.getElementById('people-hud');
  const labelEl  = document.getElementById('people-follow-label');
  const btnEl    = document.getElementById('people-follow-btn');
  const soonEl   = document.getElementById('people-soon');
  if (soonEl) soonEl.style.display = 'none';
  if (hudEl) hudEl.style.display = 'flex';

  function _followableNPCs() {
    return crowd.npcs.filter(n => n._instance); // only fully-loaded ones
  }

  function _updateLabel() {
    if (!followMode) {
      if (labelEl) labelEl.textContent = 'Overview';
      if (btnEl)   { btnEl.textContent = '🎥 Follow'; btnEl.style.background = '#1a2a1a'; }
      _highlightRing.visible = false;
    } else {
      const loaded = _followableNPCs();
      const idx    = followIndex % Math.max(1, loaded.length);
      if (labelEl) labelEl.textContent = `NPC ${idx + 1} / ${loaded.length}`;
      if (btnEl)   { btnEl.textContent = '🌐 Overview'; btnEl.style.background = '#2a1a00'; }
    }
  }

  function _enterFollow() {
    followMode = true;
    controls.enabled = false;
    camera.fov = CAM_FOV_FOLLOW;
    camera.updateProjectionMatrix();
    _updateLabel();
  }

  function _enterOverview() {
    followMode = false;
    controls.enabled = true;
    camera.fov = CAM_FOV_OVERVIEW;
    camera.updateProjectionMatrix();
    // Restore isometric view
    camera.position.set(cx + d, floorY + d * 0.8, cz + d);
    camera.lookAt(cx, floorY, cz);
    controls.target.set(cx, floorY, cz);
    controls.update();
    _highlightRing.visible = false;
    _updateLabel();
  }

  function _toggleFollow() {
    if (followMode) _enterOverview(); else _enterFollow();
  }

  btnEl?.addEventListener('click', _toggleFollow);

  // Arrow keys — switch NPC (only in follow mode)
  const onKeyDown = (e) => {
    if (!followMode) return;
    const loaded = _followableNPCs();
    if (!loaded.length) return;
    if (e.code === 'ArrowRight' || e.code === 'ArrowDown') {
      followIndex = (followIndex + 1) % loaded.length;
      _updateLabel();
      e.preventDefault();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') {
      followIndex = (followIndex - 1 + loaded.length) % loaded.length;
      _updateLabel();
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  // ── Click-to-scatter (overview mode only) ──────────────────────────────────
  const _rc         = new THREE.Raycaster();
  const _floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
  const _hit        = new THREE.Vector3();
  const _ndc        = new THREE.Vector2();
  const _canvas     = document.getElementById('viewport');

  const onPointerDown = (e) => {
    if (e.button !== 0 || followMode) return;
    const rect = _canvas.getBoundingClientRect();
    _ndc.set(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top)  / rect.height) * 2 + 1,
    );
    _rc.setFromCamera(_ndc, camera);
    if (_rc.ray.intersectPlane(_floorPlane, _hit)) crowd.scatter(_hit);
  };
  window.addEventListener('pointerdown', onPointerDown);

  // ── Update ─────────────────────────────────────────────────────────────────
  function update(dt) {
    crowd.update(dt);
    if (!followMode) { controls.update(); return; }

    const loaded = _followableNPCs();
    if (!loaded.length) return;

    const idx = followIndex % loaded.length;
    const npc = loaded[idx];
    const pos = npc.group.position;

    // Back-direction: opposite of NPC velocity, or from rotation when idle
    if (npc.velocity.lengthSq() > 0.001) {
      _backDir.copy(npc.velocity).normalize().negate();
    } else {
      // Derive from group rotation: NPC faces (sin, 0, cos) in world space
      const ry = npc.group.rotation.y - Math.PI; // remove FACING_FLIP
      _backDir.set(-Math.sin(ry), 0, -Math.cos(ry));
    }

    _camPos.copy(pos)
      .addScaledVector(_backDir, CAM_BEHIND)
      .setY(pos.y + CAM_UP);

    camera.position.lerp(_camPos, 1 - Math.exp(-CAM_LERP * dt));
    camera.lookAt(pos.x, pos.y + 1.1, pos.z);

    // Highlight ring under the tracked NPC
    _highlightRing.position.set(pos.x, pos.y + 0.05, pos.z);
    _highlightRing.visible = true;
  }

  // ── Dispose ────────────────────────────────────────────────────────────────
  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pointerdown', onPointerDown);
    btnEl?.removeEventListener('click', _toggleFollow);
    crowd.destroy();
    scene.remove(_highlightRing);
    _highlightRing.geometry.dispose();
    _highlightRing.material.dispose();
    if (hudEl) hudEl.style.display = 'none';
    controls.enabled = true;
    camera.fov = 45;
    camera.updateProjectionMatrix();
  }

  function setVoxelMesh(mesh) { crowd.setVoxelMesh(mesh); }

  return { update, setVoxelMesh, dispose };
}
