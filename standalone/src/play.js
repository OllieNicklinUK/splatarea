// ─────────────────────────────────────────────────────────────────────────────
// play.js — Gaussian Splat FPS Launcher
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { Timer } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { createPhysics } from './fps/physics.js';
import { createBallShooter } from './fps/balls.js';
import { generateCollision, isWebGPUAvailable } from './collision/client-collider.js';

// ─── PRESET PERSISTENCE ───────────────────────────────────────────────────────
// Settings (floor Y, spawn XZ, URL, name) live in localStorage.
// File buffers (for local .ply uploads) live in IndexedDB — too large for LS.

const _PRESET_LS  = i => `gm_preset_${i}`;   // localStorage key
const _PRESET_IDB = i => `gm_file_${i}`;      // IndexedDB key
const NUM_PRESETS = 3;

// Current splat's metadata — set in launchSplat, read by _saveToPreset.
let currentSplatMeta = null; // { name, url, isFile, plyBuffer, flipY }

// When non-null, _enterConfigure skips the UI and jumps straight to FPS using
// these stored values. Set immediately before launchSplat when loading a preset.
let _presetOverride = null;  // { floorY, spawnX, spawnZ }

// ── IndexedDB helpers ──────────────────────────────────────────────────────────
function _idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('gaussianMode', 1);
    r.onupgradeneeded = e => e.target.result.createObjectStore('files');
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}
async function _idbPut(key, val) {
  const db = await _idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(val, key);
    tx.oncomplete = () => { db.close(); res(); };
    tx.onerror    = e => { db.close(); rej(e.target.error); };
  });
}
async function _idbGet(key) {
  const db = await _idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', 'readonly');
    const r = tx.objectStore('files').get(key);
    r.onsuccess = e => { db.close(); res(e.target.result ?? null); };
    r.onerror   = e => { db.close(); rej(e.target.error); };
  });
}
async function _idbDel(key) {
  const db = await _idbOpen();
  return new Promise(res => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(key);
    tx.oncomplete = () => { db.close(); res(); };
  });
}

// ── Read / write / clear preset slots ─────────────────────────────────────────
function _getPreset(i) {
  try { return JSON.parse(localStorage.getItem(_PRESET_LS(i))); } catch { return null; }
}

async function _saveToPreset(slotIndex) {
  if (!currentSplatMeta) return;
  const data = {
    name:    currentSplatMeta.name,
    url:     currentSplatMeta.isFile ? null : currentSplatMeta.url,
    isFile:  currentSplatMeta.isFile,
    flipY:   currentSplatMeta.flipY,
    floorY:  configFloorY,
    // Save current camera XZ as the next spawn point so the user starts exactly
    // where they were standing when they pressed the save button.
    spawnX:  appState === 'playing' ? camera.position.x : configSpawnPos.x,
    spawnZ:  appState === 'playing' ? camera.position.z : configSpawnPos.z,
    savedAt: Date.now(),
  };
  localStorage.setItem(_PRESET_LS(slotIndex), JSON.stringify(data));
  if (currentSplatMeta.isFile && currentSplatMeta.plyBuffer) {
    const mb = currentSplatMeta.plyBuffer.byteLength / 1e6;
    if (mb > 300) {
      const ok = confirm(
        `This file is ${mb.toFixed(0)} MB. Storing it in your browser may take a moment and use significant disk space. Continue?`
      );
      if (!ok) return;
    }
    await _idbPut(_PRESET_IDB(slotIndex), currentSplatMeta.plyBuffer);
  }
  _renderPresets();
  _updatePresetButtons();
  const btn = document.getElementById(`fps-preset-btn-${slotIndex}`);
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = '✓ Saved';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1500);
  }
}

async function _launchPreset(slotIndex) {
  const data = _getPreset(slotIndex);
  if (!data) return;
  _presetOverride = { floorY: data.floorY, spawnX: data.spawnX, spawnZ: data.spawnZ };
  if (data.isFile) {
    const buffer = await _idbGet(_PRESET_IDB(slotIndex));
    if (!buffer) {
      alert(`Preset ${slotIndex + 1}: stored file missing — please re-upload the .ply file.`);
      _presetOverride = null;
      return;
    }
    if (activeObjectUrl) { URL.revokeObjectURL(activeObjectUrl); activeObjectUrl = null; }
    activeObjectUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));
    // Mock File interface so launchSplat can call .arrayBuffer() on it
    launchSplat(activeObjectUrl, data.name, data.flipY ?? true, { arrayBuffer: () => Promise.resolve(buffer) });
  } else {
    launchSplat(data.url, data.name, data.flipY ?? true);
  }
}

function _clearPreset(slotIndex) {
  localStorage.removeItem(_PRESET_LS(slotIndex));
  _idbDel(_PRESET_IDB(slotIndex)).catch(() => {});
  _renderPresets();
  _updatePresetButtons();
}

// Update HUD save-button labels to reflect which slots already have data.
function _updatePresetButtons() {
  for (let i = 0; i < NUM_PRESETS; i++) {
    const btn = document.getElementById(`fps-preset-btn-${i}`);
    if (!btn) continue;
    const saved = _getPreset(i);
    btn.textContent = saved ? `● ${i + 1}` : `⊕ ${i + 1}`;
    btn.title = saved
      ? `Overwrite Preset ${i + 1} (${saved.name})`
      : `Save current scene to Preset ${i + 1}`;
    btn.classList.toggle('has-preset', !!saved);
  }
}

// ─── BVH patches ──────────────────────────────────────────────────────────────
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ─── Three.js Scene ───────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080810);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.rotation.order = 'YXZ';
camera.position.set(0, 1.7, 5);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(5, 10, 5);
scene.add(dirLight);

// ─── Physics ──────────────────────────────────────────────────────────────────
const physics = createPhysics();

const floorSlab = new THREE.Mesh(
  new THREE.BoxGeometry(2000, 2, 2000),
  new THREE.MeshBasicMaterial({ visible: false })
);
floorSlab.position.set(0, -1, 0);
scene.add(floorSlab);
physics.addCollisionMesh(floorSlab);

// ─── Loaders ──────────────────────────────────────────────────────────────────
const gltfLoader = new GLTFLoader();

// ─── App State ────────────────────────────────────────────────────────────────
// 'launcher' | 'loading' | 'configure' | 'playing'
let appState = 'launcher';
let activeSplatMesh = null;
let splatCage = null;
let voxelMesh = null;
let sceneFloorSlab = null;
let sceneFloorVisual = null;
let activeObjectUrl = null;

// Session counter: incremented on every new launchSplat or returnToLauncher.
// Async callbacks (collision generation, onLoad) compare against this value
// before applying their result — stale completions are silently discarded.
let _loadSession = 0;

// ─── Configure / FPS Floor State ─────────────────────────────────────────────
let currentFloorCx = 0; // XZ centre of the active floor slab — stored on enterFPS
let currentFloorCz = 0; // so FPS floor adjustment can reposition it correctly
let orbitControls = null;
let configFloorY = 0;
let configBox = null;
const configSpawnPos = new THREE.Vector3();
let configFloorGrid = null;    // GridHelper group shown at floor level
let configFloorHandle = null;  // 3D up/down arrows (drag to move floor)
let configSpawnMarker = null;
let configSpawnSet = false;

// Floor handle drag state
let isDraggingFloor = false;
let _isHoveringHandle = false;

// ─── FPS Input ────────────────────────────────────────────────────────────────
const fpsKeys = {};
const fpsEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const FPS_WALK_SPEED = 4;
const FPS_RUN_SPEED  = 8;
const FPS_FLY_SPEED  = 10;
const FPS_JUMP_FORCE = 8;
let flyMode = false;

// ─── Ball Shooter ─────────────────────────────────────────────────────────────
const ballRaycaster = new THREE.Raycaster();
const ballRayDir    = new THREE.Vector3();

function _raycastCollision(origin, direction, maxDistance) {
  ballRaycaster.set(origin, ballRayDir.copy(direction).normalize());
  ballRaycaster.far = maxDistance;
  const hits = [];
  const castMesh = (c) => {
    if (!c.isMesh) return;
    const prev = c.material.side;
    c.material.side = THREE.DoubleSide;
    ballRaycaster.intersectObject(c, false, hits);
    c.material.side = prev;
  };
  if (voxelMesh)     voxelMesh.traverse(castMesh);
  if (splatCage)     splatCage.traverse(castMesh);
  if (sceneFloorSlab) castMesh(sceneFloorSlab);
  castMesh(floorSlab);
  if (!hits.length) return null;
  hits.sort((a, b) => a.distance - b.distance);
  const h = hits[0];
  const worldNormal = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize();
  if (worldNormal.dot(direction) > 0) worldNormal.negate();
  return { point: h.point, normal: worldNormal, distance: h.distance };
}

const ballShooter = createBallShooter(scene, _raycastCollision);

// ─── Collision Utilities ──────────────────────────────────────────────────────
function _buildBboxCage(bbox) {
  const mat = new THREE.MeshBasicMaterial({ visible: false });
  const cx  = (bbox.min.x + bbox.max.x) / 2;
  const cy  = (bbox.min.y + bbox.max.y) / 2;
  const cz  = (bbox.min.z + bbox.max.z) / 2;
  const w   = Math.max(bbox.max.x - bbox.min.x, 1);
  const d   = Math.max(bbox.max.z - bbox.min.z, 1);
  const h   = Math.max(bbox.max.y - bbox.min.y, 1);
  const t   = 0.5;
  const grp = new THREE.Group();
  const add = (gw, gh, gd, px, py, pz) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(gw, gh, gd), mat);
    m.position.set(px, py, pz);
    grp.add(m);
  };
  add(w + 20, 2,     d + 20, cx,             bbox.min.y - 1, cz            );
  add(w + 2,  h + 4, t,      cx,             cy,             bbox.min.z - t);
  add(w + 2,  h + 4, t,      cx,             cy,             bbox.max.z + t);
  add(t,      h + 4, d + 2,  bbox.min.x - t, cy,             cz            );
  add(t,      h + 4, d + 2,  bbox.max.x + t, cy,             cz            );
  return grp;
}

function _bvhWorld(obj) {
  obj.traverse(node => {
    if (!node.isMesh) return;
    try { node.geometry.computeBoundsTree(); } catch {}
  });
}

function _activateWorldCollision(collider, worldBbox = null) {
  if (worldBbox) {
    floorSlab.position.y = worldBbox.min.y - 3;
    floorSlab.updateMatrixWorld(true);
  }
  const objects = [floorSlab];
  if (sceneFloorSlab) objects.push(sceneFloorSlab);
  if (collider) {
    collider.updateMatrixWorld(true);
    objects.push(collider);
  }
  physics.clearCollisionMeshes(objects);
}

function _disposeGroup(grp) {
  if (!grp) return;
  scene.remove(grp);
  grp.traverse(n => { if (n.isMesh) { n.geometry?.dispose(); n.material?.dispose(); } });
}

function _disposeCollision() {
  _disposeGroup(splatCage); splatCage = null;
  _disposeGroup(voxelMesh); voxelMesh = null;
  _disposeSceneFloor();
}

function _disposeSceneFloor() {
  if (sceneFloorSlab) {
    scene.remove(sceneFloorSlab);
    sceneFloorSlab.geometry.dispose();
    sceneFloorSlab.material.dispose();
    sceneFloorSlab = null;
  }
  if (sceneFloorVisual) {
    scene.remove(sceneFloorVisual);
    sceneFloorVisual.traverse(n => {
      if (n.geometry) n.geometry.dispose();
      if (n.material) {
        if (Array.isArray(n.material)) n.material.forEach(m => m.dispose());
        else n.material.dispose();
      }
    });
    sceneFloorVisual = null;
  }
}

function _createSceneFloor(y, cx = 0, cz = 0) {
  _disposeSceneFloor();

  sceneFloorSlab = new THREE.Mesh(
    new THREE.BoxGeometry(1000, 0.4, 1000),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  sceneFloorSlab.position.set(cx, y - 0.2, cz);
  sceneFloorSlab.geometry.computeBoundsTree();
  scene.add(sceneFloorSlab);
  physics.addCollisionMesh(sceneFloorSlab);
  physics.rebuildCollision();
  // No visible floor mesh — the Gaussian splat provides its own visual floor.
  // The physics slab is invisible; height is adjusted via the FPS floor widget.
}

// ─── Configure: Floor Grid Visual ────────────────────────────────────────────
// Replaces the hard-to-see transparent plane with a dense, scene-sized grid.
// The grid lines cross through the splat, making the height immediately obvious.
function _updateConfigFloorGrid() {
  if (configFloorGrid) {
    scene.remove(configFloorGrid);
    configFloorGrid.traverse(n => { if (n.geometry) n.geometry.dispose(); if (n.material) n.material.dispose(); });
    configFloorGrid = null;
  }

  const cx = configBox ? (configBox.min.x + configBox.max.x) / 2 : 0;
  const cz = configBox ? (configBox.min.z + configBox.max.z) / 2 : 0;
  const sceneW = configBox ? (configBox.max.x - configBox.min.x) : 20;
  const sceneD = configBox ? (configBox.max.z - configBox.min.z) : 20;
  const gridSize = Math.max(sceneW, sceneD) * 2.0;
  const cellSize = Math.max(0.5, gridSize / 40); // ~40 cells across
  const divisions = Math.round(gridSize / cellSize);

  const grid = new THREE.GridHelper(gridSize, divisions, 0x4FD8F5, 0x4FD8F5);
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  grid.material.depthWrite = false;

  // Bright outer border ring so the floor level is visible from a distance
  const borderGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(gridSize * 0.98, 0.001, gridSize * 0.98));
  const borderMat = new THREE.LineBasicMaterial({ color: 0x4FD8F5, linewidth: 2 });
  const border = new THREE.LineSegments(borderGeo, borderMat);

  configFloorGrid = new THREE.Group();
  configFloorGrid.add(grid, border);
  configFloorGrid.position.set(cx, configFloorY, cz);
  scene.add(configFloorGrid);
}

// ─── Configure: Drag Handle (up/down arrows) ─────────────────────────────────
function _updateFloorHandle() {
  const cx = configBox ? (configBox.min.x + configBox.max.x) / 2 : 0;
  const cz = configBox ? (configBox.min.z + configBox.max.z) / 2 : 0;

  if (!configFloorHandle) {
    const mat = () => new THREE.MeshBasicMaterial({ color: 0x4FD8F5 });
    const ring  = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.05, 8, 32), mat());
    ring.rotation.x = Math.PI / 2;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 8), mat());
    const coneUp = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.28, 8), mat());
    coneUp.position.y = 0.59;
    const coneDn = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.28, 8), mat());
    coneDn.rotation.z = Math.PI;
    coneDn.position.y = -0.59;
    configFloorHandle = new THREE.Group();
    configFloorHandle.add(ring, shaft, coneUp, coneDn);
    scene.add(configFloorHandle);
  }
  configFloorHandle.position.set(cx, configFloorY, cz);
}

// ─── Configure: Spawn Marker (player silhouette) ──────────────────────────────
function _updateConfigSpawnMarker() {
  if (!configSpawnMarker) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x4FD8F5, transparent: true, opacity: 0.55 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.5, 8), mat.clone());
    body.position.y = 0.75;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), mat.clone());
    head.position.y = 1.61;
    configSpawnMarker = new THREE.Group();
    configSpawnMarker.add(body, head);
    scene.add(configSpawnMarker);
  }
  configSpawnMarker.position.set(configSpawnPos.x, configFloorY, configSpawnPos.z);
}

function _updateFloorValDisplay() {
  const el = document.getElementById('floor-val');
  if (!el || document.activeElement === el) return;
  el.value = configFloorY.toFixed(2);
}

function _updateSpawnStatusDisplay() {
  const el = document.getElementById('spawn-status');
  if (!el) return;
  if (configSpawnSet) {
    el.textContent = `(${configSpawnPos.x.toFixed(1)}, ${configSpawnPos.z.toFixed(1)})`;
    el.classList.add('spawn-set');
  } else {
    el.textContent = 'Click in scene to place';
    el.classList.remove('spawn-set');
  }
}

// ─── Configure: Enter / Exit ──────────────────────────────────────────────────
function _enterConfigure(box, plyUrlOrBuffer, isBuffer, flipY, session) {
  appState = 'configure';
  configBox = box;
  configSpawnSet = false;

  // ── Preset fast-path: skip the configure UI entirely ──────────────────────
  // When the user loads a saved preset the floor and spawn are already known.
  // Apply them and jump straight to FPS so the experience feels instant.
  if (_presetOverride) {
    configFloorY = _presetOverride.floorY;
    configSpawnPos.set(_presetOverride.spawnX, _presetOverride.floorY, _presetOverride.spawnZ);
    configSpawnSet = true;
    _presetOverride = null;
    _generateCollisionBackground(plyUrlOrBuffer, isBuffer, box, flipY, session).catch(console.warn);
    // One rAF delay lets the splat mesh finish attaching before enterFPS reads the scene
    requestAnimationFrame(() => { if (appState === 'configure') enterFPS(); });
    return;
  }

  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  // Start 15 % up from the world-space bbox bottom as an initial estimate.
  // box.min.y is pulled down by stray Gaussians below the scene floor, so the
  // raw minimum is almost always too low. The histogram auto-detection in
  // _generateCollisionBackground will update this once collision is ready.
  const ySpan  = box.max.y - box.min.y;
  configFloorY = box.min.y + ySpan * 0.15;
  configSpawnPos.set(center.x, configFloorY, center.z);

  if (orbitControls) { orbitControls.dispose(); orbitControls = null; }
  camera.position.set(center.x, center.y + size.y * 0.4, center.z + maxDim * 1.4);
  camera.lookAt(center);
  orbitControls = new OrbitControls(camera, canvas);
  orbitControls.target.copy(center);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.08;
  orbitControls.update();

  _updateConfigFloorGrid();
  _updateFloorHandle();
  _updateConfigSpawnMarker();
  _updateFloorValDisplay();
  _updateSpawnStatusDisplay();
  showConfigure();

  _generateCollisionBackground(plyUrlOrBuffer, isBuffer, box, flipY, session).catch(console.warn);
}

function _exitConfigure() {
  if (orbitControls) { orbitControls.dispose(); orbitControls = null; }

  if (configFloorGrid) {
    scene.remove(configFloorGrid);
    configFloorGrid.traverse(n => { if (n.geometry) n.geometry.dispose(); if (n.material) n.material.dispose(); });
    configFloorGrid = null;
  }
  if (configFloorHandle) {
    scene.remove(configFloorHandle);
    configFloorHandle.traverse(n => { if (n.isMesh) { n.geometry?.dispose(); n.material?.dispose(); } });
    configFloorHandle = null;
  }
  if (configSpawnMarker) {
    scene.remove(configSpawnMarker);
    configSpawnMarker.traverse(n => { if (n.isMesh) { n.geometry?.dispose(); n.material?.dispose(); } });
    configSpawnMarker = null;
  }

  isDraggingFloor = false;
  _isHoveringHandle = false;
  canvas.style.cursor = 'default';
  configBox = null;
  configSpawnSet = false;
}

// ─── Background Collision Generation ─────────────────────────────────────────
// session: stale completions from a previous launchSplat are discarded.
async function _generateCollisionBackground(plyUrlOrBuffer, isBuffer, box, flipY, session) {
  const setStatus = msg => {
    if (_loadSession !== session) return;
    const el = document.getElementById('collision-status');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
  };

  if (isWebGPUAvailable()) {
    try {
      const center = box.getCenter(new THREE.Vector3());

      // Seed: 1m above the visual floor in PLY space — matches library.js behaviour
      // and reliably places the flood-fill start in the navigable air rather than
      // at scene centre which can land inside solid geometry for tall scenes.
      const seed = flipY
        ? [center.x, -(box.min.y + 1.0), -center.z]
        : [center.x,  box.min.y + 1.0,   center.z];

      const bboxSize  = box.getSize(new THREE.Vector3());
      const maxDim    = Math.max(bboxSize.x, bboxSize.y, bboxSize.z);
      // ~100 voxels across the longest axis, capped at 1.5 m.
      // client-collider.js auto-doubles if the grid still exceeds MAX_VOXELS (8M).
      // This is ~3× more voxels than the old formula (maxDim/53) for large outdoor
      // scenes without the GPU stall that maxDim/200 caused.
      const voxelSize = Math.max(0.3, Math.min(1.5, maxDim / 100));

      const { positions, indices, plyFloorY, upDir } = await generateCollision({
        plyUrl:           isBuffer ? null : plyUrlOrBuffer,
        plyBuffer:        isBuffer ? plyUrlOrBuffer : null,
        seedPos:          seed,
        voxelSize,
        opacityThreshold: 0.3,
        onLog:            msg => setStatus(`⚙ ${msg.slice(0, 55)}`),
      });

      if (_loadSession !== session) return; // cancelled — a new splat loaded

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));

      // Sink the voxel mesh 0.3 m below world-space floor level so that
      // floor-facing voxel surfaces sit under the smooth physics slab.
      // Result: the player walks on the flat slab (no sticky edges) and the
      // voxels only provide horizontal wall collision above floor level.
      // With flipY=true, +Y in PLY space = −Y in world space (180° X rotation),
      // so adding +SINK to PLY Y positions moves the mesh DOWN in the world.
      const FLOOR_SINK = 0.3;
      const posAttr = geometry.getAttribute('position');
      const ySink = flipY ? +FLOOR_SINK : -FLOOR_SINK;
      for (let i = 0; i < posAttr.count; i++) posAttr.setY(i, posAttr.getY(i) + ySink);
      posAttr.needsUpdate = true;

      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ visible: false }));
      if (flipY) mesh.quaternion.set(1, 0, 0, 0);

      const colliderGroup = new THREE.Group();
      colliderGroup.add(mesh);
      _disposeGroup(splatCage); splatCage = null;
      voxelMesh = colliderGroup;
      scene.add(colliderGroup);
      _bvhWorld(colliderGroup);
      colliderGroup.updateMatrixWorld(true);
      _activateWorldCollision(colliderGroup, box);

      console.log('[Play] Voxel collision: ', (indices.length / 3).toLocaleString(), 'triangles');

      // Auto-apply the histogram-detected floor to the configure screen.
      // 180° X rotation (flipY) maps PLY_y → −world_y, so invert the sign.
      // upDir=-1 (Polycam) means the floor peak is at the top of PLY Y range →
      // a large positive plyFloorY → a negative worldFloorY, which is correct for
      // how Polycam scenes land in Three.js world space after the flip.
      if (appState === 'configure' && plyFloorY != null) {
        const worldFloorY = flipY ? -plyFloorY : plyFloorY;
        configFloorY = worldFloorY;
        _updateConfigFloorGrid();
        _updateFloorHandle();
        _updateConfigSpawnMarker();
        _updateFloorValDisplay();
        setStatus('✓ Floor auto-detected — adjust if needed');
      } else {
        setStatus('✓ Collision ready');
      }
      setTimeout(() => { const el = document.getElementById('collision-status'); if (el && _loadSession === session) el.style.display = 'none'; }, 3000);
      return;
    } catch (err) {
      if (_loadSession !== session) return;
      console.warn('[Play] GPU collision failed, trying server fallback:', err);
    }
  }

  if (_loadSession !== session) return;
  if (isBuffer) {
    await _serverUploadCollision(plyUrlOrBuffer, box, flipY, setStatus, session);
  } else {
    await _serverUrlCollision(plyUrlOrBuffer, box, flipY, setStatus, session);
  }
}

async function _serverUrlCollision(plyUrl, box, flipY, setStatus, session) {
  if (!plyUrl || plyUrl.startsWith('blob:')) return;
  const center = box.getCenter(new THREE.Vector3());
  try {
    setStatus('⚙ Generating collision…');
    const res = await fetch('/api/gen-collision', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        plyUrl,
        seedX: center.x, seedY: -(box.min.y + 1.0), seedZ: -center.z,
        voxelFloor: '0.1', voxelWall: '0.15', carveH: '1.6', carveR: '0.5',
        opacityThreshold: '0.2',
      }),
    });
    if (!res.body || _loadSession !== session) return;
    await _streamCollisionSSE(res, box, flipY, setStatus, session);
  } catch (err) {
    if (_loadSession !== session) return;
    console.warn('[Play] Server URL collision failed:', err);
    _hideStatusAfter(setStatus, '⚠ Collision unavailable', session);
  }
}

async function _serverUploadCollision(buffer, box, flipY, setStatus, session) {
  const center = box.getCenter(new THREE.Vector3());
  const seed = flipY
    ? `${center.x.toFixed(3)},${(-(box.min.y + 1.0)).toFixed(3)},${(-center.z).toFixed(3)}`
    : `${center.x.toFixed(3)},${(box.min.y + 1.0).toFixed(3)},${center.z.toFixed(3)}`;
  try {
    setStatus('⬆ Uploading PLY…');
    const params = new URLSearchParams({ seedPos: seed, voxelParams: '0.1,0.15', voxelCarve: '1.6,0.5', opacityThreshold: '0.2' });
    const res = await fetch(`/api/process-splat?${params}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body:    buffer,
    });
    if (!res.body || _loadSession !== session) return;
    await _streamCollisionSSE(res, box, flipY, setStatus, session);
  } catch (err) {
    if (_loadSession !== session) return;
    console.warn('[Play] Server upload collision failed:', err);
    _hideStatusAfter(setStatus, '⚠ Collision unavailable', session);
  }
}

function _hideStatusAfter(setStatus, msg, session) {
  setStatus(msg);
  setTimeout(() => { const el = document.getElementById('collision-status'); if (el && _loadSession === session) el.style.display = 'none'; }, 4000);
}

async function _streamCollisionSSE(res, box, flipY, setStatus, session) {
  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (_loadSession !== session) { reader.cancel(); return; }
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'log') {
          setStatus(`⚙ ${ev.text.slice(0, 55)}`);
        } else if (ev.type === 'done') {
          setStatus('↓ Loading collision mesh…');
          const glbUrl = ev.url || `/api/collision-mesh/${ev.jobId}`;
          gltfLoader.load(glbUrl, (gltf) => {
            if (_loadSession !== session) return;
            if (flipY) gltf.scene.quaternion.set(1, 0, 0, 0);
            gltf.scene.traverse(n => { if (n.isMesh) n.visible = false; });
            _disposeGroup(splatCage); splatCage = null;
            voxelMesh = gltf.scene;
            scene.add(gltf.scene);
            _bvhWorld(gltf.scene);
            setTimeout(() => {
              if (_loadSession !== session) return;
              gltf.scene.updateMatrixWorld(true);
              _activateWorldCollision(gltf.scene, box);
              setStatus(appState === 'configure' ? '✓ Click scene for accurate placement' : '✓ Collision ready');
              setTimeout(() => { const el = document.getElementById('collision-status'); if (el && _loadSession === session) el.style.display = 'none'; }, 3000);
            }, 50);
          }, undefined, (err) => _hideStatusAfter(setStatus, `⚠ ${err.message.slice(0, 50)}`, session));
        } else if (ev.type === 'error') {
          _hideStatusAfter(setStatus, `⚠ ${ev.text.slice(0, 55)}`, session);
        }
      } catch {}
    }
  }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function showLauncher() {
  document.getElementById('launcher').style.display   = 'flex';
  document.getElementById('loading').style.display    = 'none';
  document.getElementById('configure').style.display  = 'none';
  document.getElementById('hud').style.display        = 'none';
  const cs = document.getElementById('collision-status');
  if (cs) cs.style.display = 'none';
}

function showLoading(msg = 'Loading splat…') {
  document.getElementById('launcher').style.display  = 'none';
  document.getElementById('loading').style.display   = 'flex';
  document.getElementById('configure').style.display = 'none';
  document.getElementById('hud').style.display       = 'none';
  const el = document.getElementById('loading-msg');
  if (el) el.textContent = msg;
}

function showConfigure() {
  document.getElementById('launcher').style.display  = 'none';
  document.getElementById('loading').style.display   = 'none';
  document.getElementById('configure').style.display = 'flex';
  document.getElementById('hud').style.display       = 'none';
}

function showPlaying() {
  document.getElementById('launcher').style.display  = 'none';
  document.getElementById('loading').style.display   = 'none';
  document.getElementById('configure').style.display = 'none';
  document.getElementById('hud').style.display       = 'flex';
}

// ─── Core Launch Flow ─────────────────────────────────────────────────────────
async function launchSplat(url, name, flipY = true, fileObj = null) {
  if (appState === 'loading' || appState === 'configure') return;

  const session = ++_loadSession;
  appState = 'loading';
  showLoading(`Loading ${name || 'splat'}…`);

  // Track for preset saving
  currentSplatMeta = { name: name || 'Splat', url: fileObj ? null : url, isFile: !!fileObj, flipY, plyBuffer: null };

  if (activeSplatMesh) { scene.remove(activeSplatMesh); activeSplatMesh = null; }
  _disposeCollision();
  ballShooter.clear();

  floorSlab.position.y = -1;
  floorSlab.updateMatrixWorld(true);
  physics.clearCollisionMeshes([floorSlab]);

  try {
    const splatMesh = new SplatMesh({
      url,
      editable: false,
      onLoad: async (mesh) => {
        const plyBuffer = fileObj ? await fileObj.arrayBuffer() : null;
        if (_loadSession !== session) return;
        if (currentSplatMeta) currentSplatMeta.plyBuffer = plyBuffer;

        const box = mesh.getBoundingBox?.();
        if (!box || box.isEmpty()) {
          const fallback = new THREE.Box3(new THREE.Vector3(-5, -1, -5), new THREE.Vector3(5, 3, 5));
          _enterConfigure(fallback, plyBuffer ?? url, !!plyBuffer, flipY, session);
          return;
        }

        floorSlab.position.y = box.min.y - 3;
        floorSlab.updateMatrixWorld(true);

        splatCage = _buildBboxCage(box);
        scene.add(splatCage);
        _bvhWorld(splatCage);
        splatCage.updateMatrixWorld(true);
        _activateWorldCollision(splatCage, box);

        _enterConfigure(box, plyBuffer ?? url, !!plyBuffer, flipY, session);
      },
    });
    if (flipY) splatMesh.quaternion.set(1, 0, 0, 0);
    activeSplatMesh = splatMesh;
    scene.add(splatMesh);
  } catch (err) {
    if (_loadSession !== session) return;
    console.error('[Play] SplatMesh load failed:', err);
    appState = 'launcher';
    showLauncher();
  }
}

function enterFPS() {
  if (appState !== 'configure') return;
  _exitConfigure();
  appState = 'playing';
  flyMode = false;

  currentFloorCx = configSpawnPos.x;
  currentFloorCz = configSpawnPos.z;

  _createSceneFloor(configFloorY, currentFloorCx, currentFloorCz);
  physics.setPlayerPosition(currentFloorCx, configFloorY + 0.1, currentFloorCz);
  camera.position.set(currentFloorCx, configFloorY + 1.7, currentFloorCz);
  camera.rotation.set(0, 0, 0);

  _updateFPSFloorDisplay();
  _updatePresetButtons();
  showPlaying();
  _updateModeIndicator();
  canvas.requestPointerLock();
}

// Adjust the permanent floor slab while in FPS mode (no geometry recreation —
// just reposition the existing slab and rebuild the BVH).
function _adjustFPSFloor(delta) {
  configFloorY += delta;
  if (configBox) configFloorY = Math.max(configBox.min.y - 2, Math.min(configBox.max.y + 2, configFloorY));

  if (sceneFloorSlab) {
    sceneFloorSlab.position.y = configFloorY - 0.2;
    sceneFloorSlab.updateMatrixWorld(true);
  }
  physics.rebuildCollision();
  _updateFPSFloorDisplay();
}

function _updateFPSFloorDisplay() {
  const el = document.getElementById('fps-floor-val');
  if (el) el.textContent = configFloorY.toFixed(2) + 'm';
}

function returnToLauncher() {
  if (appState === 'launcher') return;
  _loadSession++; // cancel any pending async operations for the current splat
  if (appState === 'configure') _exitConfigure();
  appState = 'launcher';
  flyMode = false;

  if (document.pointerLockElement) document.exitPointerLock();
  ballShooter.clear();

  if (activeSplatMesh) { scene.remove(activeSplatMesh); activeSplatMesh = null; }
  _disposeCollision();
  if (activeObjectUrl) { URL.revokeObjectURL(activeObjectUrl); activeObjectUrl = null; }

  floorSlab.position.y = -1;
  floorSlab.updateMatrixWorld(true);
  physics.clearCollisionMeshes([floorSlab]);

  showLauncher();
}

// ─── Configure: Mouse Interaction (drag handle + spawn click) ────────────────
let _cfgMouseX = 0, _cfgMouseY = 0;

canvas.addEventListener('mousedown', e => {
  _cfgMouseX = e.clientX;
  _cfgMouseY = e.clientY;

  if (appState !== 'configure' || e.button !== 0 || !configFloorHandle) return;
  const rect = canvas.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    ((e.clientY - rect.top) / rect.height) * -2 + 1
  );
  const rc = new THREE.Raycaster();
  rc.setFromCamera(mouse, camera);
  if (rc.intersectObject(configFloorHandle, true).length > 0) {
    isDraggingFloor = true;
    if (orbitControls) orbitControls.enabled = false;
  }
});

canvas.addEventListener('mousemove', e => {
  if (appState !== 'configure') return;

  if (isDraggingFloor) {
    const cx  = configBox ? (configBox.min.x + configBox.max.x) / 2 : 0;
    const cz  = configBox ? (configBox.min.z + configBox.max.z) / 2 : 0;
    const dist = camera.position.distanceTo(new THREE.Vector3(cx, configFloorY, cz));
    const worldPerPixel = Math.tan(camera.fov * 0.5 * Math.PI / 180) * 2 * dist / window.innerHeight;
    configFloorY -= e.movementY * worldPerPixel;
    if (configBox) configFloorY = Math.max(configBox.min.y - 2, Math.min(configBox.max.y + 1, configFloorY));
    _updateConfigFloorGrid();
    _updateFloorHandle();
    _updateConfigSpawnMarker();
    _updateFloorValDisplay();
    return;
  }

  // Cursor hint on handle hover
  if (configFloorHandle) {
    const rect = canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      ((e.clientY - rect.top) / rect.height) * -2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(mouse, camera);
    const hovering = rc.intersectObject(configFloorHandle, true).length > 0;
    if (hovering !== _isHoveringHandle) {
      _isHoveringHandle = hovering;
      canvas.style.cursor = hovering ? 'ns-resize' : 'default';
    }
  }
});

document.addEventListener('mouseup', () => {
  if (isDraggingFloor) {
    isDraggingFloor = false;
    if (orbitControls) orbitControls.enabled = true;
    canvas.style.cursor = _isHoveringHandle ? 'ns-resize' : 'default';
  }
});

// Spawn point — click in scene (not on handle, not a drag)
canvas.addEventListener('mouseup', e => {
  if (appState !== 'configure' || isDraggingFloor) return;
  const dx = e.clientX - _cfgMouseX;
  const dy = e.clientY - _cfgMouseY;
  if (Math.sqrt(dx * dx + dy * dy) > 6) return;

  const rect = canvas.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    ((e.clientY - rect.top) / rect.height) * -2 + 1
  );
  const rc = new THREE.Raycaster();
  rc.setFromCamera(mouse, camera);
  const targets = [];
  if (voxelMesh) targets.push(voxelMesh);
  if (splatCage) targets.push(splatCage);
  const hits = rc.intersectObjects(targets, true);
  if (hits.length) {
    const pt = hits[0].point;
    configSpawnPos.set(pt.x, configFloorY, pt.z);
    configSpawnSet = true;
    _updateConfigSpawnMarker();
    _updateSpawnStatusDisplay();
  }
});

// ─── Pointer lock — ESC just frees the cursor, does NOT exit to launcher ─────
// When pointer lock is lost (user pressed ESC or switched window) we stay in
// the playing state so the HUD buttons (Start Again, floor adjuster) remain
// accessible. Clicking the canvas re-acquires the lock.
document.addEventListener('pointerlockchange', () => {
  // intentionally empty — no forced exit on lock loss
});

canvas.addEventListener('click', () => {
  if (appState === 'playing' && document.pointerLockElement !== canvas) canvas.requestPointerLock();
});

// ─── FPS Input Events ─────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  fpsKeys[e.code] = true;
  if (e.code === 'KeyB' && appState === 'playing') ballShooter.clear();
  if (e.code === 'Escape' && appState === 'configure') returnToLauncher();
  if (e.code === 'KeyF' && appState === 'playing') {
    flyMode = !flyMode;
    if (!flyMode) physics.setPlayerPosition(camera.position.x, camera.position.y - 1.5, camera.position.z);
    _updateModeIndicator();
  }
});

document.addEventListener('keyup', e => { fpsKeys[e.code] = false; });

document.addEventListener('mousemove', e => {
  if (appState !== 'playing' || document.pointerLockElement !== canvas) return;
  camera.rotation.y -= e.movementX / 500;
  camera.rotation.x -= e.movementY / 500;
  camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.rotation.x));
});

document.addEventListener('mousedown', e => {
  if (appState !== 'playing' || document.pointerLockElement !== canvas || e.button !== 0) return;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  ballShooter.shoot(camera.position.clone(), dir);
});

// ─── Mode indicator ───────────────────────────────────────────────────────────
function _updateModeIndicator() {
  const el = document.getElementById('mode-indicator');
  if (!el) return;
  if (flyMode) {
    el.textContent = '✈ FLY  ·  F = Walk';
    el.style.display = 'block';
  } else {
    el.textContent = '🦶 WALK  ·  F = Fly';
    el.style.display = 'block';
    setTimeout(() => { if (!flyMode && el) el.style.display = 'none'; }, 2000);
  }
}

// ─── FPS Movement Update ──────────────────────────────────────────────────────
function updateFPS(dt) {
  if (appState !== 'playing') return;

  if (flyMode) {
    const fwd   = new THREE.Vector3();
    const right = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    right.crossVectors(fwd, camera.up).normalize();
    const move = new THREE.Vector3();
    if (fpsKeys['KeyW']) move.addScaledVector(fwd,    1);
    if (fpsKeys['KeyS']) move.addScaledVector(fwd,   -1);
    if (fpsKeys['KeyD']) move.addScaledVector(right,  1);
    if (fpsKeys['KeyA']) move.addScaledVector(right, -1);
    if (fpsKeys['Space'])                         move.y += 1;
    if (fpsKeys['KeyC'] || fpsKeys['ControlLeft']) move.y -= 1;
    if (move.lengthSq() > 0) move.normalize();
    camera.position.addScaledVector(move, FPS_FLY_SPEED * dt);
    physics.setPlayerPosition(camera.position.x, camera.position.y, camera.position.z);
  } else {
    const isRunning = fpsKeys['ShiftLeft'] || fpsKeys['ShiftRight'];
    const speed = isRunning ? FPS_RUN_SPEED : FPS_WALK_SPEED;
    fpsEuler.set(0, camera.rotation.y, 0);
    const moveX = (fpsKeys['KeyD'] ? 1 : 0) - (fpsKeys['KeyA'] ? 1 : 0);
    const moveZ = (fpsKeys['KeyS'] ? 1 : 0) - (fpsKeys['KeyW'] ? 1 : 0);
    physics.inputVelocity.set(moveX, 0, moveZ);
    if (physics.inputVelocity.lengthSq() > 0) {
      physics.inputVelocity.normalize().applyEuler(fpsEuler).multiplyScalar(speed);
    }
    if (physics.getPlayerOnFloor() && fpsKeys['Space']) {
      physics.playerVelocity.y = FPS_JUMP_FORCE;
    }
    physics.updatePlayer(dt, camera, false);
  }

  ballShooter.update(dt);
}

// ─── Animation Loop ───────────────────────────────────────────────────────────
const clock = new Timer();
function animate() {
  requestAnimationFrame(animate);
  clock.update();
  const dt = Math.min(clock.getDelta(), 0.05);

  if (appState === 'configure') {
    if (orbitControls) orbitControls.update();

    // Scale gizmo so it appears the same angular size at any zoom level
    if (configFloorHandle) {
      const cx  = configBox ? (configBox.min.x + configBox.max.x) / 2 : 0;
      const cz  = configBox ? (configBox.min.z + configBox.max.z) / 2 : 0;
      const dist = camera.position.distanceTo(new THREE.Vector3(cx, configFloorY, cz));
      const s = Math.max(0.3, Math.min(dist * 0.12, 8));
      configFloorHandle.scale.setScalar(s);
    }
  }

  updateFPS(dt);
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Launcher UI Wiring ───────────────────────────────────────────────────────
function _renderPresets() {
  const grid = document.getElementById('preset-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (let i = 0; i < NUM_PRESETS; i++) {
    const saved = _getPreset(i);
    const card  = document.createElement('div');
    card.className = `preset-card${saved ? ' filled' : ' disabled'}`;

    if (saved) {
      const shortName = saved.name.length > 13 ? saved.name.slice(0, 11) + '…' : saved.name;
      const ago = _timeAgo(saved.savedAt);
      card.innerHTML = `
        <span class="preset-num">${i + 1}</span>
        <span class="preset-label">${shortName}</span>
        <span class="preset-meta">${ago}</span>
        <button class="preset-clear" title="Clear preset ${i + 1}">×</button>`;
      card.addEventListener('click', e => {
        if (e.target.closest('.preset-clear')) return;
        _launchPreset(i);
      });
      card.querySelector('.preset-clear').addEventListener('click', e => {
        e.stopPropagation();
        if (confirm(`Clear Preset ${i + 1}?`)) _clearPreset(i);
      });
    } else {
      card.innerHTML = `<span class="preset-num">${i + 1}</span><span class="preset-label">Empty</span>`;
    }
    grid.appendChild(card);
  }
}

function _timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function _handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.ply')) { alert('Please upload a .ply file.'); return; }
  if (activeObjectUrl) { URL.revokeObjectURL(activeObjectUrl); activeObjectUrl = null; }
  const objectUrl = URL.createObjectURL(file);
  activeObjectUrl = objectUrl;
  launchSplat(objectUrl, file.name.replace(/\.ply$/i, ''), true, file);
}

document.addEventListener('DOMContentLoaded', () => {
  _renderPresets();

  const urlInput = document.getElementById('url-input');
  const urlBtn   = document.getElementById('url-play-btn');
  urlBtn?.addEventListener('click', () => {
    const url = urlInput?.value?.trim();
    if (!url) return;
    const name = url.split('/').pop().replace(/\.ply$/i, '') || 'splat';
    launchSplat(url, name, true);
  });
  urlInput?.addEventListener('keydown', e => { if (e.key === 'Enter') urlBtn?.click(); });

  const dropZone  = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  dropZone?.addEventListener('click', () => fileInput?.click());
  dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone?.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files[0];
    if (file) _handleFile(file);
  });
  fileInput?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) _handleFile(file);
  });

  document.getElementById('configure-back')?.addEventListener('click', returnToLauncher);
  document.getElementById('configure-start')?.addEventListener('click', enterFPS);

  // HUD: Start Again button
  document.getElementById('restart-btn')?.addEventListener('click', returnToLauncher);

  // HUD: preset save buttons
  for (let i = 0; i < NUM_PRESETS; i++) {
    document.getElementById(`fps-preset-btn-${i}`)?.addEventListener('click', () => _saveToPreset(i));
  }

  // HUD: floor height adjuster — hold to repeat (same pattern as configure screen)
  const FPS_STEP = 0.05;
  let fpsFloorTimer = null;
  const startFpsFloor = (delta) => {
    _adjustFPSFloor(delta);
    fpsFloorTimer = setInterval(() => _adjustFPSFloor(delta), 80);
  };
  const stopFpsFloor = () => { if (fpsFloorTimer) { clearInterval(fpsFloorTimer); fpsFloorTimer = null; } };

  document.getElementById('fps-floor-dn')?.addEventListener('mousedown', () => startFpsFloor(-FPS_STEP));
  document.getElementById('fps-floor-up')?.addEventListener('mousedown', () => startFpsFloor(+FPS_STEP));
  document.addEventListener('mouseup', stopFpsFloor);
  document.getElementById('fps-floor-dn')?.addEventListener('mouseleave', stopFpsFloor);
  document.getElementById('fps-floor-up')?.addEventListener('mouseleave', stopFpsFloor);

  // Editable floor height input
  document.getElementById('floor-val')?.addEventListener('change', e => {
    const val = parseFloat(e.target.value);
    if (isNaN(val)) { _updateFloorValDisplay(); return; }
    configFloorY = val;
    if (configBox) configFloorY = Math.max(configBox.min.y - 2, Math.min(configBox.max.y + 1, configFloorY));
    e.target.value = configFloorY.toFixed(2);
    _updateConfigFloorGrid();
    _updateFloorHandle();
    _updateConfigSpawnMarker();
  });

  // Floor height stepper — hold to repeat
  const STEP = 0.05;
  let floorHoldTimer = null;
  const adjustFloor = (delta) => {
    configFloorY += delta;
    if (configBox) configFloorY = Math.max(configBox.min.y - 2, Math.min(configBox.max.y + 1, configFloorY));
    _updateConfigFloorGrid();
    _updateFloorHandle();
    _updateConfigSpawnMarker();
    _updateFloorValDisplay();
  };
  const startHold = (delta) => { adjustFloor(delta); floorHoldTimer = setInterval(() => adjustFloor(delta), 80); };
  const stopHold  = () => { if (floorHoldTimer) { clearInterval(floorHoldTimer); floorHoldTimer = null; } };

  document.getElementById('floor-dn')?.addEventListener('mousedown', () => startHold(-STEP));
  document.getElementById('floor-up')?.addEventListener('mousedown', () => startHold(+STEP));
  document.addEventListener('mouseup', stopHold);
  document.getElementById('floor-dn')?.addEventListener('mouseleave', stopHold);
  document.getElementById('floor-up')?.addEventListener('mouseleave', stopHold);
});
