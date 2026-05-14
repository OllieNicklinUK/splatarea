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

// ─── Voxel Grid ──────────────────────────────────────────────────────────────
function buildGrid(positions, voxelSize, onLog) {
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
  const d1 = dilate();
  const d2 = dilate();
  onLog?.(`Dilation added ${(d1 + d2).toLocaleString()} voxels (2 passes)`);

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

  return { verts: new Float32Array(verts), tris: new Uint32Array(tris) };
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

  const { verts, tris } = extractSurface(gridInfo);
  onLog?.(`Surface mesh: ${verts.length / 3} vertices, ${tris.length / 3} triangles`);

  if (tris.length === 0) throw new Error('Surface mesh is empty — seed may be outside the splat');

  writeGLB(verts, tris, outputPath);
  const sizeMB = (fs.statSync(outputPath).size / 1e6).toFixed(2);
  onLog?.(`Written: ${outputPath} (${sizeMB} MB)`);
}
