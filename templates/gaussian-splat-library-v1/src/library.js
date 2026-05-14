import * as THREE from 'three';
import { Timer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { SparkRenderer, SplatMesh, SplatEdit, SplatEditSdf, SplatEditSdfType } from '@sparkjsdev/spark';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { createPhysics } from './fps/physics.js';
import { generateCollision, isWebGPUAvailable } from './collision/client-collider.js';
import { createBallShooter } from './fps/balls.js';

import * as Assets from './training/warehouse-assets.js';
import { createTankGame } from './tankGame.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ─── Three.js Setup ──────────────────────────────────────────────────────────
const vp = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x333340);

const camera = new THREE.PerspectiveCamera(45, vp.clientWidth / vp.clientHeight, 0.1, 5000);
camera.position.set(3, 3, 5);

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(vp.clientWidth, vp.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
vp.appendChild(renderer.domElement);

// ─── Spark Renderer (Gaussian Splat engine) ─────────────────────────────────
const spark = new SparkRenderer({ renderer });
scene.add(spark);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.update();

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(5, 10, 5);
dirLight.castShadow = true;
scene.add(dirLight);
scene.add(new THREE.GridHelper(20, 20, 0x555566, 0x222233));

// ─── Physics (BVH + gravity for walk mode) ──────────────────────────────────
const physics = createPhysics();

// Permanent floor slab. displayModel() normalises models to min-Y ≥ 0, so the
// top of this slab (at Y = 0) is always a valid landing surface.
const _floorSlab = new THREE.Mesh(
  new THREE.BoxGeometry(2000, 2, 2000),
  new THREE.MeshBasicMaterial({ visible: false })
);
_floorSlab.position.set(0, -1, 0);
scene.add(_floorSlab);
physics.addCollisionMesh(_floorSlab);

let _worldCollider = null;
let _splatCage = null;     // bbox collision cage for PLY worlds (floor + outer walls)
let _voxelGlbScene = null; // voxelised collision GLB — lives in the Three.js scene
let _activeSplatInfo = null; // { plyPath, file, box, flipY } — needed for regeneration

function _updateColliderState(msg) {
  const el = document.getElementById('collider-state');
  if (el) el.textContent = msg;
}

function _disposeSplatCage() {
  if (!_splatCage) return;
  scene.remove(_splatCage);
  _splatCage.traverse(n => { if (n.isMesh) { n.geometry?.dispose(); n.material?.dispose(); } });
  _splatCage = null;
}

function _disposeVoxelGlb() {
  if (!_voxelGlbScene) return;
  scene.remove(_voxelGlbScene);
  _voxelGlbScene.traverse(n => { if (n.isMesh) { n.geometry?.dispose(); n.material?.dispose(); } });
  _voxelGlbScene = null;
}

// Sync the global safety floor slab to just below the scene's real floor.
// Called whenever we know the world-space bbox of the loaded splat.
function _syncFloorSlab(bbox) {
  _floorSlab.position.y = bbox.min.y - 1;
  _floorSlab.updateMatrixWorld(true);
}

// Build an invisible bounding-box cage: floor slab + 4 outer walls.
// Stops the player falling through the floor and walking off the world edge.
// Interior walls need a separate collider GLB for accurate collision.
function _buildBboxCage(bbox) {
  const mat = new THREE.MeshBasicMaterial({ visible: false });
  const cx  = (bbox.min.x + bbox.max.x) / 2;
  const cy  = (bbox.min.y + bbox.max.y) / 2;
  const cz  = (bbox.min.z + bbox.max.z) / 2;
  const w   = Math.max(bbox.max.x - bbox.min.x, 1);
  const d   = Math.max(bbox.max.z - bbox.min.z, 1);
  const h   = Math.max(bbox.max.y - bbox.min.y, 1);
  const t   = 0.5; // wall thickness
  const grp = new THREE.Group();
  const add = (gw, gh, gd, px, py, pz) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(gw, gh, gd), mat);
    m.position.set(px, py, pz);
    grp.add(m);
  };
  add(w + 20, 2, d + 20,          cx,             bbox.min.y - 1, cz            ); // floor
  add(w + 2,  h + 4, t,           cx,             cy,             bbox.min.z - t); // -Z wall
  add(w + 2,  h + 4, t,           cx,             cy,             bbox.max.z + t); // +Z wall
  add(t,      h + 4, d + 2,       bbox.min.x - t, cy,             cz            ); // -X wall
  add(t,      h + 4, d + 2,       bbox.max.x + t, cy,             cz            ); // +X wall
  return grp;
}

function _bvhWorld(obj) {
  let n = 0;
  obj.traverse(node => {
    if (!node.isMesh) return;
    try { node.geometry.computeBoundsTree(); n++; } catch (e) { /* non-indexed or degenerate mesh */ }
  });
  return n;
}

// worldBbox: when provided, drops the safety-floor slab just below the real scene
// floor so it never intercepts the player before the voxelised mesh does.
function _activateWorldCollision(colliderScene, worldBbox = null) {
  _worldCollider = colliderScene;

  if (worldBbox) {
    // Place the safety slab 3m below the real scene floor — it's only there to
    // catch players who somehow fall through the voxelised mesh entirely.
    _floorSlab.position.y = worldBbox.min.y - 3;
    _floorSlab.updateMatrixWorld(true);
  }

  const objects = [_floorSlab];
  if (colliderScene) {
    colliderScene.updateMatrixWorld(true);
    objects.push(colliderScene);
  }
  physics.clearCollisionMeshes(objects);
  const state = colliderScene ? 'Voxel mesh active' : 'Floor slab only';
  console.log(`[Library] Collision: ${state} | floorY=${_floorSlab.position.y.toFixed(2)}`);
  _updateColliderState(state);
  _refreshCollisionDebug?.();
}

// ─── Collision debug overlay ─────────────────────────────────────────────────
let _collisionDebug = false;
const _debugMat = new THREE.MeshBasicMaterial({
  color: 0xff6600, transparent: true, opacity: 0.45,
  side: THREE.DoubleSide, depthWrite: false,
});
const _debugFloorMat = new THREE.MeshBasicMaterial({
  color: 0x00ccff, transparent: true, opacity: 0.3,
  side: THREE.DoubleSide, depthWrite: false, wireframe: false,
});

function _setCollisionDebug(on) {
  _collisionDebug = on;

  // Voxelised collision GLB (in the scene, can be rendered)
  if (_voxelGlbScene) {
    _voxelGlbScene.traverse(n => {
      if (!n.isMesh) return;
      n.visible  = on;
      n.material = on ? _debugMat : n.userData._origMat ?? n.material;
      if (on) n.userData._origMat = n.material; // stash so we can restore
    });
  }

  // Bbox cage (also in the scene)
  if (_splatCage) {
    _splatCage.traverse(n => {
      if (!n.isMesh) return;
      n.visible  = on;
      n.material = on ? _debugMat : n.userData._origMat ?? n.material;
      if (on) n.userData._origMat = n.material;
    });
  }

  // Global safety floor slab
  _floorSlab.visible  = on;
  _floorSlab.material = on ? _debugFloorMat : new THREE.MeshBasicMaterial({ visible: false });

  const btn = document.getElementById('btn-toggle-collision');
  if (btn) {
    btn.textContent = on
      ? '🟠 Hide Collision  [ P ]'
      : '🔍 Show Collision  [ P ]';
    btn.style.background = on ? '#3a1a00' : '#0d1a2a';
  }
  console.log(`[Library] Collision debug: ${on ? 'ON' : 'OFF'}`);
}

// Re-apply debug materials when a new collider is loaded
function _refreshCollisionDebug() {
  if (_collisionDebug) _setCollisionDebug(true);
}

function _deleteCollisionMesh() {
  if (_collisionDebug) _setCollisionDebug(false);
  _disposeVoxelGlb();
  _worldCollider = null;
  physics.clearCollisionMeshes([_floorSlab]);
  _updateColliderState('Collider deleted — bbox cage or floor only');
}

async function _regenCollisionMesh() {
  const info = _activeSplatInfo;
  if (!info || (!info.plyPath && !info.file)) {
    _updateColliderState('Nothing to regenerate — load a PLY first');
    return;
  }
  // Delete cached GLB so the server re-runs the voxeliser
  _deleteCollisionMesh();
  if (info.plyPath) {
    await _tryGenCollision(info.plyPath, info.box, true); // force=true bypasses cache
  } else {
    await _uploadAndGenCollision(info.file, info.box, info.flipY);
  }
}

// Build a Three.js scene from client-side GPU-generated collision geometry and
// activate it as the physics collider. Returns true on success, false if skipped.
async function _tryClientSideCollision(plyUrlOrBuffer, isBuffer, box, flipY, setStatus) {
  if (!isWebGPUAvailable()) return false;
  setStatus('⚙ GPU VOXELIZING…');
  try {
    const center = box.getCenter(new THREE.Vector3());
    const worldFloorY = box.min.y + 1.0;
    // PLY data is in PLY-local space; when flipY the 180° X rotation maps world→PLY as (x,-y,-z)
    const seed = flipY
      ? [center.x, -worldFloorY, -center.z]
      : [center.x,  worldFloorY,  center.z];

    const voxelSize = parseFloat(document.getElementById('voxel-params-input')?.value?.split(',')[1]?.trim()) || 0.15;
    const opacity   = parseFloat(document.getElementById('opacity-threshold-input')?.value?.trim()) || 0.2;

    const { positions, indices } = await generateCollision({
      plyUrl:           isBuffer ? null : plyUrlOrBuffer,
      plyBuffer:        isBuffer ? plyUrlOrBuffer : null,
      seedPos:          seed,
      voxelSize,
      opacityThreshold: opacity,
      onLog: msg => setStatus(`⚙ ${msg.slice(0, 50)}`),
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ visible: false }));
    if (flipY) mesh.quaternion.set(1, 0, 0, 0);
    mesh.userData.isCollisionMesh = true;
    const colliderScene = new THREE.Group();
    colliderScene.add(mesh);

    _disposeVoxelGlb();
    _voxelGlbScene = colliderScene;
    scene.add(colliderScene);
    _bvhWorld(colliderScene);
    colliderScene.updateMatrixWorld(true);
    _disposeSplatCage();
    _activateWorldCollision(colliderScene, box);
    setStatus(`✓ GPU COLLIDER READY`);
    setTimeout(() => { if (!fpsMode) modeLabel.style.display = 'none'; }, 3000);
    return true;
  } catch (err) {
    console.warn('[ClientCollider] GPU path failed, falling back to server:', err);
    return false;
  }
}

// Call splat-transform -K on a server-side PLY to generate a watertight .collision.glb,
// then swap it in as the physics collider. No-ops for blob: URLs (uploaded files).
async function _tryGenCollision(plyPath, box, force = false) {
  if (!plyPath || plyPath.startsWith('blob:')) return;

  const center = box.getCenter(new THREE.Vector3());
  // getBoundingBox() returns world-space coords (after the 180° X flip).
  // The voxelizer works in PLY-local space, so invert Y and Z back.
  // 180° X flip: world = (x, -y, -z) ← PLY, so PLY = (x, -world_y, -world_z).
  const seed = {
    x:  center.x,
    y: -(box.min.y + 1.0), // 1 m above world floor → PLY Y
    z: -center.z,
  };

  const setStatus = (msg) => {
    modeLabel.textContent = msg;
    modeLabel.style.cssText = `
      position:fixed;top:12px;right:16px;z-index:9000;padding:6px 16px;
      border-radius:4px;font-family:'Courier New',monospace;font-size:12px;
      font-weight:bold;letter-spacing:2px;text-transform:uppercase;pointer-events:none;
      display:block;background:rgba(34,211,238,0.12);color:#22d3ee;
      border:1px solid rgba(34,211,238,0.3);
    `;
  };

  // Try GPU client-side path first (no server round-trip)
  if (!force) {
    const gpuDone = await _tryClientSideCollision(plyPath, false, box, true, setStatus);
    if (gpuDone) return;
  }

  setStatus('⚙ GENERATING COLLISION…');

  try {
    const res = await fetch('/api/gen-collision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plyUrl: plyPath,
        seedX: seed.x, seedY: seed.y, seedZ: seed.z,
        voxelFloor: document.getElementById('voxel-params-input')?.value?.split(',')[0]?.trim() || '0.1',
        voxelWall:  document.getElementById('voxel-params-input')?.value?.split(',')[1]?.trim() || '0.15',
        carveH: document.getElementById('voxel-carve-input')?.value?.split(',')[0]?.trim() || '1.6',
        carveR: document.getElementById('voxel-carve-input')?.value?.split(',')[1]?.trim() || '0.5',
        opacityThreshold: document.getElementById('opacity-threshold-input')?.value?.trim() || '0.2',
        force,
      })
    });

    if (!res.ok && !res.body) {
      setStatus('⚠ COLLISION API UNAVAILABLE');
      setTimeout(() => { if (!fpsMode) modeLabel.style.display = 'none'; }, 4000);
      return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'log') {
            setStatus(`⚙ ${ev.text.slice(0, 48)}`);
          } else if (ev.type === 'done') {
            setStatus(ev.cached ? '↩ LOADING CACHED…' : '↓ LOADING COLLISION…');
            gltfLoader.load(ev.url, (gltf) => {
              gltf.scene.quaternion.set(1, 0, 0, 0);
              gltf.scene.traverse(n => { if (n.isMesh) n.visible = false; });
              _disposeVoxelGlb();
              _voxelGlbScene = gltf.scene;
              scene.add(gltf.scene); // must be in scene for rendering + correct matrixWorld
              const n = _bvhWorld(gltf.scene);
              setTimeout(() => {
                gltf.scene.updateMatrixWorld(true);
                _disposeSplatCage();
                _activateWorldCollision(gltf.scene, box);
                setStatus(`✓ ${n} COLLISION MESHES`);
                setTimeout(() => { if (!fpsMode) modeLabel.style.display = 'none'; }, 3000);
              }, 50);
            }, undefined, (err) => {
              setStatus(`⚠ ${err.message.slice(0, 50)}`);
            });
          } else if (ev.type === 'error') {
            setStatus(`⚠ ${ev.text.slice(0, 60)}`);
            setTimeout(() => { if (!fpsMode) modeLabel.style.display = 'none'; }, 6000);
          }
        } catch { /* SSE parse error */ }
      }
    }
  } catch (err) {
    setStatus(`⚠ ${err.message.slice(0, 60)}`);
    setTimeout(() => { if (!fpsMode) modeLabel.style.display = 'none'; }, 5000);
  }
}

// Upload a PLY File object to /api/process-splat, stream progress, then swap in
// the generated .collision.glb for physics. Called after Spark loads the splat
// so we have a real bbox-derived seed position.
async function _uploadAndGenCollision(file, box, flipY = true) {
  if (!file) return;

  const center = box.getCenter(new THREE.Vector3());
  // getBoundingBox() is world-space; voxelizer needs PLY-local.
  // For the 180° X flip: PLY = (x, -world_y, -world_z).
  const worldFloorY = box.min.y + 1.0;
  const plySeedPos = flipY
    ? `${center.x.toFixed(3)},${(-worldFloorY).toFixed(3)},${(-center.z).toFixed(3)}`
    : `${center.x.toFixed(3)},${worldFloorY.toFixed(3)},${center.z.toFixed(3)}`;

  // Allow user to override seed via UI input; 'auto' or blank → use bbox-derived
  const seedInput = document.getElementById('seed-pos-input');
  const seedVal = seedInput?.value?.trim();
  const seed = (seedVal && seedVal !== 'auto') ? seedVal : plySeedPos;

  const setStatus = (msg) => {
    modeLabel.textContent = msg;
    modeLabel.style.cssText = `
      position:fixed;top:12px;right:16px;z-index:9000;padding:6px 16px;
      border-radius:4px;font-family:'Courier New',monospace;font-size:12px;
      font-weight:bold;letter-spacing:2px;text-transform:uppercase;pointer-events:none;
      display:block;background:rgba(34,211,238,0.12);color:#22d3ee;
      border:1px solid rgba(34,211,238,0.3);
    `;
  };

  const uploadStatus = document.getElementById('upload-status');
  const setSide = (msg) => { if (uploadStatus) uploadStatus.textContent = msg; };

  // Try GPU client-side path first — reads the File directly, no upload needed
  const gpuDone = await _tryClientSideCollision(
    await file.arrayBuffer(), true, box, flipY,
    msg => { setStatus(msg); setSide(msg); }
  );
  if (gpuDone) { setSide('✓ GPU collider ready. Press 1 → FPS, F → walk.'); return; }

  const voxelParams        = document.getElementById('voxel-params-input')?.value?.trim()        || '0.1,0.15';
  const voxelCarve         = document.getElementById('voxel-carve-input')?.value?.trim()         || '1.6,0.5';
  const opacityThreshold   = document.getElementById('opacity-threshold-input')?.value?.trim()   || '0.2';

  const params = new URLSearchParams({ seedPos: seed, voxelParams, voxelCarve, opacityThreshold });

  setStatus('⬆ UPLOADING PLY…');
  setSide(`Uploading ${file.name} to server…`);

  try {
    const res = await fetch(`/api/process-splat?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });

    if (!res.body) {
      setStatus('⚠ PROCESS-SPLAT UNAVAILABLE');
      setTimeout(() => { if (!fpsMode) modeLabel.style.display = 'none'; }, 4000);
      return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'log') {
            setStatus(`⚙ ${ev.text.slice(0, 48)}`);
            setSide(`⚙ ${ev.text.slice(0, 80)}`);
          } else if (ev.type === 'done') {
            setStatus(ev.cached ? '↩ LOADING CACHED…' : '↓ LOADING COLLISION…');
            setSide('Loading collision mesh…');
            const glbUrl = ev.url || `/api/collision-mesh/${ev.jobId}`;
            gltfLoader.load(glbUrl, (gltf) => {
              if (flipY) gltf.scene.quaternion.set(1, 0, 0, 0);
              gltf.scene.traverse(n => { if (n.isMesh) n.visible = false; });
              gltf.scene.userData.isCollisionMesh = true;
              _disposeVoxelGlb();
              _voxelGlbScene = gltf.scene;
              scene.add(gltf.scene); // must be in scene for rendering + correct matrixWorld
              const n = _bvhWorld(gltf.scene);
              setTimeout(() => {
                gltf.scene.updateMatrixWorld(true);
                _disposeSplatCage();
                _activateWorldCollision(gltf.scene, box);
                setStatus(`✓ ${n} COLLISION MESHES`);
                setSide(`✓ Collision ready — ${n} meshes. Press 1 → FPS, F → walk.`);
                setTimeout(() => { if (!fpsMode) modeLabel.style.display = 'none'; }, 3000);
              }, 50);
            }, undefined, (err) => {
              setStatus(`⚠ ${err.message.slice(0, 50)}`);
              setSide(`Error loading collision GLB: ${err.message}`);
            });
          } else if (ev.type === 'error') {
            setStatus(`⚠ ${ev.text.slice(0, 60)}`);
            setSide(`⚠ ${ev.text}`);
            setTimeout(() => { if (!fpsMode) modeLabel.style.display = 'none'; }, 6000);
          }
        } catch { /* SSE parse error */ }
      }
    }
  } catch (err) {
    setStatus(`⚠ ${err.message.slice(0, 60)}`);
    setSide(`Upload error: ${err.message}`);
    setTimeout(() => { if (!fpsMode) modeLabel.style.display = 'none'; }, 5000);
  }
}

window.addEventListener('resize', () => {
  camera.aspect = vp.clientWidth / vp.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(vp.clientWidth, vp.clientHeight);
});

// ─── Model Management ────────────────────────────────────────────────────────
let currentGroup = null;
let activeSplatMesh = null;  // Spark SplatMesh instance
let tankGame = null;          // Active tank game instance (set when a splat loads)

// ─── Cursor Interaction System ───────────────────────────────────────────────
let cursorEffectsEnabled = false;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const cursorWorldPos = new THREE.Vector3();
let cursorHit = false;

// SplatEdit: cursor sphere that displaces & recolors nearby splats
const cursorEdit = new SplatEdit({ name: 'cursor-effect', softEdge: 0.5 });
const cursorSdf = new SplatEditSdf({
  type: SplatEditSdfType.SPHERE,
  radius: 0.3,
  displace: new THREE.Vector3(0, 0.15, 0),
  opacity: 0.7,
  color: new THREE.Color(0.2, 0.8, 1.0),
});
cursorEdit.addSdf(cursorSdf);

// Visual cursor glow (visible feedback sphere)
const cursorGlow = new THREE.Mesh(
  new THREE.SphereGeometry(0.3, 16, 16),
  new THREE.MeshBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.15,
    depthWrite: false,
  })
);
cursorGlow.visible = false;
scene.add(cursorGlow);

// Track mouse position
vp.addEventListener('mousemove', (e) => {
  const rect = vp.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
});

function clearCurrent() {
  tankGame?.dispose();
  tankGame = null;
  // Dispose any active Spark SplatMesh
  if (activeSplatMesh) {
    scene.remove(activeSplatMesh);
    if (activeSplatMesh.edits) activeSplatMesh.edits = null;
    try { activeSplatMesh.dispose(); } catch (e) { /* ignore */ }
    activeSplatMesh = null;
  }
  cursorGlow.visible = false;
  cursorHit = false;
  if (currentGroup) {
    scene.remove(currentGroup);
    currentGroup.traverse(n => {
      if (n.isMesh) {
        n.geometry?.dispose();
        if (Array.isArray(n.material)) n.material.forEach(m => m.dispose());
        else n.material?.dispose();
      }
    });
    currentGroup = null;
  }
  _disposeSplatCage();
  _disposeVoxelGlb();
}

// Snap the orbit camera to look at `center` from the (1,1,1) diagonal —
// equal x, y, z offset — at a distance scaled to the model's bounding size.
const _frameDir = new THREE.Vector3(1, 1, 1).normalize(); // ≈ (0.577, 0.577, 0.577)
function _frameTo(center, maxDim) {
  const dist = Math.max(maxDim * 1.5, 1);
  camera.position.copy(center).addScaledVector(_frameDir, dist);
  controls.target.copy(center);
  controls.update();
}

function displayModel(group) {
  clearCurrent();
  currentGroup = group;
  const box = new THREE.Box3().setFromObject(group);
  const center = box.getCenter(new THREE.Vector3());
  group.position.x += (group.position.x - center.x);
  group.position.z += (group.position.z - center.z);
  if (box.min.y < 0) group.position.y -= box.min.y;
  scene.add(group);

  const size = box.getSize(new THREE.Vector3());
  _frameTo(center, Math.max(size.x, size.y, size.z));
}

// ─── Local Props ─────────────────────────────────────────────────────────────
const localProps = [
  { name: 'Wall Panel', fn: Assets.createWallPanel },
  { name: 'Doorway', fn: Assets.createDoorway },
  { name: 'Half Wall', fn: Assets.createHalfWall },
  { name: 'Floor Slab', fn: Assets.createFloorSlab },
  { name: 'Ceiling Panel', fn: Assets.createCeilingPanel },
  { name: 'Support Column', fn: Assets.createSupportColumn },
  { name: 'Cardboard Box', fn: Assets.createBox },
  { name: 'Traffic Cone', fn: Assets.createTrafficCone },
  { name: 'Metal Barrel', fn: Assets.createBarrel },
  { name: 'Wooden Pallet', fn: Assets.createPallet },
  { name: 'Steel Door', fn: () => { const g = new THREE.Group(); g.add(Assets.createDoor()); return g; } },
  { name: 'Chainlink Fence', fn: Assets.createFencePanel },
  { name: 'Metal Stairs', fn: Assets.createStairs },
  { name: 'Light Fixture', fn: Assets.createLightFixture },
  { name: 'Scaffolding', fn: Assets.createScaffold }
];

const listEl = document.getElementById('local-props-list');
let activeBtn = null;

localProps.forEach(prop => {
  const btn = document.createElement('button');
  btn.className = 'prop-btn';
  btn.textContent = prop.name;
  btn.onclick = () => {
    if (activeBtn) activeBtn.classList.remove('active');
    btn.classList.add('active');
    activeBtn = btn;
    displayModel(prop.fn());
  };
  listEl.appendChild(btn);
});

// ─── File Models (auto-discovered from public/models/) ───────────────────────
const fileListEl = document.getElementById('file-models-list');
const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();
const plyLoader = new PLYLoader();
const objLoader = new OBJLoader();

function loadFileModel(entry) {
  showStatus('LOADING MODEL...', entry.name);

  const onMeshLoad = (result) => {
    const obj = result.scene || result;
    displayModel(obj);
    hideStatus();
    const n = _bvhWorld(obj);
    setTimeout(() => {
      obj.updateMatrixWorld(true);
      _activateWorldCollision(obj);
      console.log(`[Library] ${entry.name}: ${n} collision meshes`);
    }, 100);
  };

  const onError = (err) => {
    console.error('Load error:', err);
    hideStatus();
  };

  if (entry.type === 'ply') {
    clearCurrent();
    showStatus('LOADING GAUSSIAN SPLAT...', entry.name);
    _activateWorldCollision(null);

    try {
      const splatMesh = new SplatMesh({
        url: entry.path,
        editable: true,
        onLoad: (mesh) => {
          hideStatus();
          console.log(`[Library] Spark Splat loaded: ${entry.name}`);
          try {
            const box = mesh.getBoundingBox?.();
            if (box && !box.isEmpty()) {
              _syncFloorSlab(box); // pin global safety floor to real scene floor level
              _disposeSplatCage();
              _splatCage = _buildBboxCage(box);
              scene.add(_splatCage);
              _bvhWorld(_splatCage);
              setTimeout(() => {
                _splatCage?.updateMatrixWorld(true);
                _activateWorldCollision(_splatCage, box);
                console.log(`[Library] PLY cage built — floor Y: ${box.min.y.toFixed(2)}`);
                tankGame?.dispose();
                tankGame = createTankGame({ scene, camera, controls, box });
              }, 50);

              const center = box.getCenter(new THREE.Vector3());
              const size = box.getSize(new THREE.Vector3());
              _frameTo(center, Math.max(size.x, size.y, size.z));

              // Track for regeneration
              _activeSplatInfo = { plyPath: entry.path, file: null, box, flipY: true };
              // Kick off splat-transform -K in the background to get a proper mesh collider.
              // Bbox cage above is the immediate fallback; this swaps it in when ready.
              _tryGenCollision(entry.path, box);
            }
          } catch (e) {
            console.warn('[Library] PLY cage/frame failed:', e);
          }
        },
      });
      splatMesh.quaternion.set(1, 0, 0, 0);
      splatMesh.edits = [cursorEdit];
      activeSplatMesh = splatMesh;
      scene.add(splatMesh);
    } catch (err) {
      console.error('[Library] Spark splat init failed:', err);
      onError(err);
    }
  } else if (entry.type === 'fbx') {
    fbxLoader.load(entry.path, onMeshLoad, undefined, onError);
  } else if (entry.type === 'obj') {
    objLoader.load(entry.path, onMeshLoad, undefined, onError);
  } else {
    gltfLoader.load(entry.path, onMeshLoad, undefined, onError);
  }
}

// Auto-discover models from public/models/ and public/splats/
async function scanModels() {
  try {
    const res = await fetch('/__models');
    const files = await res.json();
    if (!fileListEl || !files.length) return;
    fileListEl.innerHTML = '';

    const icons = { glb: '🎮', gltf: '🎮', fbx: '📦', ply: '💎', obj: '🔷' };
    const typeLabels = {
      glb: 'GLB Models',
      gltf: 'GLTF Models',
      fbx: 'FBX Models',
      ply: 'PLY Gaussian Splats',
      obj: 'OBJ Models'
    };

    // Group files by type
    const groups = {};
    files.forEach(entry => {
      const t = entry.type || 'other';
      if (!groups[t]) groups[t] = [];
      groups[t].push(entry);
    });

    // Render each group with a header
    const typeOrder = ['glb', 'gltf', 'fbx', 'ply', 'obj'];
    for (const type of typeOrder) {
      if (!groups[type] || groups[type].length === 0) continue;
      const header = document.createElement('div');
      header.style.cssText = 'font-size:11px;color:#22d3ee;margin:8px 0 4px;border-bottom:1px solid #333;padding-bottom:3px;';
      header.textContent = `${icons[type] || '📄'} ${typeLabels[type] || type.toUpperCase()} (${groups[type].length})`;
      fileListEl.appendChild(header);

      groups[type].forEach(entry => {
        const btn = document.createElement('button');
        btn.className = 'prop-btn';
        btn.textContent = `${icons[entry.type] || '📄'} ${entry.name}`;
        btn.onclick = () => {
          if (activeBtn) activeBtn.classList.remove('active');
          btn.classList.add('active');
          activeBtn = btn;
          loadFileModel(entry);
        };
        fileListEl.appendChild(btn);
      });
    }
  } catch (e) {
    console.warn('[Library] Could not scan models:', e);
  }
}
scanModels();

// ─── Meshy API via Backend Server ────────────────────────────────────────────
const BACKEND = 'https://viverse-backend.onrender.com';
const meshyBtn = document.getElementById('meshy-btn');
const meshyLog = document.getElementById('meshy-log');
const statusOverlay = document.getElementById('status-overlay');
const statusText = document.getElementById('status-text');
const statusSub = document.getElementById('status-sub');
const genListEl = document.getElementById('generated-models-list');
const loader = new GLTFLoader();

// Track generated models
const generatedModels = [];

function logMeshy(msg) {
  meshyLog.innerHTML += `> ${msg}<br>`;
  meshyLog.scrollTop = meshyLog.scrollHeight;
  console.log('[Meshy]', msg);
}

function showStatus(main, sub = '') {
  statusOverlay.style.display = 'flex';
  statusText.textContent = main;
  statusSub.textContent = sub;
}

function hideStatus() {
  statusOverlay.style.display = 'none';
}

function gatherSettings() {
  return {
    prompt: document.getElementById('meshy-prompt').value.trim(),
    negative_prompt: document.getElementById('meshy-neg-prompt').value.trim(),
    mode: document.getElementById('meshy-mode').value,
    art_style: document.getElementById('meshy-style').value,
    ai_model: document.getElementById('meshy-ai-model').value,
    topology: document.getElementById('meshy-topology').value,
    target_polycount: parseInt(document.getElementById('meshy-polycount').value) || 30000,
    seed: parseInt(document.getElementById('meshy-seed').value) || undefined,
    should_remesh: document.getElementById('meshy-remesh').checked
  };
}

async function pollBackend(taskId) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND}/api/meshy/status/${taskId}`);
        const data = await res.json();

        if (data.status === 'SUCCEEDED') {
          clearInterval(interval);
          resolve(data);
        } else if (data.status === 'FAILED' || data.status === 'EXPIRED') {
          clearInterval(interval);
          reject(new Error(`Task ${data.status}`));
        } else {
          showStatus(`GENERATING: ${data.progress || 0}%`, `Task ID: ${taskId}`);
          logMeshy(`${data.status} — ${data.progress}%`);
        }
      } catch (e) {
        clearInterval(interval);
        reject(e);
      }
    }, 5000);
  });
}

function addGeneratedModel(entry) {
  generatedModels.push(entry);

  // Clear placeholder text
  if (generatedModels.length === 1) genListEl.innerHTML = '';

  const btn = document.createElement('button');
  btn.className = 'gen-model-btn';
  btn.textContent = `${entry.prompt.substring(0, 30)} (${entry.style})`;
  btn.title = `${entry.prompt}\nSaved: ${entry.localPath || 'server only'}`;
  btn.onclick = () => {
    if (activeBtn) activeBtn.classList.remove('active');
    activeBtn = null;
    showStatus('LOADING MODEL...', entry.prompt);
    loader.load(entry.proxyUrl, (gltf) => {
      displayModel(gltf.scene);
      hideStatus();
    }, undefined, () => hideStatus());
  };
  genListEl.prepend(btn);
}

meshyBtn.addEventListener('click', async () => {
  const settings = gatherSettings();

  if (!settings.prompt) {
    logMeshy('Enter a prompt!');
    return;
  }

  meshyLog.innerHTML = '';
  meshyBtn.disabled = true;
  showStatus('SENDING TO MESHY AI...', settings.prompt);

  if (activeBtn) { activeBtn.classList.remove('active'); activeBtn = null; }

  try {
    logMeshy(`Prompt: "${settings.prompt}"`);
    logMeshy(`Style: ${settings.art_style} | Topo: ${settings.topology} | Poly: ${settings.target_polycount}`);

    // 1. Create task via backend
    const createRes = await fetch(`${BACKEND}/api/meshy/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    const createData = await createRes.json();
    if (!createRes.ok) throw new Error(createData.error || 'Server error');

    const taskId = createData.taskId;
    logMeshy(`Task: ${taskId}`);

    // 2. Poll
    const finalData = await pollBackend(taskId);
    logMeshy('Generation complete!');
    showStatus('DOWNLOADING MODEL...', 'Proxying through backend');

    // 3. Save to backend + get proxy URL
    const glbUrl = finalData.model_urls.glb;
    const saveRes = await fetch(`${BACKEND}/api/meshy/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ glb_url: glbUrl, prompt: settings.prompt, task_id: taskId })
    });
    const saveData = await saveRes.json();

    // Use saved URL if available, otherwise proxy
    const loadUrl = saveData.localUrl || `${BACKEND}/api/meshy/download?url=${encodeURIComponent(glbUrl)}`;

    // 4. Load into scene
    loader.load(loadUrl, (gltf) => {
      displayModel(gltf.scene);
      hideStatus();
      meshyBtn.disabled = false;
      logMeshy('✅ Model loaded!');

      addGeneratedModel({
        prompt: settings.prompt,
        style: settings.art_style,
        taskId,
        proxyUrl: loadUrl,
        localPath: saveData.localPath || null
      });
    }, undefined, (err) => {
      // Fallback: try direct proxy
      logMeshy('Save failed, trying direct proxy...');
      const fallbackUrl = `${BACKEND}/api/meshy/download?url=${encodeURIComponent(glbUrl)}`;
      loader.load(fallbackUrl, (gltf) => {
        displayModel(gltf.scene);
        hideStatus();
        meshyBtn.disabled = false;
        logMeshy('✅ Model loaded via proxy!');
        addGeneratedModel({
          prompt: settings.prompt, style: settings.art_style,
          taskId, proxyUrl: fallbackUrl, localPath: null
        });
      }, undefined, (err2) => {
        logMeshy(`Failed: ${err2.message}`);
        hideStatus();
        meshyBtn.disabled = false;
      });
    });

  } catch (err) {
    logMeshy(`Error: ${err.message}`);
    hideStatus();
    meshyBtn.disabled = false;
  }
});

// ─── FPS Walk Mode ───────────────────────────────────────────────────────────
let fpsMode = false;
let flyMode = false;
const fpsKeys = {};
const fpsVelocity = new THREE.Vector3();

// ─── Ball Shooter ────────────────────────────────────────────────────────────
let _ballShooter = null;
const _ballRaycaster = new THREE.Raycaster();
const _ballRayDir = new THREE.Vector3();

function _raycastCollision(origin, direction, maxDistance) {
  _ballRaycaster.set(origin, _ballRayDir.copy(direction).normalize());
  _ballRaycaster.far = maxDistance;
  const hits = [];

  // Use DoubleSide so we catch backfaces when a ball is marginally inside a surface.
  // Temporarily swap side on each mesh, restore after.
  const castMesh = (c) => {
    if (!c.isMesh) return;
    const prev = c.material.side;
    c.material.side = THREE.DoubleSide;
    _ballRaycaster.intersectObject(c, false, hits);
    c.material.side = prev;
  };
  if (_voxelGlbScene) _voxelGlbScene.traverse(castMesh);
  if (_splatCage)     _splatCage.traverse(castMesh);
  castMesh(_floorSlab);

  if (!hits.length) return null;
  hits.sort((a, b) => a.distance - b.distance);
  const h = hits[0];

  // face.normal is in local space — transform to world space
  const worldNormal = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize();
  // The navigable-region mesh can have inward-pointing normals; always flip so the
  // normal opposes the incoming ray (faces the ball).
  if (worldNormal.dot(direction) > 0) worldNormal.negate();

  return { point: h.point, normal: worldNormal, distance: h.distance };
}

function _initBallShooter() {
  if (_ballShooter) return;
  _ballShooter = createBallShooter(scene, _raycastCollision);
}

// Shoot on left-click while pointer is locked in FPS mode
document.addEventListener('mousedown', (e) => {
  if (!fpsMode || document.pointerLockElement !== vp || e.button !== 0) return;
  _initBallShooter();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  _ballShooter.shoot(camera.position.clone(), dir);
});

// B key — clear all balls
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyB' && fpsMode) _ballShooter?.clear();
});
const FPS_WALK_SPEED = 4;   // m/s — fed into physics inputVelocity
const FPS_RUN_SPEED  = 8;
const FPS_FLY_SPEED  = 20;  // direct camera move, no physics
const FPS_JUMP_FORCE = 8;   // upward impulse applied to stateVelocity
const _fpsEuler = new THREE.Euler(0, 0, 0, 'YXZ');
let savedOrbitPos = new THREE.Vector3();
let savedOrbitTarget = new THREE.Vector3();
let savedFov = 45;

// FPS HUD overlay
const fpsHud = document.createElement('div');
fpsHud.id = 'fps-hud';
fpsHud.style.cssText = `
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 9000;
  height: 36px; display: none; align-items: center; justify-content: center; gap: 24px;
  background: linear-gradient(180deg, transparent, rgba(0,8,16,0.85));
  font-family: 'Courier New', monospace; font-size: 11px;
  color: rgba(255,255,255,0.5); pointer-events: none;
`;
fpsHud.innerHTML = `
  <span><span style="color:#22d3ee;font-weight:bold">WASD</span> Move</span>
  <span><span style="color:#22d3ee;font-weight:bold">Mouse</span> Look</span>
  <span><span style="color:#eab308;font-weight:bold">Shift</span> Run</span>
  <span><span style="color:#eab308;font-weight:bold">Space</span> Jump</span>
  <span><span style="color:#22c55e;font-weight:bold">F</span> Fly/Walk</span>
  <span><span style="color:#ef4444;font-weight:bold">2</span> Exit FPS</span>
  <span id="fps-fly-label" style="color:#22c55e;display:none">✈ FLY</span>
  <span id="fps-walk-label" style="color:#eab308;display:none">🦶 WALK</span>
`;
document.body.appendChild(fpsHud);

// Mode label
const modeLabel = document.createElement('div');
modeLabel.style.cssText = `
  position: fixed; top: 12px; right: 16px; z-index: 9000;
  padding: 6px 16px; border-radius: 4px; font-family: 'Courier New', monospace;
  font-size: 12px; font-weight: bold; letter-spacing: 2px;
  text-transform: uppercase; pointer-events: none; display: none;
  background: rgba(34,211,238,0.15); color: #22d3ee; border: 1px solid rgba(34,211,238,0.3);
`;
document.body.appendChild(modeLabel);

function enterFPSMode() {
  if (fpsMode) return;
  fpsMode = true;
  flyMode = true;

  savedOrbitPos.copy(camera.position);
  savedOrbitTarget.copy(controls.target);
  savedFov = camera.fov;

  camera.fov = 75;
  camera.updateProjectionMatrix();
  camera.rotation.order = 'YXZ';

  controls.enabled = false;

  // Sync physics player to current camera position so fly→walk transition is seamless
  physics.setPlayerPosition(camera.position.x, camera.position.y, camera.position.z);

  fpsHud.style.display = 'flex';
  modeLabel.textContent = '🎮 FPS — FLY';
  modeLabel.style.display = 'block';
  document.getElementById('fps-fly-label').style.display = 'inline';
  const _wl = document.getElementById('fps-walk-label');
  if (_wl) _wl.style.display = 'none';

  vp.requestPointerLock();
}

function exitFPSMode() {
  if (!fpsMode) return;
  fpsMode = false;
  flyMode = false;

  _ballShooter?.clear();

  // Exit pointer lock
  if (document.pointerLockElement) document.exitPointerLock();

  // Restore orbit controls
  controls.enabled = true;

  // Keep current position as new orbit center
  const lookDir = new THREE.Vector3();
  camera.getWorldDirection(lookDir);
  controls.target.copy(camera.position).addScaledVector(lookDir, 3);
  controls.update();

  // Restore FOV
  camera.fov = savedFov;
  camera.updateProjectionMatrix();

  // Hide HUD
  fpsHud.style.display = 'none';
  modeLabel.textContent = '🔄 ORBIT MODE';
  setTimeout(() => { modeLabel.style.display = 'none'; }, 1500);

  fpsVelocity.set(0, 0, 0);
}

// Key handlers for FPS mode
document.addEventListener('keydown', (e) => {
  fpsKeys[e.code] = true;

  if (e.code === 'KeyP' && !fpsMode) {
    _setCollisionDebug(!_collisionDebug);
  } else if (e.code === 'Digit1' && !fpsMode) {
    enterFPSMode();
  } else if (e.code === 'Digit2' && fpsMode) {
    exitFPSMode();
  } else if (e.code === 'KeyF' && fpsMode) {
    flyMode = !flyMode;
    if (!flyMode) {
      physics.setPlayerPosition(camera.position.x, camera.position.y, camera.position.z);
      modeLabel.textContent = '🎮 FPS — WALK';
    } else {
      modeLabel.textContent = '🎮 FPS — FLY';
    }
    document.getElementById('fps-fly-label').style.display = flyMode ? 'inline' : 'none';
    const walkLabel = document.getElementById('fps-walk-label');
    if (walkLabel) walkLabel.style.display = flyMode ? 'none' : 'inline';
  } else if (e.code === 'Digit3') {
    cursorEffectsEnabled = !cursorEffectsEnabled;
    cursorGlow.visible = cursorEffectsEnabled && cursorHit;
    modeLabel.textContent = cursorEffectsEnabled ? '✨ CURSOR FX ON' : '✨ CURSOR FX OFF';
    modeLabel.style.display = 'block';
    modeLabel.style.background = cursorEffectsEnabled ? 'rgba(34,211,238,0.15)' : 'rgba(239,68,68,0.15)';
    modeLabel.style.color = cursorEffectsEnabled ? '#22d3ee' : '#ef4444';
    modeLabel.style.borderColor = cursorEffectsEnabled ? 'rgba(34,211,238,0.3)' : 'rgba(239,68,68,0.3)';
    setTimeout(() => { if (!fpsMode) modeLabel.style.display = 'none'; }, 1500);
    console.log(`[Library] Cursor effects: ${cursorEffectsEnabled ? 'ON' : 'OFF'}`);
  }
});

document.addEventListener('keyup', (e) => {
  fpsKeys[e.code] = false;
});

// Mouse look for FPS mode
document.addEventListener('mousemove', (e) => {
  if (!fpsMode || document.pointerLockElement !== vp) return;
  camera.rotation.y -= e.movementX / 500;
  camera.rotation.x -= e.movementY / 500;
  camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.rotation.x));
});

// Click to re-lock pointer in FPS mode
vp.addEventListener('click', () => {
  if (fpsMode && document.pointerLockElement !== vp) {
    vp.requestPointerLock();
  }
});

// FPS movement update
function updateFPS(dt) {
  if (!fpsMode) return;

  const isRunning = fpsKeys['ShiftLeft'] || fpsKeys['ShiftRight'];

  if (flyMode) {
    // Fly — direct camera movement, no physics
    const speed = FPS_FLY_SPEED;
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    camera.getWorldDirection(forward);
    right.crossVectors(forward, camera.up).normalize();
    const move = new THREE.Vector3();
    if (fpsKeys['KeyW']) move.addScaledVector(forward, 1);
    if (fpsKeys['KeyS']) move.addScaledVector(forward, -1);
    if (fpsKeys['KeyD']) move.addScaledVector(right, 1);
    if (fpsKeys['KeyA']) move.addScaledVector(right, -1);
    if (fpsKeys['Space']) move.y += 1;
    if (fpsKeys['KeyC'] || fpsKeys['ControlLeft']) move.y -= 1;
    if (move.lengthSq() > 0) move.normalize();
    camera.position.addScaledVector(move, speed * dt);
    // Keep physics in sync so fly→walk transition doesn't teleport
    physics.setPlayerPosition(camera.position.x, camera.position.y, camera.position.z);
  } else {
    // Walk — physics handles gravity, floor, and wall sliding
    const speed = isRunning ? FPS_RUN_SPEED : FPS_WALK_SPEED;
    _fpsEuler.set(0, camera.rotation.y, 0);
    const moveX = (fpsKeys['KeyD'] ? 1 : 0) - (fpsKeys['KeyA'] ? 1 : 0);
    const moveZ = (fpsKeys['KeyS'] ? 1 : 0) - (fpsKeys['KeyW'] ? 1 : 0);
    physics.inputVelocity.set(moveX, 0, moveZ);
    if (physics.inputVelocity.lengthSq() > 0) {
      physics.inputVelocity.normalize().applyEuler(_fpsEuler).multiplyScalar(speed);
    }
    if (physics.getPlayerOnFloor() && fpsKeys['Space']) {
      physics.playerVelocity.y = FPS_JUMP_FORCE;
    }
    physics.updatePlayer(dt, camera, false);
  }

  _ballShooter?.update(dt);
}

// ─── Cursor Raycasting ───────────────────────────────────────────────────────
function updateCursorEffects() {
  if (!cursorEffectsEnabled || !activeSplatMesh || fpsMode) {
    cursorGlow.visible = false;
    return;
  }

  // Raycast from mouse into the scene
  raycaster.setFromCamera(mouse, camera);

  // Try to hit the splat mesh
  const intersects = [];
  activeSplatMesh.raycast(raycaster, intersects);

  if (intersects.length > 0) {
    cursorHit = true;
    cursorWorldPos.copy(intersects[0].point);

    // Move the SplatEditSdf to the cursor hit position
    cursorSdf.position.copy(cursorWorldPos);

    // Move the visual glow sphere
    cursorGlow.position.copy(cursorWorldPos);
    cursorGlow.visible = true;

    // Pulse the glow with time
    const t = performance.now() / 1000;
    const pulse = 0.12 + Math.sin(t * 3) * 0.05;
    cursorGlow.material.opacity = pulse;
    cursorGlow.scale.setScalar(1.0 + Math.sin(t * 4) * 0.15);
  } else {
    cursorHit = false;
    cursorGlow.visible = false;
  }
}

// ─── Animation Loop ──────────────────────────────────────────────────────────
const clock = new Timer();
function animate() {
  requestAnimationFrame(animate);
  clock.update();
  const dt = clock.getDelta();
  if (currentGroup?.userData?.mixer) currentGroup.userData.mixer.update(dt);

  if (tankGame) {
    tankGame.update(dt);
  } else if (fpsMode) {
    updateFPS(dt);
  } else {
    controls.update();
  }

  // Update cursor interaction effects
  updateCursorEffects();

  renderer.render(scene, camera);
}
animate();

// ─── World Upload ────────────────────────────────────────────────────────────
let _pendingSplatEntry = null;
let _activeObjectUrls = [];

window.addEventListener('beforeunload', () => {
  _activeObjectUrls.forEach(u => URL.revokeObjectURL(u));
});

function _makeObjectUrl(file) {
  const url = URL.createObjectURL(file);
  _activeObjectUrls.push(url);
  return url;
}

function _loadUploadedSplat(url, name, flipY, file = null) {
  clearCurrent();
  showStatus('LOADING GAUSSIAN SPLAT...', name);
  _activateWorldCollision(null);
  const uploadStatus = document.getElementById('upload-status');
  try {
    const splatMesh = new SplatMesh({
      url,
      editable: true,
      onLoad: (mesh) => {
        hideStatus();
        try {
          const box = mesh.getBoundingBox?.();
          if (box && !box.isEmpty()) {
            _syncFloorSlab(box); // pin global safety floor to real scene floor level
            _disposeSplatCage();
            _splatCage = _buildBboxCage(box);
            scene.add(_splatCage);
            _bvhWorld(_splatCage);
            setTimeout(() => {
              _splatCage?.updateMatrixWorld(true);
              _activateWorldCollision(_splatCage, box);
              if (uploadStatus) uploadStatus.textContent = `Splat loaded — generating collision mesh…`;
              tankGame?.dispose();
              tankGame = createTankGame({ scene, camera, controls, box });
            }, 50);

            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            _frameTo(center, Math.max(size.x, size.y, size.z));

            if (file) {
              _activeSplatInfo = { plyPath: null, file, box, flipY };
              // Upload to server for proper voxel collision (uses real bbox-derived seed)
              _uploadAndGenCollision(file, box, flipY).catch(console.error);
            } else {
              // File-system path — use existing splat-transform shim
              _tryGenCollision(url, box);
            }
          }
        } catch (e) {
          if (uploadStatus) uploadStatus.textContent = `✓ ${name} — floor only. Press 1 → FPS, F → walk.`;
        }
      },
    });
    if (flipY) splatMesh.quaternion.set(1, 0, 0, 0);
    splatMesh.edits = [cursorEdit];
    activeSplatMesh = splatMesh;
    scene.add(splatMesh);
  } catch (err) {
    console.error('[Upload] Splat failed:', err);
    hideStatus();
    if (uploadStatus) uploadStatus.textContent = `Error loading ${name}`;
  }
}

function _loadUploadedGlb(url, name, flipY) {
  const uploadStatus = document.getElementById('upload-status');
  if (uploadStatus) uploadStatus.textContent = `Loading ${name}…`;
  showStatus('LOADING WORLD...', name);
  gltfLoader.load(url, (gltf) => {
    if (flipY) gltf.scene.quaternion.set(1, 0, 0, 0);
    displayModel(gltf.scene);
    hideStatus();
    if (uploadStatus) uploadStatus.textContent = `Building collision…`;
    const n = _bvhWorld(gltf.scene);
    setTimeout(() => {
      gltf.scene.updateMatrixWorld(true);
      _activateWorldCollision(gltf.scene);
      if (uploadStatus) uploadStatus.textContent = `✓ ${name} — ${n} meshes. Press 1 → FPS, F → walk.`;
    }, 100);
  }, undefined, (err) => {
    console.error('[Upload] GLB failed:', err);
    hideStatus();
    if (uploadStatus) uploadStatus.textContent = `Error loading ${name}`;
  });
}

document.getElementById('world-upload-input')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  const url = _makeObjectUrl(file);
  const flipY = document.getElementById('flip-y-upload')?.checked ?? true;
  const colliderRow = document.getElementById('collider-row');
  const uploadStatus = document.getElementById('upload-status');
  if (ext === 'ply') {
    if (colliderRow) colliderRow.style.display = 'block';
    _pendingSplatEntry = { url, name: file.name, flipY };
    _loadUploadedSplat(url, file.name, flipY, file); // pass File for server-side collision gen
  } else if (ext === 'glb' || ext === 'gltf') {
    if (colliderRow) colliderRow.style.display = 'none';
    _pendingSplatEntry = null;
    _loadUploadedGlb(url, file.name, flipY);
  } else {
    if (uploadStatus) uploadStatus.textContent = `Unsupported: ${ext}. Use .glb or .ply`;
  }
});

document.getElementById('collider-upload-input')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file || !_pendingSplatEntry) return;
  const colliderUrl = _makeObjectUrl(file);
  const uploadStatus = document.getElementById('upload-status');
  if (uploadStatus) uploadStatus.textContent = `Loading collider: ${file.name}…`;
  gltfLoader.load(colliderUrl, (gltf) => {
    if (_pendingSplatEntry.flipY) gltf.scene.quaternion.set(1, 0, 0, 0);
    gltf.scene.traverse(n => { if (n.isMesh) n.visible = false; });
    const n = _bvhWorld(gltf.scene);
    setTimeout(() => {
      gltf.scene.updateMatrixWorld(true);
      _activateWorldCollision(gltf.scene);
      if (uploadStatus) uploadStatus.textContent = `✓ Collider: ${n} meshes. Press 1 → FPS, F → walk.`;
    }, 100);
  }, undefined, (err) => {
    console.error('[Upload] Collider failed:', err);
    if (uploadStatus) uploadStatus.textContent = 'Error loading collider.';
  });
});

// ─── Collider control buttons ─────────────────────────────────────────────────
document.getElementById('btn-toggle-collision')?.addEventListener('click', () => _setCollisionDebug(!_collisionDebug));
document.getElementById('btn-delete-collision')?.addEventListener('click', () => _deleteCollisionMesh());
document.getElementById('btn-regen-collision')?.addEventListener('click', () => _regenCollisionMesh().catch(console.error));

// ─── Restart Button ──────────────────────────────────────────────────────────
document.getElementById('btn-restart-server')?.addEventListener('click', async () => {
  if (confirm('Restart Vite dev server?')) {
    logMeshy('Restarting...');
    try {
      await fetch('/__restart_server');
      setTimeout(() => window.location.reload(), 3000);
    } catch (e) {
      logMeshy('Restart failed.');
    }
  }
});
