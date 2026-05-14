import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
const cache = new Map();

function markShadows(root) {
  root.traverse((node) => {
    if (node.isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
      if (node.material && "side" in node.material) {
        node.material = node.material.clone();
        node.material.side = THREE.FrontSide;
      }
    }
  });
}

function fitModel(root, { targetSize = 3, yOffset = 0, rotationY = 0 } = {}) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const largest = Math.max(size.x, size.y, size.z, 0.001);
  const scale = targetSize / largest;
  root.scale.setScalar(scale);

  const scaledBox = new THREE.Box3().setFromObject(root);
  const scaledCenter = new THREE.Vector3();
  const scaledSize = new THREE.Vector3();
  scaledBox.getCenter(scaledCenter);
  scaledBox.getSize(scaledSize);

  root.position.sub(scaledCenter);
  root.position.y += scaledSize.y * 0.5 + yOffset;
  root.rotation.y = rotationY;
  markShadows(root);
  return root;
}

export async function loadModel(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      loader.loadAsync(url).then((gltf) => gltf.scene)
    );
  }
  return cache.get(url);
}

export async function cloneFittedModel(url, options) {
  const scene = await loadModel(url);
  const clone = scene.clone(true);
  return fitModel(clone, options);
}
