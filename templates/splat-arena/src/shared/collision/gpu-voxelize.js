// Native WebGPU voxelization — WGSL shader ported from splat-transform-main.
// Uses Beer-Lambert extinction + Mahalanobis distance per Gaussian.
//
// CPU-side SpatialIndex pre-filters which Gaussians overlap each batch region,
// reducing per-dispatch work from O(all_Gaussians × all_blocks) to O(local_density).

const WGSL = /* wgsl */`
struct Uniforms {
    opacityCutoff: f32,
    voxelResolution: f32,
    maxBlocksPerBatch: u32,
    _pad: u32
}
struct Gaussian {
    posX: f32, posY: f32, posZ: f32, opacityLogit: f32,
    rotW: f32, rotX: f32, rotY: f32, rotZ: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32,
    extentX: f32, extentY: f32, extentZ: f32,
    _pad0: f32, _pad1: f32
}
struct BatchInfo {
    indexOffset: u32, indexCount: u32,
    numBlocksX: u32, numBlocksY: u32, numBlocksZ: u32,
    blockMinX: f32, blockMinY: f32, blockMinZ: f32
}

@group(0) @binding(0) var<uniform>             uniforms:    Uniforms;
@group(0) @binding(1) var<storage, read>        allGaussians: array<Gaussian>;
@group(0) @binding(2) var<storage, read>        indices:     array<u32>;
@group(0) @binding(3) var<storage, read_write>  results:     array<u32>;
@group(0) @binding(4) var<storage, read>        batchInfos:  array<BatchInfo>;

const tileSize = 64u;
var<workgroup> sharedGaussians: array<Gaussian, tileSize>;
var<workgroup> blockMasks: array<atomic<u32>, 2>;

fn mortonToXYZ(m: u32) -> vec3u {
    return vec3u(
        (m & 1u) | ((m >> 2u) & 2u),
        ((m >> 1u) & 1u) | ((m >> 3u) & 2u),
        ((m >> 2u) & 1u) | ((m >> 4u) & 2u)
    );
}

fn evaluateGaussian(voxelCenter: vec3f, voxelHalfSize: f32, g: Gaussian) -> f32 {
    let diff = voxelCenter - vec3f(g.posX, g.posY, g.posZ);
    if (any(abs(diff) > (vec3f(g.extentX, g.extentY, g.extentZ) + voxelHalfSize))) { return 0.0; }
    let closest = clamp(vec3f(g.posX, g.posY, g.posZ), voxelCenter - voxelHalfSize, voxelCenter + voxelHalfSize);
    let cd = closest - vec3f(g.posX, g.posY, g.posZ);
    let qxyz = vec3f(-g.rotX, -g.rotY, -g.rotZ);
    let t = 2.0 * cross(qxyz, cd);
    let localDiff = cd + g.rotW * t + cross(qxyz, t);
    let invScale = vec3f(exp(-g.scaleX), exp(-g.scaleY), exp(-g.scaleZ));
    let scaled = localDiff * invScale;
    let opacity = 1.0 / (1.0 + exp(-g.opacityLogit));
    return opacity * exp(-0.5 * dot(scaled, scaled));
}

@compute @workgroup_size(64)
fn main(
    @builtin(local_invocation_index) voxelIdx: u32,
    @builtin(workgroup_id) wgId: vec3u
) {
    let batchIdx = wgId.z;
    let flatBlockId = wgId.x;
    let info = batchInfos[batchIdx];
    if (flatBlockId >= info.numBlocksX * info.numBlocksY * info.numBlocksZ) { return; }

    let blockX = flatBlockId % info.numBlocksX;
    let blockY = (flatBlockId / info.numBlocksX) % info.numBlocksY;
    let blockZ = flatBlockId / (info.numBlocksX * info.numBlocksY);
    let localPos = mortonToXYZ(voxelIdx);
    let voxelCenter = vec3f(info.blockMinX, info.blockMinY, info.blockMinZ)
        + vec3f(f32(blockX), f32(blockY), f32(blockZ)) * 4.0 * uniforms.voxelResolution
        + (vec3f(localPos) + 0.5) * uniforms.voxelResolution;
    let voxelHalfSize = uniforms.voxelResolution * 0.5;

    if (voxelIdx < 2u) { atomicStore(&blockMasks[voxelIdx], 0u); }
    workgroupBarrier();

    var totalSigma = 0.0;
    let numTiles = (info.indexCount + tileSize - 1u) / tileSize;
    for (var tile = 0u; tile < numTiles; tile++) {
        let loadIdx = tile * tileSize + voxelIdx;
        if (loadIdx < info.indexCount) { sharedGaussians[voxelIdx] = allGaussians[indices[info.indexOffset + loadIdx]]; }
        workgroupBarrier();
        if (totalSigma < 7.0) {
            let sz = min(tileSize, info.indexCount - tile * tileSize);
            for (var c = 0u; c < sz; c++) {
                totalSigma += evaluateGaussian(voxelCenter, voxelHalfSize, sharedGaussians[c]);
                if (totalSigma >= 7.0) { break; }
            }
        }
        workgroupBarrier();
    }

    let isSolid = (1.0 - exp(-totalSigma)) >= uniforms.opacityCutoff;
    let linearIdx = localPos.z * 16u + localPos.y * 4u + localPos.x;
    if (isSolid) { atomicOr(&blockMasks[linearIdx >> 5u], 1u << (linearIdx & 31u)); }
    workgroupBarrier();
    if (voxelIdx < 2u) {
        results[batchIdx * uniforms.maxBlocksPerBatch * 2u + flatBlockId * 2u + voxelIdx]
            = atomicLoad(&blockMasks[voxelIdx]);
    }
}
`;

const MAX_BLOCKS_PER_BATCH = 4096;
const FLOATS_PER_GAUSSIAN  = 16;
const BATCH_INFO_FLOATS    = 8;
const MAX_INDICES          = 4 * 1024 * 1024; // 4M per mega-dispatch

// ─── Spatial index ───────────────────────────────────────────────────────────
class SpatialIndex {
    constructor(gaussianFloats, numGaussians, cellSize, maxExtent) {
        this.cellSize = cellSize;
        this.numGaussians = numGaussians;

        const px = this.px = new Float32Array(numGaussians);
        const py = this.py = new Float32Array(numGaussians);
        const pz = this.pz = new Float32Array(numGaussians);
        const ex = this.ex = new Float32Array(numGaussians);
        const ey = this.ey = new Float32Array(numGaussians);
        const ez = this.ez = new Float32Array(numGaussians);

        let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
        let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
        for (let i = 0; i < numGaussians; i++) {
            const g = i * FLOATS_PER_GAUSSIAN;
            px[i] = gaussianFloats[g];   py[i] = gaussianFloats[g+1]; pz[i] = gaussianFloats[g+2];
            // Cap extents to avoid index explosion from artifact Gaussians with huge scales
            ex[i] = Math.min(gaussianFloats[g+11], maxExtent);
            ey[i] = Math.min(gaussianFloats[g+12], maxExtent);
            ez[i] = Math.min(gaussianFloats[g+13], maxExtent);
            if (px[i] < mnX) mnX = px[i]; if (px[i] > mxX) mxX = px[i];
            if (py[i] < mnY) mnY = py[i]; if (py[i] > mxY) mxY = py[i];
            if (pz[i] < mnZ) mnZ = pz[i]; if (pz[i] > mxZ) mxZ = pz[i];
        }
        this.mnX = mnX - cellSize; this.mnY = mnY - cellSize; this.mnZ = mnZ - cellSize;
        this.ncx = Math.ceil((mxX + cellSize - this.mnX) / cellSize) + 1;
        this.ncy = Math.ceil((mxY + cellSize - this.mnY) / cellSize) + 1;
        this.ncz = Math.ceil((mxZ + cellSize - this.mnZ) / cellSize) + 1;
        const stride = this.ncx * this.ncy;
        const cellCount = this.ncx * this.ncy * this.ncz;

        // Count (Gaussian, cell) pairs
        const counts = new Int32Array(cellCount);
        for (let i = 0; i < numGaussians; i++) {
            const x0 = Math.max(0, Math.floor((px[i] - ex[i] - this.mnX) / cellSize));
            const x1 = Math.min(this.ncx-1, Math.floor((px[i] + ex[i] - this.mnX) / cellSize));
            const y0 = Math.max(0, Math.floor((py[i] - ey[i] - this.mnY) / cellSize));
            const y1 = Math.min(this.ncy-1, Math.floor((py[i] + ey[i] - this.mnY) / cellSize));
            const z0 = Math.max(0, Math.floor((pz[i] - ez[i] - this.mnZ) / cellSize));
            const z1 = Math.min(this.ncz-1, Math.floor((pz[i] + ez[i] - this.mnZ) / cellSize));
            for (let cz = z0; cz <= z1; cz++)
                for (let cy = y0; cy <= y1; cy++)
                    for (let cx = x0; cx <= x1; cx++)
                        counts[cx + cy * this.ncx + cz * stride]++;
        }

        this.offsets = new Int32Array(cellCount + 1);
        for (let i = 0; i < cellCount; i++) this.offsets[i+1] = this.offsets[i] + counts[i];

        this.lists = new Int32Array(this.offsets[cellCount]);
        const write = new Int32Array(cellCount);
        for (let i = 0; i < numGaussians; i++) {
            const x0 = Math.max(0, Math.floor((px[i] - ex[i] - this.mnX) / cellSize));
            const x1 = Math.min(this.ncx-1, Math.floor((px[i] + ex[i] - this.mnX) / cellSize));
            const y0 = Math.max(0, Math.floor((py[i] - ey[i] - this.mnY) / cellSize));
            const y1 = Math.min(this.ncy-1, Math.floor((py[i] + ey[i] - this.mnY) / cellSize));
            const z0 = Math.max(0, Math.floor((pz[i] - ez[i] - this.mnZ) / cellSize));
            const z1 = Math.min(this.ncz-1, Math.floor((pz[i] + ez[i] - this.mnZ) / cellSize));
            for (let cz = z0; cz <= z1; cz++)
                for (let cy = y0; cy <= y1; cy++)
                    for (let cx = x0; cx <= x1; cx++) {
                        const ci = cx + cy * this.ncx + cz * stride;
                        this.lists[this.offsets[ci] + write[ci]++] = i;
                    }
        }

        this._gen = new Uint32Array(numGaussians);
        this._curGen = 1;
        console.log(`[SpatialIndex] ${this.ncx}×${this.ncy}×${this.ncz} cells, ${this.lists.length.toLocaleString()} total entries`);
    }

    // Write overlapping Gaussian indices into out[outBase..outBase+maxCount-1].
    // Returns actual count written (capped at maxCount).
    queryAABB(minX, minY, minZ, maxX, maxY, maxZ, out, outBase, maxCount) {
        const { cellSize, mnX, mnY, mnZ, ncx, ncy, ncz, offsets, lists, px, py, pz, ex, ey, ez, _gen } = this;
        const stride = ncx * ncy;
        const gen = ++this._curGen;
        let count = 0;

        const cx0 = Math.max(0, Math.floor((minX - mnX) / cellSize));
        const cx1 = Math.min(ncx-1, Math.floor((maxX - mnX) / cellSize));
        const cy0 = Math.max(0, Math.floor((minY - mnY) / cellSize));
        const cy1 = Math.min(ncy-1, Math.floor((maxY - mnY) / cellSize));
        const cz0 = Math.max(0, Math.floor((minZ - mnZ) / cellSize));
        const cz1 = Math.min(ncz-1, Math.floor((maxZ - mnZ) / cellSize));

        outer:
        for (let cz = cz0; cz <= cz1; cz++) {
            for (let cy = cy0; cy <= cy1; cy++) {
                for (let cx = cx0; cx <= cx1; cx++) {
                    const ci = cx + cy * ncx + cz * stride;
                    const end = offsets[ci+1];
                    for (let k = offsets[ci]; k < end; k++) {
                        const gi = lists[k];
                        if (_gen[gi] === gen) continue;
                        _gen[gi] = gen;
                        if (px[gi]+ex[gi] >= minX && px[gi]-ex[gi] <= maxX &&
                            py[gi]+ey[gi] >= minY && py[gi]-ey[gi] <= maxY &&
                            pz[gi]+ez[gi] >= minZ && pz[gi]-ez[gi] <= maxZ) {
                            out[outBase + count++] = gi;
                            if (count >= maxCount) break outer;
                        }
                    }
                }
            }
        }
        return count;
    }
}

export async function createVoxelizer(device, gaussianFloats, numGaussians, voxelResolution, sceneExtent) {
    const module = device.createShaderModule({ code: WGSL });

    const bgl = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        ]
    });

    const pipeline = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        compute: { module, entryPoint: 'main' }
    });

    const gaussianBufSize = numGaussians * FLOATS_PER_GAUSSIAN * 4;
    const gaussianBuf = device.createBuffer({ size: gaussianBufSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(gaussianBuf, 0, gaussianFloats, 0, numGaussians * FLOATS_PER_GAUSSIAN);

    // Cap extent to 10% of scene bounding box diagonal — prevents index explosion from artifact Gaussians
    const maxExtent = Math.max(sceneExtent * 0.10, voxelResolution * 8);
    const cellSize  = 16 * voxelResolution;
    console.log(`[GpuVoxelize] Building spatial index — ${numGaussians.toLocaleString()} Gaussians, cellSize=${cellSize.toFixed(3)}m, maxExtent=${maxExtent.toFixed(2)}m`);
    const spatialIndex = new SpatialIndex(gaussianFloats, numGaussians, cellSize, maxExtent);

    return { device, pipeline, bgl, gaussianBuf, numGaussians, spatialIndex };
}

export async function voxelizeGrid(voxelizer, gridBounds, numBlocksX, numBlocksY, numBlocksZ, voxelResolution, opacityCutoff, onProgress) {
    const { device, pipeline, bgl, gaussianBuf, numGaussians, spatialIndex } = voxelizer;
    const totalBlocks = numBlocksX * numBlocksY * numBlocksZ;
    const blockSize   = 4 * voxelResolution;
    const bStride     = numBlocksX * numBlocksY;

    const indexScratch = new Uint32Array(MAX_INDICES);
    const resultMasks  = new Uint32Array(totalBlocks * 2);

    const uniformBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    {
        const u = new ArrayBuffer(16);
        new Float32Array(u)[0] = opacityCutoff;
        new Float32Array(u)[1] = voxelResolution;
        new Uint32Array(u)[2]  = MAX_BLOCKS_PER_BATCH;
        device.queue.writeBuffer(uniformBuf, 0, u);
    }

    const BATCH_BLOCKS = 16;
    const allBatches = [];
    for (let bz = 0; bz < numBlocksZ; bz += BATCH_BLOCKS)
        for (let by = 0; by < numBlocksY; by += BATCH_BLOCKS)
            for (let bx = 0; bx < numBlocksX; bx += BATCH_BLOCKS)
                allBatches.push({
                    bx, by, bz,
                    cbx: Math.min(BATCH_BLOCKS, numBlocksX - bx),
                    cby: Math.min(BATCH_BLOCKS, numBlocksY - by),
                    cbz: Math.min(BATCH_BLOCKS, numBlocksZ - bz),
                });

    const MEGA_MAX = 64;
    let batchStart = 0;
    const total = allBatches.length;
    let totalBatchesWithGaussians = 0;
    let totalIndicesDispatched = 0;

    console.log(`[GpuVoxelize] ${total} spatial batches, grid ${numBlocksX}×${numBlocksY}×${numBlocksZ} blocks`);

    while (batchStart < total) {
        const megaBatches = [];
        const batchIndexOffsets = [];
        const batchIndexCounts  = [];
        let indexOffset = 0;

        while (batchStart < total && megaBatches.length < MEGA_MAX) {
            const b = allBatches[batchStart++];

            const bMinX = gridBounds.min.x + b.bx * blockSize;
            const bMinY = gridBounds.min.y + b.by * blockSize;
            const bMinZ = gridBounds.min.z + b.bz * blockSize;
            const bMaxX = bMinX + b.cbx * blockSize;
            const bMaxY = bMinY + b.cby * blockSize;
            const bMaxZ = bMinZ + b.cbz * blockSize;

            // Remaining slot in scratch buffer
            const available = MAX_INDICES - indexOffset;
            if (available <= 0) { batchStart--; break; }

            const cnt = spatialIndex.queryAABB(bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ, indexScratch, indexOffset, available);
            if (cnt === 0) continue;

            // If this one batch alone fills the buffer, flush what we have and retry
            if (megaBatches.length === 0 && cnt >= available) {
                // Single batch too large — use all available slots (partial Gaussians, still valid)
                batchIndexOffsets.push(0);
                batchIndexCounts.push(cnt); // cnt already capped by available
                megaBatches.push({ ...b, bMinX, bMinY, bMinZ });
                indexOffset = cnt;
                break;
            }

            if (indexOffset + cnt > MAX_INDICES) { batchStart--; break; }

            batchIndexOffsets.push(indexOffset);
            batchIndexCounts.push(cnt);
            megaBatches.push({ ...b, bMinX, bMinY, bMinZ });
            indexOffset += cnt;
        }

        if (!megaBatches.length) continue;

        totalBatchesWithGaussians += megaBatches.length;
        totalIndicesDispatched += indexOffset;

        const numBatches = megaBatches.length;

        const indexBuf = device.createBuffer({ size: Math.max(indexOffset * 4, 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(indexBuf, 0, indexScratch, 0, indexOffset);

        const biData = new ArrayBuffer(numBatches * BATCH_INFO_FLOATS * 4);
        const biU32  = new Uint32Array(biData);
        const biF32  = new Float32Array(biData);
        for (let i = 0; i < numBatches; i++) {
            const b = megaBatches[i];
            const base = i * BATCH_INFO_FLOATS;
            biU32[base+0] = batchIndexOffsets[i]; biU32[base+1] = batchIndexCounts[i];
            biU32[base+2] = b.cbx; biU32[base+3] = b.cby; biU32[base+4] = b.cbz;
            biF32[base+5] = b.bMinX; biF32[base+6] = b.bMinY; biF32[base+7] = b.bMinZ;
        }
        const batchInfoBuf = device.createBuffer({ size: biData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(batchInfoBuf, 0, biData);

        const resultCount = numBatches * MAX_BLOCKS_PER_BATCH * 2;
        const resultsBuf  = device.createBuffer({ size: resultCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

        const bindGroup = device.createBindGroup({
            layout: bgl,
            entries: [
                { binding: 0, resource: { buffer: uniformBuf } },
                { binding: 1, resource: { buffer: gaussianBuf } },
                { binding: 2, resource: { buffer: indexBuf } },
                { binding: 3, resource: { buffer: resultsBuf } },
                { binding: 4, resource: { buffer: batchInfoBuf } },
            ]
        });

        device.pushErrorScope('validation');

        const enc  = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(MAX_BLOCKS_PER_BATCH, 1, numBatches);
        pass.end();

        const stagingBuf = device.createBuffer({ size: resultCount * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        enc.copyBufferToBuffer(resultsBuf, 0, stagingBuf, 0, resultCount * 4);
        device.queue.submit([enc.finish()]);

        const gpuError = await device.popErrorScope();
        if (gpuError) {
            stagingBuf.destroy(); batchInfoBuf.destroy(); resultsBuf.destroy(); indexBuf.destroy();
            throw new Error(`WebGPU dispatch error: ${gpuError.message}`);
        }

        await stagingBuf.mapAsync(GPUMapMode.READ);
        const batchMasks = new Uint32Array(stagingBuf.getMappedRange().slice(0));
        stagingBuf.unmap();

        for (let bi = 0; bi < numBatches; bi++) {
            const b = megaBatches[bi];
            const batchBase = bi * MAX_BLOCKS_PER_BATCH * 2;
            for (let lz = 0; lz < b.cbz; lz++)
                for (let ly = 0; ly < b.cby; ly++)
                    for (let lx = 0; lx < b.cbx; lx++) {
                        const localIdx = lx + ly * b.cbx + lz * b.cbx * b.cby;
                        const lo = batchMasks[batchBase + localIdx * 2];
                        const hi = batchMasks[batchBase + localIdx * 2 + 1];
                        if (!lo && !hi) continue;
                        const absIdx = (b.bx+lx) + (b.by+ly) * numBlocksX + (b.bz+lz) * bStride;
                        resultMasks[absIdx*2]   = lo;
                        resultMasks[absIdx*2+1] = hi;
                    }
        }

        batchInfoBuf.destroy(); resultsBuf.destroy(); stagingBuf.destroy(); indexBuf.destroy();

        if (onProgress) onProgress(Math.min(batchStart, total), total);
    }

    uniformBuf.destroy();
    console.log(`[GpuVoxelize] Done — ${totalBatchesWithGaussians}/${total} batches had Gaussians, ${totalIndicesDispatched.toLocaleString()} total indices dispatched`);

    return resultMasks;
}

export function destroyVoxelizer(voxelizer) {
    voxelizer.gaussianBuf.destroy();
}
