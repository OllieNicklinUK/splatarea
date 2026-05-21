import * as THREE from 'three';
import { initArena } from './arena-loader.js';
import { createFPSGame } from './fps-game.js';

const canvas    = document.getElementById('viewport');
const colStatus = document.getElementById('collider-status');

function setStatus(msg) {
  const el = document.getElementById('load-status');
  if (el) el.textContent = msg;
  if (colStatus) { colStatus.textContent = msg; colStatus.style.display = 'block'; }
}

let game       = null;
let clock      = null;
let voxelMesh  = null;   // kept across game restarts

initArena({
  config: window.GAME_CONFIG,
  game:   'fps',
  canvas,
  onStatus: setStatus,

  onSplatReady({ scene, camera, renderer, controls, box, floorY }) {
    if (game) { game.dispose(); game = null; }
    game = createFPSGame({ scene, camera, canvas, box, floorY, voxelMesh });
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

  onColliderReady({ voxelMesh: vm, floorY }) {
    voxelMesh = vm;
    game?.setVoxelMesh(vm);
    game?.setFloorY(floorY);
    if (colStatus) {
      colStatus.textContent = '✓ Collision ready';
      setTimeout(() => { if (colStatus) colStatus.style.display = 'none'; }, 2000);
    }
  },
});
