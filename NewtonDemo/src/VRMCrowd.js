import * as THREE from 'three';
import { NPC } from './NPC.js';
import { VRM_POOL } from './character-loader.js';

const CROWD_COUNT = 80;      // one of every avatar, roughly
const SPREAD = 28;
const SMASH_LINGER = 2.0;
const SPAWN_INTERVAL = 80;   // ms between each NPC spawn — stagger loads

export class VRMCrowd {
  constructor(scene) {
    this.scene = scene;
    this.npcs = [];
    this._smashPos = new THREE.Vector3(9999, 0, 9999);
    this._smashTimer = 0;

    // Shuffle the full pool so we get variety
    const shuffled = [...VRM_POOL].sort(() => Math.random() - 0.5);

    // Stagger spawns — each NPC creation triggers an async VRM load
    // Spawning all 80 at once would fire 80 concurrent fetches
    for (let i = 0; i < CROWD_COUNT; i++) {
      const type = shuffled[i % shuffled.length];
      const angle = (i / CROWD_COUNT) * Math.PI * 2 + Math.random() * 0.5;
      const r = 6 + Math.random() * SPREAD;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;

      setTimeout(() => {
        this.npcs.push(new NPC(scene, type, x, z));
      }, i * SPAWN_INTERVAL);
    }
  }

  smash(pos) {
    this._smashPos.set(pos[0], 0, pos[2]);
    this._smashTimer = SMASH_LINGER;
  }

  update(delta) {
    this._smashTimer = Math.max(0, this._smashTimer - delta);
    const fleeActive = this._smashTimer > 0;
    const clawPos = fleeActive ? this._smashPos : new THREE.Vector3(9999, 0, 9999);

    for (const npc of this.npcs) {
      npc.update(delta, clawPos, false, { flee: fleeActive });
    }
  }
}
