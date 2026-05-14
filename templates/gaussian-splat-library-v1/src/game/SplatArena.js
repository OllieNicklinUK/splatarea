import * as THREE from 'three';

// Check heights for horizontal wall rays — samples low, mid, and upper body.
const HEIGHTS = [0.3, 0.85, 1.5];

// 8 horizontal directions (cardinal + diagonal).
const DIRS = [
  new THREE.Vector3( 1, 0,  0), new THREE.Vector3(-1, 0,  0),
  new THREE.Vector3( 0, 0,  1), new THREE.Vector3( 0, 0, -1),
  new THREE.Vector3( 0.707, 0,  0.707), new THREE.Vector3(-0.707, 0,  0.707),
  new THREE.Vector3( 0.707, 0, -0.707), new THREE.Vector3(-0.707, 0, -0.707),
];

// Reusable scratch objects — avoids allocating per-frame.
const _invMat  = new THREE.Matrix4();
const _localRay = new THREE.Ray();
const _worldRay = new THREE.Ray();
const _origin   = new THREE.Vector3();

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

  // Returns true if the tank at `position` is within `radius` of any voxel wall.
  // Uses direct BVH raycastFirst calls — not affected by mesh.visible flags.
  collides(position, radius = 1.1) {
    if (!this._meshCache.length) return false;

    const threshold = radius * 1.5;

    for (const h of HEIGHTS) {
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

  collectMaterialAt(_position, _radius = 1.8) {
    return false;
  }
}
