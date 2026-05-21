import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Viewer, SceneFormat } from '@mkkellogg/gaussian-splats-3d';
import { generateCollision as _webgpuCollision, isWebGPUAvailable } from './shared/collision/client-collider.js';

// ── UI refs ───────────────────────────────────────────────────────────────────
const dot          = document.getElementById('dot');
const statusText   = document.getElementById('status-text');
const dropzone     = document.getElementById('dropzone');
const hint         = document.getElementById('hint');
const logEl        = document.getElementById('log');
const viewportWrap = document.getElementById('viewport-wrap');
const scaleSlider  = document.getElementById('scale');
const scaleVal     = document.getElementById('scale-val');
const generateBtn  = document.getElementById('generate-btn');
const clearBtn     = document.getElementById('clear-btn');
const showMesh     = document.getElementById('show-mesh');
const meshOpacity  = document.getElementById('mesh-opacity');
const opacityVal   = document.getElementById('opacity-val');
const wireframe    = document.getElementById('wireframe');
const colorSwatch  = document.getElementById('color-swatch');
const voxelSize    = document.getElementById('voxel-size');
const opThresh     = document.getElementById('op-thresh');
const seedY        = document.getElementById('seed-y');
const urlInput     = document.getElementById('url-input');
const urlLoadBtn   = document.getElementById('url-load-btn');
const playBtn          = document.getElementById('play-btn');
const playFpsBtn       = document.getElementById('play-fps-btn');
const playPeopleBtn    = document.getElementById('play-people-btn');
const playKartBtn      = document.getElementById('play-kart-btn');
const playHint         = document.getElementById('play-hint');
const saveAlignmentBtn = document.getElementById('save-alignment-btn');
const zipRow         = document.getElementById('zip-row');
const zipNameEl      = document.getElementById('zip-name');
const clearZipBtn    = document.getElementById('clear-zip-btn');
const zipLoadBtn     = document.getElementById('zip-load-btn');
const viewSplatCb    = document.getElementById('view-splat');
const flipXCb        = document.getElementById('flip-x');
const flipYCb        = document.getElementById('flip-y');
const flipZCb        = document.getElementById('flip-z');
const canvas       = document.getElementById('viewport');

// ── Three.js setup ────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x111416);

// scene holds only the collision mesh overlay and lights — splat is rendered
// separately by the Viewer before this scene is composited on top
const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 1.5));

const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 2000);
camera.position.set(0, 2, 6);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;

// ── State ─────────────────────────────────────────────────────────────────────
let splatViewer   = null;
let splatBlobUrl  = null;
let collisionGroup= null;
let currentFile   = null;
let currentUrl    = null; // alternative to file — remote PLY or superspl.at URL
let currentZip    = null; // .voxel.zip for fast collision, bypasses PLY voxelization
let currentScale  = 1.0;
let currentFlipX  = false;
let currentFlipY  = false;
let currentFlipZ  = false;

// Auto-detected values from the collision mesh, passed to the racing game
let detectedFloorY      = null;
let detectedSpawnX      = 0;
let detectedSpawnZ      = 0;
let detectedSpawnRadius = 8;
let detectedSplatOffset = { x: 0, y: 0, z: 0 };
let detectedSplatUrl    = null; // original URL when loaded from remote source

// ── Resize ────────────────────────────────────────────────────────────────────
function resize() {
  const logH = logEl.offsetHeight;
  const w    = viewportWrap.clientWidth;
  const h    = viewportWrap.clientHeight - logH;
  if (w < 1 || h < 1) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewportWrap);
resize();

// ── Render loop ───────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  if (splatViewer) splatViewer.update();
  renderer.render(scene, camera);
}
animate();

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(text, cls = '') {
  const d = document.createElement('div');
  d.className = 'll' + (cls ? ` ${cls}` : '');
  d.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(type, text) {
  dot.className = `dot ${type}`;
  statusText.textContent = text;
}

// ── Scale ─────────────────────────────────────────────────────────────────────
function applyCollisionTransform() {
  if (!collisionGroup) return;
  collisionGroup.quaternion.set(0, 0, 0, 1); // identity — no rotation
  collisionGroup.scale.setScalar(currentScale);
}

// Helper: access scene 0 on the active Viewer's splatMesh
function _splatScene0() {
  return splatViewer?.splatMesh?.getScene?.(0) ?? null;
}

function applySplatTransform() {
  const sc = _splatScene0();
  if (!sc) return;
  sc.scale.set(
    currentScale * (currentFlipX ? -1 : 1),
    currentScale * (currentFlipY ? -1 : 1),
    currentScale * (currentFlipZ ? -1 : 1),
  );
}

function applyScale(s) {
  currentScale = s;
  scaleVal.textContent = `${s.toFixed(2)}×`;
  applySplatTransform();
  applyCollisionTransform();
}
scaleSlider.addEventListener('input', () => applyScale(parseFloat(scaleSlider.value)));

flipXCb.addEventListener('change', () => { currentFlipX = flipXCb.checked; applySplatTransform(); });
flipYCb.addEventListener('change', () => { currentFlipY = flipYCb.checked; applySplatTransform(); });
flipZCb.addEventListener('change', () => { currentFlipZ = flipZCb.checked; applySplatTransform(); });

viewSplatCb.addEventListener('change', () => {
  if (splatViewer) splatViewer.splatMesh.visible = viewSplatCb.checked;
});

// ── File loading ──────────────────────────────────────────────────────────────
function _makeSplatViewer() {
  const v = new Viewer({
    selfDrivenMode:         false,
    renderer:               renderer,
    camera:                 camera,
    useBuiltInControls:     false,
    gpuAcceleratedSort:     false,
    sharedMemoryForWorkers: false,
    dynamicScene:           true,
  });
  // splatMesh has no CPU-side bounding sphere — disable frustum culling so
  // Three.js never skips it during renderer.render(scene, camera).
  v.splatMesh.frustumCulled = false;
  scene.add(v.splatMesh);
  return v;
}

function loadFile(file) {
  currentFile = file;

  if (splatViewer) {
    if (splatViewer.splatMesh) scene.remove(splatViewer.splatMesh);
    splatViewer.dispose();
    splatViewer = null;
  }
  if (splatBlobUrl) { URL.revokeObjectURL(splatBlobUrl); splatBlobUrl = null; }
  clearCollision();

  detectedFloorY = null;
  splatBlobUrl = URL.createObjectURL(file);
  hint.style.display = 'none';
  dropzone.classList.add('has-file');
  dropzone.querySelector('.dz-label').textContent = file.name;
  setStatus('loading', `Loading ${file.name}…`);
  log(`Loading ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`);

  splatViewer = _makeSplatViewer();

  const fmt = /\.splat$/i.test(file.name) ? SceneFormat.Splat : SceneFormat.Ply;
  splatViewer.addSplatScene(splatBlobUrl, {
    format:                    fmt,
    splatAlphaRemovalThreshold: 5,
    showLoadingUI:             false,
    rotation:                  [0, 0, 0, 1],
  }).then(() => {
    setStatus('ready', `Loaded — ${file.name}`);
    log('Splat loaded.', 'ok');
    generateBtn.disabled = false;
  }).catch(err => {
    setStatus('error', 'Load failed');
    log(`Load error: ${err?.message ?? err}`, 'err');
  });
}

// ── Voxel zip loading ─────────────────────────────────────────────────────────
function loadZip(file) {
  currentZip = file;
  zipNameEl.textContent = file.name;
  zipRow.style.display = 'flex';
  generateBtn.disabled = false;
  log(`Voxel zip: ${file.name} (${(file.size / 1e6).toFixed(1)} MB) — collision will be generated from octree (fast).`);
  setStatus('ready', `Zip loaded — ${file.name}`);
}

clearZipBtn.addEventListener('click', () => {
  currentZip = null;
  zipRow.style.display = 'none';
  if (!currentFile && !currentUrl) generateBtn.disabled = true;
});

zipLoadBtn.addEventListener('click', () => {
  const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.zip' });
  inp.onchange = () => { if (inp.files[0]) loadZip(inp.files[0]); };
  inp.click();
});

// ── Drag & drop / click to browse ────────────────────────────────────────────
dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', ()  => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const files = [...e.dataTransfer.files];
  const plyFile = files.find(f => /\.(ply|splat)$/i.test(f.name));
  const zipFile = files.find(f => /\.voxel\.zip$/i.test(f.name) || (/\.zip$/i.test(f.name) && !plyFile));
  if (plyFile) loadFile(plyFile);
  if (zipFile) loadZip(zipFile);
  if (!plyFile && !zipFile) log('Please drop a .ply, .splat, or .voxel.zip file.', 'err');
});
dropzone.addEventListener('click', () => {
  const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.ply,.splat' });
  inp.onchange = () => { if (inp.files[0]) loadFile(inp.files[0]); };
  inp.click();
});

// ── URL input ─────────────────────────────────────────────────────────────────
function loadUrl(url) {
  url = url.trim();
  if (!url) return;
  currentUrl  = url;
  currentFile = null;
  clearCollision();
  detectedFloorY = null;
  hint.style.display = 'none';

  const shortName = url.split('/').pop().split('?')[0] || 'remote.ply';
  dropzone.classList.add('has-file');
  dropzone.querySelector('.dz-label').textContent = shortName;
  setStatus('loading', `Loading: ${shortName}`);
  log(`Loading URL: ${url}`);

  if (splatViewer) {
    if (splatViewer.splatMesh) scene.remove(splatViewer.splatMesh);
    splatViewer.dispose();
    splatViewer = null;
  }
  if (splatBlobUrl) { URL.revokeObjectURL(splatBlobUrl); splatBlobUrl = null; }

  splatViewer = _makeSplatViewer();
  splatViewer.addSplatScene(url, {
    format:                     SceneFormat.Ply,
    splatAlphaRemovalThreshold: 5,
    showLoadingUI:              false,
    rotation:                   [0, 0, 0, 1],
    onProgress: (pct, label) => {
      if (label) setStatus('loading', `Splat: ${label}`);
    },
  }).then(() => {
    setStatus('ready', `Loaded — click Generate Collision`);
    log('Splat loaded from URL.', 'ok');
    generateBtn.disabled = false;
  }).catch(err => {
    setStatus('error', 'URL load failed');
    log(`URL load error: ${err?.message ?? err}`, 'err');
    generateBtn.disabled = false;
  });
}
urlLoadBtn.addEventListener('click', () => loadUrl(urlInput.value));
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadUrl(urlInput.value); });

// ── Collision generation ──────────────────────────────────────────────────────
generateBtn.addEventListener('click', generateCollision);

async function generateCollision() {
  if (!currentFile && !currentUrl && !currentZip) return;
  generateBtn.disabled = true;

  if (currentZip) {
    log('Voxel zip import is not supported in standalone mode — drop a .ply file or enter a URL instead.', 'err');
    setStatus('error', 'Zip not supported');
    generateBtn.disabled = false;
    return;
  }

  if (!isWebGPUAvailable()) {
    log('WebGPU is not available in this browser. Try Chrome or Edge 113+.', 'err');
    setStatus('error', 'WebGPU required');
    generateBtn.disabled = false;
    return;
  }

  const sz     = parseFloat(voxelSize.value) || 0.10;
  const thresh = parseFloat(opThresh.value)  || 0.20;
  const sy     = parseFloat(seedY.value)     || 1.0;

  setStatus('loading', 'Generating collision mesh…');
  clearCollision();

  try {
    let plyBuffer = null;
    let plyUrl    = null;

    if (currentFile) {
      log(`Reading PLY: ${currentFile.name}…`);
      plyBuffer = await currentFile.arrayBuffer();
    } else {
      log(`Using URL: ${currentUrl}`);
      plyUrl = currentUrl;
    }

    const result = await _webgpuCollision({
      plyBuffer,
      plyUrl,
      seedPos:          [0, sy, 0],
      voxelSize:        sz,
      opacityThreshold: thresh,
      onLog: (text) => { log(text); setStatus('loading', text.slice(0, 80)); },
    });

    const { positions, indices, gridBounds, plyFloorY } = result;

    // Normalise: translate mesh so floor lands at Y=0 and scene is XZ-centred
    const cx = (gridBounds.min.x + gridBounds.max.x) / 2;
    const cz = (gridBounds.min.z + gridBounds.max.z) / 2;

    const normPos = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      normPos[i]     = positions[i]     - cx;
      normPos[i + 1] = positions[i + 1] - plyFloorY;
      normPos[i + 2] = positions[i + 2] - cz;
    }

    // Build THREE geometry directly from voxel data
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(normPos, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();

    collisionGroup = new THREE.Group();
    const meshObj  = new THREE.Mesh(geo, makeMeshMat());
    meshObj.renderOrder = 1;
    collisionGroup.add(meshObj);
    scene.add(collisionGroup);
    collisionGroup.visible = showMesh.checked;
    applyCollisionTransform();
    clearBtn.disabled = false;

    // Spawn area from normalised mesh bbox
    collisionGroup.updateWorldMatrix(true, true);
    const bbox    = new THREE.Box3().setFromObject(collisionGroup, true);
    const centre  = bbox.getCenter(new THREE.Vector3());
    const bboxSz  = bbox.getSize(new THREE.Vector3());
    detectedSpawnX      = centre.x;
    detectedSpawnZ      = centre.z;
    detectedSpawnRadius = Math.max(2, Math.min(bboxSz.x, bboxSz.z) * 0.25);

    // After normalisation the floor is at Y=0 in world space
    detectedFloorY      = 0;

    // Splat offset aligns the visual splat with the normalised collision mesh
    detectedSplatOffset = { x: -cx, y: -plyFloorY, z: -cz };

    // Reposition splat preview to match
    const sc0 = _splatScene0();
    if (sc0) sc0.position.set(detectedSplatOffset.x, detectedSplatOffset.y, detectedSplatOffset.z);

    detectedSplatUrl = currentUrl || null;

    log(`Collision mesh ready — ${(indices.length / 3).toLocaleString()} triangles | offset (${(-cx).toFixed(2)}, ${(-plyFloorY).toFixed(2)}, ${(-cz).toFixed(2)})`, 'ok');
    setStatus('ready', 'Collision overlay active');

    playBtn.disabled          = false;
    playFpsBtn.disabled       = false;
    playPeopleBtn.disabled    = false;
    playKartBtn.disabled      = false;
    playHint.style.display    = 'block';
    saveAlignmentBtn.disabled = false;

  } catch (e) {
    log(`Collision generation failed: ${e.message}`, 'err');
    setStatus('error', 'Failed');
  }

  generateBtn.disabled = false;
}

// ── Load collision GLB into the scene ─────────────────────────────────────────
async function loadCollisionMesh(url) {
  log(`Loading GLB from ${url}…`);
  clearCollision();

  const gltf = await new GLTFLoader().loadAsync(url);
  // Preserve the full GLTF hierarchy (same as _activateCollider in the games).
  // Apply overlay material and render-order to every mesh in the tree.
  collisionGroup = gltf.scene;
  collisionGroup.traverse(child => {
    if (!child.isMesh) return;
    child.material = makeMeshMat();
    child.renderOrder = 1;
  });

  scene.add(collisionGroup);
  collisionGroup.visible = showMesh.checked;
  applyCollisionTransform();
  clearBtn.disabled = false;

  // Compute spawn area from the world-space bounding box
  collisionGroup.updateWorldMatrix(true, true);
  const bbox   = new THREE.Box3().setFromObject(collisionGroup, true);
  const centre = bbox.getCenter(new THREE.Vector3());
  const bboxSz = bbox.getSize(new THREE.Vector3());
  detectedSpawnX      = centre.x;
  detectedSpawnZ      = centre.z;
  detectedSpawnRadius = Math.max(2, Math.min(bboxSz.x, bboxSz.z) * 0.25);

  // Floor Y: prefer the ground-truth value piped from the voxelizer (set in
  // generateCollision via ev.plyFloorY). Only fall back to geometry analysis
  // if the SSE value didn't arrive (e.g. loading a cached GLB directly).
  if (detectedFloorY == null) {
    detectedFloorY = _detectFloor(collisionGroup, bbox);
    log(`Floor Y = ${detectedFloorY.toFixed(3)} m  (geometric fallback, bbox ${bbox.min.y.toFixed(2)} → ${bbox.max.y.toFixed(2)})`, 'ok');
  }

  const primCount = collisionGroup.children.length;
  log(`Mesh loaded — ${primCount} primitive(s).`, 'ok');
}

// Detect the floor Y of the collision mesh.
//
// Strategy: collect all *horizontal* triangles (|normalY| / |normal| > 0.7),
// weight each by its area, build a Y histogram, Gaussian-smooth it, then pick
// the peak with the greatest total area. Vertical wall faces are inherently
// filtered out, so the dominant horizontal surface — the floor — always wins
// regardless of PLY Y-axis orientation.
function _detectFloor(group, bbox) {
  const BINS   = 512;
  const yMin   = bbox.min.y;
  const yRange = bbox.max.y - yMin;
  if (yRange < 0.001) return yMin;

  const areaHist = new Float32Array(BINS);

  const vA  = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const ab  = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();

  group.traverse(child => {
    if (!child.isMesh || !child.geometry) return;
    child.updateWorldMatrix(true, false);

    const pos = child.geometry.getAttribute('position');
    const idx = child.geometry.index;

    const processTri = (iA, iB, iC) => {
      vA.set(pos.getX(iA), pos.getY(iA), pos.getZ(iA)); child.localToWorld(vA);
      vB.set(pos.getX(iB), pos.getY(iB), pos.getZ(iB)); child.localToWorld(vB);
      vC.set(pos.getX(iC), pos.getY(iC), pos.getZ(iC)); child.localToWorld(vC);

      ab.subVectors(vB, vA);
      ac.subVectors(vC, vA);
      n.crossVectors(ab, ac);

      const len = n.length();
      if (len < 1e-10) return;

      // Skip near-vertical faces (walls) — only keep floor/ceiling
      if (Math.abs(n.y) / len < 0.7) return;

      const area  = len * 0.5;
      const faceY = (vA.y + vB.y + vC.y) / 3;
      const b     = Math.min(BINS - 1, Math.floor((faceY - yMin) / yRange * BINS));
      areaHist[b] += area;
    };

    if (idx) {
      for (let i = 0; i < idx.count; i += 3) processTri(idx.getX(i), idx.getX(i+1), idx.getX(i+2));
    } else {
      for (let i = 0; i < pos.count; i += 3) processTri(i, i+1, i+2);
    }
  });

  // Gaussian smooth (σ = 3 bins) to merge adjacent bins from the same surface
  const smooth = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) {
    let sum = 0, wsum = 0;
    for (let d = -9; d <= 9; d++) {
      const j = i + d;
      if (j < 0 || j >= BINS) continue;
      const w = Math.exp(-(d * d) / 18);
      sum  += areaHist[j] * w;
      wsum += w;
    }
    smooth[i] = sum / wsum;
  }

  // Find all significant peaks (local maxima above 2× mean area density)
  const totalArea = smooth.reduce((s, v) => s + v, 0);
  if (totalArea < 1e-6) return yMin; // no horizontal surfaces at all — fallback

  const mean = totalArea / BINS;
  const threshold = mean * 2;

  const peaks = [];
  for (let i = 1; i < BINS - 1; i++) {
    if (smooth[i] > threshold && smooth[i] >= smooth[i - 1] && smooth[i] >= smooth[i + 1]) {
      peaks.push({ y: yMin + (i + 0.5) / BINS * yRange, area: smooth[i] });
    }
  }

  if (!peaks.length) {
    // No peaks above threshold — fall back to the bin with maximum area
    let best = 0;
    for (let i = 1; i < BINS; i++) if (smooth[i] > smooth[best]) best = i;
    return yMin + (best + 0.5) / BINS * yRange;
  }

  // The floor is the largest horizontal surface.
  // Sort candidates by area descending; among the top-3, pick the lowest Y
  // (floor is always below ceiling in world space after the flipY transform).
  peaks.sort((a, b) => b.area - a.area);
  const topPeaks = peaks.slice(0, Math.min(3, peaks.length));
  topPeaks.sort((a, b) => a.y - b.y);
  return topPeaks[0].y;
}

function makeMeshMat() {
  return new THREE.MeshBasicMaterial({
    color:       new THREE.Color(colorSwatch.value),
    wireframe:   wireframe.checked,
    transparent: true,
    opacity:     parseFloat(meshOpacity.value),
    depthWrite:  false,
    side:        THREE.DoubleSide,
  });
}

function clearCollision() {
  if (!collisionGroup) return;
  scene.remove(collisionGroup);
  collisionGroup.traverse(c => {
    if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
  });
  collisionGroup = null;
  clearBtn.disabled = true;
}

function _buildGameParams() {
  const params = new URLSearchParams({
    floorY:       (detectedFloorY ?? 0).toFixed(4),
    spawnX:       detectedSpawnX.toFixed(4),
    spawnZ:       detectedSpawnZ.toFixed(4),
    spawnRadius:  detectedSpawnRadius.toFixed(2),
    scale:        currentScale.toFixed(4),
    splatOffsetX: detectedSplatOffset.x.toFixed(4),
    splatOffsetY: detectedSplatOffset.y.toFixed(4),
    splatOffsetZ: detectedSplatOffset.z.toFixed(4),
    flipX:        currentFlipX ? '1' : '0',
    flipY:        currentFlipY ? '1' : '0',
    flipZ:        currentFlipZ ? '1' : '0',
  });
  if (detectedSplatUrl) params.set('splatUrl', detectedSplatUrl);
  return params;
}

playBtn.addEventListener('click', () => {
  window.open(`/racing/?${_buildGameParams()}`, '_blank');
});

playFpsBtn.addEventListener('click', () => {
  window.open(`/fps/?${_buildGameParams()}`, '_blank');
});

playPeopleBtn.addEventListener('click', () => {
  window.open(`/people/?${_buildGameParams()}`, '_blank');
});

playKartBtn.addEventListener('click', () => {
  window.open(`/kart/?${_buildGameParams()}`, '_blank');
});

clearBtn.addEventListener('click', () => {
  clearCollision();
  log('Collision mesh cleared.');
  if (currentFile) setStatus('ready', `Loaded — ${currentFile.name}`);
});

// ── Overlay controls ──────────────────────────────────────────────────────────
showMesh.addEventListener('change', () => {
  if (collisionGroup) collisionGroup.visible = showMesh.checked;
});

meshOpacity.addEventListener('input', () => {
  const v = parseFloat(meshOpacity.value);
  opacityVal.textContent = `${Math.round(v * 100)}%`;
  collisionGroup?.traverse(c => { if (c.isMesh) c.material.opacity = v; });
});

wireframe.addEventListener('change', () => {
  collisionGroup?.traverse(c => { if (c.isMesh) c.material.wireframe = wireframe.checked; });
});

colorSwatch.addEventListener('input', () => {
  const col = new THREE.Color(colorSwatch.value);
  collisionGroup?.traverse(c => { if (c.isMesh) c.material.color.copy(col); });
});

// ── Save / restore alignment ──────────────────────────────────────────────────
const ALIGNMENT_KEY = 'mapper-global-alignment';
const ALIGNMENT_VERSION = 2; // bump when splatOffset convention changes

function saveAlignment() {
  const state = {
    _v:           ALIGNMENT_VERSION,
    scale:        currentScale,
    flipX:        currentFlipX,
    flipY:        currentFlipY,
    flipZ:        currentFlipZ,
    splatOffsetX: detectedSplatOffset.x,
    splatOffsetY: detectedSplatOffset.y,
    splatOffsetZ: detectedSplatOffset.z,
    floorY:       detectedFloorY ?? 0,
    spawnX:       detectedSpawnX,
    spawnZ:       detectedSpawnZ,
    spawnRadius:  detectedSpawnRadius,
  };
  localStorage.setItem(ALIGNMENT_KEY, JSON.stringify(state));
  const gameCfg = {
    _v:           ALIGNMENT_VERSION,
    floorY:       state.floorY,
    spawnX:       state.spawnX,
    spawnZ:       state.spawnZ,
    spawnRadius:  state.spawnRadius,
    scale:        state.scale,
    flipX:        state.flipX,
    flipY:        state.flipY,
    flipZ:        state.flipZ,
    splatOffsetX: state.splatOffsetX,
    splatOffsetY: state.splatOffsetY,
    splatOffsetZ: state.splatOffsetZ,
    locked:       true,
  };
  // Derive the PLY filename key — must match what arena-loader uses
  const plyName = detectedSplatUrl
    ? detectedSplatUrl.split('/').pop().split('?')[0]
    : 'uploaded.ply';
  for (const game of ['racing', 'fps', 'people', 'kart']) {
    localStorage.setItem(`sa-cfg:${game}:${plyName}`, JSON.stringify(gameCfg));
    if (plyName !== 'uploaded.ply') {
      localStorage.setItem(`sa-cfg:${game}:uploaded.ply`, JSON.stringify(gameCfg));
    }
  }
  log(`Alignment saved — offset (${state.splatOffsetX.toFixed(3)}, ${state.splatOffsetY.toFixed(3)}, ${state.splatOffsetZ.toFixed(3)}), scale ${state.scale.toFixed(2)}×`, 'ok');
}
saveAlignmentBtn.addEventListener('click', saveAlignment);

// ── Dev default: Alleyway Splat ───────────────────────────────────────────────
(async function autoLoadAlleyway() {
  const PLY_URL        = '/alleyway/scene.ply';
  const GLB_URL        = '/alleyway/scene.collision.glb';
  const DEFAULT_OFFSET = { x: 0.7384, y: 0.4000, z: 3.6775 };
  const DEFAULT_FLOOR  = 0;

  try {
    const glbHead = await fetch(GLB_URL, { method: 'HEAD' });
    if (!glbHead.ok) return;
  } catch { return; }

  // Restore saved alignment — fall back to hardcoded defaults.
  // Ignore saves from older coordinate conventions (missing _v or wrong version).
  let savedAlign = null;
  try {
    const raw = JSON.parse(localStorage.getItem(ALIGNMENT_KEY) || 'null');
    if (raw?._v === ALIGNMENT_VERSION) savedAlign = raw;
  } catch {}

  const SPLAT_OFFSET = savedAlign
    ? { x: savedAlign.splatOffsetX, y: savedAlign.splatOffsetY, z: savedAlign.splatOffsetZ }
    : DEFAULT_OFFSET;
  const FLOOR_Y = savedAlign?.floorY ?? DEFAULT_FLOOR;

  if (savedAlign) {
    currentScale = savedAlign.scale ?? 1;
    scaleSlider.value = currentScale;
    scaleVal.textContent = `${currentScale.toFixed(2)}×`;
    currentFlipX = savedAlign.flipX === true;
    currentFlipY = savedAlign.flipY === true;
    currentFlipZ = savedAlign.flipZ === true;
    flipXCb.checked = currentFlipX;
    flipYCb.checked = currentFlipY;
    flipZCb.checked = currentFlipZ;
    if (savedAlign.spawnX       != null) detectedSpawnX      = savedAlign.spawnX;
    if (savedAlign.spawnZ       != null) detectedSpawnZ      = savedAlign.spawnZ;
    if (savedAlign.spawnRadius  != null) detectedSpawnRadius = savedAlign.spawnRadius;
  }

  hint.style.display = 'none';
  dropzone.classList.add('has-file');
  dropzone.querySelector('.dz-label').textContent = 'alleyway.ply';
  setStatus('loading', 'Downloading Alleyway PLY…');
  log(`Auto-loading Alleyway Splat${savedAlign ? ' (saved alignment)' : ''} — downloading PLY…`);

  let plyBlobUrl;
  try {
    const resp = await fetch(PLY_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const totalBytes = parseInt(resp.headers.get('Content-Length') || '0', 10);
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (totalBytes > 0) {
        const pct = Math.round(received / totalBytes * 100);
        setStatus('loading', `Downloading PLY… ${pct}%`);
      }
    }
    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    plyBlobUrl = URL.createObjectURL(blob);
    log(`PLY downloaded (${(received / 1e6).toFixed(1)} MB). Loading splat…`);
  } catch (e) {
    log(`PLY download failed: ${e.message}`, 'err');
    setStatus('error', 'PLY download failed');
    return;
  }

  detectedFloorY      = FLOOR_Y;
  detectedSplatOffset = SPLAT_OFFSET;
  detectedSplatUrl    = PLY_URL; // pass to games so they load the same file

  splatViewer = _makeSplatViewer();

  setStatus('loading', 'Processing splat…');
  splatViewer.addSplatScene(plyBlobUrl, {
    format:                     SceneFormat.Ply,
    splatAlphaRemovalThreshold: 5,
    showLoadingUI:              false,
    rotation:                   [0, 0, 0, 1],
    position:                   [SPLAT_OFFSET.x, SPLAT_OFFSET.y, SPLAT_OFFSET.z],
    onProgress: (pct, label) => {
      if (label) setStatus('loading', `Splat: ${label}`);
    },
  }).then(() => {
    URL.revokeObjectURL(plyBlobUrl);
    // Apply saved scale/flip to the splat scene now that it's fully loaded
    applySplatTransform();
    log('Splat loaded and ready.', 'ok');
    setStatus('ready', 'Alleyway — splat + collision ready');
  }).catch(err => {
    URL.revokeObjectURL(plyBlobUrl);
    log(`Splat load error: ${err?.message ?? err}`, 'err');
    setStatus('error', 'Splat load failed');
  });

  await loadCollisionMesh(GLB_URL);

  playBtn.disabled          = false;
  playFpsBtn.disabled       = false;
  playPeopleBtn.disabled    = false;
  playKartBtn.disabled      = false;
  playHint.style.display    = 'block';
  saveAlignmentBtn.disabled = false;
})();

