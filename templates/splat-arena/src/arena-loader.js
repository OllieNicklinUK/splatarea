// arena-loader.js
// Shared initialiser for all SplatArena game pages.
//
// Flow:
//   1. Set up Three.js renderer + camera + scene + lights
//   2. Discover PLY file in game's public folder
//   3. Load PLY via SparkRenderer + SplatMesh
//   4. Show floor-setup panel (skipped if user has a locked config saved)
//   5. Call onSplatReady with confirmed floorY/spawnCenter/spawnRadius
//   6. Background: WebGPU voxelization → call onColliderReady

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import {
  computeBoundsTree, disposeBoundsTree, acceleratedRaycast,
} from 'three-mesh-bvh';
import { generateCollision, isWebGPUAvailable } from './shared/collision/client-collider.js';
import { createFloorSetup } from './floor-setup.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const _gltfLoader = new GLTFLoader();

// ─── Public API ───────────────────────────────────────────────────────────────

export async function initArena({
  config,          // { splatUrl, colliderUrl, flipY, floorY, spawnCenter, spawnRadius }
  game,            // 'fps' | 'people' | 'flight' | 'racing' — used for localStorage key
  hasSpawnArea,    // true if this game uses a spawn-area circle (people mode)
  canvas,          // HTMLCanvasElement
  onStatus,        // (msg: string) => void — progress messages
  onSplatReady,    // ({ scene, camera, renderer, spark, controls, box, floorY, spawnCenter, spawnRadius })
  onColliderReady, // ({ voxelMesh, floorY, spawnCenter, spawnRadius }) — BVH mesh ready
}) {
  onStatus('Initialising renderer…');

  // ── Three.js ──────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a12);

  const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 5000);
  camera.position.set(0, 8, 20);

  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.update();

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const sun = new THREE.DirectionalLight(0xffd5a0, 1.3);
  sun.position.set(15, 28, 10);
  scene.add(sun);

  window.addEventListener('resize', () => {
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  });

  // Render loop for the loading/setup phase — stops once the game's own loop takes over
  let _setupLoopActive = true;
  (function loop() {
    if (!_setupLoopActive) return;
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();

  // ── Discover PLY ─────────────────────────────────────────────────────────
  onStatus('Finding scene file…');
  const plyUrl = await _discoverPly(config);
  if (!plyUrl) { _showNoSplatMessage('*.ply'); return; }
  onStatus(`Loading ${plyUrl.split('/').pop()}…`);

  const colUrl = config.colliderUrl ? _resolveGameUrl(config.colliderUrl) : null;

  // ── Create floor-setup manager ────────────────────────────────────────────
  const floorSetup = createFloorSetup({
    scene, camera, controls,
    game: game || _gameFromPath(),
  });

  // ── Load splat ────────────────────────────────────────────────────────────
  const splatMesh = new SplatMesh({
    url:      plyUrl,
    editable: false,
    onLoad: async (mesh) => {
      floorSetup.setSplatMesh(mesh);
      try {
        let box = mesh.getBoundingBox?.() ?? new THREE.Box3(
          new THREE.Vector3(-10, -5, -10), new THREE.Vector3(10, 5, 10));

        if (box.isEmpty()) box.set(new THREE.Vector3(-10,-5,-10), new THREE.Vector3(10,5,10));

        // If a splat offset is applied, transform the local PLY bounding box to world space.
        // Rotation (180° around X): X unchanged, Y negated, Z negated. Then add offset.
        const { x: ox, y: oy, z: oz } = _splatOffset;
        if (ox !== 0 || oy !== 0 || oz !== 0) {
          const { min: mn, max: mx } = box;
          box = new THREE.Box3(
            new THREE.Vector3(mn.x + ox, -mx.y + oy, -mx.z + oz),
            new THREE.Vector3(mx.x + ox, -mn.y + oy, -mn.z + oz),
          );
        }

        _frameCamera(camera, controls, box);

        // Hide loading overlay — splat is visible, setup panel takes over
        const loadingEl = document.getElementById('loading');
        if (loadingEl) {
          loadingEl.style.opacity = '0';
          setTimeout(() => { if (loadingEl) loadingEl.style.display = 'none'; }, 500);
        }

        // Show floor alignment (resolves immediately if locked config exists)
        const setupCfg = await floorSetup.show(box, plyUrl);
        const { floorY, spawnX, spawnZ, spawnRadius, scale } = setupCfg;
        const spawnCenter = { x: spawnX, z: spawnZ };

        _setupLoopActive = false;  // hand rendering over to the game's loop
        onSplatReady({ scene, camera, renderer, spark, controls, box, floorY, spawnCenter, spawnRadius, scale });

        // Background collider generation
        _startColliderGen({
          config, box, plyUrl, colUrl, scene, onStatus,
          onColliderReady,
          onAutoFloor:    (y)    => floorSetup.updateAutoFloor(y),
          onVoxelMesh:    (mesh) => floorSetup.setVoxelMesh(mesh),
        });

        // If user re-edits floor after game starts, notify via onColliderReady-style callback
        floorSetup.onReEdit((cfg) => {
          onSplatReady({ scene, camera, renderer, spark, controls, box,
            floorY:      cfg.floorY,
            spawnCenter: { x: cfg.spawnX, z: cfg.spawnZ },
            spawnRadius: cfg.spawnRadius,
            scale:       cfg.scale,
          });
        });

      } catch (e) {
        console.error('[arena-loader] onLoad error:', e);
        onStatus('Error: ' + (e.message ?? String(e)).slice(0, 60));
      }
    },
  });

  if (config.flipY !== false) splatMesh.quaternion.set(1, 0, 0, 0);

  // Read the pre-computed splat offset from localStorage (written by the collision tool
  // or from URL params). Repositions the splat so the floor lands at world Y=0 and the
  // scene is centred at the world origin, matching the normalised collision mesh.
  const _plyName  = plyUrl.split('/').pop();
  const _game     = game || _gameFromPath();
  const _lsKey    = `sa-cfg:${_game}:${_plyName}`;
  let _splatOffset = { x: 0, y: 0, z: 0 };
  try {
    const _saved = JSON.parse(localStorage.getItem(_lsKey));
    if (_saved?.splatOffsetX != null) {
      _splatOffset = { x: _saved.splatOffsetX, y: _saved.splatOffsetY, z: _saved.splatOffsetZ };
      splatMesh.position.set(_splatOffset.x, _splatOffset.y, _splatOffset.z);
    }
  } catch {}

  scene.add(splatMesh);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Resolve the PLY URL to use for this game page.
// Priority: config.splatUrl (direct .ply → load from URL) →
//           config.splatUrl (non-PLY e.g. superspl.at → mirror is uploaded.ply) →
//           /__find-ply scan → common filenames.
async function _discoverPly(config) {
  // 1a. Direct PLY URL — load from it straight away
  if (config.splatUrl && /\.ply(\?|$)/i.test(config.splatUrl)) {
    const url = /^https?:\/\//i.test(config.splatUrl)
      ? config.splatUrl
      : _resolveGameUrl(config.splatUrl);
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok) return url;
    } catch {}
  }

  // 1b. Non-PLY remote URL (e.g. superspl.at) — the collision mapper has already
  //     decoded and mirrored it to uploaded.ply; skip straight to that file.
  if (config.splatUrl && !/\.ply(\?|$)/i.test(config.splatUrl)) {
    const mirror = _resolveGameUrl('./uploaded.ply');
    try {
      const r = await fetch(mirror, { method: 'HEAD' });
      if (r.ok) return mirror;
    } catch {}
  }

  // 2. Ask the Vite dev-server ply-finder plugin (localhost only — skip in production)
  const _host = window.location.hostname;
  if (_host === 'localhost' || _host === '127.0.0.1') {
    const game = window.location.pathname.replace(/\/$/, '').split('/').pop();
    try {
      const r = await fetch(`/__find-ply?game=${encodeURIComponent(game)}`);
      if (r.ok) {
        const { plyPath } = await r.json();
        if (plyPath) return plyPath;
      }
    } catch {}
  }

  // 3. Fallback: probe common filenames relative to current page
  for (const name of ['scene.ply', 'arena.ply', 'splat.ply']) {
    const url = _resolveGameUrl(`./${name}`);
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok) return url;
    } catch {}
  }

  return null;
}

function _gameFromPath() {
  return window.location.pathname.replace(/\/$/, '').split('/').pop() || 'game';
}

function _frameCamera(camera, controls, box) {
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const d = Math.max(size.x, size.y, size.z) * 1.4;
  camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.6, 1).normalize(), d);
  controls.target.copy(center);
  controls.update();
}

// Resolve a config path like './scene.sog' to an absolute URL based on the
// current page location (e.g. http://host/fps/ → http://host/fps/scene.sog).
function _resolveGameUrl(path) {
  if (!path) return null;
  return new URL(path, window.location.href).pathname;
}

async function _startColliderGen({ config, box, plyUrl, colUrl, scene, onStatus, onColliderReady, onAutoFloor, onVoxelMesh }) {
  const center  = box.getCenter(new THREE.Vector3());
  const size    = box.getSize(new THREE.Vector3());
  const spawnCx = center.x;
  const spawnCz = center.z;
  const spawnR  = Math.max(2, Math.min(size.x, size.z) * 0.4);

  // ── Option A: pre-baked collider GLB ─────────────────────────────────────
  if (colUrl) {
    onStatus('Loading pre-built collider…');
    try {
      const gltf = await _loadGltf(colUrl);
      const voxelMesh = _activateCollider(gltf.scene, scene, config.flipY);
      const detectedFloor = floorY ?? _estimateFloorFromMesh(voxelMesh, box);
      onColliderReady({
        voxelMesh,
        floorY:      detectedFloor,
        spawnCenter: { x: spawnCx, z: spawnCz },
        spawnRadius: spawnR,
      });
      onStatus('✓ Collider loaded');
    } catch (e) {
      console.warn('[arena-loader] collider GLB load failed:', e);
      _fallbackBboxCollider({ box, config, scene, floorY, spawnCx, spawnCz, spawnR, onStatus, onColliderReady });
    }
    return;
  }

  // ── Option A2: auto-detected pre-baked GLB (e.g. written by the collision mapper) ──
  // If a .collision.glb sits next to the PLY (same name, different extension),
  // load it immediately — no voxelization needed.
  if (plyUrl && !colUrl) {
    const autoGlb = plyUrl.replace(/\.ply$/i, '.collision.glb');
    try {
      const probe = await fetch(autoGlb, { method: 'HEAD' });
      if (probe.ok) {
        onStatus('Loading pre-built collision mesh…');
        const gltf      = await _loadGltf(autoGlb);
        const voxelMesh = _activateCollider(gltf.scene, scene, config.flipY);
        const floorY    = center.y - size.y * 0.35;
        onAutoFloor?.(floorY);
        onVoxelMesh?.(voxelMesh);
        onColliderReady({ voxelMesh, floorY, spawnCenter: { x: spawnCx, z: spawnCz }, spawnRadius: spawnR });
        onStatus('✓ Collision mesh ready');
        return;
      }
    } catch {}
  }

  // ── Option B: server-side Node.js voxelizer (primary on localhost) ──────────
  // Produces finer, cleaner meshes than the WebGPU path at the cost of a
  // one-time server round-trip. The result is cached as scene.collision.glb
  // next to the PLY, so subsequent loads are instant.
  if (plyUrl) {
    const host    = window.location.hostname;
    const isLocal = host === '127.0.0.1' || host === 'localhost';

    if (isLocal) {
      try {
        const result = await _serverVoxelizeFallback({
          plyUrl, box, config, scene, onStatus, onAutoFloor, onVoxelMesh,
        });
        onColliderReady({
          voxelMesh:   result.voxelMesh,
          floorY:      result.floorY,
          spawnCenter: { x: spawnCx, z: spawnCz },
          spawnRadius: spawnR,
        });
        return;
      } catch (e) {
        console.warn('[arena-loader] server voxelizer failed:', e);
        onStatus('Server voxelizer failed — trying WebGPU…');
      }
    }

    // ── Option B2: WebGPU in-browser (fallback / non-localhost) ──────────────
    const webgpu = isWebGPUAvailable();
    if (webgpu) {
      onStatus('Building collision mesh (WebGPU)…');
      try {
        const maxDim    = Math.max(size.x, size.y, size.z);
        const voxelSize = Math.max(0.3, Math.min(1.5, maxDim / 100));

        // seed: one voxel above the floor in PLY space
        const flipY = config.flipY !== false;
        const seedY = flipY ? -(box.min.y + 1.0) : (box.min.y + 1.0);
        const seed  = [center.x, seedY, flipY ? -center.z : center.z];

        const result = await generateCollision({
          plyUrl,
          seedPos:          seed,
          voxelSize,
          opacityThreshold: 0.3,
          onLog: msg => onStatus(msg.slice(0, 60)),
        });

        const { positions, indices, plyFloorY } = result;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
        geo.computeVertexNormals();

        // Sink 0.3 m so floor voxels sit under physics floor
        const ySink = flipY ? 0.3 : -0.3;
        const pa = geo.getAttribute('position');
        for (let i = 0; i < pa.count; i++) pa.setY(i, pa.getY(i) + ySink);

        const voxelMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
        }));
        if (flipY) voxelMesh.quaternion.set(1, 0, 0, 0);

        scene.add(voxelMesh);
        voxelMesh.updateMatrixWorld(true);
        _bvhMesh(voxelMesh);
        onVoxelMesh?.(voxelMesh);

        const worldFloorY = plyFloorY != null
          ? (flipY ? -plyFloorY : plyFloorY)
          : center.y - size.y * 0.35;
        onAutoFloor?.(worldFloorY);

        onColliderReady({
          voxelMesh,
          floorY:      worldFloorY,
          spawnCenter: { x: spawnCx, z: spawnCz },
          spawnRadius: spawnR,
        });
        onStatus('✓ Collision mesh ready (WebGPU)');
        return;
      } catch (e) {
        console.warn('[arena-loader] WebGPU collider failed:', e);
        onStatus('WebGPU failed — using bbox walls');
      }
    } else {
      onStatus('WebGPU unavailable — using bbox walls');
    }
  }

  // ── Option C: bbox walls fallback ─────────────────────────────────────────
  _fallbackBboxCollider({ box, config, scene, spawnCx, spawnCz, spawnR, onStatus, onColliderReady, onAutoFloor, onVoxelMesh });
}

function _fallbackBboxCollider({ box, config, scene, spawnCx, spawnCz, spawnR, onStatus, onColliderReady, onAutoFloor, onVoxelMesh }) {
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const walls  = _buildBboxWalls(box);
  scene.add(walls);
  walls.updateMatrixWorld(true);
  _bvhMesh(walls);
  const detectedFloor = center.y - size.y * 0.35;
  onAutoFloor?.(detectedFloor);
  onVoxelMesh?.(walls);
  onColliderReady({
    voxelMesh:   walls,
    floorY:      detectedFloor,
    spawnCenter: { x: spawnCx, z: spawnCz },
    spawnRadius: spawnR,
  });
  onStatus('✓ Bbox walls active (no WebGPU/PLY)');
}

function _activateCollider(gltfScene, scene, flipY) {
  if (flipY !== false) gltfScene.quaternion.set(1, 0, 0, 0);
  gltfScene.traverse(n => {
    if (n.isMesh) {
      n.material = new THREE.MeshBasicMaterial({
        colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
      });
    }
  });
  scene.add(gltfScene);
  gltfScene.updateMatrixWorld(true);
  _bvhMesh(gltfScene);
  return gltfScene;
}

function _estimateFloorFromMesh(mesh, box) {
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  return center.y - size.y * 0.35;
}

function _bvhMesh(root) {
  root.traverse(n => {
    if (n.isMesh) { try { n.geometry.computeBoundsTree(); } catch {} }
  });
}

function _buildBboxWalls(box) {
  const mat = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
  });
  const cx = (box.min.x + box.max.x) / 2;
  const cy = (box.min.y + box.max.y) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const w  = box.max.x - box.min.x + 4;
  const h  = box.max.y - box.min.y + 4;
  const d  = box.max.z - box.min.z + 4;
  const t  = 0.5;
  const grp = new THREE.Group();
  const add = (gw, gh, gd, px, py, pz) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(gw, gh, gd), mat.clone());
    m.position.set(px, py, pz);
    grp.add(m);
  };
  add(w + 20, 2, d + 20, cx, box.min.y - 1, cz);   // floor
  add(w, h, t,   cx, cy, box.min.z - t);             // north wall
  add(w, h, t,   cx, cy, box.max.z + t);             // south wall
  add(t, h, d,   box.min.x - t, cy, cz);             // west wall
  add(t, h, d,   box.max.x + t, cy, cz);             // east wall
  return grp;
}

function _loadGltf(url) {
  return new Promise((resolve, reject) =>
    _gltfLoader.load(url, resolve, undefined, reject));
}

// ── Server-side voxelizer fallback ───────────────────────────────────────────
// Calls the /api/gen-collision Vite middleware (standalone/scripts/ply-voxelizer.mjs).
// The server resolves plyUrl to the public folder, runs the Node.js voxelizer,
// caches the GLB alongside the PLY, and streams SSE progress back.
async function _serverVoxelizeFallback({ plyUrl, box, config, scene, onStatus, onAutoFloor, onVoxelMesh }) {
  onStatus('Building collision mesh (server)…');

  const center  = box.getCenter(new THREE.Vector3());
  const size    = box.getSize(new THREE.Vector3());
  const flipY   = config.flipY !== false;
  // Start fine (0.10 m) — the server auto-doubles until the grid fits in memory
  const voxSize = 0.10;

  // Seed in PLY-space coordinates — undo the 180° X-rotation Three.js applies (flipY)
  const seedX = center.x;
  const seedY = flipY ? -(box.min.y + 1.5) : (box.min.y + 1.5);
  const seedZ = flipY ? -center.z : center.z;

  const resp = await fetch('/api/gen-collision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plyUrl, seedX, seedY, seedZ, voxelFloor: voxSize, opacityThreshold: 0.3 }),
  });
  if (!resp.ok) throw new Error(`/api/gen-collision returned ${resp.status}`);

  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let glbUrl = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let ev;
      try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      if (ev.type === 'log')   onStatus(ev.text.slice(0, 60));
      if (ev.type === 'error') throw new Error(ev.text);
      if (ev.type === 'done')  { glbUrl = ev.url; if (ev.cached) onStatus('Loaded cached collision mesh'); }
    }
  }

  if (!glbUrl) throw new Error('Server voxelizer returned no GLB URL');
  onStatus('Loading collision mesh…');

  const gltf      = await _loadGltf(glbUrl);
  const voxelMesh = _activateCollider(gltf.scene, scene, config.flipY);
  const floorY    = center.y - size.y * 0.35;

  onAutoFloor?.(floorY);
  onVoxelMesh?.(voxelMesh);
  onStatus('✓ Collision mesh ready (server)');

  return { voxelMesh, floorY };
}

function _showNoSplatMessage(path) {
  const loadingEl = document.getElementById('loading');
  const statusEl  = document.getElementById('load-status');
  const spinnerEl = document.querySelector('.spinner');
  if (spinnerEl) spinnerEl.style.display = 'none';
  if (loadingEl) loadingEl.style.display = 'flex';
  if (statusEl) {
    statusEl.innerHTML = `
      <div style="color:#f59e0b;font-size:1rem;margin-bottom:8px">No splat file found</div>
      <div style="color:#64748b;font-size:0.8rem;line-height:1.7">
        Drop your <code style="color:#94a3b8">${path}</code><br>
        and (optionally) <code style="color:#94a3b8">${path.replace(/\.[^.]+$/, '.ply')}</code><br>
        into this game's folder, then reload.
      </div>`;
  }
}
