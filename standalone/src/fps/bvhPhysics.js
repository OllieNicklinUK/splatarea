import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, StaticGeometryGenerator, ExtendedTriangle } from 'three-mesh-bvh';

// Ported from viverse-main physics system (TypeScript -> JavaScript)

const rayHelper = new THREE.Ray();
const farPointHelper = new THREE.Vector3();
const boxHelper = new THREE.Box3();
const triangleHelper = new ExtendedTriangle();
const matrixHelper = new THREE.Matrix4();
const triPoint = new THREE.Vector3();
const capsulePoint = new THREE.Vector3();
const centerHelper = new THREE.Vector3();
const collisionFreePosition = new THREE.Vector3();
const position = new THREE.Vector3();
const invertedParentMatrix = new THREE.Matrix4();
const YAxis = new THREE.Vector3(0, 1, 0);

export class BvhPhysicsWorld {
  constructor() {
    this.bodies = [];
  }

  addBody(object, isStatic = true) {
    this.bodies.push(...this.computeBvhEntries(object, isStatic));
  }

  clear() {
    this.bodies = [];
  }

  computeBvhEntries(object, isStatic) {
    object.updateWorldMatrix(true, true);
    const result = [];
    let hasNonInstancedMeshes = false;
    
    object.traverse((entry) => {
      if (entry.isInstancedMesh) {
        if (!entry.geometry.boundsTree) entry.geometry.computeBoundsTree();
        const bvh = entry.geometry.boundsTree;
        for (let i = 0; i < entry.count; i++) {
          result.push({ object: entry, bvh, instanceIndex: i, isStatic });
        }
        return;
      }
      if (entry.isMesh && !entry.userData?.noCollision) {
        hasNonInstancedMeshes = true;
      }
    });

    if (hasNonInstancedMeshes) {
      // Temporarily hide noCollision meshes so StaticGeometryGenerator skips them
      const hidden = [];
      object.traverse(entry => {
        if (entry.isMesh && entry.userData?.noCollision && entry.visible) {
          entry.visible = false;
          hidden.push(entry);
        }
      });

      const parent = object.parent;
      if (!isStatic) {
        object.parent = null;
        object.updateMatrixWorld(true);
      }
      const generator = new StaticGeometryGenerator(object);
      const geometry = generator.generate();
      geometry.computeBoundsTree();
      const bvh = geometry.boundsTree;
      if (!isStatic) {
        object.parent = parent;
        object.updateMatrixWorld(true);
      }
      result.push({ object, bvh, isStatic });

      // Restore visibility
      hidden.forEach(m => { m.visible = true; });
    }
    return result;
  }

  computeMatrix(entry, target) {
    if (entry.isStatic && entry.instanceIndex == null) {
      return false; // Identity
    }
    if (entry.instanceIndex == null) {
      target.copy(entry.object.matrixWorld);
      return true;
    }
    entry.object.getMatrixAt(entry.instanceIndex, target);
    target.premultiply(entry.object.matrixWorld);
    return true;
  }

  shapecast(intersectsBounds, intersectsTriangle) {
    for (const entry of this.bodies) {
      entry.bvh.shapecast({
        intersectsBounds: (box) => {
          boxHelper.copy(box);
          if (this.computeMatrix(entry, matrixHelper)) {
            boxHelper.applyMatrix4(matrixHelper);
          }
          return intersectsBounds(boxHelper);
        },
        intersectsTriangle: (triangle) => {
          triangleHelper.copy(triangle);
          if (this.computeMatrix(entry, matrixHelper)) {
            triangleHelper.a.applyMatrix4(matrixHelper);
            triangleHelper.b.applyMatrix4(matrixHelper);
            triangleHelper.c.applyMatrix4(matrixHelper);
          }
          if (intersectsTriangle(triangleHelper) === true) {
            return true;
          }
        },
      });
    }
  }
}

export class BvhCharacterPhysics {
  constructor(world) {
    this.world = world;
    this.stateVelocity = new THREE.Vector3();
    this.inputVelocity = new THREE.Vector3();
    this.notGroundedSeconds = 0;
    this.segment = new THREE.Line3();
    this.aabbox = new THREE.Box3();
    this.radius = 0;
  }

  get isGrounded() {
    return this.notGroundedSeconds < 0.2;
  }

  update(model, fullDelta, options = {}) {
    fullDelta = Math.min(1, fullDelta);
    const updatesPerSecond = options.updatesPerSecond ?? 60;
    const physicsDelta = 1 / updatesPerSecond;

    while (fullDelta > 0) {
      const partialDelta = Math.min(fullDelta, physicsDelta);
      fullDelta -= physicsDelta;

      if (model.parent != null) {
        model.parent.updateWorldMatrix(true, false);
        position.copy(model.position).applyMatrix4(model.parent.matrixWorld);
        invertedParentMatrix.copy(model.parent.matrixWorld).invert();
      } else {
        invertedParentMatrix.identity();
        position.copy(model.position);
      }

      position.addScaledVector(this.inputVelocity, partialDelta);
      position.addScaledVector(this.stateVelocity, partialDelta);

      const isGrounded = this.shapecastCapsule(collisionFreePosition.copy(position), options.maxGroundSlope ?? 1, options) && this.stateVelocity.y <= 0;
      
      this.notGroundedSeconds += partialDelta;
      if (isGrounded) {
        this.notGroundedSeconds = 0;
      }

      if (!isGrounded || this.inputVelocity.lengthSq() > 0) {
        model.position.copy(collisionFreePosition).applyMatrix4(invertedParentMatrix);
      }

      this.stateVelocity.y += (options.gravity ?? -20) * partialDelta;
      const dampingFactor = 1.0 / (1.0 + partialDelta * (options.linearDamping ?? 0.1));
      this.stateVelocity.multiplyScalar(dampingFactor);

      if (isGrounded) {
        this.stateVelocity.set(0, (options.gravity ?? -20) * 0.01, 0); // Stick to ground
      }
    }
  }

  updateBoundingShapes(options) {
    this.radius = options.capsuleRadius ?? 0.35;
    const height = options.capsuleHeight ?? 1.6;
    this.segment.start.copy(position);
    this.segment.start.y += this.radius;
    this.segment.end.copy(position);
    this.segment.end.y += height - this.radius;
    this.aabbox.makeEmpty();
    this.aabbox.expandByPoint(this.segment.start);
    this.aabbox.expandByPoint(this.segment.end);
    this.aabbox.min.addScalar(-this.radius);
    this.aabbox.max.addScalar(this.radius);
  }

  shapecastCapsule(pos, maxGroundSlope, options) {
    this.updateBoundingShapes(options);
    let grounded = false;

    this.world.shapecast(
      (bounds) => bounds.intersectsBox(this.aabbox),
      (tri) => {
        const distance = tri.closestPointToSegment(this.segment, triPoint, capsulePoint);
        if (distance === 0) {
          const isCloserToSegmentStart = capsulePoint.distanceTo(this.segment.start) < capsulePoint.distanceTo(this.segment.end);
          if (isCloserToSegmentStart) grounded = true;
          const scaledDirection = capsulePoint.sub(isCloserToSegmentStart ? this.segment.start : this.segment.end);
          scaledDirection.y += this.radius;
          this.segment.start.add(scaledDirection);
          this.segment.end.add(scaledDirection);
        } else if (distance < this.radius) {
          const depthInsideCapsule = this.radius - distance;
          const direction = capsulePoint.sub(triPoint).divideScalar(distance);
          const slope = Math.tan(Math.acos(Math.min(1, Math.abs(direction.dot(YAxis)))));

          if (direction.y > 0 && slope <= maxGroundSlope) {
            grounded = true;
          }

          this.segment.start.addScaledVector(direction, depthInsideCapsule);
          this.segment.end.addScaledVector(direction, depthInsideCapsule);
        }
      }
    );

    pos.copy(this.segment.start);
    pos.y -= this.radius;
    return grounded;
  }
}
