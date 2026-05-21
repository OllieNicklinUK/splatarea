import * as THREE from 'three';

// All available check heights.  collides() accepts a minHeight override so
// games with terrain-following (e.g. racing) can ignore short voxel steps.
const HEIGHTS = [0.3, 0.85, 1.5];

// 8 horizontal directions (cardinal + diagonal).
const DIRS = [
  new THREE.Vector3( 1, 0,  0), new THREE.Vector3(-1, 0,  0),
  new THREE.Vector3( 0, 0,  1), new THREE.Vector3( 0, 0, -1),
  new THREE.Vector3( 0.707, 0,  0.707), new THREE.Vector3(-0.707, 0,  0.707),
  new THREE.Vector3( 0.707, 0, -0.707), new THREE.Vector3(-0.707, 0, -0.707),
];

// Reusable scratch objects — avoids allocating per-frame.
const _invMat   = new THREE.Matrix4();
const _localRay = new THREE.Ray();
const _worldRay = new THREE.Ray();
const _origin   = new THREE.Vector3();
const _hitPt    = new THREE.Vector3();
const _downDir  = new THREE.Vector3(0, -1, 0);

// Arena adapter for a Gaussian splat environment.
// Collision against real splat geometry via direct BVH queries on the
// voxel mesh. Falls back to open-field (no wall blocking) until the
// voxel mesh is ready.
export class SplatArena {
  constructor({ box, center, voxelMesh = null }) {
    this.cx = center.x;
    this.cz = center.z;
    this.floorY = center.y;

    const splatW = box.max.x - box.min.x;
    const splatD = box.max.z - box.min.z;
    this.arenaRadius = Math.max(8, Math.min(splatW, splatD) * 0.4);

    const pad = 2;
    this.minX = Math.max(this.cx - this.arenaRadius, box.min.x + pad);
    this.maxX = Math.min(this.cx + this.arenaRadius, box.max.x - pad);
    this.minZ = Math.max(this.cz - this.arenaRadius, box.min.z + pad);
    this.maxZ = Math.min(this.cz + this.arenaRadius, box.max.z - pad);

    // Required by ProjectileSystem — empty because voxel mesh handles walls.
    this.wallBoxes = [];

    // Flat list of {mesh} with a computed boundsTree. Populated by
    // _cacheVoxelMeshes. Direct BVH queries bypass Three.js visibility checks.
    this._meshCache = [];

    if (voxelMesh) this._cacheVoxelMeshes(voxelMesh);
  }

  _cacheVoxelMeshes(root) {
    this._meshCache = [];
    root.traverse(n => {
      if (n.isMesh && n.geometry?.boundsTree) this._meshCache.push(n);
    });
  }

  // Called when the async voxel mesh arrives after game start.
  setVoxelMesh(mesh) {
    this._cacheVoxelMeshes(mesh);
  }

  // Returns true if position is within radius of any voxel wall.
  // minHeight: skip ray checks below this value (lets terrain-following vehicles
  // ignore short voxel steps while still detecting proper walls above minHeight).
  collides(position, radius = 1.1, minHeight = 0) {
    if (!this._meshCache.length) return false;

    const threshold = radius * 1.5;

    for (const h of HEIGHTS) {
      if (h < minHeight) continue;
      _origin.set(position.x, position.y + h, position.z);
      _worldRay.origin.copy(_origin);

      for (const dir of DIRS) {
        _worldRay.direction.copy(dir);

        for (const mesh of this._meshCache) {
          // Transform world-space ray into mesh local space.
          _invMat.copy(mesh.matrixWorld).invert();
          _localRay.copy(_worldRay).applyMatrix4(_invMat);

          // three-mesh-bvh 0.9.x API: raycastFirst(ray, side, near, far)
          // DoubleSide so face orientation after 180° flipY never matters.
          // Pass threshold as `far` so BVH prunes branches beyond our radius.
          const hit = mesh.geometry.boundsTree.raycastFirst(
            _localRay, THREE.DoubleSide, 0, threshold,
          );
          if (hit) return true;
        }
      }
    }
    return false;
  }

  clampPosition(position, radius = 1.1) {
    position.x = Math.max(this.minX + radius, Math.min(this.maxX - radius, position.x));
    position.z = Math.max(this.minZ + radius, Math.min(this.maxZ - radius, position.z));
  }

  // Cast a ray straight down from `position` and return the world-space Y of
  // the first mesh hit, or `fallback` when the mesh isn't ready / nothing is hit.
  // searchAbove controls how far above position the ray starts (handles cases
  // where the caller is already slightly below the surface).
  groundY(position, fallback, searchAbove = 6, searchBelow = 4) {
    if (!this._meshCache.length) return fallback;

    _worldRay.origin.set(position.x, position.y + searchAbove, position.z);
    _worldRay.direction.copy(_downDir);

    let bestY = null;
    const totalRange = searchAbove + searchBelow;

    for (const mesh of this._meshCache) {
      _invMat.copy(mesh.matrixWorld).invert();
      _localRay.copy(_worldRay).applyMatrix4(_invMat);

      const hit = mesh.geometry.boundsTree.raycastFirst(
        _localRay, THREE.DoubleSide, 0, totalRange,
      );
      if (!hit) continue;

      // Convert local hit point → world space Y
      _hitPt.copy(hit.point).applyMatrix4(mesh.matrixWorld);
      if (bestY === null || Math.abs(_hitPt.y - position.y) < Math.abs(bestY - position.y)) {
        bestY = _hitPt.y;
      }
    }

    return bestY ?? fallback;
  }

  collectMaterialAt(_position, _radius = 1.8) {
    return false;
  }
}
