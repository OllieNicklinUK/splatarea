import * as THREE from 'three';
import { createBallShooter } from './fps/balls.js';

// FPS game mode — first-person exploration with physics ball shooter.
// Does NOT manage camera movement (play.js updateFPS handles that).
// Returns { update(dt), dispose() }.
export function createFPSGame({ scene, camera, voxelMesh, splatCage, floorSlab }) {
  const _rc  = new THREE.Raycaster();
  const _dir = new THREE.Vector3();

  function raycastCollision(origin, direction, maxDistance) {
    _rc.set(origin, _dir.copy(direction).normalize());
    _rc.far = maxDistance;
    const hits = [];

    const cast = (obj) => { if (obj) _rc.intersectObject(obj, true, hits); };
    cast(voxelMesh);
    cast(splatCage);
    cast(floorSlab);

    if (!hits.length) return null;
    hits.sort((a, b) => a.distance - b.distance);
    const h = hits[0];
    if (!h.face) return null;

    const worldNormal = h.face.normal.clone()
      .transformDirection(h.object.matrixWorld)
      .normalize();
    if (worldNormal.dot(direction) > 0) worldNormal.negate();
    return { point: h.point, normal: worldNormal, distance: h.distance };
  }

  const ballShooter = createBallShooter(scene, raycastCollision);

  const vp = document.getElementById('viewport');

  const onMouseDown = (e) => {
    if (document.pointerLockElement !== vp || e.button !== 0) return;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    ballShooter.shoot(camera.position.clone(), dir);
  };

  const onKeyDown = (e) => {
    if (e.code === 'KeyB') ballShooter.clear();
  };

  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('keydown', onKeyDown);

  function update(dt) {
    ballShooter.update(dt);
  }

  function dispose() {
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('keydown', onKeyDown);
    ballShooter.clear();
  }

  return { update, dispose };
}
