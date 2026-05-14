# Gaussian Splat Library — Template Guide

## Purpose
Interactive 3D prop library and scene composer with Gaussian splat support.
Users can upload GLB/PLY worlds, walk around them in first-person, generate
AI-textured 3D props via the Meshy API, and compose scenes with physics-based
collision.

## Architecture
- **`src/library.js`** — all scene logic (Three.js, Spark splat renderer, Orbit/FPS controls, Meshy integration)
- **`src/fps/`** — physics engine (BVH capsule physics, ball shooter)
- **`src/collision/`** — PLY → voxel collision mesh pipeline (GPU + CPU fallback)
- **`src/training/warehouse-assets.js`** — procedural prop definitions
- **`vite.config.js`** — custom middleware: WASM serving, COOP/COEP headers, model scanner, splat collision API
- **`scripts/ply-voxelizer.mjs`** — pure Node.js fallback voxelizer (no native binary needed)

## Customisation Surface (safe to edit)
- `index.html` — page title, UI labels, adding new controls to the settings bar
- `src/library.js` — scene behaviour, lighting, default camera, Meshy prompt defaults, prop placement logic
- `src/training/warehouse-assets.js` — procedural prop shapes and materials
- `public/models/` — drop `.glb`/`.gltf` files here; they appear in the "File Models" sidebar
- `public/splats/` — drop `.ply` splat files here; they appear in the "Import World" panel
- `rulesets/default.json` — runtime configuration

## Guardrails (do NOT modify)
- `vite.config.js` — custom Vite plugins are required for WASM, SharedArrayBuffer, and the splat collision pipeline
- `src/collision/` — GPU voxelizer pipeline; break it and PLY worlds lose walkable collision
- `src/fps/bvhPhysics.js`, `src/fps/physics.js` — BVH capsule physics engine
- `scripts/ply-voxelizer.mjs` — fallback voxelizer called by the Vite plugin

## Build
```bash
npm install
npm run dev      # dev server at http://127.0.0.1:5173
npm run build    # production build → dist/
```

Requires Node.js 18+. The dev server sets `Cross-Origin-Embedder-Policy: require-corp`
automatically (needed for SharedArrayBuffer in the Spark WASM renderer).

## Asset Symlinking (optional)
To reuse assets from the original fpsAnywhere-GaussianUpgrade project:
```bash
GAUSSIAN_PROJECT=/path/to/fpsAnywhere-GaussianUpgrade bash setup.sh
```

## Splat Collision Pipeline
- Upload a `.ply` via the browser UI → server runs `splat-transform -K` (if installed)
- If `splat-transform` is absent, falls back to the built-in `scripts/ply-voxelizer.mjs`
- Output: `.collision.glb` served at `/splats/collisions/<jobId>.collision.glb`
- Set `SPLAT_TRANSFORM_BIN=/path/to/splat-transform` env var to override the binary location

## Meshy AI Generation
The "⚡ GENERATE" button calls `https://viverse-backend.onrender.com/api/meshy/*`.
No API key is required in this template — the remote backend handles authentication.
