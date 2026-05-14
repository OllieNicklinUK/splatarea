import * as THREE from 'three';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { BvhPhysicsWorld, BvhCharacterPhysics } from './bvhPhysics.js';

// ---------------------------------------------------------------------------
// Physics engine — ported from VIVERSE reference (BvhCharacterPhysics)
// Key improvements over the old system:
//   1. Fixed timestep (60Hz) — deterministic regardless of framerate
//   2. Proper input vs state velocity separation
//   3. Slope-aware ground detection (crucial for micro-facets in photogrammetry!)
//   4. Linear damping (air resistance) instead of exponential hack
// ---------------------------------------------------------------------------

const GRAVITY         = 20;   // m/s² (reference default: 20)
const LINEAR_DAMPING  = 0.1;  // air resistance
const MAX_GROUND_SLOPE = 0.5; // max slope considered "ground" (tan of angle ~27°)
const STEPS_PER_FRAME = 5;    // exported for the main loop

function createPhysics() {
  // We keep Octree for random Raycasts or Hitscan if they still need it,
  // but character collision now strictly uses the BVH World.
  let worldOctree = new Octree();
  
  const bvhWorld = new BvhPhysicsWorld();
  const characterPhysics = new BvhCharacterPhysics(bvhWorld);

  // We use this dummy object to represent the player position/capsule
  const playerDummy = new THREE.Object3D();
  playerDummy.position.set(0, 1.6, 0);

  // Keep the old Capsule object synced so camera can read from playerCollider.end
  const playerCollider = new Capsule(
    new THREE.Vector3(0, 0.35, 0),
    new THREE.Vector3(0, 1.6, 0),
    0.35
  );

  const _baseObjects = [];

  // Tile collision (Google 3D Tiles fallback)
  let _tileCollisionGroup = null;
  const _tileRaycaster = new THREE.Raycaster();

  // ---------------------------------------------------------------------------
  // Core physics update — fixed timestep, BVH shapecast
  // ---------------------------------------------------------------------------
  function updatePlayer(fullDelta, camera, flyMode) {
    fullDelta = Math.min(1, fullDelta);

    if (flyMode) {
      // Fly mode — simple direct movement, no physics
      characterPhysics.stateVelocity.multiplyScalar(Math.exp(-8 * fullDelta));
      playerDummy.position.addScaledVector(characterPhysics.stateVelocity, fullDelta);
      
      // Also apply fly input
      playerDummy.position.addScaledVector(characterPhysics.inputVelocity, fullDelta);
      
      playerCollider.start.copy(playerDummy.position).setY(playerDummy.position.y - 1.25);
      playerCollider.end.copy(playerDummy.position);
      camera.position.copy(playerCollider.end);
      return;
    }

    // Process BVH Character Physics (it handles its own internal fixed timestep loop!)
    characterPhysics.update(playerDummy, fullDelta, {
      updatesPerSecond: 60,
      gravity: -GRAVITY,
      linearDamping: LINEAR_DAMPING,
      maxGroundSlope: MAX_GROUND_SLOPE,
      capsuleRadius: 0.2,
      capsuleHeight: 1.6,
    });

    // Handle Google Tiles (which don't use BVH yet)
    if (_tileCollisionGroup) {
      // Sync dummy to capsule to check tile intersection
      playerCollider.start.copy(playerDummy.position).setY(playerDummy.position.y - 1.25);
      playerCollider.end.copy(playerDummy.position);

      const tileResult = _checkTileCollision(playerCollider);
      if (tileResult) {
        if (tileResult.normal.y > 0) characterPhysics.notGroundedSeconds = 0; // force ground
        characterPhysics.stateVelocity.addScaledVector(tileResult.normal, -tileResult.normal.dot(characterPhysics.stateVelocity));
        playerDummy.position.addScaledVector(tileResult.normal, tileResult.depth);
      }
    }

    // Sync capsule to dummy — playerDummy.position is feet; camera is at eye level 1.6 m above
    playerCollider.start.copy(playerDummy.position).setY(playerDummy.position.y - 1.25);
    playerCollider.end.copy(playerDummy.position);
    camera.position.copy(playerDummy.position);
    camera.position.y += 1.5;
  }

  // ---------------------------------------------------------------------------
  // Tile collision fallback (Google 3D Tiles)
  // ---------------------------------------------------------------------------
  function _checkTileCollision(capsule) {
    if (!_tileCollisionGroup) return null;
    const bottom = capsule.start;
    _tileRaycaster.set(
      bottom.clone().add(new THREE.Vector3(0, 0.1, 0)),
      new THREE.Vector3(0, -1, 0)
    );
    _tileRaycaster.far = 2;
    const hits = _tileRaycaster.intersectObjects(_tileCollisionGroup.children, true);
    if (hits.length > 0) {
      return {
        normal: hits[0].face.normal,
        depth: 2 - hits[0].distance,
      };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Collision mesh management
  // ---------------------------------------------------------------------------
  function addCollisionMesh(object) {
    _baseObjects.push(object);

    // Temporarily hide noCollision meshes for both Octree and BVH
    const hidden = [];
    object.traverse(entry => {
      if (entry.isMesh && entry.userData?.noCollision && entry.visible) {
        entry.visible = false;
        hidden.push(entry);
      }
    });

    worldOctree.fromGraphNode(object); // Kept for hitscan bullet raytracing
    bvhWorld.addBody(object, true);    // Added to BVH for character sliding

    // Restore visibility
    hidden.forEach(m => { m.visible = true; });
  }

  function rebuildCollision(extraObjects = []) {
    worldOctree = new Octree();
    bvhWorld.clear();

    const _addFiltered = (obj) => {
      const toHide = []; // noCollision meshes: hide before BVH, restore after
      const toShow = []; // invisible meshes: show before BVH (StaticGeometryGenerator
                         // uses traverseVisible — invisible meshes are silently skipped,
                         // producing an empty BVH and no collision), hide again after.
      obj.traverse(entry => {
        if (!entry.isMesh) return;
        if (entry.userData?.noCollision && entry.visible) {
          entry.visible = false;
          toHide.push(entry);
        } else if (!entry.visible && !entry.userData?.noCollision) {
          entry.visible = true;
          toShow.push(entry);
        }
      });

      worldOctree.fromGraphNode(obj);
      bvhWorld.addBody(obj, true);

      toHide.forEach(m => { m.visible = true;  });
      toShow.forEach(m => { m.visible = false; });
    };

    _baseObjects.forEach(obj => _addFiltered(obj));
    extraObjects.forEach(obj => _addFiltered(obj));
    console.log('[Physics] BVH + Octree rebuilt —', _baseObjects.length, 'base +', extraObjects.length, 'extra objects');
  }

  function setTileCollisionGroup(group) {
    _tileCollisionGroup = group;
  }

  // Wipe every registered base collider then optionally seed fresh ones and
  // rebuild Octree + BVH. Used when switching splat worlds so the player
  // doesn't end up walking on the union of every world ever loaded.
  function clearCollisionMeshes(newObjects = []) {
    _baseObjects.length = 0;
    newObjects.forEach((obj) => _baseObjects.push(obj));
    rebuildCollision();
  }

  function setPlayerPosition(x, y, z) {
    playerDummy.position.set(x, y, z);
    playerCollider.start.set(x, y - 1.25, z);
    playerCollider.end.set(x, y, z);
    characterPhysics.stateVelocity.set(0, 0, 0);
  }

  return {
    playerCollider,
    playerVelocity: characterPhysics.stateVelocity,
    inputVelocity: characterPhysics.inputVelocity,
    updatePlayer,
    addCollisionMesh,
    rebuildCollision,
    clearCollisionMeshes,
    setTileCollisionGroup,
    getWorldOctree: () => worldOctree,
    getBaseObjects: () => _baseObjects,
    getPlayerOnFloor: () => characterPhysics.isGrounded,
    setPlayerPosition,
  };
}

export { createPhysics, STEPS_PER_FRAME };
