import * as THREE from 'three';
import { initArena } from './arena-loader.js';
import { createPeopleGame } from './people-game.js';

const canvas    = document.getElementById('viewport');
const colStatus = document.getElementById('collider-status');

function setStatus(msg) {
  const el = document.getElementById('load-status');
  if (el) el.textContent = msg;
  if (colStatus) { colStatus.textContent = msg; colStatus.style.display = 'block'; }
}

let game      = null;
let clock     = null;
let voxelMesh = null;

initArena({
  config: window.GAME_CONFIG,
  game:   'people',
  canvas,
  onStatus: setStatus,

  onSplatReady({ scene, camera, renderer, controls, box, floorY, spawnCenter, spawnRadius }) {
    if (game) { game.dispose(); game = null; }
    game = createPeopleGame({
      scene, camera, controls, box, floorY, voxelMesh,
      spawnCenter: spawnCenter ?? null,
      spawnRadius: spawnRadius ?? null,
    });
    if (colStatus) colStatus.style.display = 'none';
    if (!clock) {
      clock = new THREE.Clock();
      (function loop() {
        requestAnimationFrame(loop);
        game?.update(Math.min(clock.getDelta(), 0.1));
        renderer.render(scene, camera);
      })();
    }
  },

  onColliderReady({ voxelMesh: vm }) {
    voxelMesh = vm;
    game?.setVoxelMesh(vm);
    if (colStatus) {
      colStatus.textContent = '✓ Collision ready';
      setTimeout(() => { if (colStatus) colStatus.style.display = 'none'; }, 2000);
    }
  },
});
