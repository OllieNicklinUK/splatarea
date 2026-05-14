import * as THREE from "three";

class Scene {
  scene: THREE.Scene;

  constructor() {
    this.scene = new THREE.Scene();
  }

  add(object: { mesh?: THREE.Object3D | null }) {
    if (object.mesh) {
      this.scene.add(object.mesh);
    }
  }
}

export { Scene };
