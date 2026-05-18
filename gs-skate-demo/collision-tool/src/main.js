import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DropInViewer, SceneFormat } from '@mkkellogg/gaussian-splats-3d';

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
const playBtn      = document.getElementById('play-btn');
const playHint     = document.getElementById('play-hint');
const canvas       = document.getElementById('viewport');

// ── Three.js setup ────────────────────────────────────────────────────────────
// Single renderer, single scene — DropInViewer hooks in via onBeforeRender
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111416);
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
let currentScale  = 1.0;

// Auto-detected values from the collision mesh, passed to the racing game
let detectedFloorY      = null;
let detectedSpawnX      = 0;
let detectedSpawnZ      = 0;
let detectedSpawnRadius = 8;
let detectedSplatOffset = { x: 0, y: 0, z: 0 };

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
function applyScale(s) {
  currentScale = s;
  scaleVal.textContent = `${s.toFixed(2)}×`;
  if (splatViewer)    splatViewer.scale.setScalar(s);
  if (collisionGroup) collisionGroup.scale.setScalar(s);
}
scaleSlider.addEventListener('input', () => applyScale(parseFloat(scaleSlider.value)));

// ── File loading ──────────────────────────────────────────────────────────────
function loadFile(file) {
  currentFile = file;

  // Tear down previous viewer
  if (splatViewer) {
    scene.remove(splatViewer);
    splatViewer.dispose?.();
    splatViewer = null;
  }
  if (splatBlobUrl) { URL.revokeObjectURL(splatBlobUrl); splatBlobUrl = null; }
  clearCollision();

  detectedFloorY = null; // reset so the new voxelizer value is used, not a stale one
  splatBlobUrl = URL.createObjectURL(file);
  hint.style.display = 'none';
  dropzone.classList.add('has-file');
  dropzone.querySelector('.dz-label').textContent = file.name;
  setStatus('loading', `Loading ${file.name}…`);
  log(`Loading ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`);

  // DropInViewer is a THREE.Group — add it directly to the scene
  splatViewer = new DropInViewer({
    gpuAcceleratedSort: true,
    sharedMemoryForWorkers: false,
  });

  // Blob URLs have no extension — pass format explicitly so the library doesn't reject them
  const fmt = /\.splat$/i.test(file.name) ? SceneFormat.Splat : SceneFormat.Ply;
  splatViewer.addSplatScene(splatBlobUrl, {
    format: fmt,
    splatAlphaRemovalThreshold: 5,
    showLoadingUI: false,
  }).then(() => {
    setStatus('ready', `Loaded — ${file.name}`);
    log('Splat loaded.', 'ok');
    generateBtn.disabled = false;
  }).catch(err => {
    setStatus('error', 'Load failed');
    log(`Load error: ${err?.message ?? err}`, 'err');
  });

  // PLY Gaussian splats use Y-up flipped relative to Three.js convention
  splatViewer.rotation.x = Math.PI;
  scene.add(splatViewer);
  applyScale(currentScale);
}

// ── Drag & drop / click to browse ────────────────────────────────────────────
dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', ()  => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const f = [...e.dataTransfer.files].find(f => /\.(ply|splat)$/i.test(f.name));
  if (f) loadFile(f);
  else log('Please drop a .ply or .splat file.', 'err');
});
dropzone.addEventListener('click', () => {
  const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.ply,.splat' });
  inp.onchange = () => { if (inp.files[0]) loadFile(inp.files[0]); };
  inp.click();
});

// ── Collision generation ──────────────────────────────────────────────────────
generateBtn.addEventListener('click', generateCollision);

async function generateCollision() {
  if (!currentFile) return;
  generateBtn.disabled = true;
  setStatus('loading', 'Generating collision mesh…');
  log('Uploading PLY to server voxelizer…');

  const sz      = parseFloat(voxelSize.value) || 0.10;
  const thresh  = parseFloat(opThresh.value)  || 0.20;
  const sy      = parseFloat(seedY.value)     || 1.0;
  const params  = new URLSearchParams({ seedPos: `0,${sy},0`, voxelSize: sz, opacityThreshold: thresh, mode: 'quality' });

  try {
    const resp = await fetch(`/api/process-splat?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: currentFile,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

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
        if (ev.type === 'log')   log(ev.text);
        if (ev.type === 'error') { log(`Error: ${ev.text}`, 'err'); setStatus('error', 'Voxelizer failed'); generateBtn.disabled = false; return; }
        if (ev.type === 'done')  {
          glbUrl = ev.url;
          log('Collision mesh ready.', 'ok');
          // Mesh is now normalised: floor = world Y=0. plyFloorY should be 0.
          detectedFloorY = ev.plyFloorY != null ? -ev.plyFloorY : 0;
          // Splat offset: reposition the splat viewer so it aligns with the normalised mesh
          detectedSplatOffset = { x: ev.splatOffsetX ?? 0, y: ev.splatOffsetY ?? 0, z: ev.splatOffsetZ ?? 0 };
          log(`Normalised — floor Y: ${detectedFloorY.toFixed(2)} m, splat offset: (${detectedSplatOffset.x.toFixed(2)}, ${detectedSplatOffset.y.toFixed(2)}, ${detectedSplatOffset.z.toFixed(2)})`, 'ok');
          // Reposition the splat viewer in the preview to match the normalised collision mesh
          if (splatViewer) splatViewer.position.set(detectedSplatOffset.x, detectedSplatOffset.y, detectedSplatOffset.z);
          if (ev.racingReady) {
            playBtn.disabled = false;
            playHint.style.display = 'block';
          }
        }
      }
    }

    if (glbUrl) {
      await loadCollisionMesh(glbUrl);
      setStatus('ready', 'Collision overlay active');
    }
  } catch (e) {
    log(`Request failed: ${e.message}`, 'err');
    setStatus('error', 'Failed');
  }
  generateBtn.disabled = false;
}

// ── Load collision GLB into the scene ─────────────────────────────────────────
async function loadCollisionMesh(url) {
  log(`Loading GLB from ${url}…`);
  clearCollision();

  const gltf = await new GLTFLoader().loadAsync(url);
  collisionGroup = new THREE.Group();
  // Match the Y-flip applied to the Gaussian splat viewer
  collisionGroup.rotation.x = Math.PI;

  gltf.scene.traverse(child => {
    if (!child.isMesh) return;
    const mesh = new THREE.Mesh(child.geometry.clone(), makeMeshMat());
    mesh.position.copy(child.position);
    mesh.rotation.copy(child.rotation);
    mesh.scale.copy(child.scale);
    // Render after Gaussians so the wireframe is always on top
    mesh.renderOrder = 1;
    collisionGroup.add(mesh);
  });

  scene.add(collisionGroup);
  collisionGroup.visible = showMesh.checked;
  collisionGroup.scale.setScalar(currentScale);
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

playBtn.addEventListener('click', () => {
  const params = new URLSearchParams({
    floorY:       (detectedFloorY ?? 0).toFixed(4),
    spawnX:       '0',
    spawnZ:       '0',
    spawnRadius:  detectedSpawnRadius.toFixed(2),
    scale:        currentScale.toFixed(4),
    splatOffsetX: detectedSplatOffset.x.toFixed(4),
    splatOffsetY: detectedSplatOffset.y.toFixed(4),
    splatOffsetZ: detectedSplatOffset.z.toFixed(4),
  });
  window.open(`http://127.0.0.1:5174/racing/?${params}`, '_blank');
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

