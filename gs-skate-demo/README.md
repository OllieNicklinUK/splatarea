# GS Skate Demo

Ride a skateboard through any Gaussian Splat scene.

Two packages — run both dev servers, then open the Collision Mapper to load your PLY.

---

## Quick start

### 1. Collision Mapper (port 3030)

Generates the collision mesh from a `.ply` Gaussian Splat file.

```bash
cd collision-tool
npm install
npm run dev
# → http://127.0.0.1:3030
```

**Workflow:**
1. Drop a `.ply` file onto the canvas.
2. Adjust *Voxel size* (smaller = more detail, slower) and *Opacity cutoff*.
3. Click **Generate Collision** — quality mode is always on (8× dilation + Taubin smoothing).
4. Preview the mesh overlay. When happy, click **▶ Play GS Skate Demo**.

The PLY and generated `.collision.glb` are automatically mirrored to `skate-game/public/racing/`.

---

### 2. Skate Game (port 5174)

The playable racing/skating game.

```bash
cd skate-game
npm install
npm run dev
# → http://127.0.0.1:5174/racing/
```

The game loads `public/racing/uploaded.ply` + `uploaded.collision.glb` written by the Collision Mapper.

**Controls:** `WASD` / arrow keys to drive · `Space` handbrake

---

## File layout

```
gs-skate-demo/
├── collision-tool/       Vite app — PLY → collision GLB pipeline
│   ├── scripts/
│   │   └── ply-voxelizer.mjs   Node.js voxelizer (self-contained)
│   └── src/main.js
└── skate-game/           Vite app — Three.js + Spark splat renderer
    ├── src/
    │   ├── racing-game.js      Car physics
    │   ├── arena-loader.js     Splat + collider loader
    │   └── shared/
    │       ├── SplatArena.js   BVH collision helper
    │       └── collision/      GPU voxelizer (WebGPU path)
    └── public/racing/
        ├── skate.glb           Skateboard model
        ├── uploaded.ply        → written by Collision Mapper
        └── uploaded.collision.glb
```

## Node version

Requires **Node 18+** (ESM + `fs.linkSync`).
