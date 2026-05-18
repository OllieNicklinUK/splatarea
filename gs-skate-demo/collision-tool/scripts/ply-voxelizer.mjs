/**
 * ply-voxelizer.mjs
 *
 * Pure Node.js Gaussian splat → collision mesh pipeline.
 * Drop-in fallback when splat-transform is unavailable (e.g. macOS < 15).
 *
 * Algorithm:
 *  1. Parse PLY binary → positions of solid Gaussians (opacity > threshold)
 *  2. Build a 3-D voxel grid marking solid cells
 *  3. BFS flood-fill from seed position → mark navigable cells
 *  4. Extract triangles on the boundary between solid and navigable
 *  5. Write result as binary GLB (GLTF 2.0)
 *
 * Usage (from other ESM modules):
 *   import { voxelizePly } from './scripts/ply-voxelizer.mjs';
 *   await voxelizePly(plyPath, seedPos, voxelSize, outputGlbPath, onLog);
 */

import fs from 'fs';
import path from 'path';

// ─── Grid cell types ────────────────────────────────────────────────────────
const OUTSIDE = 0; // not yet explored / unreachable
const SOLID   = 1; // occupied by Gaussian point(s)
const EMPTY   = 2; // navigable — reached by flood-fill from seed

// ─── PLY Parser ─────────────────────────────────────────────────────────────
// Reads Gaussian splat PLY binary format.
// Returns Float32Array [x0,y0,z0, x1,y1,z1, ...] for Gaussians above threshold.
// opacityThreshold is in sigmoid (0-1) space. sigmoid > 0.2 keeps solid surfaces
// while discarding near-invisible Gaussians; the cluster filter removes any remaining
// small floating islands afterwards.
function parsePlyPositions(plyPath, opacityThreshold = 0.2, onLog) {
  // Pre-compute the equivalent logit threshold once
  const logitThreshold = Math.log(opacityThreshold / (1 - opacityThreshold));
  const buf = fs.readFileSync(plyPath);
  const headerEnd = findHeaderEnd(buf);
  if (headerEnd === -1) throw new Error('PLY header end not found');

  const headerText = buf.slice(0, headerEnd).toString('ascii');
  const lines = headerText.split('\n').map(l => l.trim());

  let vertexCount = 0;
  const props = []; // { name, type, byteSize }

  for (const line of lines) {
    if (line.startsWith('element vertex')) {
      vertexCount = parseInt(line.split(' ')[2]);
    } else if (line.startsWith('property')) {
      const parts = line.split(' ');
      const typeName = parts[1];
      const propName = parts[2];
      props.push({ name: propName, type: typeName, byteSize: byteSize(typeName) });
    }
  }

  if (vertexCount === 0) throw new Error('No vertices in PLY');

  // Byte offsets within each vertex record
  let offset = 0;
  const offsets = {};
  for (const p of props) {
    offsets[p.name] = { offset, type: p.type };
    offset += p.byteSize;
  }
  const stride = offset;

  const xOff = offsets['x'];
  const yOff = offsets['y'];
  const zOff = offsets['z'];
  const opOff = offsets['opacity'];

  if (!xOff || !yOff || !zOff) throw new Error('PLY missing x/y/z properties');

  const dataStart = headerEnd;
  const expectedBytes = vertexCount * stride;
  const available    = buf.length - dataStart;
  const actualCount  = Math.min(vertexCount, Math.floor(available / stride));

  onLog?.(`Parsing ${actualCount.toLocaleString()} Gaussians (stride ${stride} bytes)…`);

  const positions = new Float32Array(actualCount * 3);
  let kept = 0;

  for (let i = 0; i < actualCount; i++) {
    const base = dataStart + i * stride;
    const x = readFloat(buf, base + xOff.offset);
    const y = readFloat(buf, base + yOff.offset);
    const z = readFloat(buf, base + zOff.offset);

    let pass = true;
    if (opOff) {
      const opLogit = readFloat(buf, base + opOff.offset);
      // Gaussian splat stores opacity as a logit value.
      // Convert the sigmoid threshold to logit space: logit = ln(t / (1-t))
      pass = opLogit > logitThreshold;
    }

    if (pass) {
      positions[kept * 3]     = x;
      positions[kept * 3 + 1] = y;
      positions[kept * 3 + 2] = z;
      kept++;
    }
  }

  onLog?.(`${kept.toLocaleString()} solid Gaussians above opacity threshold`);
  return positions.subarray(0, kept * 3);
}

function findHeaderEnd(buf) {
  const marker = Buffer.from('end_header\n');
  for (let i = 0; i < buf.length - marker.length; i++) {
    let match = true;
    for (let j = 0; j < marker.length; j++) {
      if (buf[i + j] !== marker[j]) { match = false; break; }
    }
    if (match) return i + marker.length;
  }
  return -1;
}

function byteSize(type) {
  switch (type) {
    case 'float': case 'float32': case 'int': case 'int32':
    case 'uint': case 'uint32': return 4;
    case 'double': case 'float64': case 'int64': case 'uint64': return 8;
    case 'short': case 'int16': case 'ushort': case 'uint16': return 2;
    case 'char': case 'int8': case 'uchar': case 'uint8': return 1;
    default: return 4;
  }
}

function readFloat(buf, offset) {
  return buf.readFloatLE(offset);
}

// ─── Math helpers ────────────────────────────────────────────────────────────
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// Rotate vector (vx,vy,vz) by the INVERSE of unit quaternion (qw,qx,qy,qz).
// Equivalent to rotating by the conjugate (w, -x, -y, -z).
function inverseRotate(vx, vy, vz, qw, qx, qy, qz) {
  const cx = -qx, cy = -qy, cz = -qz;
  const tx = 2 * (cy * vz - cz * vy);
  const ty = 2 * (cz * vx - cx * vz);
  const tz = 2 * (cx * vy - cy * vx);
  return [
    vx + qw * tx + (cy * tz - cz * ty),
    vy + qw * ty + (cz * tx - cx * tz),
    vz + qw * tz + (cx * ty - cy * tx),
  ];
}

// ─── Quality PLY Parser ──────────────────────────────────────────────────────
// Parses all properties needed for anisotropic Beer-Lambert accumulation:
// x, y, z, opacity, scale_0/1/2 (log-scale), rot_0/1/2/3 (quaternion W,X,Y,Z).
// Returns struct-of-arrays to avoid per-element allocation.
function parsePlyGaussiansFull(plyPath, onLog) {
  const buf = fs.readFileSync(plyPath);
  const headerEnd = findHeaderEnd(buf);
  if (headerEnd === -1) throw new Error('PLY header end not found');

  const headerText = buf.slice(0, headerEnd).toString('ascii');
  const lines = headerText.split('\n').map(l => l.trim());

  let vertexCount = 0;
  const props = [];
  for (const line of lines) {
    if (line.startsWith('element vertex')) {
      vertexCount = parseInt(line.split(' ')[2]);
    } else if (line.startsWith('property')) {
      const parts = line.split(' ');
      props.push({ name: parts[2], type: parts[1], byteSize: byteSize(parts[1]) });
    }
  }
  if (vertexCount === 0) throw new Error('No vertices in PLY');

  let byteOff = 0;
  const offsets = {};
  for (const p of props) { offsets[p.name] = byteOff; byteOff += p.byteSize; }
  const stride = byteOff;

  const dataStart  = headerEnd;
  const actualCount = Math.min(vertexCount, Math.floor((buf.length - dataStart) / stride));
  onLog?.(`Parsing ${actualCount.toLocaleString()} Gaussians (full props, stride ${stride} bytes)…`);

  const xArr = new Float32Array(actualCount);
  const yArr = new Float32Array(actualCount);
  const zArr = new Float32Array(actualCount);
  const opArr= new Float32Array(actualCount);
  const sxArr= new Float32Array(actualCount);
  const syArr= new Float32Array(actualCount);
  const szArr= new Float32Array(actualCount);
  const qwArr= new Float32Array(actualCount);
  const qxArr= new Float32Array(actualCount);
  const qyArr= new Float32Array(actualCount);
  const qzArr= new Float32Array(actualCount);

  const xOff  = offsets['x'];
  const yOff  = offsets['y'];
  const zOff  = offsets['z'];
  const opOff = offsets['opacity'];
  const s0Off = offsets['scale_0'];
  const s1Off = offsets['scale_1'];
  const s2Off = offsets['scale_2'];
  const r0Off = offsets['rot_0'];
  const r1Off = offsets['rot_1'];
  const r2Off = offsets['rot_2'];
  const r3Off = offsets['rot_3'];

  if (xOff == null || yOff == null || zOff == null) throw new Error('PLY missing x/y/z');

  for (let i = 0; i < actualCount; i++) {
    const base = dataStart + i * stride;
    xArr[i]  = buf.readFloatLE(base + xOff);
    yArr[i]  = buf.readFloatLE(base + yOff);
    zArr[i]  = buf.readFloatLE(base + zOff);
    opArr[i] = opOff != null ? buf.readFloatLE(base + opOff) : 2.0;   // default: opaque
    sxArr[i] = s0Off != null ? buf.readFloatLE(base + s0Off) : -2.3;  // default: ~0.1m
    syArr[i] = s1Off != null ? buf.readFloatLE(base + s1Off) : -2.3;
    szArr[i] = s2Off != null ? buf.readFloatLE(base + s2Off) : -2.3;
    qwArr[i] = r0Off != null ? buf.readFloatLE(base + r0Off) : 1.0;
    qxArr[i] = r1Off != null ? buf.readFloatLE(base + r1Off) : 0.0;
    qyArr[i] = r2Off != null ? buf.readFloatLE(base + r2Off) : 0.0;
    qzArr[i] = r3Off != null ? buf.readFloatLE(base + r3Off) : 0.0;
  }

  onLog?.(`Parsed ${actualCount.toLocaleString()} Gaussians`);
  return { x: xArr, y: yArr, z: zArr, opLogit: opArr,
           sx: sxArr, sy: syArr, sz: szArr,
           qw: qwArr, qx: qxArr, qy: qyArr, qz: qzArr, count: actualCount };
}

// ─── Quality Voxel Grid ──────────────────────────────────────────────────────
// For each voxel, accumulates Beer-Lambert sigma by integrating each Gaussian's
// anisotropic contribution (full quaternion rotation + per-axis scale).
// Sigma → SOLID if 1 - exp(-sigma) >= opacityThreshold.

const MAX_GAUSS_SIGMA  = 0.5;   // cap per-axis std dev (prevents huge background Gaussians)
const MAHAL_CUTOFF_SQ  = 6.25;  // 2.5-sigma cutoff: exp(-0.5 × 6.25) ≈ 0.04 — negligible

function buildQualityGrid(gaussians, voxelSize, onLog) {
  const { x, y, z, opLogit, sx: logSx, sy: logSy, sz: logSz, qw, qx, qy, qz, count } = gaussians;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
    if (z[i] < minZ) minZ = z[i]; if (z[i] > maxZ) maxZ = z[i];
  }

  const pad = voxelSize * 3;
  minX -= pad; minY -= pad; minZ -= pad;
  maxX += pad; maxY += pad; maxZ += pad;

  const nx = Math.ceil((maxX - minX) / voxelSize) + 1;
  const ny = Math.ceil((maxY - minY) / voxelSize) + 1;
  const nz = Math.ceil((maxZ - minZ) / voxelSize) + 1;
  const totalCells = nx * ny * nz;

  if (totalCells > 50_000_000) {
    throw new Error(
      `Grid too large (${nx}×${ny}×${nz} = ${totalCells.toLocaleString()} cells). ` +
      `Try increasing voxel size.`
    );
  }

  onLog?.(`Quality grid ${nx}×${ny}×${nz} = ${totalCells.toLocaleString()} cells`);

  const sigmaGrid = new Float32Array(totalCells);
  const LOG_INTERVAL = Math.max(1, Math.floor(count / 10));
  let skipped = 0;

  for (let i = 0; i < count; i++) {
    if (i % LOG_INTERVAL === 0) onLog?.(`  Beer-Lambert: ${Math.round(i / count * 100)}%…`);

    // Per-axis std dev, capped so background Gaussians don't dominate
    const escX = Math.min(Math.exp(logSx[i]), MAX_GAUSS_SIGMA);
    const escY = Math.min(Math.exp(logSy[i]), MAX_GAUSS_SIGMA);
    const escZ = Math.min(Math.exp(logSz[i]), MAX_GAUSS_SIGMA);

    // AABB in voxel coords (2.5-sigma radius per axis)
    const gcX = (x[i] - minX) / voxelSize;
    const gcY = (y[i] - minY) / voxelSize;
    const gcZ = (z[i] - minZ) / voxelSize;
    const radX = Math.ceil(2.5 * escX / voxelSize);
    const radY = Math.ceil(2.5 * escY / voxelSize);
    const radZ = Math.ceil(2.5 * escZ / voxelSize);

    const vx0 = Math.max(0, Math.floor(gcX) - radX);
    const vx1 = Math.min(nx - 1, Math.ceil(gcX) + radX);
    const vy0 = Math.max(0, Math.floor(gcY) - radY);
    const vy1 = Math.min(ny - 1, Math.ceil(gcY) + radY);
    const vz0 = Math.max(0, Math.floor(gcZ) - radZ);
    const vz1 = Math.min(nz - 1, Math.ceil(gcZ) + radZ);

    // Safety cap: skip any Gaussian whose AABB exceeds ~100k voxels
    if ((vx1-vx0+1) * (vy1-vy0+1) * (vz1-vz0+1) > 100_000) { skipped++; continue; }

    const opa = sigmoid(opLogit[i]);
    const invSx2 = 1.0 / (escX * escX);
    const invSy2 = 1.0 / (escY * escY);
    const invSz2 = 1.0 / (escZ * escZ);

    // Normalise quaternion
    const qlen = Math.sqrt(qw[i]*qw[i] + qx[i]*qx[i] + qy[i]*qy[i] + qz[i]*qz[i]) || 1;
    const nqw = qw[i]/qlen, nqx = qx[i]/qlen, nqy = qy[i]/qlen, nqz = qz[i]/qlen;
    const gx = x[i], gy = y[i], gz = z[i];

    for (let iz = vz0; iz <= vz1; iz++) {
      for (let iy = vy0; iy <= vy1; iy++) {
        for (let ix = vx0; ix <= vx1; ix++) {
          const dx = (minX + (ix + 0.5) * voxelSize) - gx;
          const dy = (minY + (iy + 0.5) * voxelSize) - gy;
          const dz = (minZ + (iz + 0.5) * voxelSize) - gz;

          // Rotate displacement by inverse quaternion → Gaussian local frame
          const [lx, ly, lz] = inverseRotate(dx, dy, dz, nqw, nqx, nqy, nqz);

          const d2 = lx*lx*invSx2 + ly*ly*invSy2 + lz*lz*invSz2;
          if (d2 > MAHAL_CUTOFF_SQ) continue;
          sigmaGrid[ix + iy * nx + iz * nx * ny] += opa * Math.exp(-0.5 * d2);
        }
      }
    }
  }

  if (skipped > 0) onLog?.(`Skipped ${skipped} oversized Gaussians`);
  onLog?.('Beer-Lambert accumulation complete.');

  return { grid: new Uint8Array(totalCells), sigmaGrid, nx, ny, nz, minX, minY, minZ, voxelSize };
}

function finalizeQualityGrid(gridInfo, opacityThreshold) {
  const { grid, sigmaGrid, nx, ny, nz } = gridInfo;
  const total = nx * ny * nz;
  // 1 - exp(-sigma) >= threshold  →  sigma >= -ln(1 - threshold)
  const beerThreshold = -Math.log(1.0 - opacityThreshold);
  let solid = 0;
  for (let i = 0; i < total; i++) {
    if (sigmaGrid[i] >= beerThreshold) { grid[i] = SOLID; solid++; }
  }
  return solid;
}

// ─── Vertex Merge ────────────────────────────────────────────────────────────
// Deduplicate vertices at the same position (needed for Taubin adjacency).
function mergeVertices(verts, tris) {
  const QUANTIZE = 100000; // 0.01 mm precision
  const map = new Map();
  const newVerts = [];
  const newTris = new Uint32Array(tris.length);
  let vi = 0;

  for (let i = 0; i < tris.length; i++) {
    const oi = tris[i] * 3;
    const vx = verts[oi], vy = verts[oi + 1], vz = verts[oi + 2];
    const key = `${Math.round(vx * QUANTIZE)},${Math.round(vy * QUANTIZE)},${Math.round(vz * QUANTIZE)}`;
    let ni = map.get(key);
    if (ni === undefined) {
      ni = vi++;
      map.set(key, ni);
      newVerts.push(vx, vy, vz);
    }
    newTris[i] = ni;
  }

  return { verts: new Float32Array(newVerts), tris: newTris };
}

// ─── Taubin Smoothing ────────────────────────────────────────────────────────
// Alternating positive (λ) and negative (μ) Laplacian passes reduce shrinkage.
// Each iteration = 1 λ-pass + 1 μ-pass.
function smoothMesh(verts, tris, lambda = 0.5, mu = -0.53, iterations = 5) {
  const n = verts.length / 3;
  const pos = new Float32Array(verts);

  // Build adjacency: neighbour vertex indices per vertex
  const adjBuf = new Array(n);
  for (let i = 0; i < n; i++) adjBuf[i] = new Set();
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    adjBuf[a].add(b); adjBuf[a].add(c);
    adjBuf[b].add(a); adjBuf[b].add(c);
    adjBuf[c].add(a); adjBuf[c].add(b);
  }
  const adj = adjBuf.map(s => Array.from(s));

  const tmp = new Float32Array(n * 3);

  function laplacianPass(factor) {
    for (let i = 0; i < n; i++) {
      const nb = adj[i];
      if (!nb.length) { tmp[i*3] = pos[i*3]; tmp[i*3+1] = pos[i*3+1]; tmp[i*3+2] = pos[i*3+2]; continue; }
      let dx = 0, dy = 0, dz = 0;
      for (const j of nb) {
        dx += pos[j*3]   - pos[i*3];
        dy += pos[j*3+1] - pos[i*3+1];
        dz += pos[j*3+2] - pos[i*3+2];
      }
      const inv = factor / nb.length;
      tmp[i*3]   = pos[i*3]   + dx * inv;
      tmp[i*3+1] = pos[i*3+1] + dy * inv;
      tmp[i*3+2] = pos[i*3+2] + dz * inv;
    }
    pos.set(tmp);
  }

  for (let iter = 0; iter < iterations; iter++) {
    laplacianPass(lambda);
    laplacianPass(mu);
  }

  return pos;
}

// ─── Voxel Grid ──────────────────────────────────────────────────────────────
function buildGrid(positions, voxelSize, onLog, dilationPasses = 2) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // Pad by one voxel on each side
  const pad = voxelSize;
  minX -= pad; minY -= pad; minZ -= pad;
  maxX += pad; maxY += pad; maxZ += pad;

  const nx = Math.ceil((maxX - minX) / voxelSize) + 1;
  const ny = Math.ceil((maxY - minY) / voxelSize) + 1;
  const nz = Math.ceil((maxZ - minZ) / voxelSize) + 1;

  const totalCells = nx * ny * nz;
  if (totalCells > 50_000_000) {
    throw new Error(
      `Grid too large (${nx}×${ny}×${nz} = ${totalCells.toLocaleString()} cells). ` +
      `Try increasing voxel size.`
    );
  }

  onLog?.(`Grid ${nx}×${ny}×${nz} = ${totalCells.toLocaleString()} cells`);

  const grid = new Uint8Array(totalCells); // all OUTSIDE initially

  // Mark SOLID cells
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const cx = Math.floor((x - minX) / voxelSize);
    const cy = Math.floor((y - minY) / voxelSize);
    const cz = Math.floor((z - minZ) / voxelSize);
    const idx = cx + cy * nx + cz * nx * ny;
    if (idx >= 0 && idx < totalCells) grid[idx] = SOLID;
  }

  // ── Step 1: Noise removal ──────────────────────────────────────────────────
  // Strip isolated solid voxels with fewer than 2 solid face-adjacent neighbours.
  // These come from floating/sparse Gaussians that are not part of any surface —
  // after dilation they would create small bumps that catch the player capsule.
  // Running this BEFORE dilation prevents noise from being amplified.
  {
    const toRemove = [];
    for (let idx = 0; idx < totalCells; idx++) {
      if (grid[idx] !== SOLID) continue;
      const cx = idx % nx;
      const cy = Math.floor(idx / nx) % ny;
      const cz = Math.floor(idx / (nx * ny));
      let solidN = 0;
      if (cx > 0    && grid[idx - 1]     === SOLID) solidN++;
      if (cx < nx-1 && grid[idx + 1]     === SOLID) solidN++;
      if (cy > 0    && grid[idx - nx]    === SOLID) solidN++;
      if (cy < ny-1 && grid[idx + nx]    === SOLID) solidN++;
      if (cz > 0    && grid[idx - nx*ny] === SOLID) solidN++;
      if (cz < nz-1 && grid[idx + nx*ny] === SOLID) solidN++;
      if (solidN < 2) toRemove.push(idx);
    }
    toRemove.forEach(idx => { grid[idx] = OUTSIDE; });
    onLog?.(`Noise removal: cleared ${toRemove.length.toLocaleString()} isolated voxels`);
  }

  // ── Step 2: Two-pass dilation ─────────────────────────────────────────────
  // Expand cleaned solid cells outward twice to fill surface gaps up to 2 voxels
  // wide (~20 cm at 0.1 m resolution). Two passes produce a denser, more
  // continuous floor and wall surface without re-introducing noise.
  const dilate = () => {
    const buf = new Uint8Array(totalCells);
    for (let idx = 0; idx < totalCells; idx++) {
      if (grid[idx] !== SOLID) continue;
      const cx = idx % nx;
      const cy = Math.floor(idx / nx) % ny;
      const cz = Math.floor(idx / (nx * ny));
      buf[idx] = 1;
      if (cx > 0)    buf[idx - 1]     = 1;
      if (cx < nx-1) buf[idx + 1]     = 1;
      if (cy > 0)    buf[idx - nx]    = 1;
      if (cy < ny-1) buf[idx + nx]    = 1;
      if (cz > 0)    buf[idx - nx*ny] = 1;
      if (cz < nz-1) buf[idx + nx*ny] = 1;
    }
    let added = 0;
    for (let idx = 0; idx < totalCells; idx++) {
      if (buf[idx] && grid[idx] === OUTSIDE) { grid[idx] = SOLID; added++; }
    }
    return added;
  };
  let dilated = 0;
  for (let p = 0; p < dilationPasses; p++) dilated += dilate();
  onLog?.(`Dilation added ${dilated.toLocaleString()} voxels (${dilationPasses} passes)`);

  return { grid, nx, ny, nz, minX, minY, minZ, voxelSize };
}

// ─── Connected-component cluster filter ──────────────────────────────────────
// Label every group of touching SOLID voxels, measure each group's size, and
// remove groups smaller than `minSize`. Walls and floors form huge clusters
// (hundreds–thousands of voxels); floating debris and thin-air Gaussians form
// tiny isolated clusters (1–20 voxels). Runs after dilation so that real
// surface patches have already been thickened into coherent clusters.
function removeSmallClusters(gridInfo, minSize, onLog) {
  const { grid, nx, ny, nz } = gridInfo;
  const total = nx * ny * nz;
  // 0 = unvisited solid, -1 = not solid, >0 = cluster label
  const clusterOf = new Int32Array(total);
  for (let i = 0; i < total; i++) clusterOf[i] = grid[i] === SOLID ? 0 : -1;

  const dirs   = [1, -1, nx, -nx, nx * ny, -(nx * ny)];
  const sizes  = [0]; // index 0 unused; labels start at 1
  let nextLabel = 1;

  for (let start = 0; start < total; start++) {
    if (clusterOf[start] !== 0) continue;
    const q = [start];
    clusterOf[start] = nextLabel;
    let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      const cx  = cur % nx;
      const cy  = Math.floor(cur / nx) % ny;
      const cz  = Math.floor(cur / (nx * ny));
      for (let d = 0; d < 6; d++) {
        const ni = cur + dirs[d];
        if (d === 0 && cx === nx - 1) continue;
        if (d === 1 && cx === 0)      continue;
        if (d === 2 && cy === ny - 1) continue;
        if (d === 3 && cy === 0)      continue;
        if (d === 4 && cz === nz - 1) continue;
        if (d === 5 && cz === 0)      continue;
        if (clusterOf[ni] === 0) { clusterOf[ni] = nextLabel; q.push(ni); }
      }
    }
    sizes.push(q.length);
    nextLabel++;
  }

  let removed = 0, removedClusters = 0;
  for (let i = 0; i < total; i++) {
    const lbl = clusterOf[i];
    if (lbl > 0 && sizes[lbl] < minSize) { grid[i] = OUTSIDE; removed++; }
  }
  for (let s = 1; s < sizes.length; s++) if (sizes[s] < minSize) removedClusters++;
  onLog?.(`Cluster filter: removed ${removed.toLocaleString()} voxels across ${removedClusters} small islands (min ${minSize} voxels)`);
}

// ─── BFS Flood-fill ─────────────────────────────────────────────────────────
function floodFill(gridInfo, seedWorld, onLog) {
  const { grid, nx, ny, nz, minX, minY, minZ, voxelSize } = gridInfo;

  let seedX = Math.floor((seedWorld[0] - minX) / voxelSize);
  let seedY = Math.floor((seedWorld[1] - minY) / voxelSize);
  let seedZ = Math.floor((seedWorld[2] - minZ) / voxelSize);

  // Clamp to grid
  seedX = Math.max(0, Math.min(nx - 1, seedX));
  seedY = Math.max(0, Math.min(ny - 1, seedY));
  seedZ = Math.max(0, Math.min(nz - 1, seedZ));

  let seedIdx = seedX + seedY * nx + seedZ * nx * ny;

  // If seed is solid, search upward then spiral outward for a clear voxel
  if (grid[seedIdx] === SOLID) {
    let found = false;
    outer: for (let dy = 0; dy < ny; dy++) {
      for (let dx = -dy; dx <= dy; dx++) {
        for (let dz = -dy; dz <= dy; dz++) {
          const tx = seedX + dx, ty = seedY + dy, tz = seedZ + dz;
          if (tx < 0 || tx >= nx || ty < 0 || ty >= ny || tz < 0 || tz >= nz) continue;
          const ti = tx + ty * nx + tz * nx * ny;
          if (grid[ti] === OUTSIDE) {
            seedX = tx; seedY = ty; seedZ = tz; seedIdx = ti;
            found = true;
            onLog?.(`Seed moved to clear voxel (${(minX + seedX * voxelSize).toFixed(2)}, ${(minY + seedY * voxelSize).toFixed(2)}, ${(minZ + seedZ * voxelSize).toFixed(2)})`);
            break outer;
          }
        }
      }
    }
    if (!found) throw new Error('No navigable voxel found near seed — all cells are solid');
  }

  const queue = [seedIdx];
  grid[seedIdx] = EMPTY;
  let head = 0;

  const dirs = [1, -1, nx, -nx, nx * ny, -(nx * ny)];

  while (head < queue.length) {
    const idx = queue[head++];
    const cx = idx % nx;
    const cy = Math.floor(idx / nx) % ny;
    const cz = Math.floor(idx / (nx * ny));

    for (let d = 0; d < 6; d++) {
      const ni = idx + dirs[d];
      if (ni < 0 || ni >= grid.length) continue;
      // Bounds check to prevent wrapping
      if (d === 0 && cx === nx - 1) continue;
      if (d === 1 && cx === 0) continue;
      if (d === 2 && cy === ny - 1) continue;
      if (d === 3 && cy === 0) continue;
      if (d === 4 && cz === nz - 1) continue;
      if (d === 5 && cz === 0) continue;
      if (grid[ni] === OUTSIDE) {
        grid[ni] = EMPTY;
        queue.push(ni);
      }
    }
  }

  return queue.length; // number of navigable cells
}

// ─── Surface Mesh Extraction ─────────────────────────────────────────────────
// For each EMPTY cell, check its 6 neighbors. If a neighbor is SOLID,
// add a quad face (2 triangles) on that shared boundary.
function extractSurface(gridInfo) {
  const { grid, nx, ny, nz, minX, minY, minZ, voxelSize } = gridInfo;
  const hs = voxelSize / 2;

  const verts  = [];
  const tris   = [];
  let vi = 0;

  // Face definitions: [neighbor offset, 4 corner offsets relative to voxel center]
  const faces = [
    { dx: -1, dy:  0, dz:  0, corners: [[-hs,-hs,-hs],[-hs, hs,-hs],[-hs, hs, hs],[-hs,-hs, hs]] }, // -X
    { dx:  1, dy:  0, dz:  0, corners: [[ hs,-hs, hs],[ hs, hs, hs],[ hs, hs,-hs],[ hs,-hs,-hs]] }, // +X
    { dx:  0, dy: -1, dz:  0, corners: [[-hs,-hs, hs],[ hs,-hs, hs],[ hs,-hs,-hs],[-hs,-hs,-hs]] }, // -Y (floor)
    { dx:  0, dy:  1, dz:  0, corners: [[-hs, hs,-hs],[ hs, hs,-hs],[ hs, hs, hs],[-hs, hs, hs]] }, // +Y (ceiling)
    { dx:  0, dy:  0, dz: -1, corners: [[ hs,-hs,-hs],[ hs, hs,-hs],[-hs, hs,-hs],[-hs,-hs,-hs]] }, // -Z
    { dx:  0, dy:  0, dz:  1, corners: [[-hs,-hs, hs],[-hs, hs, hs],[ hs, hs, hs],[ hs,-hs, hs]] }, // +Z
  ];

  // Track floor-face tile counts per Y level to find the dominant floor
  const floorTilesByY = new Map();

  for (let cz = 0; cz < nz; cz++) {
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx < nx; cx++) {
        const idx = cx + cy * nx + cz * nx * ny;
        if (grid[idx] !== EMPTY) continue;

        // World centre of this empty voxel
        const wx = minX + (cx + 0.5) * voxelSize;
        const wy = minY + (cy + 0.5) * voxelSize;
        const wz = minZ + (cz + 0.5) * voxelSize;

        for (const face of faces) {
          const nx_ = cx + face.dx, ny_ = cy + face.dy, nz_ = cz + face.dz;
          if (nx_ < 0 || nx_ >= nx || ny_ < 0 || ny_ >= ny || nz_ < 0 || nz_ >= nz) continue;
          const ni = nx_ + ny_ * nx + nz_ * nx * ny;
          if (grid[ni] !== SOLID) continue;

          // Count -Y faces (floor tiles) per Y level
          if (face.dy === -1) {
            const faceY = wy - hs;
            floorTilesByY.set(faceY, (floorTilesByY.get(faceY) || 0) + 1);
          }

          // Add quad as 2 triangles
          const base = vi;
          for (const [ox, oy, oz] of face.corners) {
            verts.push(wx + ox, wy + oy, wz + oz);
            vi++;
          }
          tris.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
  }

  // The Y level with the most floor tiles is the main floor
  let plyFloorY = null, bestCount = 0;
  for (const [y, count] of floorTilesByY) {
    if (count > bestCount) { bestCount = count; plyFloorY = y; }
  }

  return { verts: new Float32Array(verts), tris: new Uint32Array(tris), plyFloorY };
}

// ─── Vertex-Clustering Decimation ────────────────────────────────────────────
// Divides the mesh into a 3-D grid with the given cellSize.  All vertices that
// fall in the same cell are merged to their centroid.  Naturally flattens planar
// regions (floor, walls) where nearby vertices all land in the same cell.
// Degenerate triangles and duplicates are discarded.
function decimateMesh(verts, tris, cellSize) {
  const n    = verts.length / 3;
  const invC = 1 / cellSize;

  const clusterMap  = new Map();   // quantised key → cluster index
  const cSumX = [], cSumY = [], cSumZ = [], cCount = [];
  const v2c = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    const qx = Math.round(verts[i*3]   * invC);
    const qy = Math.round(verts[i*3+1] * invC);
    const qz = Math.round(verts[i*3+2] * invC);
    const key = `${qx},${qy},${qz}`;
    let ci = clusterMap.get(key);
    if (ci === undefined) {
      ci = cSumX.length;
      clusterMap.set(key, ci);
      cSumX.push(verts[i*3]); cSumY.push(verts[i*3+1]); cSumZ.push(verts[i*3+2]); cCount.push(1);
    } else {
      cSumX[ci] += verts[i*3]; cSumY[ci] += verts[i*3+1]; cSumZ[ci] += verts[i*3+2]; cCount[ci]++;
    }
    v2c[i] = ci;
  }

  const nc = cSumX.length;
  const newVerts = new Float32Array(nc * 3);
  for (let i = 0; i < nc; i++) {
    const k = cCount[i];
    newVerts[i*3] = cSumX[i]/k; newVerts[i*3+1] = cSumY[i]/k; newVerts[i*3+2] = cSumZ[i]/k;
  }

  const seen = new Set();
  const newTris = [];
  for (let i = 0; i < tris.length; i += 3) {
    const a = v2c[tris[i]], b = v2c[tris[i+1]], c = v2c[tris[i+2]];
    if (a === b || b === c || a === c) continue;
    const mn = Math.min(a, b, c), mx = Math.max(a, b, c), md = a + b + c - mn - mx;
    const key = `${mn},${md},${mx}`;
    if (seen.has(key)) continue;
    seen.add(key);
    newTris.push(a, b, c);
  }

  return { verts: newVerts, tris: new Uint32Array(newTris) };
}

// ─── Keep Largest Connected Component ────────────────────────────────────────
// Removes disconnected floating islands, keeping only the largest component.
// Uses triangle-adjacency (shared edges) for connectivity.
function keepLargestComponent(verts, tris) {
  const nTri = tris.length / 3;
  if (nTri === 0) return { verts, tris };

  // Build edge → triangle adjacency
  const edgeToTris = new Map();
  const addEdge = (a, b, ti) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const arr = edgeToTris.get(key);
    if (arr) arr.push(ti); else edgeToTris.set(key, [ti]);
  };
  for (let i = 0; i < nTri; i++) {
    const a = tris[i*3], b = tris[i*3+1], c = tris[i*3+2];
    addEdge(a, b, i); addEdge(b, c, i); addEdge(c, a, i);
  }

  // BFS over triangles
  const comp   = new Int32Array(nTri).fill(-1);
  const compSz = [];
  let   label  = 0;
  for (let start = 0; start < nTri; start++) {
    if (comp[start] !== -1) continue;
    const q = [start]; comp[start] = label; let head = 0;
    while (head < q.length) {
      const ti = q[head++];
      const a = tris[ti*3], b = tris[ti*3+1], c = tris[ti*3+2];
      for (const [ea, eb] of [[a,b],[b,c],[c,a]]) {
        const key = ea < eb ? `${ea},${eb}` : `${eb},${ea}`;
        for (const ni of edgeToTris.get(key) ?? []) {
          if (comp[ni] === -1) { comp[ni] = label; q.push(ni); }
        }
      }
    }
    compSz.push(q.length);
    label++;
  }

  // Find the largest component
  let bestLabel = 0, bestSz = 0;
  for (let i = 0; i < compSz.length; i++) if (compSz[i] > bestSz) { bestSz = compSz[i]; bestLabel = i; }

  // Collect triangles from the largest component
  const keepTris = [];
  const usedVerts = new Uint8Array(verts.length / 3);
  for (let i = 0; i < nTri; i++) {
    if (comp[i] !== bestLabel) continue;
    keepTris.push(tris[i*3], tris[i*3+1], tris[i*3+2]);
    usedVerts[tris[i*3]] = usedVerts[tris[i*3+1]] = usedVerts[tris[i*3+2]] = 1;
  }

  // Compact vertices (remove unused)
  const remap = new Int32Array(verts.length / 3).fill(-1);
  const newVerts = []; let vi = 0;
  for (let i = 0; i < usedVerts.length; i++) {
    if (!usedVerts[i]) continue;
    remap[i] = vi++;
    newVerts.push(verts[i*3], verts[i*3+1], verts[i*3+2]);
  }
  const newTris = new Uint32Array(keepTris.length);
  for (let i = 0; i < keepTris.length; i++) newTris[i] = remap[keepTris[i]];

  return { verts: new Float32Array(newVerts), tris: newTris };
}

// ─── Mesh Normalisation ──────────────────────────────────────────────────────
// Translates verts in-place so the main floor sits at PLY Y=0 and the mesh is
// horizontally centred at PLY (0, 0).  Returns the splat viewer position offset
// needed to keep the Gaussian splat visual aligned with the normalised mesh:
//
//   splatMesh.position.set(splatOffsetX, splatOffsetY, splatOffsetZ)
//
// Derivation (rotation = 180° around X: Y→-Y, Z→-Z):
//   world = (px + ox, -py + oy, -pz + oz)
//   collision needs:   (px - cx, -py + plyFloorY, -pz + cz)
//   → ox = -cx,  oy = plyFloorY,  oz = +cz
function _normalizeMesh(verts, plyFloorY) {
  // Compute XZ bounding box of the surface mesh
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    if (verts[i]   < minX) minX = verts[i];   if (verts[i]   > maxX) maxX = verts[i];
    if (verts[i+2] < minZ) minZ = verts[i+2]; if (verts[i+2] > maxZ) maxZ = verts[i+2];
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  // Fall back to Y median if no floor was detected
  const floorY = plyFloorY ?? (() => {
    const ys = []; for (let i = 1; i < verts.length; i += 3) ys.push(verts[i]);
    ys.sort((a, b) => a - b); return ys[Math.floor(ys.length / 2)] || 0;
  })();

  // Translate vertices: floor → PLY Y=0, XZ → centred
  for (let i = 0; i < verts.length; i += 3) {
    verts[i]   -= cx;
    verts[i+1] -= floorY;
    verts[i+2] -= cz;
  }

  return { splatOffsetX: -cx, splatOffsetY: floorY, splatOffsetZ: cz };
}

// ─── GLB Writer ──────────────────────────────────────────────────────────────
function writeGLB(verts, tris, outputPath) {
  // Pad a buffer to 4-byte alignment
  const pad4 = (buf) => {
    const rem = buf.length % 4;
    if (rem === 0) return buf;
    return Buffer.concat([buf, Buffer.alloc(4 - rem, 0x20)]); // space-pad JSON, zero-pad bin
  };

  const vertBuf  = Buffer.from(verts.buffer);
  const triBuf   = Buffer.from(tris.buffer);
  const binData  = Buffer.concat([vertBuf, triBuf]);
  const binPadded = pad4(binData);

  // Compute bbox for accessor
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < verts.length / 3; i++) {
    const x = verts[i*3], y = verts[i*3+1], z = verts[i*3+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const json = {
    asset: { version: '2.0', generator: 'ply-voxelizer' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0 },
        indices: 1,
        mode: 4, // TRIANGLES
      }]
    }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126, // FLOAT
        count: verts.length / 3,
        type: 'VEC3',
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
      },
      {
        bufferView: 1,
        componentType: 5125, // UNSIGNED_INT
        count: tris.length,
        type: 'SCALAR',
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0,            byteLength: vertBuf.length },
      { buffer: 0, byteOffset: vertBuf.length, byteLength: triBuf.length },
    ],
    buffers: [{ byteLength: binData.length }],
  };

  const jsonBuf    = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = pad4(jsonBuf);

  const totalLength = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const header      = Buffer.alloc(12);
  header.writeUInt32LE(0x46546C67, 0); // magic 'glTF'
  header.writeUInt32LE(2,          4); // version
  header.writeUInt32LE(totalLength, 8);

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4E4F534A,        4); // 'JSON'

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binPadded.length, 0);
  binChunkHeader.writeUInt32LE(0x004E4942,       4); // 'BIN\0'

  fs.writeFileSync(outputPath, Buffer.concat([
    header, jsonChunkHeader, jsonPadded, binChunkHeader, binPadded,
  ]));
}

// ─── Public API ─────────────────────────────────────────────────────────────
export async function voxelizePly(plyPath, seedPos, voxelSize, outputPath, onLog, opacityThreshold = 0.2) {
  voxelSize = parseFloat(voxelSize) || 0.15;
  if (voxelSize < 0.05) voxelSize = 0.05;
  const threshold = Math.max(0.01, Math.min(0.99, parseFloat(opacityThreshold) || 0.2));
  const seed = typeof seedPos === 'string'
    ? seedPos.split(',').map(Number)
    : seedPos;

  onLog?.(`PLY voxelizer — voxelSize: ${voxelSize}m, opacityThreshold: ${threshold}, seed: ${seed}`);

  const positions = parsePlyPositions(plyPath, threshold, onLog);

  if (positions.length === 0) throw new Error('No solid Gaussians found — check opacity threshold');

  // Auto-scale: double voxelSize until grid fits within the cell limit
  let gridInfo;
  while (true) {
    try {
      gridInfo = buildGrid(positions, voxelSize, onLog);
      break;
    } catch (e) {
      if (!e.message.includes('Grid too large')) throw e;
      voxelSize *= 2;
      onLog?.(`Grid too large — retrying with voxelSize=${voxelSize.toFixed(3)}m`);
    }
  }
  // Remove isolated voxel clusters smaller than the equivalent of ~0.5 m² surface.
  // Scales with voxel size so the physical minimum is consistent across resolutions.
  const minCluster = Math.max(8, Math.round(0.5 / (voxelSize * voxelSize)));
  removeSmallClusters(gridInfo, minCluster, onLog);

  const emptyCells = floodFill(gridInfo, seed, onLog);
  onLog?.(`Flood-fill: ${emptyCells.toLocaleString()} navigable cells`);

  const { verts, tris, plyFloorY } = extractSurface(gridInfo);
  onLog?.(`Surface mesh: ${verts.length / 3} vertices, ${tris.length / 3} triangles`);
  if (plyFloorY != null) onLog?.(`Floor Y (PLY space): ${plyFloorY.toFixed(3)}`);

  if (tris.length === 0) throw new Error('Surface mesh is empty — seed may be outside the splat');

  // Decimate: cell = 3.5× voxelSize → ~12× fewer triangles on flat surfaces
  onLog?.('Decimating…');
  const { verts: decVerts, tris: decTris } = decimateMesh(verts, tris, voxelSize * 3.5);
  onLog?.(`After decimation: ${decVerts.length / 3} vertices, ${decTris.length / 3} triangles`);

  // Remove floating disconnected islands
  const { verts: finalVerts, tris: finalTris } = keepLargestComponent(decVerts, decTris);
  onLog?.(`After component filter: ${finalVerts.length / 3} vertices, ${finalTris.length / 3} triangles`);

  const splatOffset = _normalizeMesh(finalVerts, plyFloorY);
  onLog?.(`Normalised — splatOffset: (${splatOffset.splatOffsetX.toFixed(2)}, ${splatOffset.splatOffsetY.toFixed(2)}, ${splatOffset.splatOffsetZ.toFixed(2)})`);

  writeGLB(finalVerts, finalTris, outputPath);
  const sizeMB = (fs.statSync(outputPath).size / 1e6).toFixed(2);
  onLog?.(`Written: ${outputPath} (${sizeMB} MB)`);
  return { plyFloorY: 0, ...splatOffset };
}

// ─── Quality export ──────────────────────────────────────────────────────────
// Produces a smooth, hole-free game-ready collision surface.
//
// Strategy: use the same voxel pipeline as fast mode but with:
//   • lower opacity threshold (0.1) — captures sparse geometry that fast mode misses
//   • 4 dilation passes (vs 2) — seals gaps up to ~0.6m wide, eliminating holes
//   • coarser default voxelSize (0.15m) — reduces triangle count significantly
//   • vertex merge + Taubin smoothing — rounds off blocky voxel edges
//
// Anisotropic Beer-Lambert accumulation was tried but produced blobby, complex
// surfaces unsuited to game collision. Dilation + smoothing is far more effective
// for producing clean, navigable terrain.
export async function voxelizePlyQuality(plyPath, seedPos, voxelSize, outputPath, onLog, opacityThreshold = 0.1) {
  voxelSize = parseFloat(voxelSize) || 0.15;
  if (voxelSize < 0.05) voxelSize = 0.05;
  const threshold = Math.max(0.01, Math.min(0.99, parseFloat(opacityThreshold) || 0.1));
  const seed = typeof seedPos === 'string' ? seedPos.split(',').map(Number) : seedPos;

  onLog?.(`PLY quality voxelizer — voxelSize: ${voxelSize}m, opacityThreshold: ${threshold}, seed: ${seed}`);

  // Lower threshold captures more geometry — essential for sparse facade regions
  const positions = parsePlyPositions(plyPath, threshold, onLog);
  if (positions.length === 0) throw new Error('No solid Gaussians found — check opacity threshold');

  let gridInfo;
  while (true) {
    try {
      // 8 dilation passes seal gaps up to ~1.2m wide (8 × voxelSize × 2 sides)
      gridInfo = buildGrid(positions, voxelSize, onLog, 8);
      break;
    } catch (e) {
      if (!e.message.includes('Grid too large')) throw e;
      voxelSize *= 2;
      onLog?.(`Grid too large — retrying with voxelSize=${voxelSize.toFixed(3)}m`);
    }
  }

  const minCluster = Math.max(8, Math.round(0.5 / (voxelSize * voxelSize)));
  removeSmallClusters(gridInfo, minCluster, onLog);

  const emptyCells = floodFill(gridInfo, seed, onLog);
  onLog?.(`Flood-fill: ${emptyCells.toLocaleString()} navigable cells`);

  const { verts: rawVerts, tris: rawTris, plyFloorY } = extractSurface(gridInfo);
  onLog?.(`Raw surface: ${rawVerts.length / 3} vertices, ${rawTris.length / 3} triangles`);
  if (plyFloorY != null) onLog?.(`Floor Y (PLY space): ${plyFloorY.toFixed(3)}`);

  if (rawTris.length === 0) throw new Error('Surface mesh is empty — seed may be outside the splat');

  // Merge duplicate voxel-corner vertices so the adjacency graph is correct
  onLog?.('Merging vertices…');
  const { verts: mergedVerts, tris: mergedTris } = mergeVertices(rawVerts, rawTris);
  onLog?.(`Merged: ${mergedVerts.length / 3} unique vertices`);

  // Taubin smoothing rounds off the blocky voxel surface without volume shrinkage.
  // 10 iterations visibly rounds all hard edges; more iterations over-smooth thin walls.
  onLog?.('Taubin smoothing (20 iterations)…');
  const smoothedVerts = smoothMesh(mergedVerts, mergedTris, 0.5, -0.53, 20);
  onLog?.('Smoothing done.');

  // Decimate: cell = 3.5× voxelSize → ~12× fewer triangles
  onLog?.('Decimating…');
  const { verts: decVerts, tris: decTris } = decimateMesh(smoothedVerts, mergedTris, voxelSize * 3.5);
  onLog?.(`After decimation: ${decVerts.length / 3} vertices, ${decTris.length / 3} triangles`);

  // Remove floating disconnected islands
  const { verts: compVerts, tris: compTris } = keepLargestComponent(decVerts, decTris);
  onLog?.(`After component filter: ${compVerts.length / 3} vertices, ${compTris.length / 3} triangles`);

  const splatOffset = _normalizeMesh(compVerts, plyFloorY);
  onLog?.(`Normalised — splatOffset: (${splatOffset.splatOffsetX.toFixed(2)}, ${splatOffset.splatOffsetY.toFixed(2)}, ${splatOffset.splatOffsetZ.toFixed(2)})`);

  writeGLB(compVerts, compTris, outputPath);
  const sizeMB = (fs.statSync(outputPath).size / 1e6).toFixed(2);
  onLog?.(`Written: ${outputPath} (${sizeMB} MB)`);
  return { plyFloorY: 0, ...splatOffset };
}

// ─── SOG Parser ─────────────────────────────────────────────────────────────
// Reads PlayCanvas SOG (WebP-compressed) Gaussian splat format.
// sogMetaJsonPath must point to the meta.json file; the WebP tile files are
// resolved relative to that directory.
// Returns Float32Array [x0,y0,z0, x1,y1,z1, ...] for Gaussians above threshold.
async function parseSogPositions(sogMetaJsonPath, opacityThreshold = 0.2, onLog) {
  const webpMjsPath = new URL('../../splat-transform-main/lib/webp.mjs', import.meta.url);
  const { default: createWebP } = await import(webpMjsPath.href);
  const Module = await createWebP();

  const decodeWebP = (bytes) => {
    const inPtr = Module._malloc(bytes.length);
    const outPtrPtr = Module._malloc(4);
    const widthPtr  = Module._malloc(4);
    const heightPtr = Module._malloc(4);
    Module.HEAPU8.set(bytes, inPtr);
    const ok = Module._webp_decode_rgba(inPtr, bytes.length, outPtrPtr, widthPtr, heightPtr);
    if (!ok) {
      Module._free(inPtr); Module._free(outPtrPtr); Module._free(widthPtr); Module._free(heightPtr);
      throw new Error('WebP decode failed');
    }
    const outPtr = Module.HEAPU32[outPtrPtr >> 2];
    const width   = Module.HEAPU32[widthPtr  >> 2];
    const height  = Module.HEAPU32[heightPtr >> 2];
    const rgba    = Module.HEAPU8.slice(outPtr, outPtr + width * height * 4);
    Module._webp_free(outPtr);
    Module._free(inPtr); Module._free(outPtrPtr); Module._free(widthPtr); Module._free(heightPtr);
    return rgba;
  };

  const meta    = JSON.parse(fs.readFileSync(sogMetaJsonPath, 'utf8'));
  const count   = meta.count;
  const baseDir = path.dirname(sogMetaJsonPath);
  const load    = (name) => fs.readFileSync(path.join(baseDir, name));

  onLog?.(`Parsing ${count.toLocaleString()} SOG Gaussians…`);

  const lo = decodeWebP(load(meta.means.files[0]));
  const hi = decodeWebP(load(meta.means.files[1]));
  const c0 = decodeWebP(load(meta.sh0.files[0]));

  const { mins, maxs } = meta.means;
  const xMin = mins[0], xScale = (maxs[0] - mins[0]) || 1;
  const yMin = mins[1], yScale = (maxs[1] - mins[1]) || 1;
  const zMin = mins[2], zScale = (maxs[2] - mins[2]) || 1;
  const invLog = (v) => { const a = Math.abs(v); return v < 0 ? -(Math.exp(a) - 1) : Math.exp(a) - 1; };

  const positions = new Float32Array(count * 3);
  let kept = 0;

  for (let i = 0; i < count; i++) {
    // sh0 alpha byte encodes sigmoid opacity directly as 0-255
    if (c0[i * 4 + 3] / 255 <= opacityThreshold) continue;

    const o    = i * 4;
    const xu16 = lo[o]     | (hi[o]     << 8);
    const yu16 = lo[o + 1] | (hi[o + 1] << 8);
    const zu16 = lo[o + 2] | (hi[o + 2] << 8);

    positions[kept * 3]     = invLog(xMin + xScale * (xu16 / 65535));
    positions[kept * 3 + 1] = invLog(yMin + yScale * (yu16 / 65535));
    positions[kept * 3 + 2] = invLog(zMin + zScale * (zu16 / 65535));
    kept++;
  }

  onLog?.(`Kept ${kept.toLocaleString()} / ${count.toLocaleString()} Gaussians after opacity filter`);
  return positions.subarray(0, kept * 3);
}

export async function voxelizeSog(sogMetaJsonPath, seedPos, voxelSize, outputPath, onLog, opacityThreshold = 0.2) {
  voxelSize = parseFloat(voxelSize) || 0.15;
  if (voxelSize < 0.05) voxelSize = 0.05;
  const threshold = Math.max(0.01, Math.min(0.99, parseFloat(opacityThreshold) || 0.2));
  const seed = typeof seedPos === 'string' ? seedPos.split(',').map(Number) : seedPos;

  onLog?.(`SOG voxelizer — voxelSize: ${voxelSize}m, opacityThreshold: ${threshold}, seed: ${seed}`);

  const positions = await parseSogPositions(sogMetaJsonPath, threshold, onLog);
  if (positions.length === 0) throw new Error('No solid Gaussians found — check opacity threshold');

  let gridInfo;
  while (true) {
    try {
      gridInfo = buildGrid(positions, voxelSize, onLog);
      break;
    } catch (e) {
      if (!e.message.includes('Grid too large')) throw e;
      voxelSize *= 2;
      onLog?.(`Grid too large — retrying with voxelSize=${voxelSize.toFixed(3)}m`);
    }
  }

  const minCluster = Math.max(8, Math.round(0.5 / (voxelSize * voxelSize)));
  removeSmallClusters(gridInfo, minCluster, onLog);

  const emptyCells = floodFill(gridInfo, seed, onLog);
  onLog?.(`Flood-fill: ${emptyCells.toLocaleString()} navigable cells`);

  const { verts, tris } = extractSurface(gridInfo);
  onLog?.(`Surface mesh: ${verts.length / 3} vertices, ${tris.length / 3} triangles`);

  if (tris.length === 0) throw new Error('Surface mesh is empty — seed may be outside the splat');

  writeGLB(verts, tris, outputPath);
  const sizeMB = (fs.statSync(outputPath).size / 1e6).toFixed(2);
  onLog?.(`Written: ${outputPath} (${sizeMB} MB)`);
}
