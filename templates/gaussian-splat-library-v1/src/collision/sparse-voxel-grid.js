import { BlockMaskMap } from './block-mask-map.js';

const SOLID_LO = 0xFFFFFFFF >>> 0;
const SOLID_HI = 0xFFFFFFFF >>> 0;

const BLOCK_EMPTY = 0;
const BLOCK_SOLID = 1;
const BLOCK_MIXED = 2;

const FACE_MASKS_LO = [
    0x11111111 >>> 0, // -X
    0x88888888 >>> 0, // +X
    0x000F000F >>> 0, // -Y
    0xF000F000 >>> 0, // +Y
    0x0000FFFF >>> 0, // -Z
    0x00000000 >>> 0  // +Z
];
const FACE_MASKS_HI = [
    0x11111111 >>> 0,
    0x88888888 >>> 0,
    0x000F000F >>> 0,
    0xF000F000 >>> 0,
    0x00000000 >>> 0,
    0xFFFF0000 >>> 0
];

const TYPE_BITS = 2;
const BLOCKS_PER_WORD = 16; // 32 / 2
const TYPE_MASK = 0x3;
const SOLID_WORD = 0x55555555 >>> 0;
const EVEN_BITS  = 0x55555555 >>> 0;

const readBlockType = (types, blockIdx) =>
    (types[blockIdx >>> 4] >>> ((blockIdx & 15) << 1)) & TYPE_MASK;

const writeBlockType = (types, blockIdx, value) => {
    const w = blockIdx >>> 4;
    const shift = (blockIdx & 15) << 1;
    types[w] = ((types[w] & ~(TYPE_MASK << shift)) | ((value & TYPE_MASK) << shift)) >>> 0;
};

class SparseVoxelGrid {
    constructor(nx, ny, nz) {
        this.nx = nx;
        this.ny = ny;
        this.nz = nz;
        this.nbx = nx >> 2;
        this.nby = ny >> 2;
        this.nbz = nz >> 2;
        this.bStride = this.nbx * this.nby;
        const totalBlocks = this.nbx * this.nby * this.nbz;
        this.types = new Uint32Array(Math.ceil(totalBlocks / BLOCKS_PER_WORD));
        this.masks = new BlockMaskMap();
    }

    getBlockType(blockIdx) { return readBlockType(this.types, blockIdx); }
    setBlockType(blockIdx, value) { writeBlockType(this.types, blockIdx, value); }

    getVoxel(ix, iy, iz) {
        const blockIdx = (ix >> 2) + (iy >> 2) * this.nbx + (iz >> 2) * this.bStride;
        const bt = readBlockType(this.types, blockIdx);
        if (bt === BLOCK_EMPTY) return 0;
        if (bt === BLOCK_SOLID) return 1;
        const s = this.masks.slot(blockIdx);
        const bitIdx = (ix & 3) + ((iy & 3) << 2) + ((iz & 3) << 4);
        return bitIdx < 32
            ? (this.masks.lo[s] >>> bitIdx) & 1
            : (this.masks.hi[s] >>> (bitIdx - 32)) & 1;
    }

    setVoxel(ix, iy, iz) {
        const blockIdx = (ix >> 2) + (iy >> 2) * this.nbx + (iz >> 2) * this.bStride;
        const bt = readBlockType(this.types, blockIdx);
        if (bt === BLOCK_SOLID) return;
        const bitIdx = (ix & 3) + ((iy & 3) << 2) + ((iz & 3) << 4);
        if (bt === BLOCK_MIXED) {
            const s = this.masks.slot(blockIdx);
            if (bitIdx < 32) this.masks.lo[s] = (this.masks.lo[s] | (1 << bitIdx)) >>> 0;
            else             this.masks.hi[s] = (this.masks.hi[s] | (1 << (bitIdx - 32))) >>> 0;
            if (this.masks.lo[s] === SOLID_LO && this.masks.hi[s] === SOLID_HI) {
                this.masks.removeAt(s);
                writeBlockType(this.types, blockIdx, BLOCK_SOLID);
            }
        } else {
            writeBlockType(this.types, blockIdx, BLOCK_MIXED);
            this.masks.set(blockIdx,
                bitIdx < 32 ? (1 << bitIdx) >>> 0 : 0,
                bitIdx >= 32 ? (1 << (bitIdx - 32)) >>> 0 : 0
            );
        }
    }

    orBlock(blockIdx, lo, hi) {
        if (!lo && !hi) return;
        const bt = readBlockType(this.types, blockIdx);
        if (bt === BLOCK_SOLID) return;
        if (bt === BLOCK_MIXED) {
            const s = this.masks.slot(blockIdx);
            this.masks.lo[s] = (this.masks.lo[s] | lo) >>> 0;
            this.masks.hi[s] = (this.masks.hi[s] | hi) >>> 0;
            if (this.masks.lo[s] === SOLID_LO && this.masks.hi[s] === SOLID_HI) {
                this.masks.removeAt(s);
                writeBlockType(this.types, blockIdx, BLOCK_SOLID);
            }
        } else {
            if ((lo >>> 0) === SOLID_LO && (hi >>> 0) === SOLID_HI) {
                writeBlockType(this.types, blockIdx, BLOCK_SOLID);
            } else {
                writeBlockType(this.types, blockIdx, BLOCK_MIXED);
                this.masks.set(blockIdx, lo >>> 0, hi >>> 0);
            }
        }
    }

    clear() { this.types.fill(0); this.masks.clear(); }

    releaseStorage() {
        this.types = new Uint32Array(0);
        this.masks.releaseStorage();
    }

    static findNearestFreeCell(blocked, seedIx, seedIy, seedIz, maxRadius) {
        const { nx, ny, nz } = blocked;
        for (let r = 1; r <= maxRadius; r++) {
            for (let dz = -r; dz <= r; dz++) {
                for (let dy = -r; dy <= r; dy++) {
                    for (let dx = -r; dx <= r; dx++) {
                        if (Math.abs(dx) !== r && Math.abs(dy) !== r && Math.abs(dz) !== r) continue;
                        const ix = seedIx + dx, iy = seedIy + dy, iz = seedIz + dz;
                        if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) continue;
                        if (!blocked.getVoxel(ix, iy, iz)) return { ix, iy, iz };
                    }
                }
            }
        }
        return null;
    }
}

export {
    BLOCK_EMPTY, BLOCK_MIXED, BLOCK_SOLID,
    BLOCKS_PER_WORD, EVEN_BITS,
    FACE_MASKS_HI, FACE_MASKS_LO,
    SOLID_HI, SOLID_LO, SOLID_WORD,
    TYPE_MASK,
    SparseVoxelGrid,
    readBlockType, writeBlockType
};
