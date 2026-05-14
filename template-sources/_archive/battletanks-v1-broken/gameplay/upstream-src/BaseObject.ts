import * as THREE from "three";
import { disposeMeshes } from "../../core-engine/upstream-src/utils/mesh";

class BaseObject {
  type: string;
  name: string;
  mesh: THREE.Object3D | null;

  constructor(type: string, name: string) {
    this.type = type;
    this.name = name;
    this.mesh = null;
  }

  tick(_delta: number): void {}

  destruct() {
    if (!this.mesh) {
      return;
    }

    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }

    disposeMeshes(this.mesh);
  }
}

class MovableObject extends BaseObject {}

export { BaseObject, MovableObject };
