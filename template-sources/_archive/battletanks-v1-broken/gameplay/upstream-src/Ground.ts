import * as THREE from "three";
import { BaseObject } from "./BaseObject";

class Ground extends BaseObject {
  halfSize: number;

  constructor(name = "main") {
    super("ground", name);

    this.halfSize = 760;

    const geometry = new THREE.PlaneGeometry(this.halfSize * 2, this.halfSize * 2, 1, 1);
    const material = new THREE.MeshStandardMaterial({
      color: 0x4e9154,
      roughness: 0.95,
      metalness: 0.05,
    });
    const plane = new THREE.Mesh(geometry, material);
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;

    this.mesh = plane;
  }

  inBoundary(position: THREE.Vector3) {
    return Math.abs(position.x) <= this.halfSize && Math.abs(position.y) <= this.halfSize;
  }
}

export { Ground };
