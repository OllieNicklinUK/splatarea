import * as THREE from 'three';
import { Timer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { createPhysics } from './fps/physics.js';
import { createTankGame }   from './tankGame.js';
import { createFlightGame } from './flightGame.js';
import { createFPSGame }    from './fpsGame.js';
import { createPeopleGame } from './peopleGame.js';
import { generateCollision, isWebGPUAvailable } from './collision/client-collider.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ─── PRESET PERSISTENCE ──────────────────────────────────────────────────────
// Settings only (floor Y, spawn XZ, URL, mode) stored in localStorage.
// No binary data — file-based splats ask the user to re-select the file
// when loading a preset, then apply all saved settings automatically.

const _PRESET_LS  = i => `sp_preset_${i}`;
const NUM_PRESETS = 3;

let currentSplatMeta = null; // { name, url, isFile } — set in loadSplat
let _presetOverride  = null; // { floorY, spawnX, spawnZ, spawnRadius, gameMode }

function _getPreset(i) {
  try { return JSON.parse(localStorage.getItem(_PRESET_LS(i))); } catch { return null; }
}

function _timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function _saveToPreset(slot) {
  if (!currentSplatMeta) return;
  const data = {
    name:        currentSplatMeta.name,
    url:         currentSplatMeta.isFile ? null : currentSplatMeta.url,
    isFile:      currentSplatMeta.isFile,
    floorY:      configFloorY,
    spawnX:      configSpawnX,
    spawnZ:      configSpawnZ,
    spawnRadius: configSpawnRadius,
    gameMode:    selectedMode,
    savedAt:     Date.now(),
  };
  localStorage.setItem(_PRESET_LS(slot), JSON.stringify(data));
  _renderPresets();
  _renderPresetBar();
}

function _launchPreset(slot) {
  const data = _getPreset(slot);
  if (!data) return;
  _presetOverride = {
    floorY:      data.floorY,
    spawnX:      data.spawnX,
    spawnZ:      data.spawnZ,
    spawnRadius: data.spawnRadius,
    gameMode:    data.gameMode,
  };
  if (data.url) {
    // Remote URL — load directly with saved settings
    loadSplat(data.url, data.name);
  } else {
    // Local file preset — settings queued, ask user to re-select the file
    setSplashStatus(`Preset ${slot + 1}: select "${data.name}" to apply settings`);
    if (splashEl) { splashEl.style.display = 'flex'; splashEl.style.opacity = '1'; }
    document.getElementById('ply-upload')?.click();
  }
}

function _clearPreset(slot) {
  localStorage.removeItem(_PRESET_LS(slot));
  _renderPresets();
  _renderPresetBar();
}

// Splash-screen preset grid (large cards)
function _renderPresets() {
  const grid = document.getElementById('preset-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (let i = 0; i < NUM_PRESETS; i++) {
    const saved = _getPreset(i);
    const card  = document.createElement('div');
    card.className = `preset-card${saved ? ' filled' : ''}`;
    if (saved) {
      const shortName = saved.name.length > 11 ? saved.name.slice(0, 9) + '…' : saved.name;
      card.innerHTML = `
        <span class="preset-num">${i + 1} · ${saved.gameMode ?? 'tank'}</span>
        <span class="preset-label">${shortName}</span>
        <span class="preset-meta">${_timeAgo(saved.savedAt)}</span>
        <button class="preset-clear" title="Clear">×</button>`;
      card.addEventListener('click', e => { if (!e.target.closest('.preset-clear')) _launchPreset(i); });
      card.querySelector('.preset-clear').addEventListener('click', e => {
        e.stopPropagation();
        if (confirm(`Clear Preset ${i + 1}?`)) _clearPreset(i);
      });
    } else {
      card.innerHTML = `<span class="preset-num">${i + 1}</span><span class="preset-label" style="color:#475569">Empty</span>`;
    }
    grid.appendChild(card);
  }
}

// In-game preset bar (compact rows: num | name | Load | Save)
function _renderPresetBar() {
  const bar = document.getElementById('preset-bar');
  if (!bar) return;
  // Keep the label div, replace the rows
  const label = bar.querySelector('.pb-label');
  bar.innerHTML = '';
  if (label) bar.appendChild(label);
  else {
    const lbl = document.createElement('div');
    lbl.className = 'pb-label';
    lbl.textContent = 'Presets';
    bar.appendChild(lbl);
  }
  for (let i = 0; i < NUM_PRESETS; i++) {
    const saved  = _getPreset(i);
    const row    = document.createElement('div');
    row.className = 'pb-row';
    const shortName = saved ? (saved.name.length > 12 ? saved.name.slice(0, 10) + '…' : saved.name) : 'Empty';
    row.innerHTML = `
      <span class="pb-num">${i + 1}</span>
      <span class="pb-name${saved ? ' filled' : ''}">${shortName}</span>
      <button class="pb-load"${saved ? '' : ' disabled'}>▶</button>
      <button class="pb-save" title="Save current state to Preset ${i + 1}">💾</button>`;
    if (saved) row.querySelector('.pb-load').addEventListener('click', () => _launchPreset(i));
    row.querySelector('.pb-save').addEventListener('click', () => {
      _saveToPreset(i);
      const btn = row.querySelector('.pb-save');
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '💾'; _renderPresetBar(); }, 1500);
    });
    bar.appendChild(row);
  }
}

function _showPresetBar(visible) {
  const bar = document.getElementById('preset-bar');
  if (bar) bar.style.display = visible ? 'flex' : 'none';
}

// Initialise on load
_renderPresets();
_renderPresetBar();

// ─── Phases: idle → loading → orbit → explore → playing ─────────────────────
let phase = 'idle';

// ─── Three.js ────────────────────────────────────────────────────────────────
const vp = document.getElementById('viewport');
const scene    = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a12);

const camera = new THREE.PerspectiveCamera(45, vp.clientWidth / vp.clientHeight, 0.1, 5000);
camera.position.set(0, 5, 10);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(vp.clientWidth, vp.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
vp.appendChild(renderer.domElement);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xffd5a0, 1.3);
sun.position.set(15, 28, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -30; sun.shadow.camera.right = 30;
sun.shadow.camera.top  =  30; sun.shadow.camera.bottom = -30;
sun.shadow.camera.far  = 120;
scene.add(sun);

const physics = createPhysics();
const _floorSlab = new THREE.Mesh(
  new THREE.BoxGeometry(2000, 2, 2000),
  new THREE.MeshBasicMaterial({ visible: false })
);
_floorSlab.position.set(0, -1, 0);
scene.add(_floorSlab);
physics.clearCollisionMeshes([_floorSlab]);

window.addEventListener('resize', () => {
  camera.aspect = vp.clientWidth / vp.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(vp.clientWidth, vp.clientHeight);
});

// ─── State ────────────────────────────────────────────────────────────────────
let activeSplatMesh   = null;
let _splatCage        = null;
let _voxelGlbScene    = null;
let _splatBox         = null;
let _pendingSplatFile = null;
let _loadSession      = 0;
let activeGame        = null;   // current game instance (tank or flight)
let selectedMode      = 'tank'; // 'tank' | 'flight'
const gltfLoader      = new GLTFLoader();

// Floor configure state
let configFloorY      = 0;
let configBox         = null;
let configFloorGrid   = null;
let configFloorHandle = null;
// Spawn area state
let configSpawnX      = 0;
let configSpawnZ      = 0;
let configSpawnRadius = 10;
let _spawnGroup       = null;  // THREE.Group — disc + ring on floor

// ─── UI refs ──────────────────────────────────────────────────────────────────
const splashEl           = document.getElementById('splash');
const splashStatus       = document.getElementById('splash-status');
const loadingBar         = document.getElementById('loading-bar');
const floorSetupEl       = document.getElementById('floor-setup');
const floorColliderStatus= document.getElementById('floor-collider-status');
const walkBtn            = document.getElementById('walk-btn');
const confirmBtn         = document.getElementById('confirm-btn');
const statusBar          = document.getElementById('status-bar');
const crosshair          = document.getElementById('crosshair');
const fpsHint            = document.getElementById('fps-hint');
const fpsFloorWidget     = document.getElementById('fps-floor-widget');
const fpsFloorValEl      = document.getElementById('fps-floor-val');

function setSplashStatus(msg) { if (splashStatus) splashStatus.textContent = msg; }
function setFloorStatus(msg)  { if (floorColliderStatus) floorColliderStatus.textContent = msg; }

// ─── Collider debug toggle ────────────────────────────────────────────────────
let _colliderDebugOn = false;
const _debugMat = new THREE.MeshBasicMaterial({
  color: 0xf97316, transparent: true, opacity: 0.45,
  side: THREE.DoubleSide, depthWrite: false,
});

function _toggleColliderDebug() {
  if (!_voxelGlbScene) return;
  _colliderDebugOn = !_colliderDebugOn;
  _voxelGlbScene.traverse(n => {
    if (!n.isMesh) return;
    if (_colliderDebugOn) {
      n.userData._origMat = n.material;
      n.material = _debugMat;
      n.visible  = true;
    } else {
      n.material = n.userData._origMat ?? new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
      n.visible  = true; // visible stays true — colorWrite:false hides it from camera
    }
  });
  const btn = document.getElementById('view-collider-btn');
  if (btn) {
    btn.textContent = _colliderDebugOn ? '🟠 Hide Collider' : '👁 View Collider';
    btn.style.background = _colliderDebugOn ? '#7c2d12' : '#0d1a2a';
  }
}

document.getElementById('view-collider-btn')?.addEventListener('click', _toggleColliderDebug);

// ─── Game mode selection ──────────────────────────────────────────────────────
const _modeIds = ['mode-fps', 'mode-tank', 'mode-flight', 'mode-people'];
const _modeMap  = { 'mode-fps': 'fps', 'mode-tank': 'tank', 'mode-flight': 'flight', 'mode-people': 'people' };

function _selectMode(id) {
  selectedMode = _modeMap[id];
  _modeIds.forEach(m => document.getElementById(m)?.classList.toggle('active', m === id));
  // Update the FPS hint action text for modes that use the FPS explore phase
  const hintEl = document.getElementById('fps-hint-action');
  if (hintEl) {
    const labels = { fps: '<b>Enter</b> or <b>Confirm</b> to start shooting', tank: '<b>Enter</b> or <b>Confirm</b> to start battle', flight: '<b>Enter</b> or <b>Confirm</b> to take off', people: '<b>Enter</b> or <b>Confirm</b> to place crowd' };
    hintEl.innerHTML = labels[selectedMode] ?? '<b>Enter</b> or <b>Confirm</b> to start';
  }
}

_modeIds.forEach(id => document.getElementById(id)?.addEventListener('click', () => _selectMode(id)));

function _updateFloorValDisplay() {
  const el = document.getElementById('floor-val');
  if (el) el.value = configFloorY.toFixed(2);
  if (fpsFloorValEl) fpsFloorValEl.textContent = `${configFloorY.toFixed(2)}m`;
}

// ─── 3D floor grid & drag handle ─────────────────────────────────────────────
function _updateConfigFloorGrid() {
  if (configFloorGrid) {
    scene.remove(configFloorGrid);
    configFloorGrid.traverse(n => { n.geometry?.dispose(); n.material?.dispose(); });
    configFloorGrid = null;
  }
  if (!configBox) return;

  const cx = (configBox.min.x + configBox.max.x) / 2;
  const cz = (configBox.min.z + configBox.max.z) / 2;
  const w = configBox.max.x - configBox.min.x;
  const d = configBox.max.z - configBox.min.z;
  const gridSize = Math.max(w, d) * 1.6;
  const divisions = Math.round(gridSize / Math.max(0.5, gridSize / 40));

  const grid = new THREE.GridHelper(gridSize, divisions, 0x4FD8F5, 0x4FD8F5);
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  grid.material.depthWrite = false;

  const borderGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(gridSize * 0.98, 0.001, gridSize * 0.98));
  const border = new THREE.LineSegments(borderGeo, new THREE.LineBasicMaterial({ color: 0x4FD8F5 }));

  configFloorGrid = new THREE.Group();
  configFloorGrid.add(grid, border);
  configFloorGrid.position.set(cx, configFloorY, cz);
  scene.add(configFloorGrid);
}

function _updateFloorHandle() {
  if (!configBox) return;
  const cx = (configBox.min.x + configBox.max.x) / 2;
  const cz = (configBox.min.z + configBox.max.z) / 2;

  if (!configFloorHandle) {
    const mat = () => new THREE.MeshBasicMaterial({ color: 0x4FD8F5 });
    const ring   = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.05, 8, 32), mat());
    ring.rotation.x = Math.PI / 2;
    const shaft  = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 8), mat());
    const coneUp = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.28, 8), mat());
    coneUp.position.y = 0.59;
    const coneDn = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.28, 8), mat());
    coneDn.rotation.z = Math.PI; coneDn.position.y = -0.59;
    configFloorHandle = new THREE.Group();
    configFloorHandle.add(ring, shaft, coneUp, coneDn);
    scene.add(configFloorHandle);
  }
  configFloorHandle.position.set(cx, configFloorY, cz);
}

function _disposeFloorVisuals() {
  if (configFloorGrid)  { scene.remove(configFloorGrid);  configFloorGrid = null; }
  if (configFloorHandle){ scene.remove(configFloorHandle); configFloorHandle = null; }
  if (_spawnGroup)      { scene.remove(_spawnGroup);       _spawnGroup = null; }
}

// ─── Spawn area disc ──────────────────────────────────────────────────────────
function _updateSpawnSphere() {
  if (!_spawnGroup) {
    const discMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24, transparent: true, opacity: 0.13,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24, transparent: true, opacity: 0.75,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 64), discMat);
    disc.rotation.x = -Math.PI / 2;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 64), ringMat);
    ring.rotation.x = -Math.PI / 2;
    // Small centre dot so user knows the exact position
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.04, 16), ringMat.clone());
    dot.rotation.x = -Math.PI / 2;
    _spawnGroup = new THREE.Group();
    _spawnGroup.add(disc, ring, dot);
    scene.add(_spawnGroup);
  }
  _spawnGroup.position.set(configSpawnX, configFloorY + 0.03, configSpawnZ);
  _spawnGroup.scale.set(configSpawnRadius, 1, configSpawnRadius);

  // Sync UI
  const rEl = document.getElementById('spawn-r-val');
  if (rEl) rEl.textContent = `${configSpawnRadius.toFixed(1)}m`;
  const xEl = document.getElementById('spawn-x-slider');
  if (xEl) xEl.value = configSpawnX;
  const xVEl = document.getElementById('spawn-x-val');
  if (xVEl) xVEl.textContent = configSpawnX.toFixed(1);
  const zEl = document.getElementById('spawn-z-slider');
  if (zEl) zEl.value = configSpawnZ;
  const zVEl = document.getElementById('spawn-z-val');
  if (zVEl) zVEl.textContent = configSpawnZ.toFixed(1);
}

// Radius +/- buttons
const _SPAWN_R_STEP = 0.5;
let _spawnRTimer = null;
const _startSpawnR = (d) => {
  configSpawnRadius = Math.max(1, configSpawnRadius + d);
  _updateSpawnSphere();
  _spawnRTimer = setInterval(() => {
    configSpawnRadius = Math.max(1, configSpawnRadius + d);
    _updateSpawnSphere();
  }, 80);
};
const _stopSpawnR = () => { clearInterval(_spawnRTimer); _spawnRTimer = null; };
document.getElementById('spawn-r-dn')?.addEventListener('mousedown', () => _startSpawnR(-_SPAWN_R_STEP));
document.getElementById('spawn-r-up')?.addEventListener('mousedown', () => _startSpawnR(+_SPAWN_R_STEP));
document.addEventListener('mouseup', _stopSpawnR);

// X / Z sliders
document.getElementById('spawn-x-slider')?.addEventListener('input', (e) => {
  configSpawnX = parseFloat(e.target.value); _updateSpawnSphere();
});
document.getElementById('spawn-z-slider')?.addEventListener('input', (e) => {
  configSpawnZ = parseFloat(e.target.value); _updateSpawnSphere();
});

// Click-on-floor to reposition centre (orbit phase only)
const _spawnFloorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _spawnHitPt      = new THREE.Vector3();
const _spawnRc         = new THREE.Raycaster();
const _spawnNdc        = new THREE.Vector2();
renderer.domElement.addEventListener('click', (e) => {
  if (phase !== 'orbit') return;
  // Don't intercept clicks that were a floor-handle drag
  if (_isDraggingFloor) return;
  const rect = renderer.domElement.getBoundingClientRect();
  _spawnNdc.set(
    ((e.clientX - rect.left) / rect.width)  * 2 - 1,
    -((e.clientY - rect.top)  / rect.height) * 2 + 1,
  );
  _spawnFloorPlane.constant = -configFloorY;
  _spawnRc.setFromCamera(_spawnNdc, camera);
  if (_spawnRc.ray.intersectPlane(_spawnFloorPlane, _spawnHitPt)) {
    configSpawnX = _spawnHitPt.x;
    configSpawnZ = _spawnHitPt.z;
    // Clamp to bbox if available
    if (configBox) {
      configSpawnX = THREE.MathUtils.clamp(configSpawnX, configBox.min.x, configBox.max.x);
      configSpawnZ = THREE.MathUtils.clamp(configSpawnZ, configBox.min.z, configBox.max.z);
    }
    _updateSpawnSphere();
  }
});

// ─── Floor Y adjustment ───────────────────────────────────────────────────────
const FLOOR_STEP = 0.05;

function setFloor(y) {
  if (configBox) y = Math.max(configBox.min.y - 2, Math.min(configBox.max.y + 2, y));
  configFloorY = y;
  _floorSlab.position.y = y - 0.2;
  _floorSlab.updateMatrixWorld(true);
  _updateConfigFloorGrid();
  _updateFloorHandle();
  _updateFloorValDisplay();
  if (_spawnGroup) _updateSpawnSphere(); // keep disc on floor
  physics.rebuildCollision();
}

function adjustFloor(delta) { setFloor(configFloorY + delta); }

// Configure-screen floor buttons (hold-to-repeat)
let _floorHoldTimer = null;
const _startFloorHold = (d) => { adjustFloor(d); _floorHoldTimer = setInterval(() => adjustFloor(d), 80); };
const _stopFloorHold  = () => { clearInterval(_floorHoldTimer); _floorHoldTimer = null; };

document.getElementById('floor-dn')?.addEventListener('mousedown', () => _startFloorHold(-FLOOR_STEP));
document.getElementById('floor-up')?.addEventListener('mousedown', () => _startFloorHold(+FLOOR_STEP));
document.addEventListener('mouseup', _stopFloorHold);

// Numeric input direct edit
document.getElementById('floor-val')?.addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (!isNaN(v)) setFloor(v);
});

// Mouse drag on the handle
let _isDraggingFloor = false;
renderer.domElement.addEventListener('mousedown', (e) => {
  if (phase !== 'orbit' || !configFloorHandle) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width)  * 2 - 1,
    -((e.clientY - rect.top)  / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(configFloorHandle, true);
  if (hits.length) { _isDraggingFloor = true; e.stopPropagation(); }
});
renderer.domElement.addEventListener('mousemove', (e) => {
  if (!_isDraggingFloor || !configBox) return;
  const cx = (configBox.min.x + configBox.max.x) / 2;
  const cz = (configBox.min.z + configBox.max.z) / 2;
  const dist = camera.position.distanceTo(new THREE.Vector3(cx, configFloorY, cz));
  const worldPerPx = Math.tan(camera.fov * 0.5 * Math.PI / 180) * 2 * dist / renderer.domElement.clientHeight;
  adjustFloor(-e.movementY * worldPerPx);
});
renderer.domElement.addEventListener('mouseup', () => { _isDraggingFloor = false; });

// FPS-phase floor buttons (for fine-tuning after entering walk mode)
let _fpsFlorTimer = null;
const _startFpsFloor = (d) => { _adjustFPSFloor(d); _fpsFlorTimer = setInterval(() => _adjustFPSFloor(d), 80); };
const _stopFpsFloor  = () => { clearInterval(_fpsFlorTimer); _fpsFlorTimer = null; };
document.getElementById('fps-floor-dn')?.addEventListener('mousedown', () => _startFpsFloor(-FLOOR_STEP));
document.getElementById('fps-floor-up')?.addEventListener('mousedown', () => _startFpsFloor(+FLOOR_STEP));
document.addEventListener('mouseup', _stopFpsFloor);

function _adjustFPSFloor(delta) {
  configFloorY += delta;
  _floorSlab.position.y = configFloorY - 0.2;
  _floorSlab.updateMatrixWorld(true);
  _updateFloorValDisplay();
  physics.rebuildCollision();
}

function _fadeOut(el, cb) {
  if (!el) { cb?.(); return; }
  el.style.opacity = '0';
  setTimeout(() => { el.style.display = 'none'; cb?.(); }, 380);
}

// ─── Collision helpers ────────────────────────────────────────────────────────
function _bvhWorld(obj) {
  let n = 0;
  obj.traverse(node => {
    if (!node.isMesh) return;
    try { node.geometry.computeBoundsTree(); n++; } catch {}
  });
  return n;
}

function _buildBboxCage(bbox) {
  const mat = new THREE.MeshBasicMaterial({ visible: false });
  const cx  = (bbox.min.x + bbox.max.x) / 2;
  const cy  = (bbox.min.y + bbox.max.y) / 2;
  const cz  = (bbox.min.z + bbox.max.z) / 2;
  const w = Math.max(bbox.max.x - bbox.min.x, 1);
  const d = Math.max(bbox.max.z - bbox.min.z, 1);
  const h = Math.max(bbox.max.y - bbox.min.y, 1);
  const t = 0.5;
  const grp = new THREE.Group();
  const add = (gw, gh, gd, px, py, pz) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(gw, gh, gd), mat);
    m.position.set(px, py, pz); grp.add(m);
  };
  add(w+20, 2,   d+20, cx, bbox.min.y-1,  cz);
  add(w+2,  h+4, t,    cx, cy, bbox.min.z-t);
  add(w+2,  h+4, t,    cx, cy, bbox.max.z+t);
  add(t,    h+4, d+2,  bbox.min.x-t, cy, cz);
  add(t,    h+4, d+2,  bbox.max.x+t, cy, cz);
  return grp;
}

function _activateCollision(collider, worldBbox = null) {
  if (worldBbox) {
    _floorSlab.position.y = worldBbox.min.y - 3;
    _floorSlab.updateMatrixWorld(true);
  }
  const objs = [_floorSlab];
  if (collider) { collider.updateMatrixWorld(true); objs.push(collider); }
  physics.clearCollisionMeshes(objs);
}

// ─── Collision generation — WebGPU client path + server fallbacks ─────────────
// Tries WebGPU (fast, client-side) → server URL path → server upload path.
// `session` prevents stale callbacks from a previous load replacing the current.
async function _generateCollisionBackground(plyUrlOrBuffer, isBuffer, box, flipY, session) {
  const center  = box.getCenter(new THREE.Vector3());
  const size    = box.getSize(new THREE.Vector3());
  const maxDim  = Math.max(size.x, size.y, size.z);

  // ── WebGPU client path ──────────────────────────────────────────────────────
  if (isWebGPUAvailable()) {
    try {
      const seed = flipY
        ? [center.x, -(box.min.y + 1.0), -center.z]
        : [center.x,  box.min.y + 1.0,   center.z];

      // ~100 voxels across longest axis, 0.3–1.5 m range; auto-doubles if grid
      // exceeds MAX_VOXELS (8 M) inside generateCollision.
      const voxelSize = Math.max(0.3, Math.min(1.5, maxDim / 100));

      const result = await generateCollision({
        plyUrl:           isBuffer ? null : plyUrlOrBuffer,
        plyBuffer:        isBuffer ? plyUrlOrBuffer : null,
        seedPos:          seed,
        voxelSize,
        opacityThreshold: 0.3,
        onLog:            msg => { if (_loadSession === session) setFloorStatus(`⚙ ${msg.slice(0, 55)}`); },
      });

      if (_loadSession !== session) return;

      const { positions, indices, plyFloorY } = result;

      // Auto-apply histogram floor to configure panel
      if (plyFloorY != null && phase === 'orbit') {
        const worldFloorY = flipY ? -plyFloorY : plyFloorY;
        setFloor(worldFloorY);
        setFloorStatus('✓ Floor auto-detected — adjust if needed');
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
      geo.computeVertexNormals();

      // Sink 0.3 m so floor-facing voxel surfaces sit under the physics slab
      const posAttr = geo.getAttribute('position');
      const ySink = flipY ? +0.3 : -0.3;
      for (let i = 0; i < posAttr.count; i++) posAttr.setY(i, posAttr.getY(i) + ySink);

      const voxelMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
      }));
      if (flipY) voxelMesh.quaternion.set(1, 0, 0, 0);

      if (_loadSession !== session) return;
      if (_voxelGlbScene) scene.remove(_voxelGlbScene);
      if (_splatCage) { scene.remove(_splatCage); _splatCage = null; }
      _voxelGlbScene = voxelMesh;
      scene.add(voxelMesh);
      _bvhWorld(voxelMesh);
      setTimeout(() => {
        voxelMesh.updateMatrixWorld(true);
        _activateCollision(voxelMesh, box);
        activeGame?.setVoxelMesh(voxelMesh);
        setFloorStatus('✓ Voxel collider ready');
      }, 50);
      return;
    } catch (err) {
      console.warn('[play] WebGPU voxelizer failed:', err.message ?? err);
      if (_loadSession === session) setFloorStatus('⚙ GPU unavailable, trying server…');
    }
  }

  // ── Server fallbacks ────────────────────────────────────────────────────────
  if (isBuffer) {
    await _serverUploadCollision(plyUrlOrBuffer, box, flipY, session);
  } else if (plyUrlOrBuffer && !plyUrlOrBuffer.startsWith('blob:')) {
    await _serverUrlCollision(plyUrlOrBuffer, box, flipY, session);
  } else {
    setFloorStatus('⚠ No server path for this file — WebGPU required');
  }
}

// Server path A: PLY accessible by URL
async function _serverUrlCollision(plyUrl, box, flipY, session) {
  const center = box.getCenter(new THREE.Vector3());
  setFloorStatus('⚙ Generating collision (server)…');
  try {
    const res = await fetch('/api/gen-collision', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plyUrl,
        seedX: center.x, seedY: -(box.min.y + 1.0), seedZ: -center.z,
        voxelFloor: 0.1, voxelWall: 0.15, carveH: 1.6, carveR: 0.5, opacityThreshold: 0.2,
      }),
    });
    if (!res.body || _loadSession !== session) return;
    await _streamCollisionSSE(res, box, flipY, session);
  } catch { setFloorStatus('⚠ Server collision unavailable'); }
}

// Server path B: Upload raw PLY bytes
async function _serverUploadCollision(buffer, box, flipY, session) {
  const center = box.getCenter(new THREE.Vector3());
  const wf = configFloorY + 1.0;
  const seed = flipY
    ? `${center.x.toFixed(2)},${(-wf).toFixed(2)},${(-center.z).toFixed(2)}`
    : `${center.x.toFixed(2)},${wf.toFixed(2)},${center.z.toFixed(2)}`;
  const params = new URLSearchParams({ seedPos: seed, voxelParams: '0.1,0.15', voxelCarve: '1.6,0.5', opacityThreshold: '0.2' });
  setFloorStatus('⬆ Uploading PLY…');
  try {
    const res = await fetch(`/api/process-splat?${params}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer,
    });
    if (!res.body || _loadSession !== session) return;
    await _streamCollisionSSE(res, box, flipY, session);
  } catch { setFloorStatus('⚠ Server upload failed'); }
}

// SSE stream → loads GLB when done
async function _streamCollisionSSE(res, box, flipY, session) {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'log')   { if (_loadSession === session) setFloorStatus(`⚙ ${ev.text.slice(0, 52)}`); }
        if (ev.type === 'error') { setFloorStatus(`⚠ ${ev.text.slice(0, 52)}`); return; }
        if (ev.type === 'done') {
          setFloorStatus('↓ Loading collider…');
          const glbUrl = ev.url || `/api/collision-mesh/${ev.jobId}`;
          gltfLoader.load(glbUrl, (gltf) => {
            if (_loadSession !== session) return;
            if (flipY) gltf.scene.quaternion.set(1, 0, 0, 0);
            gltf.scene.traverse(n => {
              if (n.isMesh) n.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
            });
            if (_voxelGlbScene) scene.remove(_voxelGlbScene);
            if (_splatCage) { scene.remove(_splatCage); _splatCage = null; }
            _voxelGlbScene = gltf.scene;
            scene.add(gltf.scene);
            _bvhWorld(gltf.scene);
            setTimeout(() => {
              gltf.scene.updateMatrixWorld(true);
              _activateCollision(gltf.scene, box);
              activeGame?.setVoxelMesh(gltf.scene);
              setFloorStatus('✓ Collider ready — walls active');
            }, 50);
          }, undefined, () => setFloorStatus('⚠ Failed to load collider'));
        }
      } catch {}
    }
  }
}

// Kept only for backward compatibility — new code uses _generateCollisionBackground
async function _genVoxelMesh(plyUrl, box, flipY) {
  if (!plyUrl || plyUrl.startsWith('blob:')) return; // blob URLs need upload path

  const center = box.getCenter(new THREE.Vector3());
  const worldFloorY = box.min.y + 1.0;

  // Honour user-set seed if provided
  const seedVal = seedPosInput?.value?.trim();
  let seedX, seedY, seedZ;
  if (seedVal && seedVal !== 'auto') {
    const parts = seedVal.split(',').map(Number);
    [seedX, seedY, seedZ] = parts;
  } else {
    seedX = center.x;
    seedY = flipY ? -worldFloorY : worldFloorY;
    seedZ = flipY ? -center.z : center.z;
  }

  const voxelParams     = voxelParamsInput?.value?.trim()   || '0.1,0.15';
  const voxelCarve      = voxelCarveInput?.value?.trim()    || '1.6,0.5';
  const opacityThreshold= opacityInput?.value?.trim()       || '0.2';

  setFloorStatus('⚙ Generating collider…');

  try {
    const res = await fetch('/api/gen-collision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plyUrl, seedX, seedY, seedZ,
        voxelFloor: parseFloat(voxelParams.split(',')[0]) || 0.1,
        voxelWall:  parseFloat(voxelParams.split(',')[1]) || 0.15,
        carveH: parseFloat(voxelCarve.split(',')[0])      || 1.6,
        carveR: parseFloat(voxelCarve.split(',')[1])      || 0.5,
        opacityThreshold: parseFloat(opacityThreshold)    || 0.2,
      }),
    });
    if (!res.body) { setFloorStatus('⚠ Server unavailable'); return; }

    const reader = res.body.getReader();
    const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'log')   setFloorStatus(`⚙ ${ev.text.slice(0, 52)}`);
          if (ev.type === 'error') setFloorStatus(`⚠ ${ev.text.slice(0, 52)}`);
          if (ev.type === 'done') {
            setFloorStatus('↓ Loading collider…');
            gltfLoader.load(ev.url, (gltf) => {
              gltf.scene.quaternion.set(1, 0, 0, 0);
              // colorWrite:false keeps the mesh invisible to the camera but
              // visible=true (default) so Three.js raycaster can still hit it.
              // DoubleSide so face orientation after flipY never blocks a raycast.
              gltf.scene.traverse(n => {
                if (n.isMesh) {
                  n.material = new THREE.MeshBasicMaterial({
                    colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
                  });
                }
              });
              if (_voxelGlbScene) scene.remove(_voxelGlbScene);
              _voxelGlbScene = gltf.scene;
              scene.add(gltf.scene);
              _bvhWorld(gltf.scene);
              setTimeout(() => {
                gltf.scene.updateMatrixWorld(true);
                if (_splatCage) { scene.remove(_splatCage); _splatCage = null; }
                _activateCollision(gltf.scene, box);
                setFloorStatus('✓ Collider ready — walls active');
                // Pass to live tank game if already playing
                activeGame?.setVoxelMesh(gltf.scene);
              }, 50);
            }, undefined, () => setFloorStatus('⚠ Failed to load collider GLB'));
          }
        } catch {}
      }
    }
  } catch (e) {
    setFloorStatus(`⚠ ${e.message.slice(0, 52)}`);
  }
}

// ─── Voxel mesh via file upload (blob: URLs / user-uploaded PLY) ─────────────
// Streams the raw PLY bytes to /api/process-splat, which runs splat-transform
// (or the Node.js fallback) server-side and returns a .collision.glb.
async function _uploadAndGenCollision(file, box, flipY) {
  const center = box.getCenter(new THREE.Vector3());

  const seedVal = seedPosInput?.value?.trim();
  let seedPos;
  if (seedVal && seedVal !== 'auto') {
    seedPos = seedVal;
  } else {
    const wf = _floorOffset + 1.0;
    seedPos = flipY
      ? `${center.x.toFixed(2)},${(-wf).toFixed(2)},${(-center.z).toFixed(2)}`
      : `${center.x.toFixed(2)},${wf.toFixed(2)},${center.z.toFixed(2)}`;
  }

  const voxelParams      = voxelParamsInput?.value?.trim()  || '0.1,0.15';
  const voxelCarve       = voxelCarveInput?.value?.trim()   || '1.6,0.5';
  const opacityThreshold = opacityInput?.value?.trim()      || '0.2';

  setFloorStatus('⬆ Uploading PLY…');

  try {
    const params = new URLSearchParams({ seedPos, voxelParams, voxelCarve, opacityThreshold });
    const res = await fetch(`/api/process-splat?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (!res.body) { setFloorStatus('⚠ Server unavailable'); return; }

    const reader = res.body.getReader();
    const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'log')   setFloorStatus(`⚙ ${ev.text.slice(0, 52)}`);
          if (ev.type === 'error') { setFloorStatus(`⚠ ${ev.text.slice(0, 52)}`); return; }
          if (ev.type === 'done') {
            setFloorStatus('↓ Loading collider…');
            const glbUrl = ev.url || `/api/collision-mesh/${ev.jobId}`;
            gltfLoader.load(glbUrl, (gltf) => {
              if (flipY) gltf.scene.quaternion.set(1, 0, 0, 0);
              gltf.scene.traverse(n => {
                if (n.isMesh) {
                  n.material = new THREE.MeshBasicMaterial({
                    colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
                  });
                }
              });
              if (_voxelGlbScene) scene.remove(_voxelGlbScene);
              _voxelGlbScene = gltf.scene;
              scene.add(gltf.scene);
              _bvhWorld(gltf.scene);
              setTimeout(() => {
                gltf.scene.updateMatrixWorld(true);
                if (_splatCage) { scene.remove(_splatCage); _splatCage = null; }
                _activateCollision(gltf.scene, box);
                activeGame?.setVoxelMesh(gltf.scene);
                setFloorStatus('✓ Collider ready — walls active');
              }, 50);
            }, undefined, () => setFloorStatus('⚠ Failed to load collider GLB'));
          }
        } catch {}
      }
    }
  } catch (e) {
    setFloorStatus(`⚠ ${e.message.slice(0, 52)}`);
  }
}

// ─── Splat loading ────────────────────────────────────────────────────────────
function loadSplat(url, name, file = null) {
  if (activeSplatMesh) { scene.remove(activeSplatMesh); try { activeSplatMesh.dispose(); } catch {} activeSplatMesh = null; }
  if (_splatCage)      { scene.remove(_splatCage); _splatCage = null; }
  if (_voxelGlbScene)  { scene.remove(_voxelGlbScene); _voxelGlbScene = null; }
  activeGame?.dispose(); activeGame = null;
  _pendingSplatFile = file;
  _disposeFloorVisuals();
  _showPresetBar(false);
  const session = ++_loadSession;

  currentSplatMeta = {
    name:   (name || 'splat').replace(/\.(ply|sog)$/i, ''),
    url:    file ? null : url,   // null for local file uploads (blob: URLs don't persist)
    isFile: !!file,
  };

  phase = 'loading';
  setSplashStatus(`Loading ${name}…`);
  if (loadingBar) loadingBar.style.display = 'block';

  const splatMesh = new SplatMesh({
    url,
    editable: false,
    onLoad: async (mesh) => {
      try {
        const box = mesh.getBoundingBox?.();
        if (!box || box.isEmpty()) { setSplashStatus('Loaded (no bounds found)'); return; }
        _splatBox  = box;
        configBox  = box;

        // Initial floor estimate: 15% up from bbox bottom (matches standalone)
        const ySpan = box.max.y - box.min.y;
        configFloorY = box.min.y + ySpan * 0.15;

        // Bbox cage for immediate FPS walk collision
        _splatCage = _buildBboxCage(box);
        scene.add(_splatCage);
        _bvhWorld(_splatCage);
        setTimeout(() => {
          _splatCage?.updateMatrixWorld(true);
          _activateCollision(_splatCage, box);
        }, 50);

        // Frame orbit camera
        const center = box.getCenter(new THREE.Vector3());
        const size   = box.getSize(new THREE.Vector3());
        const d = Math.max(size.x, size.y, size.z) * 1.4;
        camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.6, 1).normalize(), d);
        controls.target.copy(center);
        controls.update();

        // Read PLY buffer early so it's available in the _presetOverride path too
        const isSog = name?.toLowerCase().endsWith('.sog');
        let plyBuffer = null;
        if (!isSog && file) {
          setFloorStatus('⚙ Reading PLY…');
          plyBuffer = await file.arrayBuffer();
        }
        const plyUrlOrBuffer = plyBuffer ?? url;
        const isBuffer = plyBuffer !== null;

        // Enter configure/orbit phase — shows floor grid + handle + spawn disc
        _fadeOut(splashEl, () => {
          // ── PRESET OVERRIDE: skip floor setup, launch game directly ────────
          if (_presetOverride) {
            const po = _presetOverride;
            _presetOverride = null;
            configFloorY     = po.floorY;
            configSpawnX     = po.spawnX;
            configSpawnZ     = po.spawnZ;
            configSpawnRadius = po.spawnRadius ?? configSpawnRadius;
            if (po.gameMode) selectedMode = po.gameMode;
            // Rebuild floor physics at preset height
            _floorSlab.position.y = configFloorY - 0.2;
            _floorSlab.updateMatrixWorld(true);
            physics.rebuildCollision();
            _launchGameFromPreset();
            return;
          }

          // ── NORMAL: show floor setup ───────────────────────────────────────
          phase = 'orbit';
          floorSetupEl.style.display = 'flex';
          controls.enabled = true;

          configSpawnX = center.x;
          configSpawnZ = center.z;
          const splatW = box.max.x - box.min.x;
          const splatD = box.max.z - box.min.z;
          configSpawnRadius = Math.max(2, Math.min(splatW, splatD) * 0.4);

          const xEl = document.getElementById('spawn-x-slider');
          if (xEl) { xEl.min = box.min.x.toFixed(1); xEl.max = box.max.x.toFixed(1); xEl.step = '0.1'; }
          const zEl = document.getElementById('spawn-z-slider');
          if (zEl) { zEl.min = box.min.z.toFixed(1); zEl.max = box.max.z.toFixed(1); zEl.step = '0.1'; }

          setFloor(configFloorY);
          _updateFloorValDisplay();
          _updateSpawnSphere();
        });

        // Start collision generation in background (runs regardless of preset override)
        if (isSog) {
          setFloorStatus('SOG loaded — using bbox boundary (no voxel collision)');
        } else {
          _generateCollisionBackground(plyUrlOrBuffer, isBuffer, box, true, session)
            .catch(err => { if (_loadSession === session) setFloorStatus(`⚠ ${err.message?.slice(0, 52)}`); });
        }
      } catch (e) {
        console.warn('[play] onLoad error:', e);
        setSplashStatus('Error: ' + e.message.slice(0, 60));
      }
    },
  });
  splatMesh.quaternion.set(1, 0, 0, 0);
  activeSplatMesh = splatMesh;
  scene.add(splatMesh);
}

// ─── Walk button: orbit → FPS ─────────────────────────────────────────────────
walkBtn?.addEventListener('click', () => {
  if (phase !== 'orbit' || !_splatBox) return;
  _fadeOut(floorSetupEl, () => _enterFPS(_splatBox));
});

// ─── FPS mode ─────────────────────────────────────────────────────────────────
const FPS_FLY_SPEED  = 16;
const FPS_WALK_SPEED = 5;
const FPS_RUN_SPEED  = 10;
const FPS_JUMP_FORCE = 8;
const fpsKeys = {};
const _fpsEuler = new THREE.Euler(0, 0, 0, 'YXZ');
let fpsMode = false;
let flyMode = false;

function _enterFPS(box) {
  phase = 'explore';
  fpsMode = true;
  flyMode = true;
  controls.enabled = false;

  // Floor visuals no longer needed inside FPS
  _disposeFloorVisuals();

  confirmBtn.style.display     = 'block';
  statusBar.style.display      = 'block';
  statusBar.textContent        = 'Walk to arena centre · Enter or Confirm to play';
  fpsHint.style.display        = 'flex';
  crosshair.style.display      = 'block';
  if (fpsFloorWidget) fpsFloorWidget.style.display = 'flex';
  _updateFloorValDisplay();

  const center = box.getCenter(new THREE.Vector3());
  const eyeY   = configFloorY + 1.7;
  camera.fov = 75;
  camera.updateProjectionMatrix();
  camera.rotation.order = 'YXZ';
  camera.rotation.set(0, 0, 0);
  camera.position.set(center.x, eyeY, center.z);
  physics.setPlayerPosition(center.x, eyeY, center.z);

  vp.requestPointerLock();
}

function _exitFPS() {
  fpsMode = false;
  flyMode = false;
  if (document.pointerLockElement) document.exitPointerLock();
  crosshair.style.display      = 'none';
  fpsHint.style.display        = 'none';
  statusBar.style.display      = 'none';
  confirmBtn.style.display     = 'none';
  if (fpsFloorWidget) fpsFloorWidget.style.display = 'none';
}

document.addEventListener('mousemove', (e) => {
  if (!fpsMode || document.pointerLockElement !== vp) return;
  camera.rotation.y -= e.movementX / 500;
  camera.rotation.x -= e.movementY / 500;
  camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.rotation.x));
});

vp.addEventListener('click', () => {
  if (fpsMode && document.pointerLockElement !== vp) vp.requestPointerLock();
});

document.addEventListener('keydown', (e) => {
  fpsKeys[e.code] = true;
  if (e.code === 'KeyF' && fpsMode) {
    flyMode = !flyMode;
    if (!flyMode) physics.setPlayerPosition(camera.position.x, camera.position.y, camera.position.z);
  }
  if ((e.code === 'Enter' || e.code === 'NumpadEnter') && phase === 'explore') {
    e.preventDefault(); _confirm();
  }
});
document.addEventListener('keyup', (e) => { fpsKeys[e.code] = false; });

function updateFPS(dt) {
  const shift = fpsKeys['ShiftLeft'] || fpsKeys['ShiftRight'];
  if (flyMode) {
    const fwd = new THREE.Vector3(); const right = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    right.crossVectors(fwd, camera.up).normalize();
    const move = new THREE.Vector3();
    if (fpsKeys['KeyW']) move.addScaledVector(fwd,   1);
    if (fpsKeys['KeyS']) move.addScaledVector(fwd,  -1);
    if (fpsKeys['KeyD']) move.addScaledVector(right,  1);
    if (fpsKeys['KeyA']) move.addScaledVector(right, -1);
    if (fpsKeys['Space'])                    move.y += 1;
    if (fpsKeys['KeyC'] || fpsKeys['ControlLeft']) move.y -= 1;
    if (move.lengthSq() > 0) move.normalize();
    camera.position.addScaledVector(move, FPS_FLY_SPEED * dt);
    physics.setPlayerPosition(camera.position.x, camera.position.y, camera.position.z);
  } else {
    const speed = shift ? FPS_RUN_SPEED : FPS_WALK_SPEED;
    _fpsEuler.set(0, camera.rotation.y, 0);
    const mx = (fpsKeys['KeyD'] ? 1 : 0) - (fpsKeys['KeyA'] ? 1 : 0);
    const mz = (fpsKeys['KeyS'] ? 1 : 0) - (fpsKeys['KeyW'] ? 1 : 0);
    physics.inputVelocity.set(mx, 0, mz);
    if (physics.inputVelocity.lengthSq() > 0)
      physics.inputVelocity.normalize().applyEuler(_fpsEuler).multiplyScalar(speed);
    if (physics.getPlayerOnFloor() && fpsKeys['Space'])
      physics.playerVelocity.y = FPS_JUMP_FORCE;
    physics.updatePlayer(dt, camera, false);
  }
}

// ─── Confirm → start tank game ────────────────────────────────────────────────
// Direct game launch used by preset loader — skips FPS explore phase for
// non-FPS modes, positions player at saved spawn for FPS mode.
function _launchGameFromPreset() {
  const spawnCenter = new THREE.Vector3(configSpawnX, configFloorY, configSpawnZ);
  phase = 'playing';

  if (selectedMode === 'fps') {
    // FPS: enter walk mode at saved position, let user click to lock pointer
    _enterFPS(_splatBox);
    phase = 'explore'; // keep as explore so confirm is available
    statusBar.textContent = 'Preset loaded · Enter or Confirm to activate FPS game';
  } else if (selectedMode === 'flight') {
    activeGame = createFlightGame({ scene, camera, controls, box: _splatBox, floorY: configFloorY });
  } else if (selectedMode === 'people') {
    activeGame = createPeopleGame({
      scene, camera, controls, box: _splatBox, floorY: configFloorY,
      voxelMesh: _voxelGlbScene,
      spawnCenter, spawnRadius: configSpawnRadius,
    });
  } else {
    activeGame = createTankGame({
      scene, camera, controls, box: _splatBox, center: spawnCenter, voxelMesh: _voxelGlbScene,
    });
  }
  _showPresetBar(true);
  _renderPresetBar();
}

function _confirm() {
  if (phase !== 'explore' || !_splatBox) return;
  phase = 'playing';
  // Use player's current XZ but the configured floor Y as the arena floor
  const center = new THREE.Vector3(camera.position.x, configFloorY, camera.position.z);
  _exitFPS();
  activeGame?.dispose();

  _showPresetBar(true);
  _renderPresetBar();

  if (selectedMode === 'fps') {
    // Stay in FPS mode — just add ball shooter on top
    phase = 'playing';
    confirmBtn.style.display = 'none';
    if (fpsFloorWidget) fpsFloorWidget.style.display = 'none';
    statusBar.textContent = 'Click shoot · B clear balls · F fly/walk';
    activeGame = createFPSGame({
      scene, camera,
      voxelMesh: _voxelGlbScene,
      splatCage: _splatCage,
      floorSlab: _floorSlab,
    });
    return; // don't call _exitFPS()

  } else if (selectedMode === 'flight') {
    activeGame = createFlightGame({
      scene, camera, controls,
      box: _splatBox, floorY: configFloorY,
    });

  } else if (selectedMode === 'people') {
    activeGame = createPeopleGame({
      scene, camera, controls,
      box:          _splatBox,
      floorY:       configFloorY,
      voxelMesh:    _voxelGlbScene,
      spawnCenter:  new THREE.Vector3(configSpawnX, configFloorY, configSpawnZ),
      spawnRadius:  configSpawnRadius,
    });

  } else {
    // Tank Battle (default)
    activeGame = createTankGame({
      scene, camera, controls,
      box: _splatBox, center, voxelMesh: _voxelGlbScene,
    });
  }
}

confirmBtn?.addEventListener('click', _confirm);

// ─── Upload ───────────────────────────────────────────────────────────────────
document.getElementById('ply-upload')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  loadSplat(URL.createObjectURL(file), file.name, file);
  e.target.value = '';
});

splashEl?.addEventListener('dragover', (e) => e.preventDefault());
splashEl?.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files ?? [])].find(f => f.name.endsWith('.ply') || f.name.endsWith('.sog'));
  if (file) loadSplat(URL.createObjectURL(file), file.name, file);
});

// ─── Animate ──────────────────────────────────────────────────────────────────
const clock = new Timer();
function animate() {
  requestAnimationFrame(animate);
  clock.update();
  const dt = Math.min(clock.getDelta(), 0.05);

  // FPS physics always runs when pointer-locked (explore phase or FPS game mode)
  if (fpsMode) updateFPS(dt);
  // Game logic (tank/flight/fps-balls/people placeholder)
  if (activeGame)        activeGame.update(dt);
  else if (!fpsMode)     controls.update();

  renderer.render(scene, camera);
}
animate();
