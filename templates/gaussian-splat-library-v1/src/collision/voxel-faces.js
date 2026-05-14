import {
    BLOCK_EMPTY, BLOCK_SOLID,
    BLOCKS_PER_WORD, EVEN_BITS,
    SparseVoxelGrid,
    readBlockType
} from './sparse-voxel-grid.js';

const HASH_MUL = 0x9E3779B9;

// gridBounds: { min: { x, y, z } }
function voxelFaces(grid, gridBounds, voxelResolution) {
    const { nbx, nby, nbz, bStride, types, masks, nx, ny, nz } = grid;
    const totalBlocks = nbx * nby * nbz;
    const coordStride = Math.max(nx, ny, nz) + 1;

    let faceCap = 1024, faceLen = 0;
    let faceKeys = new Float64Array(faceCap);

    const addFace = (bucket, p, u, v) => {
        if (faceLen === faceCap) {
            faceCap *= 2;
            const grown = new Float64Array(faceCap);
            grown.set(faceKeys);
            faceKeys = grown;
        }
        faceKeys[faceLen++] = (((bucket * coordStride + p) * coordStride + u) * coordStride + v);
    };

    const blockTypeAt = (bx, by, bz) => {
        if (bx < 0 || by < 0 || bz < 0 || bx >= nbx || by >= nby || bz >= nbz) return BLOCK_EMPTY;
        return readBlockType(types, bx + by * nbx + bz * bStride);
    };

    const isVoxelSetLocal = (lo, hi, lx, ly, lz) => {
        const bitIdx = lx + (ly << 2) + (lz << 4);
        return bitIdx < 32 ? ((lo >>> bitIdx) & 1) !== 0 : ((hi >>> (bitIdx - 32)) & 1) !== 0;
    };

    const isVoxelSetGlobal = (ix, iy, iz) => {
        if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return false;
        const blockIdx = (ix >> 2) + (iy >> 2) * nbx + (iz >> 2) * bStride;
        const bt = readBlockType(types, blockIdx);
        if (bt === BLOCK_EMPTY) return false;
        if (bt === BLOCK_SOLID) return true;
        const s = masks.slot(blockIdx);
        return isVoxelSetLocal(masks.lo[s], masks.hi[s], ix & 3, iy & 3, iz & 3);
    };

    const addVoxelFace = (ix, iy, iz, bucket) => {
        switch (bucket) {
            case 0: addFace(0, ix,   iy, iz); break;
            case 1: addFace(1, ix+1, iy, iz); break;
            case 2: addFace(2, iy,   ix, iz); break;
            case 3: addFace(3, iy+1, ix, iz); break;
            case 4: addFace(4, iz,   ix, iy); break;
            default: addFace(5, iz+1, ix, iy); break;
        }
    };

    const processSolidBlock = (bx, by, bz) => {
        const x0 = bx << 2, y0 = by << 2, z0 = bz << 2;
        const emitX = (bucket, nbt, ix, nx2) => {
            if (nbt === BLOCK_SOLID) return;
            for (let lz = 0; lz < 4; lz++) { const iz = z0+lz; for (let ly = 0; ly < 4; ly++) { const iy = y0+ly; if (nbt === BLOCK_EMPTY || !isVoxelSetGlobal(nx2, iy, iz)) addVoxelFace(ix, iy, iz, bucket); } }
        };
        const emitY = (bucket, nbt, iy, ny2) => {
            if (nbt === BLOCK_SOLID) return;
            for (let lz = 0; lz < 4; lz++) { const iz = z0+lz; for (let lx = 0; lx < 4; lx++) { const ix = x0+lx; if (nbt === BLOCK_EMPTY || !isVoxelSetGlobal(ix, ny2, iz)) addVoxelFace(ix, iy, iz, bucket); } }
        };
        const emitZ = (bucket, nbt, iz, nz2) => {
            if (nbt === BLOCK_SOLID) return;
            for (let ly = 0; ly < 4; ly++) { const iy = y0+ly; for (let lx = 0; lx < 4; lx++) { const ix = x0+lx; if (nbt === BLOCK_EMPTY || !isVoxelSetGlobal(ix, iy, nz2)) addVoxelFace(ix, iy, iz, bucket); } }
        };
        emitX(0, blockTypeAt(bx-1, by, bz), x0,   x0-1);
        emitX(1, blockTypeAt(bx+1, by, bz), x0+3, x0+4);
        emitY(2, blockTypeAt(bx, by-1, bz), y0,   y0-1);
        emitY(3, blockTypeAt(bx, by+1, bz), y0+3, y0+4);
        emitZ(4, blockTypeAt(bx, by, bz-1), z0,   z0-1);
        emitZ(5, blockTypeAt(bx, by, bz+1), z0+3, z0+4);
    };

    const processMixedBlock = (blockIdx, bx, by, bz) => {
        const s = masks.slot(blockIdx);
        const lo = masks.lo[s], hi = masks.hi[s];
        const x0 = bx<<2, y0 = by<<2, z0 = bz<<2;
        for (let lz = 0; lz < 4; lz++) { const iz = z0+lz; for (let ly = 0; ly < 4; ly++) { const iy = y0+ly; for (let lx = 0; lx < 4; lx++) {
            if (!isVoxelSetLocal(lo, hi, lx, ly, lz)) continue;
            const ix = x0+lx;
            if (!isVoxelSetGlobal(ix-1, iy, iz)) addVoxelFace(ix, iy, iz, 0);
            if (!isVoxelSetGlobal(ix+1, iy, iz)) addVoxelFace(ix, iy, iz, 1);
            if (!isVoxelSetGlobal(ix, iy-1, iz)) addVoxelFace(ix, iy, iz, 2);
            if (!isVoxelSetGlobal(ix, iy+1, iz)) addVoxelFace(ix, iy, iz, 3);
            if (!isVoxelSetGlobal(ix, iy, iz-1)) addVoxelFace(ix, iy, iz, 4);
            if (!isVoxelSetGlobal(ix, iy, iz+1)) addVoxelFace(ix, iy, iz, 5);
        }}}
    };

    for (let w = 0; w < types.length; w++) {
        const word = types[w];
        if (!word) continue;
        let nonEmpty = ((word & EVEN_BITS) | ((word >>> 1) & EVEN_BITS)) >>> 0;
        const baseBlockIdx = w * BLOCKS_PER_WORD;
        while (nonEmpty) {
            const bp = 31 - Math.clz32(nonEmpty & -nonEmpty);
            const lane = bp >>> 1;
            const blockIdx = baseBlockIdx + lane;
            nonEmpty &= nonEmpty - 1;
            if (blockIdx >= totalBlocks) break;
            const bx = blockIdx % nbx, byBz = (blockIdx / nbx) | 0, by = byBz % nby, bz = (byBz / nby) | 0;
            const bt = (word >>> (lane << 1)) & 3;
            if (bt === BLOCK_SOLID) processSolidBlock(bx, by, bz);
            else processMixedBlock(blockIdx, bx, by, bz);
        }
    }

    if (!faceLen) return { positions: new Float32Array(0), indices: new Uint32Array(0) };

    // ── Greedy rect merge ────────────────────────────────────────────────────
    let rectCap = 1024, rectLen = 0;
    let rectBucket = new Int32Array(rectCap), rectP = new Int32Array(rectCap);
    let rectU0 = new Int32Array(rectCap), rectV0 = new Int32Array(rectCap);
    let rectU1 = new Int32Array(rectCap), rectV1 = new Int32Array(rectCap);

    const addRect = (bucket, p, u0, v0, u1, v1) => {
        if (rectLen === rectCap) {
            rectCap *= 2;
            const grow = src => { const out = new Int32Array(rectCap); out.set(src); return out; };
            rectBucket = grow(rectBucket); rectP = grow(rectP);
            rectU0 = grow(rectU0); rectV0 = grow(rectV0); rectU1 = grow(rectU1); rectV1 = grow(rectV1);
        }
        rectBucket[rectLen] = bucket; rectP[rectLen] = p;
        rectU0[rectLen] = u0; rectV0[rectLen] = v0; rectU1[rectLen] = u1; rectV1[rectLen] = v1;
        rectLen++;
    };

    const keys = faceKeys.subarray(0, faceLen);
    faceKeys = new Float64Array(0);
    keys.sort();

    const decodeGroup = k => {
        let q = Math.floor(k / coordStride); q = Math.floor(q / coordStride);
        return { bucket: Math.floor(q / coordStride), p: q % coordStride };
    };
    const decodeUvKey = k => {
        const v = k % coordStride, q = Math.floor(k / coordStride), u = q % coordStride;
        return u * coordStride + v;
    };

    let groupStart = 0;
    while (groupStart < keys.length) {
        const { bucket, p } = decodeGroup(keys[groupStart]);
        let groupEnd = groupStart + 1;
        while (groupEnd < keys.length) {
            const g = decodeGroup(keys[groupEnd]);
            if (g.bucket !== bucket || g.p !== p) break;
            groupEnd++;
        }
        const count = groupEnd - groupStart;
        let hCap = 1; while (hCap < count / 0.7) hCap *= 2;
        const hMask = hCap - 1;
        const hKeys = new Float64Array(hCap).fill(-1);
        const hVals = new Int32Array(hCap);
        const hash = k => { const hi = (k / 0x100000000) | 0; return (Math.imul((k | 0) ^ hi, HASH_MUL) >>> 0) & hMask; };
        for (let i = 0; i < count; i++) {
            const uvKey = decodeUvKey(keys[groupStart + i]);
            let h = hash(uvKey); while (hKeys[h] !== -1) h = (h + 1) & hMask;
            hKeys[h] = uvKey; hVals[h] = i;
        }
        const lookup = uvKey => { let h = hash(uvKey); while (true) { const k = hKeys[h]; if (k === uvKey) return hVals[h]; if (k === -1) return -1; h = (h + 1) & hMask; } };
        const visited = new Uint8Array(count);
        const uvKeyOf = (u, v) => u * coordStride + v;
        for (let i = 0; i < count; i++) {
            if (visited[i]) continue;
            const uvKey = decodeUvKey(keys[groupStart + i]);
            const u0 = Math.floor(uvKey / coordStride), v0 = uvKey % coordStride;
            let width = 1;
            while (true) { const idx = lookup(uvKeyOf(u0+width, v0)); if (idx === -1 || visited[idx]) break; width++; }
            let height = 1;
            while (true) {
                let ok = true;
                for (let du = 0; du < width; du++) { const idx = lookup(uvKeyOf(u0+du, v0+height)); if (idx === -1 || visited[idx]) { ok = false; break; } }
                if (!ok) break; height++;
            }
            for (let dv = 0; dv < height; dv++) for (let du = 0; du < width; du++) visited[lookup(uvKeyOf(u0+du, v0+dv))] = 1;
            addRect(bucket, p, u0, v0, u0+width, v0+height);
        }
        groupStart = groupEnd;
    }

    // ── T-junction elimination & triangulation ───────────────────────────────
    const globalPoint = (axis, p, u, v) => axis === 0 ? [p, u, v] : axis === 1 ? [u, p, v] : [u, v, p];
    const lineKey = (varAxis, x, y, z) =>
        varAxis === 0 ? (y + z * coordStride) * 3 :
        varAxis === 1 ? (x + z * coordStride) * 3 + 1 :
                        (x + y * coordStride) * 3 + 2;

    const linePoints = new Map();
    const addLinePoint = (key, value) => { let pts = linePoints.get(key); if (!pts) { pts = []; linePoints.set(key, pts); } pts.push(value); };
    const addLineSegment = (x0, y0, z0, x1, y1, z1) => {
        if (x0 !== x1)      { const k = lineKey(0, x0, y0, z0); addLinePoint(k, x0); addLinePoint(k, x1); }
        else if (y0 !== y1) { const k = lineKey(1, x0, y0, z0); addLinePoint(k, y0); addLinePoint(k, y1); }
        else                { const k = lineKey(2, x0, y0, z0); addLinePoint(k, z0); addLinePoint(k, z1); }
    };

    for (let r = 0; r < rectLen; r++) {
        const axis = rectBucket[r] >> 1, p = rectP[r];
        const a = globalPoint(axis, p, rectU0[r], rectV0[r]);
        const b = globalPoint(axis, p, rectU1[r], rectV0[r]);
        const c = globalPoint(axis, p, rectU1[r], rectV1[r]);
        const d = globalPoint(axis, p, rectU0[r], rectV1[r]);
        addLineSegment(...a, ...b); addLineSegment(...b, ...c); addLineSegment(...c, ...d); addLineSegment(...d, ...a);
    }
    for (const pts of linePoints.values()) {
        pts.sort((a, b) => a - b);
        let w = 0; for (let i = 0; i < pts.length; i++) if (i === 0 || pts[i] !== pts[i-1]) pts[w++] = pts[i];
        pts.length = w;
    }

    let posCap = 1024, posLen = 0, positions = new Float32Array(posCap);
    let idxCap = 1024, idxLen = 0, indices = new Uint32Array(idxCap);
    const vertexMap = new Map();
    let perimScratch = new Uint32Array(16), perimU = new Int32Array(16), perimV = new Int32Array(16), perimLen = 0;
    let triPrev = new Int32Array(16), triNext = new Int32Array(16);

    const addPosition = (x, y, z) => {
        if (posLen + 3 > posCap) { posCap *= 2; const g = new Float32Array(posCap); g.set(positions); positions = g; }
        const idx = posLen / 3;
        positions[posLen++] = gridBounds.min.x + x * voxelResolution;
        positions[posLen++] = gridBounds.min.y + y * voxelResolution;
        positions[posLen++] = gridBounds.min.z + z * voxelResolution;
        return idx;
    };
    const getVertex = (x, y, z) => {
        const key = x + y * coordStride + z * coordStride * coordStride;
        const e = vertexMap.get(key); if (e !== undefined) return e;
        const idx = addPosition(x, y, z); vertexMap.set(key, idx); return idx;
    };
    const appendTri = (a, b, c) => {
        if (idxLen + 3 > idxCap) { while (idxLen + 3 > idxCap) idxCap *= 2; const g = new Uint32Array(idxCap); g.set(indices); indices = g; }
        indices[idxLen++] = a; indices[idxLen++] = b; indices[idxLen++] = c;
    };

    const localUv = (axis, x, y, z) => axis === 0 ? [y, z] : axis === 1 ? [x, z] : [x, y];
    const addPerimVertex = (v, u, pv) => {
        if (perimLen > 0 && perimScratch[perimLen-1] === v) return;
        if (perimLen === perimScratch.length) {
            const grow32 = s => { const g = new Uint32Array(s.length*2); g.set(s); return g; };
            const growS = s => { const g = new Int32Array(s.length*2); g.set(s); return g; };
            perimScratch = grow32(perimScratch); perimU = growS(perimU); perimV = growS(perimV);
        }
        perimScratch[perimLen] = v; perimU[perimLen] = u; perimV[perimLen] = pv; perimLen++;
    };

    const addEdgeVerts = (axis, x0, y0, z0, x1, y1, z1) => {
        let varAxis, start, end;
        if (x0 !== x1)      { varAxis = 0; start = x0; end = x1; }
        else if (y0 !== y1) { varAxis = 1; start = y0; end = y1; }
        else                { varAxis = 2; start = z0; end = z1; }
        const key = lineKey(varAxis, x0, y0, z0);
        const pts = linePoints.get(key); if (!pts) return;
        const lo = Math.min(start, end), hi = Math.max(start, end), fwd = start <= end;
        const emit = (x, y, z) => { const [u, v] = localUv(axis, x, y, z); addPerimVertex(getVertex(x, y, z), u, v); };
        if (fwd) {
            for (let i = 0; i < pts.length; i++) { const t = pts[i]; if (t < lo) continue; if (t > hi) break; if (varAxis===0) emit(t,y0,z0); else if(varAxis===1) emit(x0,t,z0); else emit(x0,y0,t); }
        } else {
            for (let i = pts.length-1; i >= 0; i--) { const t = pts[i]; if (t > hi) continue; if (t < lo) break; if (varAxis===0) emit(t,y0,z0); else if(varAxis===1) emit(x0,t,z0); else emit(x0,y0,t); }
        }
    };

    const isConvexEar = (prev, curr, next) => {
        const ax = perimU[curr]-perimU[prev], ay = perimV[curr]-perimV[prev];
        const bx = perimU[next]-perimU[prev], by = perimV[next]-perimV[prev];
        return ax*by - ay*bx > 0;
    };
    const isNonDegenTri = (a, b, c) => {
        const ax = perimU[b]-perimU[a], ay = perimV[b]-perimV[a];
        const bx = perimU[c]-perimU[a], by = perimV[c]-perimV[a];
        return ax*by - ay*bx > 0;
    };

    const triangulatePeri = (ccw) => {
        if (perimLen < 3) return;
        if (perimLen > triPrev.length) {
            let cap = triPrev.length; while (perimLen > cap) cap *= 2;
            triPrev = new Int32Array(cap); triNext = new Int32Array(cap);
        }
        for (let i = 0; i < perimLen; i++) { triPrev[i] = i === 0 ? perimLen-1 : i-1; triNext[i] = i === perimLen-1 ? 0 : i+1; }
        let remaining = perimLen, cur = 0, attempts = 0;
        while (remaining > 3 && attempts < remaining) {
            const prev = triPrev[cur], next = triNext[cur], next2 = triNext[next];
            const ok = (remaining !== 4 || isNonDegenTri(prev, next, next2)) && isConvexEar(prev, cur, next);
            if (ok) {
                if (ccw) appendTri(perimScratch[prev], perimScratch[cur], perimScratch[next]);
                else     appendTri(perimScratch[prev], perimScratch[next], perimScratch[cur]);
                triNext[prev] = next; triPrev[next] = prev; cur = next; remaining--; attempts = 0;
            } else { cur = triNext[cur]; attempts++; }
        }
        if (remaining === 3) {
            const a = cur, b = triNext[a], c = triNext[b];
            if (isConvexEar(a, b, c)) {
                if (ccw) appendTri(perimScratch[a], perimScratch[b], perimScratch[c]);
                else     appendTri(perimScratch[a], perimScratch[c], perimScratch[b]);
            }
        }
    };

    for (let r = 0; r < rectLen; r++) {
        const bucket = rectBucket[r], axis = bucket >> 1, positive = (bucket & 1) === 1, p = rectP[r];
        const u0 = rectU0[r], v0 = rectV0[r], u1 = rectU1[r], v1 = rectV1[r];
        const a = globalPoint(axis, p, u0, v0), b = globalPoint(axis, p, u1, v0);
        const c = globalPoint(axis, p, u1, v1), d = globalPoint(axis, p, u0, v1);
        perimLen = 0;
        addEdgeVerts(axis, ...a, ...b); addEdgeVerts(axis, ...b, ...c); addEdgeVerts(axis, ...c, ...d); addEdgeVerts(axis, ...d, ...a);
        if (perimLen > 1 && perimScratch[0] === perimScratch[perimLen-1]) perimLen--;
        if (perimLen < 3) continue;
        triangulatePeri(positive === (axis !== 1));
    }

    return { positions: positions.slice(0, posLen), indices: indices.slice(0, idxLen) };
}

export { voxelFaces };
