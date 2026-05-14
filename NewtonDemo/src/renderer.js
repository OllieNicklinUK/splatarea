import * as THREE from 'three';

const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

// ── Particle renderer (Idea 3 — soft body destruction) ──

export class ParticleRenderer {
  constructor(scene, maxCount = 4000) {
    this.maxCount = maxCount;
    const geo = new THREE.SphereGeometry(0.18, 4, 3);
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.4,
      metalness: 0.6,
      vertexColors: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, maxCount);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    // Pre-hide all instances
    _dummy.scale.setScalar(0);
    _dummy.updateMatrix();
    for (let i = 0; i < maxCount; i++) {
      this.mesh.setMatrixAt(i, _dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(particles) {
    // particles: array of {pos:[x,y,z], vel:[vx,vy,vz]}
    const count = Math.min(particles.length, this.maxCount);
    this.mesh.count = count;

    for (let i = 0; i < count; i++) {
      const p = particles[i];
      _dummy.position.set(p.pos[0], p.pos[1], p.pos[2]);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(i, _dummy.matrix);

      // Color by speed: slow=deep blue, fast=orange/white
      const speed = Math.sqrt(p.vel[0] ** 2 + p.vel[1] ** 2 + p.vel[2] ** 2);
      const t = Math.min(speed / 15, 1);
      if (t < 0.5) {
        _color.setRGB(0.1 + t * 0.4, 0.3 + t * 0.3, 0.9 - t * 0.4);
      } else {
        const u = (t - 0.5) * 2;
        _color.setRGB(0.3 + u * 0.7, 0.6 - u * 0.4, 0.5 - u * 0.5);
      }
      this.mesh.setColorAt(i, _color);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ── Crowd renderer (Idea 4 — 1000 GPU agents) ──

export class CrowdRenderer {
  constructor(scene, maxCount = 1000) {
    this.maxCount = maxCount;
    // Simple capsule-ish shape: box body + sphere head
    const bodyGeo = new THREE.CapsuleGeometry(0.18, 0.5, 2, 6);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 });
    this.mesh = new THREE.InstancedMesh(bodyGeo, mat, maxCount);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    _dummy.scale.setScalar(0);
    _dummy.updateMatrix();
    for (let i = 0; i < maxCount; i++) {
      this.mesh.setMatrixAt(i, _dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(agents) {
    // agents: array of {pos:[x,y,z], heading:float, speed:float, id:int}
    const count = Math.min(agents.length, this.maxCount);
    this.mesh.count = count;

    for (let i = 0; i < count; i++) {
      const a = agents[i];
      _dummy.position.set(a.pos[0], a.pos[1] + 0.55, a.pos[2]);
      _dummy.rotation.set(0, a.heading, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(i, _dummy.matrix);

      // Color by agent ID — stable hue per agent
      const hue = (a.id * 0.618033) % 1;
      const sat = 0.5 + a.speed * 0.3;
      _color.setHSL(hue, sat, 0.55);
      this.mesh.setColorAt(i, _color);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

// ── Smash ring effect ──

export class SmashRing {
  constructor(scene) {
    const geo = new THREE.RingGeometry(0.1, 0.3, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this._active = false;
    this._t = 0;
  }

  trigger(pos) {
    this.mesh.position.set(pos[0], 0.05, pos[2]);
    this.mesh.scale.setScalar(0.1);
    this.mesh.material.opacity = 0.9;
    this.mesh.visible = true;
    this._active = true;
    this._t = 0;
  }

  tick(dt) {
    if (!this._active) return;
    this._t += dt;
    const scale = 1 + this._t * 12;
    this.mesh.scale.setScalar(scale);
    this.mesh.material.opacity = Math.max(0, 0.9 - this._t * 3);
    if (this._t > 0.3) {
      this.mesh.visible = false;
      this._active = false;
    }
  }
}
