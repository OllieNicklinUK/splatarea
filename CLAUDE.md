# Splat Arena — Project Context for Claude

## Core Objective

**Make interactive games playable inside real Gaussian Splat environments.**

That is the only objective of this codebase. A user uploads (or links) a `.ply` Gaussian Splat file, the system auto-generates a physics collision mesh from the splat's geometry, aligns the game world to the splat's floor and scale, then launches one of several playable game modes inside the splat scene. The splat is the level. There is nothing else.

---

## System Overview

The pipeline has two parts that run sequentially:

```
[Collision Mapper]  →  alignment + collision mesh  →  [Game]
     (browser)              (localStorage)             (browser)
```

1. **Collision Mapper** — the user's entry point. Upload a PLY, tweak alignment, generate the collision voxel mesh, hit "Play". Passes configuration to the game via URL params + localStorage.
2. **Game** — loads the splat, reads the saved config, applies alignment, starts gameplay on top of the splat environment.

Both are served from a single Vite dev server running on **port 3030** (`templates/splat-arena/` or `templates/splat-collision-tool/`). The two templates are functionally equivalent collision mappers — `splat-arena` is the primary one and owns the games.

---

## Collision Mapper

### Entry point
`templates/splat-arena/index.html` — sidebar UI + 3D viewport.
`templates/splat-arena/src/mapper-main.js` — all mapper logic.

### What it does
1. User drops a `.ply` file onto the dropzone, or pastes a URL (superspl.at link or direct `.ply` URL).
2. The splat is rendered via `@mkkellogg/gaussian-splats-3d` (GS3D `Viewer`).
3. User sets **Scale**, **Splat Flip** (X/Y/Z axes), **Floor Y** (seed for flood-fill), voxel resolution, opacity threshold.
4. Clicking **Generate Collision** runs the full GPU voxelization pipeline in-browser via WebGPU, producing a THREE.js `BufferGeometry` collision mesh overlay.
5. User drags the splat offset sliders to align the splat with the normalised collision GLB (floor at Y=0, centred on XZ).
6. **Save Alignment** writes the full config to localStorage.
7. Play buttons (`Play Skate`, `Play FPS`, `Play People`) open the respective game page with alignment params in the URL.

### Sidebar controls
| Control | ID | Purpose |
|---|---|---|
| URL input | `url-input` | Load remote PLY or superspl.at link |
| Scale | `scale` | Uniform scale applied to splat only |
| Flip X/Y/Z | `flip-x`, `flip-y`, `flip-z` | Per-axis reflection of splat only |
| Voxel Size | `voxel-size` | Collision resolution (smaller = finer, slower) |
| Opacity Threshold | `op-thresh` | Gaussian opacity cutoff — raise to exclude fog/sky |
| Floor Seed Y | `seed-y` | Y-level the flood-fill uses to find walkable volume |
| Splat Offset X/Y/Z | `splat-offset-x/y/z` | Fine-align splat to collision mesh |
| Save Alignment | `save-alignment-btn` | Persist full config to localStorage |
| Play buttons | `play-btn`, `play-fps-btn`, `play-people-btn` | Launch game with current config |

### Collision pipeline
`templates/splat-arena/src/shared/collision/`

```
PLY bytes
  └─ ply-reader.js        parseGaussians() / fetchAndParseGaussians()
       └─ gpu-voxelize.js   WebGPU compute shader — Gaussian → voxel grid
            └─ sparse-voxel-grid.js  SparseVoxelGrid (block-map)
                 └─ flood-fill.js    twoLevelBFS — keep only reachable walkable space
                      └─ voxel-faces.js  face extraction → THREE.BufferGeometry
                           └─ client-collider.js  public entry point — generateCollision()
```

The generated mesh is also simplified via `simplify-collision.js` (mesh-opt simplifier) and BVH-accelerated via `three-mesh-bvh` before being handed to the game's physics layer.

---

## Games

All games share the same initialisation flow via `arena-loader.js` and floor-setup panel via `floor-setup.js`. Each game is a subdirectory with its own `index.html` and `src/<game>-main.js` + `src/<game>-game.js`.

### Shared init flow (`src/arena-loader.js`)
1. Set up THREE.js renderer, camera, scene, lights, SparkRenderer (for splat).
2. Discover PLY: check `GAME_CONFIG.splatUrl` → fall back to `public/scene.ply`.
3. Load splat via `@sparkjsdev/spark` `SplatMesh`.
4. Check localStorage for a locked config (`sa-cfg:<game>:<plyName>`).
   - If locked config exists with `_v >= 2`: skip alignment panel, go straight to gameplay.
   - Otherwise: show `floor-setup.js` alignment panel.
5. After alignment confirmed: call `onSplatReady` with scene/camera/floorY/spawnCenter/spawnRadius.
6. Background: run WebGPU voxelization → BVH mesh → call `onColliderReady`.

### Games

#### FPS Arena (`fps/`)
- First-person shooter. WASD + mouse look, click to shoot physics balls.
- `src/fps-main.js` → `src/fps-game.js`
- localStorage key: `sa-cfg:fps:<plyName>`

#### GS Skate Demo (`racing/`)
- Third-person skating/driving. WASD + Space (handbrake). Speed HUD.
- `src/racing-main.js` → `src/racing-game.js`
- localStorage key: `sa-cfg:racing:<plyName>`

#### People Park (`people/`)
- Top-down NPC crowd simulation. Click to scatter NPCs. Follow-cam button.
- NPCs (`NPC.js`) wander using multi-ray wall avoidance + terrain-Y clamped to floor.
- `src/people-main.js` → `src/people-game.js`
- Crowd: `src/shared/people/SplatCrowd.js` — spawns VRM NPCs staggered over time.
- localStorage key: `sa-cfg:people:<plyName>`

#### Flight (`flight/`)
- Free-flight mode through the splat environment.
- `src/flight-main.js` → `src/flight-game.js`
- localStorage key: `sa-cfg:flight:<plyName>`

---

## Floor Setup & Alignment Panel (`src/floor-setup.js`)

The alignment panel is an in-scene overlay shown before gameplay if no locked config exists. It lets the user:
- Set **Floor Y** (drag or type) — defines the Y world-coordinate of the walkable surface.
- Set **Spawn Centre** (X/Z) and **Spawn Radius** — where NPCs/player spawn.
- Set **Scale**, **Flip X/Y/Z** — same as mapper controls, applied to the splat mesh.
- Set **Splat Offset X/Y/Z** — fine-tune splat position relative to the collision mesh.
- Click **Lock In & Play** — saves config to localStorage with `locked: true` and starts gameplay.

### Scale and flip on the splat mesh
Reflections cannot be represented as rotation quaternions (det = −1). Always use:
```js
mesh.scale.set(
  scale * (flipX ? -1 : 1),
  scale * (flipY ? -1 : 1),
  scale * (flipZ ? -1 : 1),
);
```
Never try to flip via `rotation`.

---

## localStorage Persistence

### Key format
```
sa-cfg:<game>:<plyName>
```
- `<game>`: `fps` | `racing` | `people` | `flight`
- `<plyName>`: filename from PLY URL (e.g. `scene.ply`) or `uploaded.ply` for uploaded/superspl.at files

### Config schema (`_v: 2`)
```js
{
  _v:           2,          // REQUIRED — checked by arena-loader before applying splatOffset
  floorY:       number,
  spawnX:       number,
  spawnZ:       number,
  spawnRadius:  number,
  scale:        number,
  flipX:        boolean,
  flipY:        boolean,
  flipZ:        boolean,
  splatOffsetX: number,
  splatOffsetY: number,
  splatOffsetZ: number,
  locked:       boolean,    // true = skip alignment panel on next load
}
```

### `_v: 2` is critical
`arena-loader.js` checks `_saved?._v >= 2 && _saved?.splatOffsetX != null` before applying `splatOffset`. If `_v` is missing the splat stays at (0,0,0) and is misaligned from the collision mesh. Every code path that writes to localStorage must include `_v: 2`.

This applies to:
- `floor-setup.js` `_confirm()` — must preserve `_v` from existing config (`const keep = { _v: existing._v ?? 2 }`)
- Game HTML URL-param init scripts (in `fps/index.html`, `racing/index.html`, `people/index.html`, `flight/index.html`) — must write `_v: 2` as first field

### splatOffset convention
`splatOffset = (−cx, −plyFloorY, −cz)` — places the splat so its detected floor lands at world Y=0 and the scene is XZ-centred, aligning with the normalised collision GLB.

---

## File Structure

```
templates/splat-arena/              Primary template — mapper + all games
├── index.html                      Collision mapper UI
├── src/
│   ├── mapper-main.js              Mapper logic (GS3D viewer, voxelization, alignment, launch)
│   ├── arena-loader.js             Shared game initialiser (THREE + Spark + floor-setup + collider)
│   ├── floor-setup.js              In-game alignment panel + settings persistence
│   ├── simplify-collision.js       Mesh simplification (mesh-opt WASM)
│   ├── fps-main.js / fps-game.js   FPS mode
│   ├── racing-main.js / racing-game.js   Skate/racing mode
│   ├── people-main.js / people-game.js   NPC crowd mode
│   ├── flight-main.js / flight-game.js   Flight mode
│   └── shared/
│       ├── collision/              GPU voxelization pipeline
│       │   ├── client-collider.js  Public entry: generateCollision()
│       │   ├── ply-reader.js       PLY parser + floor detection
│       │   ├── gpu-voxelize.js     WebGPU compute voxelizer
│       │   ├── sparse-voxel-grid.js
│       │   ├── flood-fill.js       BFS reachability filter
│       │   └── voxel-faces.js      Geometry extraction
│       └── people/                 NPC system
│           ├── SplatCrowd.js       Crowd manager (spawn, update, scatter)
│           ├── NPC.js              Individual NPC (wander, wall avoidance, terrain Y)
│           └── character-loader.js VRM model loader + instance pool
├── fps/index.html                  FPS game page
├── racing/index.html               Skate game page
├── people/index.html               People Park game page
├── flight/index.html               Flight game page
├── public/                         Static assets (default scene.ply goes here)
└── vite.config.js

templates/splat-collision-tool/     Standalone collision mapper (mirrors splat-arena mapper)
├── index.html
└── src/main.js

gs-skate-demo/                      Standalone skate demo package
├── collision-tool/                 Copy of collision mapper
└── skate-game/                     Copy of skate game
```

---

## Dev Server

Single Vite server serves everything from `templates/splat-arena/` (or `splat-collision-tool/`) on **port 3030**.

```bash
cd templates/splat-arena
npm install
npm run dev   # → http://localhost:3030
```

Routes:
- `/` → Collision Mapper
- `/fps/` → FPS Arena
- `/racing/` → GS Skate Demo
- `/people/` → People Park
- `/flight/` → Flight mode

---

## Key Dependencies

| Package | Role |
|---|---|
| `@sparkjsdev/spark` | Gaussian Splat renderer (games) — `SparkRenderer` + `SplatMesh` |
| `@mkkellogg/gaussian-splats-3d` | GS3D viewer (collision mapper only) |
| `three` | 3D engine |
| `three-mesh-bvh` | BVH acceleration for raycasting against collision mesh |
| `@pixiv/three-vrm` | VRM character loading for NPCs |

---

## NPC System (People Park)

### `SplatCrowd.js`
- Spawns `CROWD_COUNT` NPCs staggered by `SPAWN_INTERVAL` ms.
- Accepts `voxelMesh` (set it via `setVoxelMesh()` once the collider is ready).
- `scatter(worldPos)` triggers flee behaviour from a point for `SCATTER_LINGER` seconds.

### `NPC.js`
- States: `wander` → `flee` → `held` → `thrown` → `recovering` → `wander`
- Wall avoidance: 3 rays (forward + ±30°) at `_floorY + 0.9`, look-ahead `1.4m`. Turns toward more open side. Push-back if within `0.45m`.
- Terrain Y: downward raycast from `_floorY + 4` (fixed, not `pos.y`), clamped to `[_floorY − 0.5, _floorY + 0.5]` to prevent wall-face climbing.
- Scale: `_floorY` passed in options; NPC stays at that Y at all times via `_terrainY()`.
