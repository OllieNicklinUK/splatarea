import { initArena } from './arena-loader.js';
import { createKartGame } from './kart-game.js';

const canvas   = document.getElementById( 'viewport' );
const statusEl = document.getElementById( 'load-status' );
const loading  = document.getElementById( 'loading' );
const kartHud  = document.getElementById( 'kart-hud' );

let game = null;

initArena( {
  config: window.GAME_CONFIG,
  game:   'kart',
  canvas,
  onStatus: ( msg ) => { if ( statusEl ) statusEl.textContent = msg; },

  async onSplatReady( { scene, camera, renderer, controls, box, floorY } ) {

    if ( loading ) {

      loading.style.transition = 'opacity 0.6s ease';
      loading.classList.add( 'hidden' );

    }

    if ( kartHud ) kartHud.style.display = 'flex';

    game = await createKartGame( {
      scene,
      camera,
      renderer,
      controls,
      boundingBox: box,
      floorY,
    } );

  },

  onColliderReady( { voxelMesh } ) {

    if ( game ) game.setVoxelMesh( voxelMesh );

  },
} );
