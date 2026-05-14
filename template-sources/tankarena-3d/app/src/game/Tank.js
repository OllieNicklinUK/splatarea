import * as THREE from "three";
import { cloneFittedModel } from "./modelCache.js";

function makeTankMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.7,
    metalness: 0.2
  });
}

export class Tank {
  constructor({ id, color, position, scene }) {
    this.id = id;
    this.radius = 1.1;
    this.speed = 8;
    this.reverseSpeedMultiplier = 0.72;
    this.turnSpeed = 2.8;
    this.turretTurnSpeed = 2.6;
    this.cooldown = 0;
    this.standardCooldown = 0.55;
    this.heavyCooldown = 1.75;
    this.bodyAngle = 0;
    this.turretAngle = 0;
    this.position = position.clone();
    this.velocity = new THREE.Vector3();

    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.group.name = `Tank:${id}`;
    this.visualRoot = new THREE.Group();
    this.hullVisual = new THREE.Group();

    this.visualRoot.add(this.hullVisual);
    this.group.add(this.visualRoot);
    this.buildFallbackVisual(color);
    this.loadAssetVisual();

    const shadowRing = new THREE.Mesh(
      new THREE.RingGeometry(1.35, 1.65, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    shadowRing.rotation.x = -Math.PI / 2;
    shadowRing.position.y = 0.04;
    this.group.add(shadowRing);

    scene.add(this.group);
    this.syncTransforms();
  }

  buildFallbackVisual(color) {
    const hullMaterial = makeTankMaterial(color);
    const trimMaterial = makeTankMaterial("#dbeafe");
    const darkMetal = makeTankMaterial("#172033");
    const tireMaterial = new THREE.MeshStandardMaterial({
      color: "#0f172a",
      roughness: 0.92,
      metalness: 0.08
    });

    const hull = new THREE.Group();

    const lowerHull = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.58, 3.5), hullMaterial);
    lowerHull.position.y = 0.82;
    lowerHull.castShadow = true;
    hull.add(lowerHull);

    const upperHull = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.62, 2.15), hullMaterial);
    upperHull.position.set(0, 1.24, 0.08);
    upperHull.castShadow = true;
    hull.add(upperHull);

    const glacis = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.42, 0.95), trimMaterial);
    glacis.position.set(0, 1.2, -1.1);
    glacis.rotation.x = -0.42;
    glacis.castShadow = true;
    hull.add(glacis);

    const rearPlate = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.36, 0.72), trimMaterial);
    rearPlate.position.set(0, 1.08, 1.34);
    rearPlate.rotation.x = 0.32;
    rearPlate.castShadow = true;
    hull.add(rearPlate);

    const sideSkirtGeometry = new THREE.BoxGeometry(0.28, 0.55, 3.18);
    for (const side of [-1, 1]) {
      const skirt = new THREE.Mesh(sideSkirtGeometry, darkMetal);
      skirt.position.set(side * 1.15, 0.9, 0);
      skirt.castShadow = true;
      hull.add(skirt);

      const track = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.68, 3.34), tireMaterial);
      track.position.set(side * 1.32, 0.74, 0);
      track.castShadow = true;
      hull.add(track);

      for (let i = -2; i <= 2; i += 1) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.14, 16), tireMaterial);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * 1.32, 0.48, i * 0.62);
        wheel.castShadow = true;
        hull.add(wheel);
      }
    }

    const turretBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.72, 0.38, 12),
      darkMetal
    );
    turretBase.position.y = 1.58;
    turretBase.castShadow = true;
    hull.add(turretBase);

    this.turret = new THREE.Group();
    this.turret.position.y = 1.62;

    const turretBody = new THREE.Mesh(
      new THREE.BoxGeometry(1.32, 0.42, 1.45),
      hullMaterial
    );
    turretBody.position.set(0, 0.14, -0.08);
    turretBody.castShadow = true;
    this.turret.add(turretBody);

    const turretTop = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 0.18, 0.78),
      trimMaterial
    );
    turretTop.position.set(0, 0.44, -0.04);
    turretTop.castShadow = true;
    this.turret.add(turretTop);

    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.16, 2.35, 10),
      trimMaterial
    );
    barrel.rotation.z = Math.PI / 2;
    barrel.position.set(0, 0.18, -1.34);
    barrel.castShadow = true;
    this.turret.add(barrel);

    const muzzle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 0.26, 10),
      darkMetal
    );
    muzzle.rotation.z = Math.PI / 2;
    muzzle.position.set(0, 0.18, -2.44);
    muzzle.castShadow = true;
    this.turret.add(muzzle);

    this.hullVisual.add(hull);
    this.visualRoot.add(this.turret);
  }

  async loadAssetVisual() {
    try {
      const asset = await cloneFittedModel("/models/tank_model_new/scene.gltf", {
        targetSize: 3.6,
        yOffset: 0.02,
        rotationY: Math.PI
      });
      if (!this.visualRoot.parent) return;
      const turretNode =
        asset.getObjectByName("Turret") ||
        asset.getObjectByName("turret") ||
        asset.getObjectByName("Gun") ||
        asset.getObjectByName("gun") ||
        asset.getObjectByProperty("name", "Turret_M3A1_mtl1_0");

      if (!turretNode || !turretNode.parent) {
        return;
      }

      turretNode.parent.remove(turretNode);
      this.hullVisual.clear();
      this.turret.clear();
      this.hullVisual.add(asset);
      this.turret.position.set(0, 0, 0);
      this.turret.add(turretNode);
    } catch {
      // Keep procedural fallback.
    }
  }

  syncTransforms() {
    this.group.position.copy(this.position);
    this.group.rotation.y = this.bodyAngle;
    this.turret.rotation.y = this.turretAngle - this.bodyAngle;
  }

  update(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.syncTransforms();
  }

  drive(input, dt, arena) {
    const turn = Math.max(-1, Math.min(1, input.turn || 0));
    const throttle = Math.max(-1, Math.min(1, input.throttle || 0));
    if (turn !== 0) {
      this.bodyAngle += turn * this.turnSpeed * dt;
    }
    if (throttle === 0) return;

    const speed = throttle > 0 ? this.speed : this.speed * this.reverseSpeedMultiplier;
    const nextPosition = this.position.clone();
    nextPosition.x += Math.sin(this.bodyAngle) * speed * throttle * dt;
    nextPosition.z += Math.cos(this.bodyAngle) * speed * throttle * dt;
    arena.clampPosition(nextPosition, this.radius);

    if (!arena.collides(nextPosition, this.radius)) {
      this.position.copy(nextPosition);
    }
  }

  driveToward(direction, dt, arena) {
    if (!direction || direction.lengthSq() < 0.0001) return;
    const desiredAngle = Math.atan2(direction.x, direction.z);
    const angleDelta = Math.atan2(
      Math.sin(desiredAngle - this.bodyAngle),
      Math.cos(desiredAngle - this.bodyAngle)
    );
    const turn = Math.max(-1, Math.min(1, angleDelta / 0.6));
    const throttle = Math.abs(angleDelta) < 1.15 ? 1 : 0.42;
    this.drive({ throttle, turn }, dt, arena);
  }

  rotateTurret(turn, dt) {
    if (!turn) return;
    this.turretAngle += Math.max(-1, Math.min(1, turn)) * this.turretTurnSpeed * dt;
  }

  aimAt(target) {
    const direction = target.clone().sub(this.position);
    if (direction.lengthSq() < 0.0001) return;
    this.turretAngle = Math.atan2(-direction.x, -direction.z);
  }

  tryFire(projectiles, options = {}) {
    if (this.cooldown > 0) return;
    const heavy = Boolean(options.heavy);
    this.cooldown = heavy ? this.heavyCooldown : this.standardCooldown;
    const forward = new THREE.Vector3(-Math.sin(this.turretAngle), 0, -Math.cos(this.turretAngle));
    const spawn = this.position.clone().add(forward.clone().multiplyScalar(1.8));
    spawn.y = 1.25;
    projectiles.spawn({
      ownerId: this.id,
      position: spawn,
      velocity: forward.multiplyScalar(heavy ? 24 : 20),
      projectileType: heavy ? "heavy" : "standard",
      damage: heavy ? 34 : 18,
      passesThroughWalls: heavy
    });
  }
}
