import {
    BLOCK_EMPTY, BLOCK_MIXED, BLOCK_SOLID,
    FACE_MASKS_HI, FACE_MASKS_LO,
    SOLID_HI, SOLID_LO,
    SparseVoxelGrid,
    readBlockType, writeBlockType
} from './sparse-voxel-grid.js';

function twoLevelBFS(blocked, blockSeeds, voxelSeeds, nx, ny, nz, onBlockFilled) {
    const visited = new SparseVoxelGrid(nx, ny, nz);
    const nbx = nx >> 2;
    const nby = ny >> 2;
    const bStride = nbx * nby;

    const blockedTypes = blocked.types;
    const bMasks = blocked.masks;
    const visitedTypes = visited.types;
    const vMasks = visited.masks;

    const QUEUE_CAP_MAX = 1 << 30;

    let bqCap = 1 << 14, bqBuf = new Uint32Array(bqCap), bqMask = bqCap - 1, bqHead = 0, bqTail = 0, bqSize = 0;
    let vqCap = 1 << 14;
    let vqIx = new Uint32Array(vqCap), vqIy = new Uint32Array(vqCap), vqIz = new Uint32Array(vqCap);
    let vqMask = vqCap - 1, vqHead = 0, vqTail = 0, vqSize = 0;

    const growBlockQueue = () => {
        if (bqCap >= QUEUE_CAP_MAX) throw new Error('flood-fill: block queue overflow');
        const newCap = bqCap * 2;
        const nb = new Uint32Array(newCap);
        for (let i = 0; i < bqSize; i++) nb[i] = bqBuf[(bqHead + i) & bqMask];
        bqBuf = nb; bqCap = newCap; bqMask = newCap - 1; bqHead = 0; bqTail = bqSize;
    };

    const growVoxelQueue = () => {
        if (vqCap >= QUEUE_CAP_MAX) throw new Error('flood-fill: voxel queue overflow');
        const newCap = vqCap * 2;
        const nix = new Uint32Array(newCap), niy = new Uint32Array(newCap), niz = new Uint32Array(newCap);
        for (let i = 0; i < vqSize; i++) {
            const j = (vqHead + i) & vqMask;
            nix[i] = vqIx[j]; niy[i] = vqIy[j]; niz[i] = vqIz[j];
        }
        vqIx = nix; vqIy = niy; vqIz = niz; vqCap = newCap; vqMask = newCap - 1; vqHead = 0; vqTail = vqSize;
    };

    const enqueueVoxel = (ix, iy, iz) => {
        if (vqSize >= vqCap) growVoxelQueue();
        vqIx[vqTail] = ix; vqIy[vqTail] = iy; vqIz[vqTail] = iz;
        vqTail = (vqTail + 1) & vqMask; vqSize++;
    };

    let blockFillCount = 0;
    let nextProgressAt = 1024;

    const tryFillBlock = (blockIdx) => {
        if (readBlockType(blockedTypes, blockIdx) !== BLOCK_EMPTY) return false;
        if (readBlockType(visitedTypes, blockIdx) !== BLOCK_EMPTY) return false;
        writeBlockType(visitedTypes, blockIdx, BLOCK_SOLID);
        if (bqSize >= bqCap) growBlockQueue();
        bqBuf[bqTail] = blockIdx; bqTail = (bqTail + 1) & bqMask; bqSize++;
        blockFillCount++;
        if (onBlockFilled && blockFillCount >= nextProgressAt) {
            onBlockFilled(blockFillCount);
            nextProgressAt = blockFillCount + 1024;
        }
        return true;
    };

    const enqueueFaceVoxels = (nBlockIdx, face, nBx, nBy, nBz) => {
        const vbt = readBlockType(visitedTypes, nBlockIdx);
        if (vbt === BLOCK_SOLID) return;
        const bs = bMasks.slot(nBlockIdx);
        let vLo = 0, vHi = 0, vs = -1;
        if (vbt === BLOCK_MIXED) {
            vs = vMasks.slot(nBlockIdx);
            vLo = vMasks.lo[vs]; vHi = vMasks.hi[vs];
        }
        const freeLo = (FACE_MASKS_LO[face] & ~bMasks.lo[bs] & ~vLo) >>> 0;
        const freeHi = (FACE_MASKS_HI[face] & ~bMasks.hi[bs] & ~vHi) >>> 0;
        if (!freeLo && !freeHi) return;
        if (vbt === BLOCK_EMPTY) {
            writeBlockType(visitedTypes, nBlockIdx, BLOCK_MIXED);
            vMasks.set(nBlockIdx, freeLo, freeHi);
        } else {
            vMasks.lo[vs] = (vMasks.lo[vs] | freeLo) >>> 0;
            vMasks.hi[vs] = (vMasks.hi[vs] | freeHi) >>> 0;
            if (vMasks.lo[vs] === SOLID_LO && vMasks.hi[vs] === SOLID_HI) {
                vMasks.removeAt(vs);
                writeBlockType(visitedTypes, nBlockIdx, BLOCK_SOLID);
            }
        }
        const baseIx = nBx << 2, baseIy = nBy << 2, baseIz = nBz << 2;
        let bits = freeLo;
        while (bits) {
            const bp = 31 - Math.clz32(bits & -bits);
            enqueueVoxel(baseIx + (bp & 3), baseIy + ((bp >> 2) & 3), baseIz + (bp >> 4));
            bits &= bits - 1;
        }
        bits = freeHi;
        while (bits) {
            const bp = 31 - Math.clz32(bits & -bits);
            const bi = bp + 32;
            enqueueVoxel(baseIx + (bi & 3), baseIy + ((bi >> 2) & 3), baseIz + (bi >> 4));
            bits &= bits - 1;
        }
    };

    const processBlock = (blockIdx) => {
        const bx = blockIdx % nbx;
        const byBz = (blockIdx / nbx) | 0;
        const by = byBz % nby;
        const bz = (byBz / nby) | 0;
        if (bx > 0)     { const ni = blockIdx - 1;       const nbt = readBlockType(blockedTypes, ni); if (nbt === BLOCK_EMPTY) tryFillBlock(ni); else if (nbt === BLOCK_MIXED) enqueueFaceVoxels(ni, 1, bx-1, by, bz); }
        if (bx < nbx-1) { const ni = blockIdx + 1;       const nbt = readBlockType(blockedTypes, ni); if (nbt === BLOCK_EMPTY) tryFillBlock(ni); else if (nbt === BLOCK_MIXED) enqueueFaceVoxels(ni, 0, bx+1, by, bz); }
        if (by > 0)     { const ni = blockIdx - nbx;     const nbt = readBlockType(blockedTypes, ni); if (nbt === BLOCK_EMPTY) tryFillBlock(ni); else if (nbt === BLOCK_MIXED) enqueueFaceVoxels(ni, 3, bx, by-1, bz); }
        if (by < nby-1) { const ni = blockIdx + nbx;     const nbt = readBlockType(blockedTypes, ni); if (nbt === BLOCK_EMPTY) tryFillBlock(ni); else if (nbt === BLOCK_MIXED) enqueueFaceVoxels(ni, 2, bx, by+1, bz); }
        if (bz > 0)     { const ni = blockIdx - bStride; const nbt = readBlockType(blockedTypes, ni); if (nbt === BLOCK_EMPTY) tryFillBlock(ni); else if (nbt === BLOCK_MIXED) enqueueFaceVoxels(ni, 5, bx, by, bz-1); }
        if (bz < (nz>>2)-1) { const ni = blockIdx + bStride; const nbt = readBlockType(blockedTypes, ni); if (nbt === BLOCK_EMPTY) tryFillBlock(ni); else if (nbt === BLOCK_MIXED) enqueueFaceVoxels(ni, 4, bx, by, bz+1); }
    };

    const tryEnqueueVoxel = (ix, iy, iz) => {
        const blockIdx = (ix >> 2) + (iy >> 2) * nbx + (iz >> 2) * bStride;
        const bbt = readBlockType(blockedTypes, blockIdx);
        if (bbt === BLOCK_SOLID) return;
        if (bbt === BLOCK_EMPTY) { tryFillBlock(blockIdx); return; }
        const bs = bMasks.slot(blockIdx);
        const bitIdx = (ix & 3) + ((iy & 3) << 2) + ((iz & 3) << 4);
        if (bitIdx < 32 ? (bMasks.lo[bs] >>> bitIdx) & 1 : (bMasks.hi[bs] >>> (bitIdx - 32)) & 1) return;
        const vbt = readBlockType(visitedTypes, blockIdx);
        if (vbt === BLOCK_SOLID) return;
        if (vbt === BLOCK_MIXED) {
            const vs = vMasks.slot(blockIdx);
            if (bitIdx < 32 ? (vMasks.lo[vs] >>> bitIdx) & 1 : (vMasks.hi[vs] >>> (bitIdx - 32)) & 1) return;
            if (bitIdx < 32) vMasks.lo[vs] = (vMasks.lo[vs] | (1 << bitIdx)) >>> 0;
            else             vMasks.hi[vs] = (vMasks.hi[vs] | (1 << (bitIdx - 32))) >>> 0;
            if (vMasks.lo[vs] === SOLID_LO && vMasks.hi[vs] === SOLID_HI) {
                vMasks.removeAt(vs);
                writeBlockType(visitedTypes, blockIdx, BLOCK_SOLID);
            }
        } else {
            writeBlockType(visitedTypes, blockIdx, BLOCK_MIXED);
            vMasks.set(blockIdx,
                bitIdx < 32 ? (1 << bitIdx) >>> 0 : 0,
                bitIdx >= 32 ? (1 << (bitIdx - 32)) >>> 0 : 0
            );
        }
        enqueueVoxel(ix, iy, iz);
    };

    for (let i = 0; i < blockSeeds.length; i++) tryFillBlock(blockSeeds[i]);
    for (let i = 0; i < voxelSeeds.length; i++) tryEnqueueVoxel(voxelSeeds[i].ix, voxelSeeds[i].iy, voxelSeeds[i].iz);

    while (bqSize > 0 || vqSize > 0) {
        while (bqSize > 0) {
            const blockIdx = bqBuf[bqHead]; bqHead = (bqHead + 1) & bqMask; bqSize--;
            processBlock(blockIdx);
        }
        if (vqSize > 0) {
            const ix = vqIx[vqHead], iy = vqIy[vqHead], iz = vqIz[vqHead];
            vqHead = (vqHead + 1) & vqMask; vqSize--;
            if (ix > 0)    tryEnqueueVoxel(ix-1, iy, iz);
            if (ix < nx-1) tryEnqueueVoxel(ix+1, iy, iz);
            if (iy > 0)    tryEnqueueVoxel(ix, iy-1, iz);
            if (iy < ny-1) tryEnqueueVoxel(ix, iy+1, iz);
            if (iz > 0)    tryEnqueueVoxel(ix, iy, iz-1);
            if (iz < nz-1) tryEnqueueVoxel(ix, iy, iz+1);
        }
    }

    if (onBlockFilled) onBlockFilled(blockFillCount);
    return visited;
}

export { twoLevelBFS };
