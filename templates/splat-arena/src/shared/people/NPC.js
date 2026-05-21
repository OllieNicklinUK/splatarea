import * as THREE from 'three';
import { createInstance } from './character-loader.js';

// Unchanged from NewtonDemo except:
//  - constructor accepts optional floorY and bounds so it works inside
//    an arbitrary splat bounding box instead of a fixed ±4.5 unit arena.
//  - All claw / throw / held / ragdoll logic is preserved in case we add
//    interactions later.

const FLEE_SPEED   = 2.2;
const WANDER_SPEED = 1.6;
const PICKUP_RADIUS = 1.0;
const FACING_FLIP = Math.PI;

export const ANIM_SPEED = { walk: 0.4, run: 0.55 };

export class NPC {
  constructor(scene, type, x, z, options = {}) {
    this.scene = scene;
    this.type  = type;
    this.state = 'wander';
    this.velocity = new THREE.Vector3();
    this.angle = Math.random() * Math.PI * 2;
    this._t = Math.random() * 100;

    // Configurable bounds for this NPC (defaults match original demo)
    const floorY = options.floorY ?? 0;
    this._bMinX = options.minX ?? -4.5;
    this._bMaxX = options.maxX ??  4.5;
    this._bMinZ = options.minZ ?? -4.5;
    this._bMaxZ = options.maxZ ??  4.5;

    // Optional voxel mesh for wall avoidance + terrain following (set via setVoxelMesh)
    this._voxelMesh   = options.voxelMesh ?? null;
    this._wallRc      = new THREE.Raycaster();
    this._wallRc.far  = 1.2; // look-ahead distance for obstacle detection
    this._groundRc    = new THREE.Raycaster();
    this._groundOrig  = new THREE.Vector3();
    this._groundDir   = new THREE.Vector3(0, -1, 0);
    this._rcTick      = false; // alternates each frame so raycasts run every other frame

    this.group = new THREE.Group();
    this.group.position.set(x, floorY, z);
    scene.add(this.group);

    this.mixer  = null;
    this.actions = {};
    this._currentActionName = null;
    this.holdOffsetY = -1.55;
    this._modelUpdate = null;

    this.swingVel  = new THREE.Vector3();
    this.thrownVel = new THREE.Vector3();
    this.tumbleX   = 0;
    this.tumbleZ   = 0;
    this.recoverTime = 0;
    this._floorY = floorY;

    this._buildPlaceholder();
    this._loadModel();
  }

  _buildPlaceholder() {
    this._placeholder = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.18, 0.9, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0x88aacc, transparent: true, opacity: 0.4 })
    );
    this._placeholder.position.y = 0.75;
    this.group.add(this._placeholder);
  }

  async _loadModel() {
    try {
      const { model, instance, mixer, actions, scale, holdOffsetY } =
        await createInstance(this.type);

      instance.scale.setScalar(scale);
      this.holdOffsetY = holdOffsetY;
      this.mixer       = mixer;
      this.actions     = actions;

      if (actions.walk) actions.walk.timeScale = ANIM_SPEED.walk;
      if (actions.run)  actions.run.timeScale  = ANIM_SPEED.run;
      this._modelUpdate = (typeof model?.update === 'function')
        ? model.update.bind(model) : null;

      this.group.remove(this._placeholder);
      this._placeholder.geometry.dispose();
      this._placeholder.material.dispose();
      this.group.add(instance);
      this._instance = instance;
      this._playAction('idle', 0);
    } catch (err) {
      console.warn(`[NPC] load failed (${this.type}):`, err);
      if (this._placeholder) {
        this._placeholder.material.color.setHex(0xff3344);
        this._placeholder.material.opacity = 1;
      }
    }
  }

  _playAction(name, fadeTime = 0.2) {
    const next = this.actions[name];
    if (!next || this._currentActionName === name) return;
    if (this._currentActionName) {
      const prev = this.actions[this._currentActionName];
      if (prev) prev.fadeOut(fadeTime);
    }
    next.reset().fadeIn(fadeTime).play();
    this._currentActionName = name;
  }

  update(delta, clawPos, clawClosed, options = {}) {
    this._t += delta;
    if (this.mixer) this.mixer.update(delta);
    if (this._modelUpdate) this._modelUpdate(delta);

    const allowFlee   = options.flee === true;
    const armEffector = options.armEffector;
    const clawVel     = options.clawVelocity;
    const fx          = options.effects;

    if (this.state === 'thrown') {
      this.thrownVel.y -= 9.8 * delta;
      this.group.position.addScaledVector(this.thrownVel, delta);
      this.group.rotation.x += this.tumbleX * delta;
      this.group.rotation.z += this.tumbleZ * delta;

      if (this.group.position.y <= this._floorY) {
        this.group.position.y = this._floorY;
        if (this.thrownVel.y < -1.0) {
          this.thrownVel.y *= -0.55;
          this.thrownVel.x *= 0.72;
          this.thrownVel.z *= 0.72;
          this.tumbleX *= 0.7; this.tumbleZ *= 0.7;
        } else {
          this.thrownVel.set(0, 0, 0);
          this.tumbleX = this.tumbleZ = 0;
          this.group.rotation.set(0, Math.random() * Math.PI * 2, 0);
          this.state = 'recovering';
          this.recoverTime = 0;
        }
      }
      if (this.actions.idle) this._playAction('idle', 0.05);
      return;
    }

    if (this.state === 'recovering') {
      this.recoverTime += delta;
      if (this.actions.idle) this._playAction('idle', 0.1);
      if (this.recoverTime > 1.2) { this.state = 'wander'; this.angle = Math.random() * Math.PI * 2; }
      return;
    }

    if (this.state === 'held') {
      const damping = 0.94, stiffness = 0.07, noise = 0.012;
      this.swingVel.x = this.swingVel.x * damping - this.group.rotation.x * stiffness + (Math.random() - 0.5) * noise;
      this.swingVel.z = this.swingVel.z * damping - this.group.rotation.z * stiffness + (Math.random() - 0.5) * noise;
      if (clawVel) { this.swingVel.x -= clawVel.z * 0.008; this.swingVel.z += clawVel.x * 0.008; }
      this.group.rotation.x = THREE.MathUtils.clamp(this.group.rotation.x + this.swingVel.x, -1.2, 1.2);
      this.group.rotation.z = THREE.MathUtils.clamp(this.group.rotation.z + this.swingVel.z, -1.2, 1.2);
      if (this.actions.idle) this._playAction('idle', 0.15);
      if (!clawClosed) this._dropFromClaw(clawVel, fx);
      return;
    }

    const dx = this.group.position.x - clawPos.x;
    const dz = this.group.position.z - clawPos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    const fleeRadius = options.fleeRadius ?? 3.0;
    const fleeing = allowFlee && horizDist < fleeRadius;
    this.state = fleeing ? 'flee' : 'wander';
    const speed = fleeing ? FLEE_SPEED : WANDER_SPEED;

    if (fleeing) {
      const away = this.group.position.clone().sub(clawPos);
      away.y = 0;
      away.lengthSq() < 0.001 ? away.set(1, 0, 0) : away.normalize();
      this.angle = Math.atan2(away.x, away.z);
    } else {
      this.angle += (Math.random() - 0.5) * delta * 1.8;
    }

    // Voxel wall avoidance — cast three rays (forward, ±30°) at floor level.
    // Throttled to every other frame (alternating _rcTick) to halve raycast cost.
    this._rcTick = !this._rcTick;
    let wallBlocked = false;
    if (this._voxelMesh && this._rcTick) {
      const WALL_NEAR = 0.45;
      const WALL_FAR  = 1.4;
      const origin = new THREE.Vector3(
        this.group.position.x, this._floorY + 0.9, this.group.position.z
      );
      const checkRay = (a) => {
        const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
        this._wallRc.far = WALL_FAR;
        this._wallRc.set(origin, dir);
        const hits = this._wallRc.intersectObject(this._voxelMesh, true);
        return hits.length ? hits[0].distance : Infinity;
      };
      const fwdDist  = checkRay(this.angle);
      const leftDist = checkRay(this.angle - Math.PI / 6);
      const rghtDist = checkRay(this.angle + Math.PI / 6);
      if (fwdDist < WALL_FAR) {
        const origAngle = this.angle;
        const turnDir = leftDist >= rghtDist ? -1 : 1;
        this.angle += turnDir * (Math.PI * 0.5 + (Math.random() - 0.5) * 0.4);
        wallBlocked = true;
        if (fwdDist < WALL_NEAR) {
          this.group.position.x -= Math.sin(origAngle) * (WALL_NEAR - fwdDist);
          this.group.position.z -= Math.cos(origAngle) * (WALL_NEAR - fwdDist);
        }
      }
    }

    this.velocity.set(Math.sin(this.angle), 0, Math.cos(this.angle)).multiplyScalar(speed);
    if (!wallBlocked) {
      this.group.position.addScaledVector(this.velocity, delta);
    }
    if (this._rcTick) this.group.position.y = this._terrainY(this.group.position);

    // Bounce off splat bounding box walls
    const p = this.group.position;
    if (p.x < this._bMinX || p.x > this._bMaxX || p.z < this._bMinZ || p.z > this._bMaxZ) {
      this.angle += Math.PI + (Math.random() - 0.5) * 0.5;
      p.x = THREE.MathUtils.clamp(p.x, this._bMinX, this._bMaxX);
      p.z = THREE.MathUtils.clamp(p.z, this._bMinZ, this._bMaxZ);
    }

    if (this.velocity.lengthSq() > 0.001) {
      this.group.rotation.y = Math.atan2(this.velocity.x, this.velocity.z) + FACING_FLIP;
    }

    if (this.actions.walk) this._playAction(fleeing ? 'run' : 'walk');
  }

  _terrainY(pos) {
    if (!this._voxelMesh) return this._floorY;
    // Cast from a fixed height above _floorY (not pos.y) so already-elevated
    // NPCs don't cast from too high and land on wall faces above the floor.
    this._groundOrig.set(pos.x, this._floorY + 4, pos.z);
    this._groundRc.set(this._groundOrig, this._groundDir);
    this._groundRc.far = 5;
    const hits = this._groundRc.intersectObject(this._voxelMesh, true);
    const rawY = hits.length ? hits[0].point.y : this._floorY;
    // Clamp: ignore wall faces that are well above or below the floor plane.
    return THREE.MathUtils.clamp(rawY, this._floorY - 0.5, this._floorY + 0.5);
  }

  _dropFromClaw(clawVelocity) {
    this.scene.attach(this.group);
    this.group.position.y = this._floorY;
    this.angle = Math.random() * Math.PI * 2;
    this.group.rotation.set(0, this.angle, 0);
    this.state = 'wander';
  }

  setVoxelMesh(mesh) { this._voxelMesh = mesh; }

  destroy() {
    this.scene.remove(this.group);
    this.group.traverse(child => {
      if (child.isMesh) { child.geometry?.dispose(); child.material?.dispose(); }
    });
  }
}
