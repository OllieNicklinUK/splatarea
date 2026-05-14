// Browser PLY parser for Gaussian splat data.
// Reads positions, opacity (logit), rotation quaternion, scale (log), and
// computes per-Gaussian world-space 3-sigma AABB extents for GPU voxelization.

const FLOATS_PER_GAUSSIAN = 16; // pos(3), opacity(1), rot(4), scale(3), extent(3), pad(2)

function findHeaderEnd(buf) {
    const marker = [101,110,100,95,104,101,97,100,101,114,10]; // "end_header\n"
    outer: for (let i = 0; i < buf.byteLength - marker.length; i++) {
        for (let j = 0; j < marker.length; j++) {
            if (buf[i + j] !== marker[j]) continue outer;
        }
        return i + marker.length;
    }
    return -1;
}

function byteSize(type) {
    switch (type) {
        case 'float': case 'float32': case 'int': case 'int32': case 'uint': case 'uint32': return 4;
        case 'double': case 'float64': return 8;
        case 'short': case 'int16': case 'ushort': case 'uint16': return 2;
        case 'char': case 'int8': case 'uchar': case 'uint8': return 1;
        default: return 4;
    }
}

// Compute per-axis 3-sigma world-space AABB extents for a Gaussian.
// Returns [extX, extY, extZ].
function computeExtents(qw, qx, qy, qz, sx, sy, sz) {
    // Rotation matrix from quaternion
    const x2=qx*2, y2=qy*2, z2=qz*2;
    const xx=qx*x2, yy=qy*y2, zz=qz*z2;
    const xy=qx*y2, xz=qx*z2, yz=qy*z2;
    const wx=qw*x2, wy=qw*y2, wz=qw*z2;

    // Row vectors of rotation matrix
    const r00=1-(yy+zz), r01=xy-wz,     r02=xz+wy;
    const r10=xy+wz,     r11=1-(xx+zz), r12=yz-wx;
    const r20=xz-wy,     r21=yz+wx,     r22=1-(xx+yy);

    const esx = Math.exp(sx), esy = Math.exp(sy), esz = Math.exp(sz);

    // World-axis variance = sum_j (R_ij * scale_j)^2
    const varX = (r00*esx)**2 + (r01*esy)**2 + (r02*esz)**2;
    const varY = (r10*esx)**2 + (r11*esy)**2 + (r12*esz)**2;
    const varZ = (r20*esx)**2 + (r21*esy)**2 + (r22*esz)**2;

    return [3 * Math.sqrt(varX), 3 * Math.sqrt(varY), 3 * Math.sqrt(varZ)];
}

// Parse a PLY buffer (ArrayBuffer or Uint8Array) and return interleaved
// Float32Array of Gaussian data ready for the GPU voxelizer.
// Also returns positions separately for bounds computation.
export function parseGaussians(plyBuffer, opacityThreshold = 0.2) {
    const logitThreshold = Math.log(opacityThreshold / (1 - opacityThreshold));
    const buf = plyBuffer instanceof ArrayBuffer
        ? new Uint8Array(plyBuffer)
        : plyBuffer;

    const headerEnd = findHeaderEnd(buf);
    if (headerEnd === -1) throw new Error('PLY header end not found');

    const headerText = new TextDecoder('ascii').decode(buf.slice(0, headerEnd));
    const lines = headerText.split('\n').map(l => l.trim());

    let vertexCount = 0;
    const props = [];
    for (const line of lines) {
        if (line.startsWith('element vertex')) {
            vertexCount = parseInt(line.split(' ')[2]);
        } else if (line.startsWith('property')) {
            const parts = line.split(' ');
            props.push({ name: parts[2], type: parts[1], size: byteSize(parts[1]) });
        }
    }
    if (!vertexCount) throw new Error('No vertices in PLY');

    let stride = 0;
    const offsets = {};
    for (const p of props) { offsets[p.name] = { off: stride, type: p.type }; stride += p.size; }

    const dv = new DataView(buf.buffer, buf.byteOffset + headerEnd);
    const available = buf.byteLength - headerEnd;
    const count = Math.min(vertexCount, Math.floor(available / stride));

    const rf = (byteOff) => dv.getFloat32(byteOff, true);

    const xOff = offsets['x']?.off ?? 0;
    const yOff = offsets['y']?.off ?? 4;
    const zOff = offsets['z']?.off ?? 8;
    const opOff = offsets['opacity']?.off;
    const r0Off = offsets['rot_0']?.off;  // w
    const r1Off = offsets['rot_1']?.off;  // x
    const r2Off = offsets['rot_2']?.off;  // y
    const r3Off = offsets['rot_3']?.off;  // z
    const s0Off = offsets['scale_0']?.off;
    const s1Off = offsets['scale_1']?.off;
    const s2Off = offsets['scale_2']?.off;

    const hasRot   = r0Off != null && r1Off != null && r2Off != null && r3Off != null;
    const hasScale = s0Off != null && s1Off != null && s2Off != null;

    const gaussians = new Float32Array(count * FLOATS_PER_GAUSSIAN);
    let kept = 0;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < count; i++) {
        const base = i * stride;
        if (opOff != null) {
            const opLogit = rf(base + opOff);
            if (opLogit <= logitThreshold) continue;
        }

        const x = rf(base + xOff);
        const y = rf(base + yOff);
        const z = rf(base + zOff);

        const opLogit = opOff != null ? rf(base + opOff) : 0;

        let qw = 1, qx = 0, qy = 0, qz = 0;
        if (hasRot) {
            qw = rf(base + r0Off); qx = rf(base + r1Off);
            qy = rf(base + r2Off); qz = rf(base + r3Off);
            const qlen = Math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz);
            if (qlen > 0) { const inv = 1/qlen; qw*=inv; qx*=inv; qy*=inv; qz*=inv; }
        }

        let sx = 0, sy = 0, sz = 0;
        if (hasScale) { sx = rf(base + s0Off); sy = rf(base + s1Off); sz = rf(base + s2Off); }

        const [extX, extY, extZ] = computeExtents(qw, qx, qy, qz, sx, sy, sz);

        const g = kept * FLOATS_PER_GAUSSIAN;
        gaussians[g+0]  = x;  gaussians[g+1]  = y;  gaussians[g+2]  = z;
        gaussians[g+3]  = opLogit;
        gaussians[g+4]  = qw; gaussians[g+5]  = qx; gaussians[g+6]  = qy; gaussians[g+7]  = qz;
        gaussians[g+8]  = sx; gaussians[g+9]  = sy; gaussians[g+10] = sz;
        gaussians[g+11] = extX; gaussians[g+12] = extY; gaussians[g+13] = extZ;
        // g+14, g+15: padding

        if (x < minX) minX=x; if (x > maxX) maxX=x;
        if (y < minY) minY=y; if (y > maxY) maxY=y;
        if (z < minZ) minZ=z; if (z > maxZ) maxZ=z;

        kept++;
    }

    return {
        gaussians: gaussians.subarray(0, kept * FLOATS_PER_GAUSSIAN),
        numGaussians: kept,
        bounds: { minX, minY, minZ, maxX, maxY, maxZ }
    };
}

/**
 * Detect the floor Y level from a histogram of Gaussian Y positions.
 *
 * The floor is the densest horizontal band in the scene — walls and ceiling
 * spread their Gaussians across a range of Y values, but the floor concentrates
 * them at a single level. The peak of the Y histogram is therefore the floor.
 *
 * Also determines "upDir": which PLY-Y direction is physically "above" the floor.
 * If the floor peak is in the upper half of the Y range the navigable space is
 * below it (decreasing PLY Y = up), which is the typical flipY Polycam convention.
 *
 * Returns { floorY, upDir (+1 or -1), minY, maxY } or null if data is empty.
 */
export function detectFloorY(gaussians, numGaussians) {
    if (!numGaussians) return null;

    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < numGaussians; i++) {
        const y = gaussians[i * FLOATS_PER_GAUSSIAN + 1];
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    if (maxY - minY < 1e-6) return { floorY: minY, upDir: 1, minY, maxY };

    const BINS = 128;
    const binSize = (maxY - minY) / BINS;
    const hist = new Float64Array(BINS);
    for (let i = 0; i < numGaussians; i++) {
        const y = gaussians[i * FLOATS_PER_GAUSSIAN + 1];
        hist[Math.min(BINS - 1, Math.floor((y - minY) / binSize))]++;
    }

    // Weighted 3-bin smoothing — reduces single-splat spikes
    const smooth = new Float64Array(BINS);
    for (let b = 0; b < BINS; b++) {
        smooth[b] = (
            (b > 0      ? hist[b - 1] : 0) +
            hist[b] * 2 +
            (b < BINS-1 ? hist[b + 1] : 0)
        ) / 4;
    }

    let peakBin = 0;
    for (let b = 1; b < BINS; b++) if (smooth[b] > smooth[peakBin]) peakBin = b;

    const floorY = minY + (peakBin + 0.5) * binSize;

    // If the floor peak sits in the upper half of the Y range, the walkable
    // space is on the lower side → "up" = decreasing PLY Y (upDir = -1).
    // This matches the standard flipY Polycam/3DGS convention.
    const upDir = (floorY - minY) > (maxY - floorY) ? -1 : 1;

    return { floorY, upDir, minY, maxY };
}

// Fetch a PLY from a URL and parse it.
export async function fetchAndParseGaussians(url, opacityThreshold = 0.2, onLog) {
    onLog?.(`Fetching PLY from ${url}…`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`PLY fetch failed: ${resp.status} ${resp.statusText}`);
    const buf = await resp.arrayBuffer();
    onLog?.(`Parsing ${(buf.byteLength / 1e6).toFixed(1)} MB PLY…`);
    const result = parseGaussians(buf, opacityThreshold);
    onLog?.(`${result.numGaussians.toLocaleString()} Gaussians above opacity threshold`);
    return result;
}
