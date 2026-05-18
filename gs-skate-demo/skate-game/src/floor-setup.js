// floor-setup.js
// Settings panel for each game: scale, floor height, spawn area.
//
// Call flow:
//   const setup = createFloorSetup({ scene, camera, controls, game })
//   setup.setSplatMesh(mesh)              // once splat loads
//   setup.setVoxelMesh(mesh)             // once collider arrives
//   const cfg = await setup.show(box, plyUrl)  // shows panel or skips if locked
//   setup.updateAutoFloor(y)             // called by collider gen with histogram floor
//   setup.onReEdit(fn)                   // fn({ floorY, spawnX, spawnZ, spawnRadius, scale })
//                                        //   called when user re-saves mid-game
//   setup.dispose()

import * as THREE from 'three';

const FLOOR_STEP = 0.05;
const SPAWN_STEP = 0.5;
const SCALE_STEP = 0.05;
const SCALE_MIN  = 0.05;
const SCALE_MAX  = 20;

const LS_KEY = (game, plyName) => `sa-cfg:${game}:${plyName}`;

export function createFloorSetup({ scene, camera, controls, game }) {
  // ── State ─────────────────────────────────────────────────────────────────
  let _box         = null;
  let _plyName     = '';
  let _splatMesh   = null;
  let _voxelMesh   = null;
  let _origBox     = null;   // original unscaled bbox from PLY

  let _scale       = 1.0;
  let _floorY      = 0;
  let _spawnX      = 0;
  let _spawnZ      = 0;
  let _spawnRadius = 8;
  let _autoFloorY  = null;
  let _gameStarted = false;

  // Collision overlay state (green wireframe shown only while panel is open)
  let _overlayOn      = false;
  let _overlayOpacity = 0.55;

  // ── 3D visuals ────────────────────────────────────────────────────────────
  let _grid   = null;
  let _handle = null;
  let _disc   = null;

  function _rebuildGrid() {
    _disposeObj(_grid); _grid = null;
    if (!_box) return;
    const cx = (_box.min.x + _box.max.x) / 2;
    const cz = (_box.min.z + _box.max.z) / 2;
    const w  = _box.max.x - _box.min.x;
    const d  = _box.max.z - _box.min.z;
    const gs = Math.max(w, d) * 1.6;
    const divs = Math.round(gs / Math.max(0.5, gs / 40));

    const grid = new THREE.GridHelper(gs, divs, 0x4fd8f5, 0x4fd8f5);
    grid.material.transparent = true; grid.material.opacity = 0.45; grid.material.depthWrite = false;
    const bGeo   = new THREE.EdgesGeometry(new THREE.BoxGeometry(gs * 0.98, 0.001, gs * 0.98));
    const border = new THREE.LineSegments(bGeo, new THREE.LineBasicMaterial({ color: 0x4fd8f5 }));
    _grid = new THREE.Group(); _grid.add(grid, border);
    _grid.position.set(cx, _floorY, cz);
    scene.add(_grid);
  }

  function _rebuildHandle() {
    _disposeObj(_handle); _handle = null;
    if (!_box) return;
    const cx = (_box.min.x + _box.max.x) / 2;
    const cz = (_box.min.z + _box.max.z) / 2;
    const m  = () => new THREE.MeshBasicMaterial({ color: 0x4fd8f5 });
    const ring  = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.05, 8, 32), m()); ring.rotation.x = Math.PI / 2;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 8), m());
    const coneU = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.28, 8), m()); coneU.position.y = 0.59;
    const coneD = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.28, 8), m()); coneD.rotation.z = Math.PI; coneD.position.y = -0.59;
    _handle = new THREE.Group(); _handle.add(ring, shaft, coneU, coneD);
    _handle.position.set(cx, _floorY, cz);
    scene.add(_handle);
  }

  function _rebuildDisc() {
    _disposeObj(_disc); _disc = null;
    if (!_box) return;
    const dMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false });
    const rMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 64), dMat); disc.rotation.x = -Math.PI / 2;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 64), rMat); ring.rotation.x = -Math.PI / 2;
    const dot  = new THREE.Mesh(new THREE.CircleGeometry(0.04, 16), rMat.clone()); dot.rotation.x = -Math.PI / 2;
    _disc = new THREE.Group(); _disc.add(disc, ring, dot);
    _disc.position.set(_spawnX, _floorY + 0.03, _spawnZ);
    _disc.scale.set(_spawnRadius, 1, _spawnRadius);
    scene.add(_disc);
  }

  function _syncVisuals() {
    const cx = _box ? (_box.min.x + _box.max.x) / 2 : 0;
    const cz = _box ? (_box.min.z + _box.max.z) / 2 : 0;
    if (_grid)   _grid.position.set(cx, _floorY, cz);
    if (_handle) _handle.position.set(cx, _floorY, cz);
    if (_disc)   { _disc.position.set(_spawnX, _floorY + 0.03, _spawnZ); _disc.scale.set(_spawnRadius, 1, _spawnRadius); }
  }

  function _destroyVisuals() {
    _disposeObj(_grid); _disposeObj(_handle); _disposeObj(_disc);
    _grid = _handle = _disc = null;
  }

  function _disposeObj(obj) {
    if (!obj) return;
    scene.remove(obj);
    obj.traverse(n => { n.geometry?.dispose(); n.material?.dispose(); });
  }

  // ── Scale helpers ─────────────────────────────────────────────────────────

  function _applyScale(newScale, fromOld) {
    const ratio = newScale / (fromOld ?? _scale);
    _scale  = newScale;

    // Scale Three.js objects
    if (_splatMesh) _splatMesh.scale.setScalar(newScale);
    if (_voxelMesh) _voxelMesh.scale.setScalar(newScale);

    // Scale all world-space positions proportionally
    _floorY      *= ratio;
    _spawnX      *= ratio;
    _spawnZ      *= ratio;
    _spawnRadius *= ratio;

    // Update effective bbox
    if (_origBox) {
      const c = _origBox.getCenter(new THREE.Vector3()).multiplyScalar(ratio);
      const h = _origBox.getSize(new THREE.Vector3()).multiplyScalar(newScale / 2);
      _box = new THREE.Box3(c.clone().sub(h), c.clone().add(h));
    }

    _syncVisuals();
    _syncUI();
  }

  // ── Panel DOM ─────────────────────────────────────────────────────────────

  let _panel = null;
  let _resolveShow = null;
  let _onReEditCb  = null;
  let _isDragging  = false;
  let _canvasEl    = null;

  // Cached button interval handles
  const _intervals = {};
  function _startRepeat(key, fn) {
    fn(); clearInterval(_intervals[key]);
    _intervals[key] = setInterval(fn, 80);
  }
  function _stopRepeat(key) { clearInterval(_intervals[key]); }

  function _injectStyles() {
    if (document.getElementById('_sa-setup-styles')) return;
    const s = document.createElement('style');
    s.id = '_sa-setup-styles';
    s.textContent = `
      #sa-settings-panel {
        position: fixed; bottom: 24px; left: 24px;
        background: #0c0f15ee; border: 1px solid #1e2a3a;
        border-radius: 14px; padding: 18px 20px 16px;
        width: 290px; z-index: 200;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 0.82rem; color: #e2e8f0;
        box-shadow: 0 12px 40px #000000bb;
        transition: opacity 0.2s;
      }
      #sa-settings-panel h3 {
        font-size: 0.78rem; font-weight: 700; color: #64748b;
        margin: 0 0 14px; text-transform: uppercase; letter-spacing: 0.09em;
        display: flex; justify-content: space-between; align-items: center;
      }
      #sa-settings-panel h3 span { color: #4fd8f5; font-size: 0.82rem; }
      .sa-section { margin-bottom: 12px; }
      .sa-section-title {
        font-size: 0.7rem; font-weight: 600; color: #475569;
        text-transform: uppercase; letter-spacing: 0.07em;
        margin-bottom: 7px;
      }
      .sa-row {
        display: flex; align-items: center; gap: 7px; margin-bottom: 6px;
      }
      .sa-label { flex: 1; color: #94a3b8; font-size: 0.8rem; }
      .sa-val {
        min-width: 58px; text-align: center; color: #f1f5f9;
        font-variant-numeric: tabular-nums; font-size: 0.82rem;
      }
      .sa-btn {
        background: #141a24; border: 1px solid #24344a; color: #94a3b8;
        width: 26px; height: 26px; border-radius: 6px; cursor: pointer;
        font-size: 0.95rem; display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .sa-btn:hover { border-color: #4fd8f5; color: #4fd8f5; }
      .sa-btn-wide {
        flex: 1; height: 26px; padding: 0 8px;
        white-space: nowrap; font-size: 0.72rem;
      }
      #sa-status {
        font-size: 0.71rem; color: #4fd8f5; margin: 4px 0 12px;
        min-height: 13px; text-align: center;
      }
      #sa-divider { border: none; border-top: 1px solid #1a2333; margin: 10px 0 12px; }
      #sa-lock-btn {
        width: 100%; padding: 11px; background: #f59e0b; border: none;
        border-radius: 8px; color: #000; font-weight: 700; font-size: 0.85rem;
        cursor: pointer; letter-spacing: 0.04em; margin-bottom: 7px;
      }
      #sa-lock-btn:hover { background: #fbbf24; }
      #sa-play-btn {
        width: 100%; padding: 7px; background: transparent;
        border: 1px solid #1e2a3a; border-radius: 8px; color: #475569;
        font-size: 0.75rem; cursor: pointer;
      }
      #sa-play-btn:hover { border-color: #475569; color: #94a3b8; }

      .sa-toggle {
        position: relative; display: inline-block;
        width: 34px; height: 18px; cursor: pointer; flex-shrink: 0;
      }
      .sa-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
      .sa-toggle-track {
        position: absolute; inset: 0;
        background: #141a24; border: 1px solid #24344a;
        border-radius: 9px; transition: background .15s, border-color .15s;
      }
      .sa-toggle input:checked + .sa-toggle-track { background: #00c870; border-color: #00c870; }
      .sa-toggle-track::after {
        content: ''; position: absolute; top: 2px; left: 2px;
        width: 12px; height: 12px; border-radius: 50%;
        background: #475569; transition: transform .15s, background .15s;
      }
      .sa-toggle input:checked + .sa-toggle-track::after {
        transform: translateX(16px); background: #fff;
      }
      #sa-overlay-opacity {
        flex: 1; accent-color: #00c870; cursor: pointer; height: 4px;
      }

      #sa-settings-btn {
        position: fixed; top: 14px; right: 14px;
        background: #0c0f15; border: 1px solid #1e2a3a;
        color: #94a3b8; font-size: 0.78rem;
        font-family: -apple-system, sans-serif;
        padding: 7px 13px; border-radius: 7px; cursor: pointer; z-index: 60;
        display: none; gap: 5px; align-items: center;
        letter-spacing: 0.03em;
      }
      #sa-settings-btn:hover { border-color: #4fd8f5; color: #4fd8f5; }
    `;
    document.head.appendChild(s);
  }

  function _buildPanel() {
    if (_panel) return;
    _injectStyles();

    _panel = document.createElement('div');
    _panel.id = 'sa-settings-panel';
    _panel.style.display = 'none';
    _panel.innerHTML = `
      <h3>SCENE SETTINGS <span id="sa-ply-name"></span></h3>

      <div class="sa-section">
        <div class="sa-section-title">Scale</div>
        <div class="sa-row">
          <button class="sa-btn" id="sa-scale-dn">−</button>
          <span class="sa-val" id="sa-scale-val">1.00×</span>
          <button class="sa-btn" id="sa-scale-up">+</button>
          <button class="sa-btn sa-btn-wide" id="sa-scale-reset">Reset 1×</button>
        </div>
      </div>

      <div class="sa-section">
        <div class="sa-section-title">Floor Height</div>
        <div class="sa-row">
          <button class="sa-btn" id="sa-floor-dn">−</button>
          <span class="sa-val" id="sa-floor-val">0.00m</span>
          <button class="sa-btn" id="sa-floor-up">+</button>
          <button class="sa-btn sa-btn-wide" id="sa-auto-btn">⟳ Auto</button>
        </div>
      </div>

      <div class="sa-section">
        <div class="sa-section-title">Spawn Area</div>
        <div class="sa-row">
          <span class="sa-label">Radius</span>
          <button class="sa-btn" id="sa-spawn-dn">−</button>
          <span class="sa-val" id="sa-spawn-val">8.0m</span>
          <button class="sa-btn" id="sa-spawn-up">+</button>
        </div>
        <div style="font-size:0.7rem;color:#475569;margin-top:-2px;margin-bottom:4px">
          Click floor to reposition centre
        </div>
      </div>

      <hr style="border:none;border-top:1px solid #1a2333;margin:10px 0 12px">

      <div class="sa-section">
        <div class="sa-section-title">Collision Overlay</div>
        <div class="sa-row">
          <span class="sa-label">Show mesh</span>
          <label class="sa-toggle">
            <input type="checkbox" id="sa-overlay-toggle">
            <span class="sa-toggle-track"></span>
          </label>
        </div>
        <div class="sa-row" id="sa-overlay-opacity-row" style="display:none">
          <span class="sa-label">Opacity</span>
          <input type="range" id="sa-overlay-opacity" min="0.05" max="1" step="0.05" value="0.55">
          <span class="sa-val" id="sa-overlay-opacity-val">55%</span>
        </div>
        <div id="sa-overlay-status" style="font-size:0.7rem;color:#475569;margin-top:-2px;min-height:13px"></div>
      </div>

      <div id="sa-status"></div>
      <hr id="sa-divider">
      <button id="sa-lock-btn">Lock In &amp; Play</button>
      <button id="sa-play-btn">Play without saving</button>
    `;
    document.body.appendChild(_panel);

    // Settings trigger button (shown during gameplay)
    if (!document.getElementById('sa-settings-btn')) {
      const btn = document.createElement('button');
      btn.id = 'sa-settings-btn';
      btn.innerHTML = '⚙&nbsp;Settings';
      document.body.appendChild(btn);
      btn.addEventListener('click', _openSettings);
    }

    _wirePanel();
  }

  function _wirePanel() {
    const q = id => document.getElementById(id);

    // Scale
    q('sa-scale-dn').addEventListener('mousedown',  () => _startRepeat('scl', () => _setScale(Math.max(SCALE_MIN, +(_scale - SCALE_STEP).toFixed(2)))));
    q('sa-scale-up').addEventListener('mousedown',  () => _startRepeat('scl', () => _setScale(Math.min(SCALE_MAX, +(_scale + SCALE_STEP).toFixed(2)))));
    q('sa-scale-reset').addEventListener('click',   () => _setScale(1.0));
    document.addEventListener('mouseup', () => { _stopRepeat('scl'); _stopRepeat('flo'); _stopRepeat('spa'); });

    // Floor
    q('sa-floor-dn').addEventListener('mousedown',  () => _startRepeat('flo', () => _adjustFloor(-FLOOR_STEP)));
    q('sa-floor-up').addEventListener('mousedown',  () => _startRepeat('flo', () => _adjustFloor(+FLOOR_STEP)));
    q('sa-auto-btn').addEventListener('click', () => {
      if (_autoFloorY != null) { _setFloor(_autoFloorY); _setStatus('✓ Auto floor applied'); }
      else _setStatus('⚙ Collider still building…');
    });

    // Spawn
    q('sa-spawn-dn').addEventListener('mousedown',  () => _startRepeat('spa', () => _adjustSpawn(-SPAWN_STEP)));
    q('sa-spawn-up').addEventListener('mousedown',  () => _startRepeat('spa', () => _adjustSpawn(+SPAWN_STEP)));

    // Collision overlay
    q('sa-overlay-toggle').checked = _overlayOn;
    q('sa-overlay-toggle').addEventListener('change', (e) => {
      _overlayOn = e.target.checked;
      q('sa-overlay-opacity-row').style.display = _overlayOn ? 'flex' : 'none';
      _overlayOn ? _applyOverlayMat() : _applyHiddenMat();
      if (_overlayOn && !_voxelMesh) _setOverlayStatus('⚙ Collider still building…');
    });
    q('sa-overlay-opacity').addEventListener('input', (e) => {
      _overlayOpacity = parseFloat(e.target.value);
      q('sa-overlay-opacity-val').textContent = `${Math.round(_overlayOpacity * 100)}%`;
      _applyOverlayMat();
    });

    // Confirm
    q('sa-lock-btn').addEventListener('click', () => _confirm(true));
    q('sa-play-btn').addEventListener('click', () => _confirm(false));
  }

  // ── Collision overlay helpers ─────────────────────────────────────────────

  function _applyOverlayMat() {
    if (!_voxelMesh) return;
    _voxelMesh.traverse(n => {
      if (!n.isMesh) return;
      n.material = new THREE.MeshBasicMaterial({
        color:       0x00ff88,
        wireframe:   true,
        transparent: true,
        opacity:     _overlayOpacity,
        depthWrite:  false,
        side:        THREE.DoubleSide,
      });
      n.renderOrder = 1;
    });
    _setOverlayStatus('');
  }

  function _applyHiddenMat() {
    if (!_voxelMesh) return;
    _voxelMesh.traverse(n => {
      if (!n.isMesh) return;
      n.material = new THREE.MeshBasicMaterial({
        colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
      });
      n.renderOrder = 0;
    });
  }

  function _setOverlayStatus(msg) {
    const el = document.getElementById('sa-overlay-status');
    if (el) el.textContent = msg;
  }

  // ── Value setters ─────────────────────────────────────────────────────────

  function _setScale(s) {
    const old = _scale;
    _applyScale(Math.max(SCALE_MIN, Math.min(SCALE_MAX, s)), old);
    _rebuildGrid();
    _rebuildHandle();
    _rebuildDisc();
  }

  function _setFloor(y) {
    if (_box) y = Math.max(_box.min.y - 2, Math.min(_box.max.y + 2, y));
    _floorY = y;
    _syncVisuals();
    _syncUI();
  }

  function _adjustFloor(d) { _setFloor(_floorY + d); }

  function _adjustSpawn(d) {
    _spawnRadius = Math.max(1, _spawnRadius + d);
    _syncVisuals();
    _syncUI();
  }

  function _syncUI() {
    const q = id => document.getElementById(id);
    if (q('sa-scale-val')) q('sa-scale-val').textContent = `${_scale.toFixed(2)}×`;
    if (q('sa-floor-val')) q('sa-floor-val').textContent = `${_floorY.toFixed(2)}m`;
    if (q('sa-spawn-val')) q('sa-spawn-val').textContent = `${_spawnRadius.toFixed(1)}m`;
  }

  function _setStatus(msg) {
    const el = document.getElementById('sa-status');
    if (el) el.textContent = msg;
  }

  // ── Drag handle ───────────────────────────────────────────────────────────

  const _rc  = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  let _onDragStart = null, _onDragMove = null, _onDragEnd = null;
  const _floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const _floorHit   = new THREE.Vector3();
  let _onFloorClick = null;

  function _setupInteraction() {
    _canvasEl = document.getElementById('viewport');
    if (!_canvasEl) return;

    _onDragStart = (e) => {
      if (!_handle) return;
      const rect = _canvasEl.getBoundingClientRect();
      _ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1,
               -((e.clientY - rect.top) / rect.height) * 2 + 1);
      _rc.setFromCamera(_ndc, camera);
      if (_rc.intersectObject(_handle, true).length) { _isDragging = true; e.stopPropagation(); }
    };
    _onDragMove = (e) => {
      if (!_isDragging || !_box) return;
      const cx   = (_box.min.x + _box.max.x) / 2;
      const cz   = (_box.min.z + _box.max.z) / 2;
      const dist = camera.position.distanceTo(new THREE.Vector3(cx, _floorY, cz));
      const wpp  = Math.tan(camera.fov * 0.5 * Math.PI / 180) * 2 * dist / _canvasEl.clientHeight;
      _adjustFloor(-e.movementY * wpp);
    };
    _onDragEnd = () => { _isDragging = false; };
    _onFloorClick = (e) => {
      if (_isDragging || e.button !== 0) return;
      const rect = _canvasEl.getBoundingClientRect();
      _ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1,
               -((e.clientY - rect.top) / rect.height) * 2 + 1);
      _floorPlane.constant = -_floorY;
      _rc.setFromCamera(_ndc, camera);
      if (_rc.ray.intersectPlane(_floorPlane, _floorHit)) {
        _spawnX = _box ? THREE.MathUtils.clamp(_floorHit.x, _box.min.x, _box.max.x) : _floorHit.x;
        _spawnZ = _box ? THREE.MathUtils.clamp(_floorHit.z, _box.min.z, _box.max.z) : _floorHit.z;
        _syncVisuals();
      }
    };
    _canvasEl.addEventListener('mousedown', _onDragStart);
    _canvasEl.addEventListener('mousemove', _onDragMove);
    _canvasEl.addEventListener('click',     _onFloorClick);
    window.addEventListener('mouseup', _onDragEnd);
  }

  function _teardownInteraction() {
    if (!_canvasEl) return;
    if (_onDragStart)  _canvasEl.removeEventListener('mousedown', _onDragStart);
    if (_onDragMove)   _canvasEl.removeEventListener('mousemove', _onDragMove);
    if (_onFloorClick) _canvasEl.removeEventListener('click', _onFloorClick);
    if (_onDragEnd)    window.removeEventListener('mouseup', _onDragEnd);
    _isDragging = false;
  }

  // ── Show / hide panel ─────────────────────────────────────────────────────

  function _openSettings() {
    _buildPanel();
    _panel.style.display = 'block';
    const btn = document.getElementById('sa-settings-btn');
    if (btn) btn.style.display = 'none';
    controls.enabled = true;   // allow orbit while adjusting
    _rebuildGrid();
    _rebuildHandle();
    _rebuildDisc();
    _syncUI();
    _setStatus('');
    const nameEl = document.getElementById('sa-ply-name');
    if (nameEl) nameEl.textContent = _plyName;
    _setupInteraction();
  }

  function _closeSettings() {
    if (_panel) _panel.style.display = 'none';
    _applyHiddenMat();   // always restore invisible mat when panel closes
    _destroyVisuals();
    _teardownInteraction();
    const btn = document.getElementById('sa-settings-btn');
    if (btn) btn.style.display = 'flex';
  }

  // ── Confirm ───────────────────────────────────────────────────────────────

  function _cfg() {
    return { floorY: _floorY, spawnX: _spawnX, spawnZ: _spawnZ, spawnRadius: _spawnRadius, scale: _scale };
  }

  function _confirm(lock) {
    // Bug fix 1: always write locked:true so show() skips the panel next load
    if (lock) {
      try { localStorage.setItem(LS_KEY(game, _plyName), JSON.stringify({ ..._cfg(), locked: true })); } catch {}
    }
    _closeSettings();
    const cfg = _cfg();
    if (_resolveShow) {
      // First-time confirm: resolve the promise from show()
      const resolve = _resolveShow;
      _resolveShow = null;
      _gameStarted = true;   // mark so re-edits use _onReEditCb
      resolve(cfg);
    } else if (_onReEditCb) {
      // Bug fix 2: removed _gameStarted guard — always fire re-edit callback
      _onReEditCb(cfg);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function setSplatMesh(mesh) {
    _splatMesh = mesh;
    mesh.scale.setScalar(_scale);
  }

  function setVoxelMesh(mesh) {
    _voxelMesh = mesh;
    mesh.scale.setScalar(_scale);
    // If the panel is open and overlay is already toggled on, apply immediately
    if (_panel?.style.display !== 'none' && _overlayOn) {
      _applyOverlayMat();
    }
  }

  // show() — call once after PLY loads. Resolves with config.
  // If a saved config exists, resolves immediately (skips panel).
  function show(box, plyUrl) {
    _origBox = box.clone();
    _plyName = plyUrl.split('/').pop();
    _box     = box;

    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());

    // Defaults
    _scale       = 1.0;
    _floorY      = box.min.y + size.y * 0.15;
    _spawnX      = center.x;
    _spawnZ      = center.z;
    _spawnRadius = Math.max(2, Math.min(size.x, size.z) * 0.35);

    // Load saved config
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY(game, _plyName))); } catch {}
    if (saved) {
      if (saved.scale       != null) _scale       = saved.scale;
      if (saved.floorY      != null) _floorY      = saved.floorY;
      if (saved.spawnX      != null) _spawnX      = saved.spawnX;
      if (saved.spawnZ      != null) _spawnZ      = saved.spawnZ;
      if (saved.spawnRadius != null) _spawnRadius = saved.spawnRadius;
      // Apply saved scale to meshes
      if (_splatMesh) _splatMesh.scale.setScalar(_scale);
    }

    // If saved AND explicitly locked, skip the panel
    if (saved?.locked === true) {
      _buildPanel();   // build (creates settings btn)
      _gameStarted = true;
      const btn = document.getElementById('sa-settings-btn');
      if (btn) btn.style.display = 'flex';
      return Promise.resolve(_cfg());
    }

    // First run or unlocked — show the panel
    _buildPanel();
    _openSettings();
    _setStatus('Adjust then "Lock In & Play" to save');

    return new Promise(resolve => { _resolveShow = resolve; });
  }

  // Called by collider gen with histogram-detected floor Y
  function updateAutoFloor(y) {
    _autoFloorY = y;
    const defaultY = _origBox ? _origBox.min.y + (_origBox.max.y - _origBox.min.y) * 0.15 : 0;
    if (_panel?.style.display !== 'none' && Math.abs(_floorY - defaultY * _scale) < 0.2) {
      _setFloor(y);
      _setStatus('✓ Floor auto-detected — adjust if needed');
    } else {
      _setStatus('✓ Auto floor ready — press ⟳ to apply');
    }
  }

  // Register callback fired when user re-saves from settings mid-game
  function onReEdit(fn) { _onReEditCb = fn; }

  function dispose() {
    _destroyVisuals();
    _teardownInteraction();
    if (_panel) { _panel.remove(); _panel = null; }
    const btn = document.getElementById('sa-settings-btn');
    if (btn) btn.remove();
  }

  return { show, setSplatMesh, setVoxelMesh, updateAutoFloor, onReEdit, dispose };
}

export function clearFloorConfig(game, plyName) {
  try { localStorage.removeItem(LS_KEY(game, plyName)); } catch {}
}
