// simplify-collision.js
// Converts a full voxel collision mesh into a compact set of flat planes.
// Floor faces (|normalY| ≥ 0.7) become horizontal PlaneGeometries clustered
// by height. Wall faces become vertical planes bucketed by their X or Z
// position. The result is BVH-accelerated and drop-in compatible with
// SplatArena's collision queries.
//
// Activated by adding ?sc=1 to the game URL. No effect without that param.

import * as THREE from 'three';

const FLOOR_DOT  = 0.7;   // |normalY| above this → floor or ceiling face
const WALL_MERGE = 0.3;   // bucket wall planes this many metres apart
const FLOOR_GAP  = 0.5;   // split floor clusters when Y gap exceeds this

const _va   = new THREE.Vector3();
const _vb   = new THREE.Vector3();
const _vc   = new THREE.Vector3();
const _ab   = new THREE.Vector3();
const _ac   = new THREE.Vector3();
const _norm = new THREE.Vector3();

export function buildSimplifiedCollision(root) {
  root.updateMatrixWorld(true);

  const floorFaces = [];              // { y, x0, x1, z0, z1 }
  const xWalls     = new Map();       // key → { x, y0, y1, z0, z1 }
  const zWalls     = new Map();       // key → { z, y0, y1, x0, x1 }

  root.traverse(node => {
    if (!node.isMesh) return;
    const geo = node.geometry;
    if (!geo) return;
    const pos      = geo.getAttribute('position');
    const idx      = geo.index;
    const mw       = node.matrixWorld;
    const triCount = idx ? idx.count / 3 : pos.count / 3;

    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3)     : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;

      _va.fromBufferAttribute(pos, i0).applyMatrix4(mw);
      _vb.fromBufferAttribute(pos, i1).applyMatrix4(mw);
      _vc.fromBufferAttribute(pos, i2).applyMatrix4(mw);

      _ab.subVectors(_vb, _va);
      _ac.subVectors(_vc, _va);
      _norm.crossVectors(_ab, _ac);
      const len = _norm.length();
      if (len < 1e-10) continue;
      _norm.divideScalar(len);

      if (Math.abs(_norm.y) >= FLOOR_DOT) {
        floorFaces.push({
          y:  (_va.y + _vb.y + _vc.y) / 3,
          x0: Math.min(_va.x, _vb.x, _vc.x),
          x1: Math.max(_va.x, _vb.x, _vc.x),
          z0: Math.min(_va.z, _vb.z, _vc.z),
          z1: Math.max(_va.z, _vb.z, _vc.z),
        });
      } else if (Math.abs(_norm.x) >= Math.abs(_norm.z)) {
        const cx  = (_va.x + _vb.x + _vc.x) / 3;
        const key = Math.round(cx / WALL_MERGE);
        if (!xWalls.has(key)) xWalls.set(key, { x: cx, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity });
        const w = xWalls.get(key);
        w.y0 = Math.min(w.y0, _va.y, _vb.y, _vc.y);
        w.y1 = Math.max(w.y1, _va.y, _vb.y, _vc.y);
        w.z0 = Math.min(w.z0, _va.z, _vb.z, _vc.z);
        w.z1 = Math.max(w.z1, _va.z, _vb.z, _vc.z);
      } else {
        const cz  = (_va.z + _vb.z + _vc.z) / 3;
        const key = Math.round(cz / WALL_MERGE);
        if (!zWalls.has(key)) zWalls.set(key, { z: cz, y0: Infinity, y1: -Infinity, x0: Infinity, x1: -Infinity });
        const w = zWalls.get(key);
        w.y0 = Math.min(w.y0, _va.y, _vb.y, _vc.y);
        w.y1 = Math.max(w.y1, _va.y, _vb.y, _vc.y);
        w.x0 = Math.min(w.x0, _va.x, _vb.x, _vc.x);
        w.x1 = Math.max(w.x1, _va.x, _vb.x, _vc.x);
      }
    }
  });

  const invisMat = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
  });

  const group = new THREE.Group();
  const _addPlane = (geo, mat, px, py, pz, rx, ry) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz);
    if (rx) m.rotation.x = rx;
    if (ry) m.rotation.y = ry;
    group.add(m);
  };

  // Floor planes — one per height cluster
  for (const cluster of _clusterByY(floorFaces, FLOOR_GAP)) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, ySum = 0;
    for (const f of cluster) {
      x0 = Math.min(x0, f.x0); x1 = Math.max(x1, f.x1);
      z0 = Math.min(z0, f.z0); z1 = Math.max(z1, f.z1);
      ySum += f.y;
    }
    _addPlane(
      new THREE.PlaneGeometry(x1 - x0 + 1, z1 - z0 + 1),
      invisMat.clone(),
      (x0 + x1) / 2, ySum / cluster.length, (z0 + z1) / 2,
      -Math.PI / 2, 0,
    );
  }

  // X-facing wall planes
  for (const w of xWalls.values()) {
    const h = w.y1 - w.y0;
    const d = w.z1 - w.z0;
    if (h <= 0 || d <= 0) continue;
    _addPlane(
      new THREE.PlaneGeometry(d, h),
      invisMat.clone(),
      w.x, (w.y0 + w.y1) / 2, (w.z0 + w.z1) / 2,
      0, Math.PI / 2,
    );
  }

  // Z-facing wall planes
  for (const w of zWalls.values()) {
    const h = w.y1 - w.y0;
    const d = w.x1 - w.x0;
    if (h <= 0 || d <= 0) continue;
    _addPlane(
      new THREE.PlaneGeometry(d, h),
      invisMat.clone(),
      (w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2, w.z,
      0, 0,
    );
  }

  group.updateMatrixWorld(true);
  group.traverse(n => {
    if (n.isMesh) { try { n.geometry.computeBoundsTree(); } catch {} }
  });

  const floorCount = _clusterByY(floorFaces, FLOOR_GAP).length;
  const wallCount  = xWalls.size + zWalls.size;
  console.log(`[simplify-collision] ${group.children.length} planes (${floorCount} floor, ${wallCount} wall)`);

  return group;
}

// Returns groups of faces where consecutive Y values are within `gap` of each other.
function _clusterByY(faces, gap) {
  if (!faces.length) return [];
  const sorted = [...faces].sort((a, b) => a.y - b.y);
  const out = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y <= gap) {
      out[out.length - 1].push(sorted[i]);
    } else {
      out.push([sorted[i]]);
    }
  }
  return out;
}
