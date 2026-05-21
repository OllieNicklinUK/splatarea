// people-game.js
// Adapted from gaussian-splat-library-v1/src/peopleGame.js
// Crowd of VRM NPCs + follow-camera mode.
//
// Returns { update(dt), setVoxelMesh(mesh), dispose() }

import * as THREE from 'three';
import { SplatCrowd } from './shared/people/SplatCrowd.js';

const CAM_BEHIND = 3.8;
const CAM_UP     = 2.2;
const CAM_LERP   = 6.0;
const FOV_FOLLOW = 65;
const FOV_OVERVIEW = 55;

export function createPeopleGame({
  scene, camera, controls, box, floorY,
  voxelMesh = null, spawnCenter = null, spawnRadius = null,
}) {
  // ── Overview camera ────────────────────────────────────────────────────────
  controls.enabled = true;
  camera.fov = FOV_OVERVIEW;
  camera.updateProjectionMatrix();

  const cx   = (box.min.x + box.max.x) / 2;
  const cz   = (box.min.z + box.max.z) / 2;
  const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  const d    = span * 0.55;
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

  const _highlightRing = new THREE.Mesh(
    new THREE.RingGeometry(0.38, 0.46, 32),
    new THREE.MeshBasicMaterial({ color: 0xfbbf24, side: THREE.DoubleSide, depthWrite: false }),
  );
  _highlightRing.rotation.x = -Math.PI / 2;
  _highlightRing.visible = false;
  scene.add(_highlightRing);

  // ── UI ──────────────────────────────────────────────────────────────────────
  const hudEl   = document.getElementById('people-hud');
  const labelEl = document.getElementById('people-follow-label');
  const btnEl   = document.getElementById('people-follow-btn');
  if (hudEl) hudEl.style.display = 'flex';

  function _followable() { return crowd.npcs.filter(n => n._instance); }

  function _updateLabel() {
    if (!followMode) {
      if (labelEl) labelEl.textContent = 'Overview';
      if (btnEl)   btnEl.textContent   = '🎥 Follow';
      _highlightRing.visible = false;
    } else {
      const loaded = _followable();
      const idx    = followIndex % Math.max(1, loaded.length);
      if (labelEl) labelEl.textContent = `NPC ${idx + 1} / ${loaded.length}`;
      if (btnEl)   btnEl.textContent   = '🌐 Overview';
    }
  }

  function _enterFollow() {
    followMode = true;
    controls.enabled = false;
    camera.fov = FOV_FOLLOW;
    camera.updateProjectionMatrix();
    _updateLabel();
  }

  function _enterOverview() {
    followMode = false;
    controls.enabled = true;
    camera.fov = FOV_OVERVIEW;
    camera.updateProjectionMatrix();
    camera.position.set(cx + d, floorY + d * 0.8, cz + d);
    camera.lookAt(cx, floorY, cz);
    controls.target.set(cx, floorY, cz);
    controls.update();
    _highlightRing.visible = false;
    _updateLabel();
  }

  btnEl?.addEventListener('click', () => { if (followMode) _enterOverview(); else _enterFollow(); });

  const _onKeyDown = (e) => {
    if (!followMode) return;
    const loaded = _followable();
    if (!loaded.length) return;
    if (e.code === 'ArrowRight' || e.code === 'ArrowDown') {
      followIndex = (followIndex + 1) % loaded.length; _updateLabel(); e.preventDefault();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') {
      followIndex = (followIndex - 1 + loaded.length) % loaded.length; _updateLabel(); e.preventDefault();
    }
  };
  window.addEventListener('keydown', _onKeyDown);

  // Click-to-scatter (overview mode)
  const _rc    = new THREE.Raycaster();
  const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
  const _hit   = new THREE.Vector3();
  const _ndc   = new THREE.Vector2();
  const _canvas = document.getElementById('viewport');

  const _onPointerDown = (e) => {
    if (e.button !== 0 || followMode) return;
    const rect = _canvas.getBoundingClientRect();
    _ndc.set(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top)  / rect.height) * 2 + 1,
    );
    _rc.setFromCamera(_ndc, camera);
    if (_rc.ray.intersectPlane(_plane, _hit)) crowd.scatter(_hit);
  };
  window.addEventListener('pointerdown', _onPointerDown);

  // ── Update ─────────────────────────────────────────────────────────────────
  function update(dt) {
    crowd.update(dt);
    if (!followMode) { controls.update(); return; }

    const loaded = _followable();
    if (!loaded.length) return;

    const npc = loaded[followIndex % loaded.length];
    const pos = npc.group.position;

    if (npc.velocity.lengthSq() > 0.001) {
      _backDir.copy(npc.velocity).normalize().negate();
    } else {
      const ry = npc.group.rotation.y - Math.PI;
      _backDir.set(-Math.sin(ry), 0, -Math.cos(ry));
    }

    _camPos.copy(pos)
      .addScaledVector(_backDir, CAM_BEHIND)
      .setY(pos.y + CAM_UP);
    camera.position.lerp(_camPos, 1 - Math.exp(-CAM_LERP * dt));
    camera.lookAt(pos.x, pos.y + 1.1, pos.z);

    _highlightRing.position.set(pos.x, pos.y + 0.05, pos.z);
    _highlightRing.visible = true;
  }

  function setVoxelMesh(mesh) { crowd.setVoxelMesh(mesh); }

  function dispose() {
    window.removeEventListener('keydown', _onKeyDown);
    window.removeEventListener('pointerdown', _onPointerDown);
    btnEl?.removeEventListener('click', () => {});
    crowd.destroy();
    scene.remove(_highlightRing);
    _highlightRing.geometry.dispose();
    _highlightRing.material.dispose();
    if (hudEl) hudEl.style.display = 'none';
    controls.enabled = true;
    camera.fov = 60;
    camera.updateProjectionMatrix();
  }

  return { update, setVoxelMesh, dispose };
}
