// Client-side GPU collision mesh generation.
// Runs fully in the browser using WebGPU — no server round-trip.
//
// Pipeline: PLY → parseGaussians → GPU voxelization → SparseVoxelGrid →
//           twoLevelBFS (flood fill from seed) → voxelFaces → BufferGeometry

import { parseGaussians, fetchAndParseGaussians, detectFloorY } from './ply-reader.js';
import { createVoxelizer, voxelizeGrid, destroyVoxelizer } from './gpu-voxelize.js';
import {
    BLOCK_EMPTY, BLOCK_SOLID, BLOCK_MIXED,
    SparseVoxelGrid
} from './sparse-voxel-grid.js';
import { twoLevelBFS } from './flood-fill.js';
import { voxelFaces } from './voxel-faces.js';

// Max total voxels before auto-scaling the voxelSize up.
const MAX_VOXELS = 8_000_000;

function alignDown(v, blockSize) { return Math.floor(v / blockSize) * blockSize; }
function alignUp(v, blockSize)   { return Math.ceil(v  / blockSize) * blockSize; }

function computeGridBounds(bounds, voxelResolution) {
    const blockSize = 4 * voxelResolution;
    const pad = blockSize; // one block of padding on each side
    return {
        min: {
            x: alignDown(bounds.minX - pad, blockSize),
            y: alignDown(bounds.minY - pad, blockSize),
            z: alignDown(bounds.minZ - pad, blockSize),
        },
        max: {
            x: alignUp(bounds.maxX + pad, blockSize),
            y: alignUp(bounds.maxY + pad, blockSize),
            z: alignUp(bounds.maxZ + pad, blockSize),
        }
    };
}

function gridDims(gridBounds, voxelResolution) {
    const blockSize = 4 * voxelResolution;
    return {
        nx: Math.round((gridBounds.max.x - gridBounds.min.x) / voxelResolution),
        ny: Math.round((gridBounds.max.y - gridBounds.min.y) / voxelResolution),
        nz: Math.round((gridBounds.max.z - gridBounds.min.z) / voxelResolution),
        nbx: Math.round((gridBounds.max.x - gridBounds.min.x) / blockSize),
        nby: Math.round((gridBounds.max.y - gridBounds.min.y) / blockSize),
        nbz: Math.round((gridBounds.max.z - gridBounds.min.z) / blockSize),
    };
}

// Populate a SparseVoxelGrid from the flat u32 mask array returned by voxelizeGrid.
function masksToGrid(masks, nbx, nby, nbz, nx, ny, nz) {
    const grid = new SparseVoxelGrid(nx, ny, nz);
    const SOLID_MASK = 0xFFFFFFFF >>> 0;
    const total = nbx * nby * nbz;
    for (let i = 0; i < total; i++) {
        const lo = masks[i * 2];
        const hi = masks[i * 2 + 1];
        if (!lo && !hi) continue;
        if (lo === SOLID_MASK && hi === SOLID_MASK) {
            grid.setBlockType(i, BLOCK_SOLID);
        } else {
            grid.setBlockType(i, BLOCK_MIXED);
            grid.masks.set(i, lo, hi);
        }
    }
    return grid;
}

/**
 * Generate a collision mesh client-side using WebGPU.
 *
 * @param {Object} opts
 * @param {string|null}  opts.plyUrl         - URL to fetch PLY from (null if using opts.plyBuffer)
 * @param {ArrayBuffer|null} opts.plyBuffer   - Raw PLY bytes (null if using opts.plyUrl)
 * @param {number[]} opts.seedPos             - [x,y,z] seed in PLY-local world space
 * @param {number}   opts.voxelSize           - Initial voxel size in metres (default 0.15)
 * @param {number}   opts.opacityThreshold    - Opacity threshold 0–1 (default 0.2)
 * @param {Function} opts.onLog               - Optional log callback(string)
 * @returns {{ positions: Float32Array, indices: Uint32Array, gridBounds: object }}
 */
export async function generateCollision({
    plyUrl = null,
    plyBuffer = null,
    seedPos = [0, 1, 0],
    voxelSize = 0.15,
    opacityThreshold = 0.2,
    onLog = null,
} = {}) {
    if (!navigator.gpu) throw new Error('WebGPU not supported in this browser');

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter found');
    const device = await adapter.requestDevice({
        requiredLimits: {
            maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
            maxBufferSize: adapter.limits.maxBufferSize,
        }
    });

    try {
        // ── 1. Parse PLY ─────────────────────────────────────────────────────
        // MAX_GAUSSIANS is passed directly into parseGaussians so it stride-samples
        // during parsing — the output array is always ≤ 400K × 64 bytes = 26 MB.
        // Without this, a 10M-Gaussian / 880 MB file would allocate ~640 MB of
        // JS heap for the intermediate Gaussian array before any subsampling.
        const MAX_GAUSSIANS = 400_000;
        let parsed;
        if (plyBuffer) {
            onLog?.('Parsing PLY bytes…');
            parsed = parseGaussians(plyBuffer, opacityThreshold, MAX_GAUSSIANS);
            onLog?.(`${parsed.numGaussians.toLocaleString()} Gaussians sampled`);
        } else if (plyUrl) {
            parsed = await fetchAndParseGaussians(plyUrl, opacityThreshold, onLog, MAX_GAUSSIANS);
        } else {
            throw new Error('generateCollision: provide plyUrl or plyBuffer');
        }

        if (!parsed.numGaussians) throw new Error('No solid Gaussians found — check opacity threshold');

        let { gaussians, numGaussians, bounds } = parsed;

        // ── 1b. Detect floor from Y histogram (Option A) ─────────────────────
        // The peak of the Y-position histogram identifies the real floor,
        // which is far more reliable than bbox.min/max that include stray Gaussians.
        const floorDetect = detectFloorY(gaussians, numGaussians);
        const plyFloorY = floorDetect?.floorY ?? (bounds.minY + bounds.maxY) / 2;
        const upDir     = floorDetect?.upDir  ?? 1;
        onLog?.(`Floor detected at PLY Y=${plyFloorY.toFixed(3)} (above=${upDir > 0 ? '+Y' : '-Y'})`);

        // ── 1c. Height-clamp voxel zone (Option B) ───────────────────────────
        // Keep the full navigable side of the floor; trim only the stray-Gaussian
        // side (the region physically "below" the floor) to 5 % of total Y span.
        // This prevents GPU crashes on large outdoor scenes and focuses voxel
        // resolution where the player can actually stand.
        const ySpan     = bounds.maxY - bounds.minY;
        const belowFrac = ySpan * 0.05; // 5 % of total span as below-floor buffer
        const voxelBounds = {
            minX: bounds.minX, maxX: bounds.maxX,
            minZ: bounds.minZ, maxZ: bounds.maxZ,
            minY: upDir < 0
                ? bounds.minY                                        // navigable side: keep all
                : Math.max(bounds.minY, plyFloorY - belowFrac),     // stray side: trim
            maxY: upDir < 0
                ? Math.min(bounds.maxY, plyFloorY + belowFrac)      // stray side: trim
                : bounds.maxY,                                        // navigable side: keep all
        };
        const trimPct = (1 - (voxelBounds.maxY - voxelBounds.minY) / ySpan) * 100;
        if (trimPct > 1) onLog?.(`Voxel zone: trimmed ${trimPct.toFixed(0)}% of below-floor strays`);

        // ── 2. Grid sizing with auto-scale ───────────────────────────────────
        let vs = parseFloat(voxelSize) || 0.15;
        if (vs < 0.05) vs = 0.05;
        let gridBounds, dims;
        while (true) {
            gridBounds = computeGridBounds(voxelBounds, vs); // height-clamped bounds
            dims = gridDims(gridBounds, vs);
            const total = dims.nx * dims.ny * dims.nz;
            if (total <= MAX_VOXELS) break;
            vs *= 2;
            onLog?.(`Grid too large — retrying with voxelSize=${vs.toFixed(3)}m`);
        }
        onLog?.(`Grid ${dims.nx}×${dims.ny}×${dims.nz} (${(dims.nx*dims.ny*dims.nz/1e6).toFixed(1)}M voxels, ${vs.toFixed(3)}m res)`);

        // ── 3. GPU voxelization ──────────────────────────────────────────────
        const sceneExtent = Math.sqrt(
            (bounds.maxX-bounds.minX)**2 + (bounds.maxY-bounds.minY)**2 + (bounds.maxZ-bounds.minZ)**2
        );
        onLog?.('Building spatial index & uploading to GPU…');
        const voxelizer = await createVoxelizer(device, gaussians, numGaussians, vs, sceneExtent);

        onLog?.('Running GPU voxelization…');
        const masks = await voxelizeGrid(
            voxelizer, gridBounds,
            dims.nbx, dims.nby, dims.nbz,
            vs, opacityThreshold,
            (done, total) => onLog?.(`Voxelizing… ${Math.round(done/total*100)}%`)
        );
        destroyVoxelizer(voxelizer);
        onLog?.('Voxelization complete');

        // ── 4. Build SparseVoxelGrid ─────────────────────────────────────────
        const solidGrid = masksToGrid(masks, dims.nbx, dims.nby, dims.nbz, dims.nx, dims.ny, dims.nz);

        // Guard: if voxelization produced nothing, the GPU path failed silently — fall back to server
        let solidBlockCount = 0;
        for (let i = 0; i < solidGrid.types.length; i++) if (solidGrid.types[i]) solidBlockCount++;
        onLog?.(`Solid blocks: ${solidBlockCount.toLocaleString()}`);
        if (solidBlockCount === 0) throw new Error('Voxelization produced no solid blocks — GPU path unsupported for this splat, falling back to server');

        // ── 5. Multi-point seed generation (Options A + D) ───────────────────
        // Place a 3×3 XZ grid of candidates 5 voxels "above" the histogram-detected
        // floor. Using multiple seeds means the flood fill covers disconnected
        // navigable regions and is robust when the scene centre is empty space
        // (open-plan rooms, outdoor plazas, etc.).
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // "Above floor" = moving upDir voxels from the detected floor in PLY space.
        // upDir=-1 → above = decreasing PLY Y (flipY Polycam convention)
        // upDir=+1 → above = increasing PLY Y
        const SEED_ABOVE = 5; // voxels above the floor surface
        const seedYPly = plyFloorY + upDir * SEED_ABOVE * vs;

        const cx      = (bounds.minX + bounds.maxX) / 2;
        const cz      = (bounds.minZ + bounds.maxZ) / 2;
        const xSpread = (bounds.maxX - bounds.minX) * 0.25;
        const zSpread = (bounds.maxZ - bounds.minZ) * 0.25;

        const seedVoxels = [];
        const seen = new Set();
        for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
                const ix = clamp(Math.floor((cx + di * xSpread - gridBounds.min.x) / vs), 0, dims.nx - 1);
                const iy = clamp(Math.floor((seedYPly          - gridBounds.min.y) / vs), 0, dims.ny - 1);
                const iz = clamp(Math.floor((cz + dj * zSpread - gridBounds.min.z) / vs), 0, dims.nz - 1);
                const key = `${ix},${iy},${iz}`;
                if (!seen.has(key) && !solidGrid.getVoxel(ix, iy, iz)) {
                    seen.add(key);
                    seedVoxels.push({ ix, iy, iz });
                }
            }
        }

        // Fallback: if every grid candidate landed inside solid geometry, relocate
        // the original seedPos to the nearest free voxel.
        if (!seedVoxels.length) {
            let sIx = clamp(Math.floor((seedPos[0] - gridBounds.min.x) / vs), 0, dims.nx - 1);
            let sIy = clamp(Math.floor((seedPos[1] - gridBounds.min.y) / vs), 0, dims.ny - 1);
            let sIz = clamp(Math.floor((seedPos[2] - gridBounds.min.z) / vs), 0, dims.nz - 1);
            if (solidGrid.getVoxel(sIx, sIy, sIz)) {
                const free = SparseVoxelGrid.findNearestFreeCell(solidGrid, sIx, sIy, sIz, 200);
                if (!free) throw new Error('No navigable voxel found near any seed — all cells solid');
                onLog?.(`Fallback seed relocated to nearest free voxel`);
                sIx = free.ix; sIy = free.iy; sIz = free.iz;
            }
            seedVoxels.push({ ix: sIx, iy: sIy, iz: sIz });
        }
        onLog?.(`Flood fill: ${seedVoxels.length} seed voxel(s) at detected floor`);

        // ── 6. Flood fill (two-level BFS) ────────────────────────────────────
        onLog?.('Running flood fill…');
        const navigableGrid = twoLevelBFS(
            solidGrid, [], seedVoxels,
            dims.nx, dims.ny, dims.nz,
            count => onLog?.(`Flood fill: ${(count * 64).toLocaleString()} voxels`)
        );
        solidGrid.releaseStorage();
        onLog?.('Flood fill complete');

        // ── 7. Mesh extraction ───────────────────────────────────────────────
        onLog?.('Extracting collision mesh…');
        const mesh = voxelFaces(navigableGrid, gridBounds, vs);
        navigableGrid.releaseStorage();

        if (!mesh.indices.length) throw new Error('Empty collision mesh — seed may be outside the splat');

        const triCount = mesh.indices.length / 3;
        const vertCount = mesh.positions.length / 3;
        onLog?.(`Mesh: ${vertCount.toLocaleString()} vertices, ${triCount.toLocaleString()} triangles`);

        return { positions: mesh.positions, indices: mesh.indices, gridBounds, plyFloorY, upDir };

    } finally {
        device.destroy();
    }
}

// Check whether WebGPU is available in this browser.
export function isWebGPUAvailable() {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
}
