import * as THREE from "three";
import { BaseObject } from "./BaseObject";

class Wall extends BaseObject {
  size: THREE.Vector3;

  constructor(
    name: string,
    _textureDict: { [key: string]: THREE.Texture } = {},
    size: THREE.Vector3 = new THREE.Vector3(20, 100, 50),
    position: THREE.Vector3 = new THREE.Vector3(0, 0, 0),
    rotation: THREE.Euler = new THREE.Euler(0, 0, 0)
  ) {
    super("wall", name);

    this.size = size.clone();

    const geometry = new THREE.BoxGeometry(size.y, size.x, size.z);
    const material = new THREE.MeshStandardMaterial({
      color: 0x7d6751,
      roughness: 0.9,
      metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.copy(position);
    mesh.rotation.copy(rotation);

    this.mesh = mesh;
  }
}

export { Wall };
