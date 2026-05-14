import * as THREE from "three";
import { cloneFittedModel } from "./modelCache.js";

export class ProjectileSystem {
  constructor(scene) {
    this.scene = scene;
    this.projectiles = [];
    this.geometry = new THREE.SphereGeometry(0.25, 14, 14);
    this.material = new THREE.MeshStandardMaterial({
      color: "#fbbf24",
      emissive: "#f97316",
      emissiveIntensity: 0.7
    });
    this.heavyGeometry = new THREE.SphereGeometry(0.36, 18, 18);
    this.heavyMaterial = new THREE.MeshStandardMaterial({
      color: "#a78bfa",
      emissive: "#7c3aed",
      emissiveIntensity: 0.9,
      metalness: 0.18,
      roughness: 0.32
    });
  }

  spawn({ ownerId, position, velocity, projectileType = "standard", damage = 18, passesThroughWalls = false }) {
    const isHeavy = projectileType === "heavy";
    const mesh = new THREE.Group();
    const fallback = new THREE.Mesh(isHeavy ? this.heavyGeometry : this.geometry, isHeavy ? this.heavyMaterial : this.material);
    fallback.castShadow = true;
    const glow = new THREE.PointLight(isHeavy ? 0xa78bfa : 0xfbbf24, isHeavy ? 1.6 : 1.2, isHeavy ? 8 : 6, 2);
    glow.position.set(0, 0, 0);
    mesh.add(fallback);
    mesh.add(glow);
    if (isHeavy) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.56, 0.08, 12, 28),
        new THREE.MeshStandardMaterial({
          color: "#f472b6",
          emissive: "#c026d3",
          emissiveIntensity: 1,
          roughness: 0.24,
          metalness: 0.32
        })
      );
      ring.rotation.x = Math.PI / 2;
      mesh.add(ring);

      const fin = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.24, 0),
        new THREE.MeshStandardMaterial({
          color: "#fde68a",
          emissive: "#f59e0b",
          emissiveIntensity: 0.8,
          roughness: 0.2,
          metalness: 0.18
        })
      );
      fin.position.z = -0.48;
      mesh.add(fin);
    }
    mesh.position.copy(position);
    this.scene.add(mesh);
    this.loadAssetMesh(mesh, isHeavy);
    this.projectiles.push({
      ownerId,
      position: position.clone(),
      velocity: velocity.clone(),
      life: isHeavy ? 3.1 : 2.4,
      mesh,
      damage,
      projectileType,
      passesThroughWalls
    });
  }

  async loadAssetMesh(root, isHeavy) {
    try {
      const asset = await cloneFittedModel("/models/bullet_model/scene.gltf", {
        targetSize: isHeavy ? 0.95 : 0.72,
        yOffset: 0,
        rotationY: Math.PI / 2
      });
      if (!root.parent) return;
      root.clear();
      if (isHeavy) {
        asset.traverse((node) => {
          if (node.isMesh && node.material && "emissive" in node.material) {
            node.material = node.material.clone();
            node.material.emissive = new THREE.Color("#7c3aed");
            node.material.emissiveIntensity = 0.95;
          }
        });
      } else {
        asset.traverse((node) => {
          if (node.isMesh && node.material) {
            node.material = node.material.clone();
            if ("color" in node.material) {
              node.material.color.multiplyScalar(1.35);
            }
            if ("emissive" in node.material) {
              node.material.emissive = new THREE.Color("#fbbf24");
              node.material.emissiveIntensity = 0.85;
            }
          }
        });
      }
      root.add(asset);
    } catch {
      // Keep primitive fallback.
    }
  }

  update(dt, arena, tanks, onHit) {
    const survivors = [];

    for (const projectile of this.projectiles) {
      projectile.life -= dt;
      projectile.position.addScaledVector(projectile.velocity, dt);
      projectile.mesh.position.copy(projectile.position);
      projectile.mesh.rotation.y += dt * (projectile.projectileType === "heavy" ? 7 : 3.5);
      projectile.mesh.rotation.z += dt * (projectile.projectileType === "heavy" ? 5 : 2.5);

      if (projectile.life <= 0) {
        this.scene.remove(projectile.mesh);
        continue;
      }

      if (!projectile.passesThroughWalls && arena.collides(projectile.position, projectile.projectileType === "heavy" ? 0.28 : 0.2)) {
        this.scene.remove(projectile.mesh);
        continue;
      }

      const hitTank = tanks.find(
        (tank) =>
          tank.id !== projectile.ownerId &&
          tank.position.distanceToSquared(projectile.position) <= Math.pow(tank.radius + 0.3, 2)
      );

      if (hitTank) {
        onHit(hitTank.id, projectile);
        this.scene.remove(projectile.mesh);
        continue;
      }

      survivors.push(projectile);
    }

    this.projectiles = survivors;
  }

  dispose() {
    for (const projectile of this.projectiles) {
      this.scene.remove(projectile.mesh);
    }
    this.projectiles = [];
  }
}
