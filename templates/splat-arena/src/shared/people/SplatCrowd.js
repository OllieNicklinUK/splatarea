import * as THREE from 'three';
import { NPC } from './NPC.js';
import { VRM_POOL } from './character-loader.js';

const CROWD_COUNT    = 20;
const SPAWN_INTERVAL = 80;   // ms between spawns — staggers VRM fetches
const FLEE_RADIUS    = 5.0;
const SCATTER_LINGER = 2.5;  // seconds flee mode stays active after a click

// Crowd of walking NPCs distributed across a splat bounding box.
// Call crowd.scatter(worldPos) to make NPCs near that point flee briefly.
export class SplatCrowd {
  constructor(scene, box, floorY, voxelMesh = null, spawnCenter = null, spawnRadius = null) {
    this.scene      = scene;
    this.npcs       = [];
    this._voxelMesh = voxelMesh;
    this._fleePos   = new THREE.Vector3(99999, 0, 99999);
    this._fleeTimer = 0;

    const pad  = 1.5;
    const minX = box.min.x + pad;
    const maxX = box.max.x - pad;
    const minZ = box.min.z + pad;
    const maxZ = box.max.z - pad;

    // Spawn centre and radius — if not provided, use bbox centre with 40% of shorter side
    const cx = spawnCenter ? spawnCenter.x : (box.min.x + box.max.x) / 2;
    const cz = spawnCenter ? spawnCenter.z : (box.min.z + box.max.z) / 2;
    const sr = spawnRadius ?? Math.max(2, Math.min(maxX - minX, maxZ - minZ) * 0.4);

    const shuffled = [...VRM_POOL].sort(() => Math.random() - 0.5);

    for (let i = 0; i < CROWD_COUNT; i++) {
      const type = shuffled[i % shuffled.length];
      // Uniform distribution within spawn circle (sqrt gives uniform density)
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * sr;
      const px = THREE.MathUtils.clamp(cx + Math.cos(angle) * r, minX, maxX);
      const pz = THREE.MathUtils.clamp(cz + Math.sin(angle) * r, minZ, maxZ);

      setTimeout(() => {
        const npc = new NPC(scene, type, px, pz, {
          floorY,
          minX, maxX, minZ, maxZ,
          voxelMesh: this._voxelMesh,
        });
        this.npcs.push(npc);
      }, i * SPAWN_INTERVAL);
    }
  }

  // Swap in the voxel collision mesh once it finishes generating
  setVoxelMesh(mesh) {
    this._voxelMesh = mesh;
    for (const npc of this.npcs) npc.setVoxelMesh(mesh);
  }

  // Trigger flee behaviour centred on a world-space XZ point
  scatter(worldPos) {
    this._fleePos.set(worldPos.x, 0, worldPos.z);
    this._fleeTimer = SCATTER_LINGER;
  }

  update(delta) {
    this._fleeTimer = Math.max(0, this._fleeTimer - delta);
    const fleeActive = this._fleeTimer > 0;
    const clawPos = fleeActive ? this._fleePos : new THREE.Vector3(99999, 0, 99999);

    for (const npc of this.npcs) {
      npc.update(delta, clawPos, false, { flee: fleeActive, fleeRadius: FLEE_RADIUS });
    }
  }

  destroy() {
    for (const npc of this.npcs) npc.destroy();
    this.npcs = [];
  }
}
