import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Warehouse Assets — Procedural geometry factory for modular warehouse pieces
//
// Every function returns a THREE.Group with proper shadows and materials.
// All meshes use MeshStandardMaterial for consistent PBR-style rendering.
// ---------------------------------------------------------------------------

// ── Shared Materials ──────────────────────────────────────────────────────

const _matCache = {};
const _textureLoader = new THREE.TextureLoader();

// Wall Textures
const _wallAlbedo = _textureLoader.load('/textures/Poliigon_ConcreteWorn_8690/2K/Poliigon_ConcreteWorn_8690_BaseColor.jpg');
const _wallNormal = _textureLoader.load('/textures/Poliigon_ConcreteWorn_8690/2K/Poliigon_ConcreteWorn_8690_Normal.png');
const _wallRoughness = _textureLoader.load('/textures/Poliigon_ConcreteWorn_8690/2K/Poliigon_ConcreteWorn_8690_Roughness.jpg');
const _wallAO = _textureLoader.load('/textures/Poliigon_ConcreteWorn_8690/2K/Poliigon_ConcreteWorn_8690_AmbientOcclusion.jpg');

const _wallMaps = [_wallAlbedo, _wallNormal, _wallRoughness, _wallAO];

_wallMaps.forEach(map => {
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1, 1);
  map.colorSpace = THREE.SRGBColorSpace; // especially for BaseColor
});
// only albedo is in sRGB
_wallNormal.colorSpace = THREE.LinearSRGBColorSpace;
_wallRoughness.colorSpace = THREE.LinearSRGBColorSpace;
_wallAO.colorSpace = THREE.LinearSRGBColorSpace;

// Ceiling Textures (Vinyl Square Tile)
const _ceilAlbedo = _textureLoader.load('/textures/Poliigon_VinylSquareTile_10623/2K/Poliigon_VinylSquareTile_10623_BaseColor.jpg');
const _ceilNormal = _textureLoader.load('/textures/Poliigon_VinylSquareTile_10623/2K/Poliigon_VinylSquareTile_10623_Normal.png');
const _ceilRoughness = _textureLoader.load('/textures/Poliigon_VinylSquareTile_10623/2K/Poliigon_VinylSquareTile_10623_Roughness.jpg');
const _ceilAO = _textureLoader.load('/textures/Poliigon_VinylSquareTile_10623/2K/Poliigon_VinylSquareTile_10623_AmbientOcclusion.jpg');

const _ceilMaps = [_ceilAlbedo, _ceilNormal, _ceilRoughness, _ceilAO];

_ceilMaps.forEach(map => {
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1, 1);
  map.colorSpace = THREE.SRGBColorSpace;
});
_ceilNormal.colorSpace = THREE.LinearSRGBColorSpace;
_ceilRoughness.colorSpace = THREE.LinearSRGBColorSpace;
_ceilAO.colorSpace = THREE.LinearSRGBColorSpace;

function getMaterial(key) {
  if (_matCache[key]) return _matCache[key];

  const defs = {
    concrete:      { 
      color: 0x8a8a7a, 
      map: _wallAlbedo,
      normalMap: _wallNormal,
      roughnessMap: _wallRoughness,
      aoMap: _wallAO,
      roughness: 1.0, 
      metalness: 0.0 
    },
    concreteFloor: { color: 0x6a6a5e, roughness: 0.9,  metalness: 0.0 },
    concreteDark:  { color: 0x5a5a4e, roughness: 0.95, metalness: 0.0 },
    metalWall:     { color: 0x556670, roughness: 0.5,  metalness: 0.6 },
    metalDark:     { color: 0x333840, roughness: 0.4,  metalness: 0.7 },
    metalLight:    { color: 0x778899, roughness: 0.45, metalness: 0.5 },
    wood:          { color: 0x8B6914, roughness: 0.8,  metalness: 0.0 },
    woodDark:      { color: 0x5C4A1C, roughness: 0.85, metalness: 0.0 },
    plastic:       { color: 0x2244aa, roughness: 0.7,  metalness: 0.1 },
    caution:       { color: 0xccaa00, roughness: 0.6,  metalness: 0.1 },
    cautionStripe: { color: 0x111111, roughness: 0.6,  metalness: 0.1 },
    ceiling:       { 
      color: 0x888888, 
      map: _ceilAlbedo,
      normalMap: _ceilNormal,
      roughnessMap: _ceilRoughness,
      aoMap: _ceilAO,
      roughness: 0.8, 
      metalness: 0.1 
    },
    trim:          { color: 0x3a3a3a, roughness: 0.7,  metalness: 0.3 },
    red:           { color: 0xaa2222, roughness: 0.6,  metalness: 0.1 },
    green:         { color: 0x22aa44, roughness: 0.6,  metalness: 0.1 },
    lightFixture:  { color: 0xdddddd, roughness: 0.3,  metalness: 0.6 },
    lightGlow:     { color: 0xffffee, roughness: 0.1,  metalness: 0.0, emissive: 0xffffcc, emissiveIntensity: 0.5 },
  };

  const def = defs[key] ?? defs.concrete;
  const mat = new THREE.MeshStandardMaterial(def);
  _matCache[key] = mat;
  return mat;
}

export function updateTextureScale(target, scaleX, scaleY) {
  const maps = target === 'ceiling' ? _ceilMaps : _wallMaps;
  maps.forEach(map => {
    map.repeat.set(scaleX, scaleY);
    map.needsUpdate = true;
  });
}

function setShadows(mesh, cast = true, receive = true) {
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
}

// ── 1. Wall Panel ─────────────────────────────────────────────────────────

export function createWallPanel(width = 4, height = 3.5, thickness = 0.2, matKey = 'concrete') {
  const group = new THREE.Group();

  // Main wall
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, thickness),
    getMaterial(matKey)
  );
  wall.position.y = height / 2;
  setShadows(wall);
  group.add(wall);

  // Baseboard strip
  const baseH = 0.12;
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.02, baseH, thickness + 0.04),
    getMaterial('trim')
  );
  base.position.y = baseH / 2;
  setShadows(base, false, true);
  group.add(base);

  return group;
}

// ── 2. Wall with Door ─────────────────────────────────────────────────────

export function createWallWithDoor(width = 4, height = 3.5, doorWidth = 2.0, doorHeight = 2.8, thickness = 0.2, matKey = 'concrete') {
  const group = new THREE.Group();

  const halfW = width / 2;
  const halfDoor = doorWidth / 2;

  // Left pillar
  const leftW = halfW - halfDoor;
  if (leftW > 0.01) {
    const left = new THREE.Mesh(
      new THREE.BoxGeometry(leftW, height, thickness),
      getMaterial(matKey)
    );
    left.position.set(-(halfW - leftW / 2), height / 2, 0);
    setShadows(left);
    group.add(left);
  }

  // Right pillar
  const rightW = halfW - halfDoor;
  if (rightW > 0.01) {
    const right = new THREE.Mesh(
      new THREE.BoxGeometry(rightW, height, thickness),
      getMaterial(matKey)
    );
    right.position.set(halfW - rightW / 2, height / 2, 0);
    setShadows(right);
    group.add(right);
  }

  // Header above door
  const headerH = height - doorHeight;
  if (headerH > 0.01) {
    const header = new THREE.Mesh(
      new THREE.BoxGeometry(doorWidth, headerH, thickness),
      getMaterial(matKey)
    );
    header.position.set(0, doorHeight + headerH / 2, 0);
    setShadows(header);
    group.add(header);
  }

  // Door frame trim
  const trimThick = 0.06;
  const trimDepth = thickness + 0.06;
  // Left trim
  const ltrim = new THREE.Mesh(
    new THREE.BoxGeometry(trimThick, doorHeight, trimDepth),
    getMaterial('trim')
  );
  ltrim.position.set(-halfDoor, doorHeight / 2, 0);
  ltrim.userData.noCollision = true; // exclude from BVH
  group.add(ltrim);
  // Right trim
  const rtrim = new THREE.Mesh(
    new THREE.BoxGeometry(trimThick, doorHeight, trimDepth),
    getMaterial('trim')
  );
  rtrim.position.set(halfDoor, doorHeight / 2, 0);
  rtrim.userData.noCollision = true; // exclude from BVH
  group.add(rtrim);
  // Top trim
  const ttrim = new THREE.Mesh(
    new THREE.BoxGeometry(doorWidth + trimThick * 2, trimThick, trimDepth),
    getMaterial('trim')
  );
  ttrim.position.set(0, doorHeight, 0);
  ttrim.userData.noCollision = true; // exclude from BVH
  group.add(ttrim);

  return group;
}

// ── 3. Half Wall ──────────────────────────────────────────────────────────

export function createHalfWall(width = 4, height = 1.2, thickness = 0.2) {
  const group = new THREE.Group();
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, thickness),
    getMaterial('concrete')
  );
  wall.position.y = height / 2;
  setShadows(wall);
  group.add(wall);

  // Flat cap on top
  const cap = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.04, 0.05, thickness + 0.04),
    getMaterial('metalLight')
  );
  cap.position.y = height;
  group.add(cap);

  return group;
}

// ── 4. Floor Slab ─────────────────────────────────────────────────────────

export function createFloorSlab(width = 32, depth = 32, thickness = 0.2) {
  const group = new THREE.Group();
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(width, thickness, depth),
    getMaterial('concreteFloor')
  );
  floor.position.y = -thickness / 2;
  setShadows(floor, false, true);
  group.add(floor);
  return group;
}

// ── 5. Ceiling Panel ──────────────────────────────────────────────────────

export function createCeilingPanel(width = 32, depth = 32, height = 3.5) {
  const group = new THREE.Group();
  const ceil = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.15, depth),
    getMaterial('ceiling')
  );
  ceil.position.y = height;
  setShadows(ceil, false, true);
  ceil.userData.isCeiling = true; // Tag for overseer visibility toggling
  group.add(ceil);
  group.userData.isCeiling = true;
  return group;
}

// ── 6. Support Column ─────────────────────────────────────────────────────

export function createSupportColumn(radius = 0.25, height = 3.5) {
  const group = new THREE.Group();
  const col = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 8),
    getMaterial('concreteDark')
  );
  col.position.y = height / 2;
  setShadows(col);
  group.add(col);

  // Base plate
  const plateR = radius + 0.1;
  const plate = new THREE.Mesh(
    new THREE.CylinderGeometry(plateR, plateR, 0.08, 8),
    getMaterial('metalDark')
  );
  plate.position.y = 0.04;
  group.add(plate);

  return group;
}

// ── 7. Crate ──────────────────────────────────────────────────────────────

export function createCrate(size = 1.0, matKey = 'wood') {
  const group = new THREE.Group();
  const crate = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    getMaterial(matKey)
  );
  crate.position.y = size / 2;
  setShadows(crate);
  group.add(crate);

  // Edge strips
  const stripW = 0.04;
  const stripMat = getMaterial(matKey === 'wood' ? 'woodDark' : 'metalDark');
  for (const axis of ['x', 'z']) {
    for (const sign of [-1, 1]) {
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(
          axis === 'x' ? stripW : size + 0.02,
          size + 0.02,
          axis === 'z' ? stripW : size + 0.02
        ),
        stripMat
      );
      strip.position.y = size / 2;
      if (axis === 'x') strip.position.x = sign * (size / 2);
      else strip.position.z = sign * (size / 2);
      group.add(strip);
    }
  }
  return group;
}

// ── 8. Crate Stack ────────────────────────────────────────────────────────

export function createCrateStack(rng) {
  const group = new THREE.Group();
  const count = 2 + Math.floor(rng() * 3); // 2-4 crates

  // Base layer: 1-2 crates
  const baseCount = Math.min(count, 1 + Math.floor(rng() * 2));
  const size = 0.7 + rng() * 0.6; // 0.7-1.3m
  const matKey = rng() > 0.5 ? 'wood' : 'metalDark';

  for (let i = 0; i < baseCount; i++) {
    const c = createCrate(size, matKey);
    c.position.x = (i - (baseCount - 1) / 2) * (size + 0.05);
    group.add(c);
  }

  // Top layer
  const topCount = count - baseCount;
  const topSize = size * (0.7 + rng() * 0.3);
  for (let i = 0; i < topCount; i++) {
    const c = createCrate(topSize, matKey);
    c.position.set(
      (i - (topCount - 1) / 2) * (topSize + 0.05) + (rng() - 0.5) * 0.1,
      size,
      (rng() - 0.5) * 0.1
    );
    group.add(c);
  }

  return group;
}

// ── 9. Barrel ─────────────────────────────────────────────────────────────

export function createBarrel(radius = 0.35, height = 1.0, matKey = 'metalDark') {
  const group = new THREE.Group();
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 0.95, height, 12),
    getMaterial(matKey)
  );
  barrel.position.y = height / 2;
  setShadows(barrel);
  group.add(barrel);

  // Top/bottom rim
  for (const y of [0.05, height - 0.05]) {
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.02, 4, 12),
      getMaterial('metalLight')
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = y;
    group.add(rim);
  }
  return group;
}

// ── 10. Barrel Cluster ────────────────────────────────────────────────────

export function createBarrelCluster(rng) {
  const group = new THREE.Group();
  const count = 2 + Math.floor(rng() * 3); // 2-4

  for (let i = 0; i < count; i++) {
    const matKey = rng() > 0.6 ? 'caution' : 'metalDark';
    const b = createBarrel(0.3 + rng() * 0.1, 0.9 + rng() * 0.2, matKey);
    const angle = (i / count) * Math.PI * 2 + rng() * 0.5;
    const dist = 0.4 + rng() * 0.3;
    b.position.set(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
    b.rotation.y = rng() * Math.PI;
    group.add(b);
  }
  return group;
}

// ── 11. Shelf Unit ────────────────────────────────────────────────────────

export function createShelfUnit(width = 2.0, height = 2.4, depth = 0.6, shelves = 3) {
  const group = new THREE.Group();
  const frameMat = getMaterial('metalLight');
  const shelfMat = getMaterial('woodDark');

  // 4 Vertical poles
  const poleR = 0.03;
  for (const xOff of [-width / 2 + poleR, width / 2 - poleR]) {
    for (const zOff of [-depth / 2 + poleR, depth / 2 - poleR]) {
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(poleR, poleR, height, 6),
        frameMat
      );
      pole.position.set(xOff, height / 2, zOff);
      setShadows(pole);
      group.add(pole);
    }
  }

  // Shelf planes
  for (let i = 0; i <= shelves; i++) {
    const y = (i / shelves) * (height - 0.1) + 0.05;
    const shelf = new THREE.Mesh(
      new THREE.BoxGeometry(width - 0.02, 0.04, depth - 0.02),
      shelfMat
    );
    shelf.position.y = y;
    setShadows(shelf);
    group.add(shelf);
  }

  return group;
}

// ── 12. Pallet ────────────────────────────────────────────────────────────

export function createPallet(width = 1.2, depth = 1.0) {
  const group = new THREE.Group();
  const h = 0.12;
  const mat = getMaterial('wood');

  // Top planks (3)
  for (let i = 0; i < 3; i++) {
    const plank = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.03, depth / 3 - 0.02),
      mat
    );
    plank.position.set(0, h, (i - 1) * (depth / 3));
    group.add(plank);
  }

  // Support blocks (3 runners)
  for (let i = 0; i < 3; i++) {
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, h - 0.03, depth),
      getMaterial('woodDark')
    );
    block.position.set((i - 1) * (width / 2 - 0.06), (h - 0.03) / 2, 0);
    group.add(block);
  }

  setShadows(group.children[0], false, true);
  return group;
}

// ── 13. Pallet with Crates ────────────────────────────────────────────────

export function createPalletWithCrates(rng) {
  const group = new THREE.Group();
  const pallet = createPallet();
  group.add(pallet);

  const count = 1 + Math.floor(rng() * 2);
  const size = 0.5 + rng() * 0.3;
  for (let i = 0; i < count; i++) {
    const c = createCrate(size, rng() > 0.5 ? 'wood' : 'plastic');
    c.position.set((i - (count - 1) / 2) * (size + 0.05), 0.12, 0);
    group.add(c);
  }
  return group;
}

// ── 14. Forklift ──────────────────────────────────────────────────────────

export function createForklift() {
  const group = new THREE.Group();

  // Body
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.6, 2.0),
    getMaterial('caution')
  );
  body.position.set(0, 1.0, 0);
  setShadows(body);
  group.add(body);

  // Roof
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(1.3, 0.08, 2.1),
    getMaterial('metalDark')
  );
  roof.position.set(0, 1.85, 0);
  group.add(roof);

  // Roof posts (4)
  for (const x of [-0.55, 0.55]) {
    for (const z of [-0.9, 0.9]) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6),
        getMaterial('metalDark')
      );
      post.position.set(x, 1.4, z);
      group.add(post);
    }
  }

  // Mast
  const mast = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 2.4, 0.1),
    getMaterial('metalDark')
  );
  mast.position.set(0, 1.2, -1.1);
  group.add(mast);

  // Fork arms
  for (const x of [-0.35, 0.35]) {
    const fork = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.06, 1.2),
      getMaterial('metalDark')
    );
    fork.position.set(x, 0.1, -1.6);
    group.add(fork);
  }

  // Wheels (4 cylinders)
  for (const x of [-0.55, 0.55]) {
    for (const z of [-0.7, 0.6]) {
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.2, 0.15, 8),
        getMaterial('cautionStripe')
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.2, z);
      group.add(wheel);
    }
  }

  return group;
}

// ── 15. Overhead Light ────────────────────────────────────────────────────

export function createOverheadLight(y = 3.4, intensity = 2) {
  const group = new THREE.Group();

  // Fixture housing
  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.08, 0.3),
    getMaterial('lightFixture')
  );
  housing.position.y = y;
  group.add(housing);

  // Diffuser (glowing panel underneath)
  const diffuser = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.02, 0.22),
    getMaterial('lightGlow')
  );
  diffuser.position.y = y - 0.05;
  group.add(diffuser);

  // PointLight — no shadows to avoid exceeding MAX_TEXTURE_IMAGE_UNITS
  const light = new THREE.PointLight(0xfff8e8, intensity, 14, 1.5);
  light.position.set(0, y - 0.06, 0);
  light.castShadow = false;
  group.add(light);

  // Store reference for flicker control
  group.userData.light = light;
  group.userData.diffuser = diffuser;

  return group;
}

// ── 16. Emergency Light ───────────────────────────────────────────────────

export function createEmergencyLight() {
  const group = new THREE.Group();

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.12, 0.08),
    getMaterial('red')
  );
  group.add(box);

  const light = new THREE.PointLight(0xff2222, 0.3, 6);
  light.position.set(0, 0, 0.06);
  group.add(light);

  group.userData.light = light;
  return group;
}

// ── 17. Traffic Cone ──────────────────────────────────────────────────────

export function createCone() {
  const group = new THREE.Group();
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.15, 0.5, 8),
    getMaterial('caution')
  );
  cone.position.y = 0.25;
  setShadows(cone);
  group.add(cone);

  // Base
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(0.35, 0.04, 0.35),
    getMaterial('cautionStripe')
  );
  base.position.y = 0.02;
  group.add(base);
  return group;
}

// ── Cover Composition Factory ─────────────────────────────────────────────

/**
 * Creates a random cover composition based on a type string.
 * Returns { group, bounds } where bounds is { x, z } extents for placement checking.
 */
export function createCoverComposition(type, rng) {
  let group;
  let bounds;

  switch (type) {
    case 'crate_stack':
      group = createCrateStack(rng);
      bounds = { x: 2.2, z: 1.5 };
      break;
    case 'barrel_cluster':
      group = createBarrelCluster(rng);
      bounds = { x: 1.6, z: 1.6 };
      break;
    case 'shelf':
      group = createShelfUnit(1.5 + rng() * 1.0, 2.0 + rng() * 0.5);
      bounds = { x: 2.5, z: 0.8 };
      break;
    case 'half_wall':
      group = createHalfWall(2.0 + rng() * 2.0);
      bounds = { x: 4, z: 0.4 };
      break;
    case 'pallet':
      group = createPalletWithCrates(rng);
      bounds = { x: 1.5, z: 1.2 };
      break;
    case 'forklift':
      group = createForklift();
      bounds = { x: 1.5, z: 3.0 };
      break;
    case 'barrel_cone':
      group = new THREE.Group();
      const b = createBarrel(0.35, 1.0, rng() > 0.5 ? 'caution' : 'metalDark');
      const c = createCone();
      c.position.set(0.6, 0, 0.3);
      group.add(b, c);
      bounds = { x: 1.2, z: 1.0 };
      break;
    default:
      group = createCrate(1.0);
      bounds = { x: 1.2, z: 1.2 };
  }

  return { group, bounds };
}

// ── Cover Type Picker ─────────────────────────────────────────────────────

const COVER_TYPES = [
  { type: 'crate_stack',    weight: 0.35 },
  { type: 'barrel_cluster', weight: 0.20 },
  { type: 'shelf',          weight: 0.15 },
  { type: 'half_wall',      weight: 0.10 },
  { type: 'pallet',         weight: 0.10 },
  { type: 'forklift',       weight: 0.05 },
  { type: 'barrel_cone',    weight: 0.05 },
];

export function pickCoverType(rng) {
  let roll = rng();
  for (const entry of COVER_TYPES) {
    roll -= entry.weight;
    if (roll <= 0) return entry.type;
  }
  return 'crate_stack';
}
