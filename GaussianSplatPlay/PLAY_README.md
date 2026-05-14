# Gaussian Mode — Play

A self-contained browser FPS viewer for 3D Gaussian Splat (`.ply`) scenes.  
Walk, jump and shoot inside any Gaussian splat — drag-and-drop a file or point at a URL.

---

## What it does

`play.html` is a single shareable page that wraps the full pipeline:

```
.ply file / URL
    │
    ▼
SplatMesh (Spark renderer)      ← renders the Gaussian splat
    │
    ▼
Configure screen                ← user sets floor height + spawn point
    │
    ▼
WebGPU voxelization             ← client-side GPU collision mesh generation
    │  (runs in background while user explores)
    ▼
BVH character physics           ← capsule controller with slope + step detection
    │
    ▼
FPS mode                        ← WASD walk, mouse look, Space jump, LMB shoot
```

---

## Quick start

```bash
npm install
npm run dev
# open http://localhost:8080/play.html
```

Requires a browser with **WebGPU** support (Chrome 113+, Edge 113+).

---

## File map

| File | Purpose |
|---|---|
| `play.html` | Launcher UI, loading screen, configure screen, FPS HUD |
| `src/play.js` | All game logic — state machine, splat loading, preset persistence, physics loop |
| `src/collision/client-collider.js` | WebGPU voxelization pipeline entry point |
| `src/collision/gpu-voxelize.js` | WGSL compute shaders — Beer-Lambert opacity, Mahalanobis distance |
| `src/collision/ply-reader.js` | PLY parser + `detectFloorY` histogram floor detection |
| `src/collision/sparse-voxel-grid.js` | Two-level 4×4×4 sparse voxel grid |
| `src/collision/flood-fill.js` | Two-level BFS flood fill from seed voxels |
| `src/collision/voxel-faces.js` | Marching-cubes-style face extraction → BufferGeometry |
| `src/collision/block-mask-map.js` | Bitmask lookup table for block types |
| `src/fps/physics.js` | Character physics wrapper (BVH + Octree) |
| `src/fps/bvhPhysics.js` | BVH capsule shapecast (ported from VIVERSE SDK) |
| `src/fps/balls.js` | Ball shooter — physics, bounce, cleanup |
| `vite.config.js` | Dev server, WASM middleware, COEP/COOP headers |

---

## Key dependencies

| Package | Used for |
|---|---|
| `@sparkjsdev/spark` | `SparkRenderer` + `SplatMesh` — Gaussian splat rendering |
| `three` | Scene graph, camera, geometry, materials |
| `three-mesh-bvh` | BVH acceleration for capsule physics and ball raycasting |
| `vite` | Dev server and bundler |

---

## State machine

```
'launcher' ──► 'loading' ──► 'configure' ──► 'playing'
     ▲                              │               │
     └──────────────────────────────┘◄──────────────┘
          (returnToLauncher)     (ESC / Start Again button)
```

### launcher
Splash page. Three preset cards (load from localStorage/IndexedDB), URL input, file drag-and-drop.

### loading
SplatMesh is fetching and parsing. Shows spinner.

### configure
Orbit camera preview of the splat. User sets:
- **Floor height** — drag the cyan ↕ gizmo, use ±0.05 steppers, or type a value
- **Spawn point** — click anywhere in the scene to place a cyan player figure
- **Auto-detect** — once WebGPU collision finishes, floor Y is auto-updated from the Gaussian histogram

Clicking **▶ Start Walking** enters FPS.

### playing
Pointer-locked FPS mode.  
- **WASD** — move  
- **Mouse** — look  
- **Space** — jump  
- **F** — toggle fly / walk  
- **LMB** — shoot ball  
- **B** — clear balls  
- **ESC** — release cursor (stays in playing state) → can use HUD widgets  

HUD elements (accessible after ESC):
- **← Start Again** — return to launcher  
- **↕ Floor Height** — fine-tune floor physics slab while walking  
- **Save to Preset ⊕ 1/2/3** — save current position + settings to a slot  

---

## Preset system

Presets are stored in **localStorage** (settings) and **IndexedDB** (file bytes for local uploads).

```js
// localStorage key: gm_preset_0 / gm_preset_1 / gm_preset_2
{
  name:    "My Scene",
  url:     "https://…/scene.ply",   // null for local files
  isFile:  false,
  flipY:   true,
  floorY:  -1.4,                    // world-space Y of physics floor slab
  spawnX:  2.3,                     // camera XZ at time of save
  spawnZ:  -0.8,
  savedAt: 1715000000000
}
```

When a preset is loaded it skips the configure screen entirely and enters FPS directly.

To add hardcoded presets at the top of `src/play.js`:
```js
// These are only used if no localStorage data exists for that slot
const HARDCODED_PRESETS = [
  { name: 'Garden', url: '/splats/garden.ply', flipY: true },
];
```
(Currently the launcher starts with three empty slots; users populate them at runtime.)

---

## Collision pipeline

### Overview

```
PLY bytes
  └─ parseGaussians()          CPU — extracts pos, opacity, rot, scale → 16-float structs
  └─ detectFloorY()            CPU — 128-bin Y histogram → floor peak + upDir
  └─ height-clamped voxelBounds
  └─ createVoxelizer()         GPU — uploads Gaussians, builds spatial index
  └─ voxelizeGrid()            GPU compute — Beer-Lambert extinction per voxel
  └─ masksToGrid()             CPU — u32 bitmasks → SparseVoxelGrid
  └─ twoLevelBFS()             CPU — flood fill from floor seeds → navigable space
  └─ voxelFaces()              CPU — extract collision faces → Float32Array
```

### Tuning knobs (in `src/play.js`)

```js
const voxelSize = Math.max(0.3, Math.min(1.5, maxDim / 100));
// maxDim/100 = ~100 voxels across the longest axis, capped at 1.5 m.
// Increase divisor (e.g. /150) for finer detail, slower GPU.
// Decrease divisor (e.g. /60) for faster, coarser.

opacityThreshold: 0.3
// Gaussians below this opacity are ignored.
// Raise to 0.4–0.5 to strip semi-transparent foliage (faster, fewer artifacts).
// Lower to 0.15 to include faint geometry.
```

### Floor sink (movement fix)

After voxelization, every vertex Y is shifted **+0.3 m in PLY space** (= −0.3 m world Y for flipY=true scenes). This pushes all floor-level collision faces below the physics slab surface. The player walks on the smooth slab; voxels only contribute horizontal wall collision above floor level. Small obstacles (< 0.3 m) disappear entirely.

```js
const FLOOR_SINK = 0.3; // metres — increase if player still catches on terrain
```

### Auto-detected floor

`generateCollision` now returns `plyFloorY` and `upDir`. `play.js` converts:
```js
const worldFloorY = flipY ? -plyFloorY : plyFloorY;
```
and updates `configFloorY` in the configure screen once collision finishes.

---

## Physics

`BvhCharacterPhysics` in `src/fps/bvhPhysics.js` — ported from VIVERSE SDK.

Key parameters (in `src/fps/physics.js`):
```js
capsuleRadius: 0.2,      // metres — small to avoid grass; raise for wider body
capsuleHeight: 1.6,      // metres — total player height
maxGroundSlope: 0.5,     // tan(angle) — surfaces steeper than ~27° are walls
gravity: 20,             // m/s²
```

Walk/run speeds and jump force in `src/play.js`:
```js
const FPS_WALK_SPEED = 4;   // m/s
const FPS_RUN_SPEED  = 8;   // m/s  (hold Shift)
const FPS_FLY_SPEED  = 10;  // m/s
const FPS_JUMP_FORCE = 8;   // m/s upward impulse
```

---

## Known issues / further development

### 1. Wall collision unreliable on some splats
The flood-fill seed is placed 1 m above `box.min.y` in PLY space. For scenes where navigable space is not at the bounding-box bottom (e.g. multi-floor buildings, elevated structures), the seed may land in solid geometry and the mesh will only produce a floor. **Fix**: expose a seed-override in the configure screen so the user can click where the flood-fill should start.

### 2. flipY assumption
All code assumes `flipY: true` (180° X rotation — standard Polycam / most 3DGS exports). Splats from other tools (Luma AI, some RealityScan exports) may use `flipY: false` or a different up-axis. The configure screen currently has no axis selector. **Fix**: add a Y-flip toggle to the configure panel.

### 3. Large outdoor scenes — sparse collision
For scenes > 100 m across, even 1.5 m voxels produce coarse collision. Walls of thin structures (fences, columns) may be missed. **Fix**: increase `MAX_VOXELS` (currently 8M) in `src/collision/client-collider.js` if GPU memory allows, or implement a two-pass approach (coarse global + fine local around spawn).

### 4. Local file presets require IndexedDB
File-upload presets store the entire PLY ArrayBuffer in IndexedDB. For files > 500 MB this can be slow to read back. **Fix**: store only a hash, prompt the user to re-drop the file if it's missing, or stream from an object URL.

### 5. No mobile / touch support
Pointer lock and keyboard-only controls make the experience desktop-only. **Fix**: add a virtual joystick (e.g. `nipplejs`) and gyroscope look for mobile.

### 6. Collision regeneration on floor change
When the user adjusts floor height via the FPS widget, only the physics slab moves — the voxel collision mesh stays fixed. For large floor adjustments the player may float above or fall through walls near the base. **Fix**: trigger a lightweight re-voxelization of just the height-range affected by the change.

### 7. CORS for cross-origin PLY URLs
Fetching a `.ply` from another origin requires the host to send `Cross-Origin-Resource-Policy: cross-origin`. Without it the fetch will fail silently. **Fix**: add better error messaging and a CORS proxy option in the URL input.

---

## Deployment

The `play` entry point is already registered in `vite.config.js`:
```js
input: {
  play: resolve(__dirname, 'play.html'),
  // …other entries
}
```

```bash
npm run build
# dist/play.html + assets are ready to deploy
```

COEP/COOP headers are required for WebGPU SharedArrayBuffer. The Vite config injects them in dev. For production, configure your server:
```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

---

## Branch / version

This code lives on the `GaussianSplat-Play` branch of `dkatz23/fpsAnywhere`.  
Base branch: `GaussianUpgrade`.
