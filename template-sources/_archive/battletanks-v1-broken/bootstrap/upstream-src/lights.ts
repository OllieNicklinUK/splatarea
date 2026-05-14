import * as THREE from "three";

class HemiSphereLight {
  mesh: THREE.HemisphereLight;

  constructor(name = "main") {
    this.mesh = new THREE.HemisphereLight(0xf4f1ff, 0x2a3148, 1.15);
    this.mesh.name = `${name}-hemisphere-light`;
    this.mesh.position.set(0, 0, 600);
  }
}

class DirectionalLight {
  mesh: THREE.DirectionalLight;

  constructor(name = "main") {
    this.mesh = new THREE.DirectionalLight(0xffffff, 1.2);
    this.mesh.name = `${name}-directional-light`;
    this.mesh.position.set(260, -320, 420);
    this.mesh.castShadow = true;
    this.mesh.shadow.mapSize.set(1024, 1024);
  }
}

export { HemiSphereLight, DirectionalLight };
