import * as THREE from "three";
import { cloneFittedModel } from "./modelCache.js";

const WALL_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#dbe7f5",
  roughness: 0.54,
  metalness: 0.22
});

const PILLAR_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#7dd3fc",
  roughness: 0.72,
  metalness: 0.16,
  emissive: "#164e63",
  emissiveIntensity: 0.18
});

const WALL_CAP_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#8ecae6",
  roughness: 0.34,
  metalness: 0.3,
  emissive: "#155e75",
  emissiveIntensity: 0.25
});

const WALL_STRIPE_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#f472b6",
  roughness: 0.4,
  metalness: 0.18,
  emissive: "#db2777",
  emissiveIntensity: 0.55
});

function createGroundTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#081421");
  gradient.addColorStop(0.45, "#12314f");
  gradient.addColorStop(1, "#24113e");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(125,211,252,0.12)";
  ctx.lineWidth = 3;
  for (let i = 0; i <= 16; i += 1) {
    const p = (canvas.width / 16) * i;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(canvas.width, p);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(244,114,182,0.22)";
  ctx.lineWidth = 14;
  ctx.strokeRect(84, 84, canvas.width - 168, canvas.height - 168);

  ctx.strokeStyle = "rgba(251,191,36,0.28)";
  ctx.lineWidth = 8;
  ctx.setLineDash([28, 22]);
  ctx.beginPath();
  ctx.moveTo(canvas.width * 0.25, 0);
  ctx.lineTo(canvas.width * 0.25, canvas.height);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(canvas.width * 0.75, 0);
  ctx.lineTo(canvas.width * 0.75, canvas.height);
  ctx.stroke();
  ctx.setLineDash([]);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function intersectsAny(box, boxes, padding = 0) {
  const padded = box.clone().expandByScalar(padding);
  return boxes.some((candidate) => padded.intersectsBox(candidate));
}

export class Arena {
  constructor(scene) {
    this.scene = scene;
    this.bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
    this.spawnZones = [
      new THREE.Box3(
        new THREE.Vector3(-15.5, -1, 7.5),
        new THREE.Vector3(-6.5, 4, 15.5)
      ),
      new THREE.Box3(
        new THREE.Vector3(6.5, -1, -15.5),
        new THREE.Vector3(15.5, 4, -7.5)
      )
    ];
    this.wallBoxes = [];
    this.wallMeshes = [];
    this.decorMeshes = [];
    this.materialNodes = [];
    this.groundGroup = new THREE.Group();
    this.wallGroup = new THREE.Group();
    this.decorGroup = new THREE.Group();
    this.materialGroup = new THREE.Group();
    this.group = new THREE.Group();
    this.group.name = "Arena";
    this.group.add(this.groundGroup);
    this.group.add(this.wallGroup);
    this.group.add(this.decorGroup);
    this.group.add(this.materialGroup);
    scene.add(this.group);
    this.createGround();
    this.createLights();
    this.regenerateLayout(1);
  }

  createGround() {
    const groundTexture = createGroundTexture();
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: "#18324c",
      map: groundTexture,
      emissive: "#0b1a2c",
      emissiveMap: groundTexture,
      emissiveIntensity: 0.22,
      roughness: 0.84,
      metalness: 0.08
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(46, 46, 1, 1), groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.groundGroup.add(ground);

    const grid = new THREE.GridHelper(46, 23, 0x8fd3ff, 0x1d6a8e);
    grid.position.y = 0.03;
    grid.material.opacity = 0.28;
    grid.material.transparent = true;
    this.groundGroup.add(grid);

    const boundary = new THREE.Mesh(
      new THREE.RingGeometry(22.2, 23.2, 4, 1),
      new THREE.MeshBasicMaterial({
        color: "#f472b6",
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide
      })
    );
    boundary.rotation.x = -Math.PI / 2;
    boundary.position.y = 0.045;
    this.groundGroup.add(boundary);
  }

  createLights() {
    const hemi = new THREE.HemisphereLight(0xbfe8ff, 0x071018, 1.45);
    hemi.position.set(0, 25, 0);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(8, 18, 10);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 50;
    dir.shadow.camera.left = -26;
    dir.shadow.camera.right = 26;
    dir.shadow.camera.top = 26;
    dir.shadow.camera.bottom = -26;
    this.scene.add(dir);
  }

  regenerateLayout(seed) {
    this.clearDynamicLayout();
    this.wallBoxes = [];

    const random = seededRandom(seed * 7919 + 17);
    const reservedBoxes = [...this.spawnZones];
    const laneBox = new THREE.Box3(
      new THREE.Vector3(-4, -1, -4),
      new THREE.Vector3(4, 4, 4)
    );
    reservedBoxes.push(laneBox);

    const layouts = [
      [-12, -3, 3, 8],
      [12, 3, 3, 8],
      [0, 0, 2.8, 10],
      [-7, 10, 5, 2],
      [7, -10, 5, 2],
      [-14, 11, 2, 6],
      [14, -11, 2, 6]
    ];

    const shuffled = layouts
      .map((item) => ({ item, score: random() }))
      .sort((a, b) => a.score - b.score)
      .map((entry) => entry.item);

    for (const [x, z, width, depth] of shuffled.slice(0, 5)) {
      this.addWall(x, z, width, depth, reservedBoxes);
    }

    const wallCount = 4 + Math.floor(random() * 4);
    let attempts = 0;
    while (this.wallBoxes.length < wallCount + 3 && attempts < 60) {
      attempts += 1;
      const wide = random() > 0.5;
      const width = wide ? 5 + Math.floor(random() * 3) : 2.4 + random() * 1.2;
      const depth = wide ? 2.2 + random() * 1.4 : 5 + Math.floor(random() * 3);
      const x = -14 + random() * 28;
      const z = -14 + random() * 28;
      this.addWall(x, z, width, depth, reservedBoxes);
    }

    this.addDecor(seed);
    this.addMaterials(seed);
  }

  addWall(x, z, width, depth, reservedBoxes) {
    const box = new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(x, 1.4, z),
      new THREE.Vector3(width, 2.8, depth)
    );

    if (intersectsAny(box, reservedBoxes, 1.3)) return false;
    if (intersectsAny(box, this.wallBoxes, 1.1)) return false;

    const wall = new THREE.Group();
    wall.position.set(x, 0, z);

    const body = new THREE.Mesh(new THREE.BoxGeometry(width, 2.8, depth), WALL_MATERIAL);
    body.position.y = 1.4;
    body.castShadow = true;
    body.receiveShadow = true;
    wall.add(body);

    const cap = new THREE.Mesh(new THREE.BoxGeometry(width + 0.22, 0.18, depth + 0.22), WALL_CAP_MATERIAL);
    cap.position.y = 2.9;
    cap.castShadow = true;
    wall.add(cap);

    const stripeHorizontal = width >= depth;
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(
        stripeHorizontal ? width * 0.82 : 0.16,
        0.18,
        stripeHorizontal ? 0.16 : depth * 0.82
      ),
      WALL_STRIPE_MATERIAL
    );
    stripe.position.set(0, 2.12, 0);
    wall.add(stripe);

    const underGlow = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.32, 0.08, depth + 0.32),
      new THREE.MeshBasicMaterial({
        color: "#7dd3fc",
        transparent: true,
        opacity: 0.22
      })
    );
    underGlow.position.y = 0.05;
    wall.add(underGlow);

    this.wallGroup.add(wall);
    this.wallMeshes.push(wall);
    this.wallBoxes.push(box);
    return true;
  }

  addDecor(seed) {
    const random = seededRandom(seed * 2971 + 101);
    const pillarCount = 5 + Math.floor(random() * 4);
    let attempts = 0;

    while (this.decorMeshes.length < pillarCount && attempts < 40) {
      attempts += 1;
      const x = -17 + random() * 34;
      const z = -17 + random() * 34;
      const box = new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(x, 0.9, z),
        new THREE.Vector3(1.2, 1.8, 1.2)
      );
      if (intersectsAny(box, this.spawnZones, 1.4)) continue;
      if (intersectsAny(box, this.wallBoxes, 1.2)) continue;

      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45 + random() * 0.35, 0.55 + random() * 0.35, 1.4 + random() * 1.8, 10),
        PILLAR_MATERIAL
      );
      pillar.position.set(x, 0.8 + random() * 0.9, z);
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      this.decorGroup.add(pillar);
      this.decorMeshes.push(pillar);
    }
  }

  addMaterials(seed) {
    const random = seededRandom(seed * 4447 + 313);
    let attempts = 0;
    while (this.materialNodes.length < 6 && attempts < 50) {
      attempts += 1;
      const x = -16 + random() * 32;
      const z = -16 + random() * 32;
      const box = new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(x, 0.9, z),
        new THREE.Vector3(1.5, 1.8, 1.5)
      );
      if (intersectsAny(box, this.spawnZones, 1.2)) continue;
      if (intersectsAny(box, this.wallBoxes, 1.1)) continue;

      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.55 + random() * 0.22, 0),
        new THREE.MeshStandardMaterial({
          color: "#facc15",
          emissive: "#ca8a04",
          emissiveIntensity: 0.45,
          roughness: 0.28,
          metalness: 0.12
        })
      );
      mesh.position.set(x, 1, z);
      mesh.castShadow = true;
      this.materialGroup.add(mesh);
      const node = {
        position: new THREE.Vector3(x, 1, z),
        mesh,
        collected: false
      };
      this.materialNodes.push(node);
      this.loadMaterialAsset(node, random);
    }
  }

  async loadMaterialAsset(node, random) {
    try {
      const asset = await cloneFittedModel("/models/powerup_model/scene.gltf", {
        targetSize: 1.3 + random() * 0.28,
        yOffset: -0.05,
        rotationY: random() * Math.PI * 2
      });
      if (node.collected || !node.mesh.parent) return;
      node.mesh.clear();
      node.mesh.add(asset);
    } catch {
      // Keep primitive fallback.
    }
  }

  collectMaterialAt(position, radius = 1.8) {
    for (const node of this.materialNodes) {
      if (node.collected) continue;
      if (node.position.distanceToSquared(position) <= radius * radius) {
        node.collected = true;
        this.materialGroup.remove(node.mesh);
        return true;
      }
    }
    return false;
  }

  clearDynamicLayout() {
    for (const mesh of this.wallMeshes) {
      this.wallGroup.remove(mesh);
    }
    for (const mesh of this.decorMeshes) {
      this.decorGroup.remove(mesh);
    }
    for (const node of this.materialNodes) {
      this.materialGroup.remove(node.mesh);
    }
    this.wallMeshes = [];
    this.decorMeshes = [];
    this.materialNodes = [];
  }

  clampPosition(position, radius = 1.1) {
    position.x = Math.max(this.bounds.minX + radius, Math.min(this.bounds.maxX - radius, position.x));
    position.z = Math.max(this.bounds.minZ + radius, Math.min(this.bounds.maxZ - radius, position.z));
  }

  collides(position, radius = 1.1) {
    const body = new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(position.x, 1.3, position.z),
      new THREE.Vector3(radius * 2, 2.6, radius * 2)
    );
    return this.wallBoxes.some((box) => box.intersectsBox(body));
  }
}
