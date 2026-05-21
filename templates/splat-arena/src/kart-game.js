// kart-game.js
// Kart game integrated into a Gaussian Splat environment.
// The track is procedurally generated from the splat's collision mesh.
// The splat IS the level — no background decorations, no pre-built track tiles.

import * as THREE from 'three';
import {
  createWorldSettings, createWorld,
  addBroadphaseLayer, addObjectLayer,
  enableCollision, registerAll, updateWorld,
  rigidBody, box as physBox, MotionType,
} from 'crashcat';

import { Vehicle, MAX_SPEED }       from './kart/Vehicle.js';
import { Camera }                    from './kart/Camera.js';
import { Controls }                  from './kart/Controls.js';
import { createSphereBody }          from './kart/Physics.js';
import { SmokeTrails }               from './kart/Particles.js';
import { DriftMarks }                from './kart/DriftMarks.js';
import { GameAudio }                 from './kart/Audio.js';
import { ColorMapGLTFLoader }        from './kart/Loader.js';

const MODEL_NAMES = [ 'vehicle-truck-yellow' ];

export async function createKartGame( {
  scene,
  camera: arenaCamera,
  renderer,
  controls: orbitControls,
  boundingBox,
  floorY,
} ) {

  // Disable orbit controls — kart takes over the camera
  orbitControls.enabled = false;

  // ── Load vehicle model ───────────────────────────────────────────────────────
  const loader = new ColorMapGLTFLoader();
  const models = {};

  await Promise.all( MODEL_NAMES.map( ( name ) =>
    new Promise( ( resolve, reject ) => {

      loader.load( `/kart/models/${ name }.glb`, ( gltf ) => {

        const meshes = [];
        gltf.scene.traverse( ( child ) => {

          if ( child.isMesh ) {

            child.material.side = THREE.FrontSide;
            meshes.push( child );

          }

        } );

        if ( name.startsWith( 'vehicle-' ) ) gltf.scene.scale.setScalar( 0.5 );

        models[ name ] = meshes.length === 1
          ? ( meshes[ 0 ].removeFromParent(), meshes[ 0 ] )
          : gltf.scene;

        resolve();

      }, undefined, reject );

    } )
  ) );

  // ── Crashcat physics world ───────────────────────────────────────────────────
  registerAll();

  const worldSettings = createWorldSettings();
  worldSettings.gravity = [ 0, - 9.81, 0 ];

  const BPL_MOVING = addBroadphaseLayer( worldSettings );
  const BPL_STATIC = addBroadphaseLayer( worldSettings );
  const OL_MOVING  = addObjectLayer( worldSettings, BPL_MOVING );
  const OL_STATIC  = addObjectLayer( worldSettings, BPL_STATIC );

  enableCollision( worldSettings, OL_MOVING, OL_STATIC );
  enableCollision( worldSettings, OL_MOVING, OL_MOVING );

  const world = createWorld( worldSettings );
  world._OL_MOVING = OL_MOVING;
  world._OL_STATIC = OL_STATIC;

  // ── Large flat floor at floorY ───────────────────────────────────────────────
  let groundCX = 0;
  let groundCZ = 0;
  let groundHW = 150;

  if ( boundingBox && ! boundingBox.isEmpty() ) {

    const bSize   = boundingBox.getSize( new THREE.Vector3() );
    const bCenter = boundingBox.getCenter( new THREE.Vector3() );
    groundHW = Math.max( bSize.x, bSize.z ) / 2 + 30;
    groundCX = bCenter.x;
    groundCZ = bCenter.z;

  }

  rigidBody.create( world, {
    shape: physBox.create( { halfExtents: [ groundHW, 0.125, groundHW ] } ),
    motionType: MotionType.STATIC,
    objectLayer: OL_STATIC,
    position:   [ groundCX, floorY - 0.125, groundCZ ],
    friction:    5.0,
    restitution: 0.0,
  } );

  // ── Player vehicle — initial spawn at floor centre ───────────────────────────
  const spawnOrigin = new THREE.Vector3( groundCX, floorY + 0.5, groundCZ );

  const sphereBody = createSphereBody( world, [ spawnOrigin.x, spawnOrigin.y, spawnOrigin.z ] );

  const vehicle = new Vehicle( spawnOrigin );
  vehicle.rigidBody    = sphereBody;
  vehicle.physicsWorld = world;

  vehicle.spherePos.copy( spawnOrigin );
  vehicle.prevModelPos.set( spawnOrigin.x, spawnOrigin.y - 0.5, spawnOrigin.z );

  const vehicleGroup = vehicle.init( models[ 'vehicle-truck-yellow' ] );
  scene.add( vehicleGroup );

  // ── Camera ───────────────────────────────────────────────────────────────────
  const cam = new Camera();
  scene.add( cam.debug );

  const _onResize = () => {

    cam.camera.aspect = renderer.domElement.clientWidth / renderer.domElement.clientHeight;
    cam.camera.updateProjectionMatrix();

  };
  window.addEventListener( 'resize', _onResize );

  // Reuse arena-loader's existing directional light
  const sun = scene.children.find( c => c.isDirectionalLight ) || new THREE.DirectionalLight( 0xffd5a0, 1.3 );
  if ( ! sun.parent ) scene.add( sun );

  // ── Controls ─────────────────────────────────────────────────────────────────
  const controls = new Controls();

  // ── Effects ──────────────────────────────────────────────────────────────────
  const particles  = new SmokeTrails( scene );
  const driftMarks = new DriftMarks( scene, null );

  // ── Audio ────────────────────────────────────────────────────────────────────
  const audio = new GameAudio();
  audio.init( cam.camera );

  // ── HUD ──────────────────────────────────────────────────────────────────────
  const speedEl = document.getElementById( 'kart-speed' );
  const hintEl  = document.getElementById( 'kart-hint' );
  if ( hintEl ) hintEl.textContent = 'WASD / Arrows to drive';

  // ── Contact listener for impact sounds ───────────────────────────────────────
  const _fwd = new THREE.Vector3();
  const contactListener = {

    onContactAdded( bodyA, bodyB ) {

      if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;
      _fwd.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
      _fwd.y = 0;
      _fwd.normalize();
      const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _fwd ) );
      audio.playImpact( impactVelocity );

    },

  };

  // ── Game loop ─────────────────────────────────────────────────────────────────
  const timer    = new THREE.Timer();
  const _camLead = new THREE.Vector3();
  const _mv      = new THREE.Vector3();

  let disposed = false;

  function animate() {

    if ( disposed ) return;
    requestAnimationFrame( animate );

    timer.update();
    const dt = Math.min( timer.getDelta(), 1 / 30 );

    const input = controls.update();

    updateWorld( world, contactListener, dt );

    vehicle.update( dt, input );

    // Move sun to follow vehicle
    sun.position.set(
      vehicle.spherePos.x + 11.4,
      floorY + 15,
      vehicle.spherePos.z - 5.3,
    );
    sun.target = vehicleGroup;

    // Update camera
    _mv.copy( vehicle.modelVelocity );
    _camLead.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion )
      .multiplyScalar( Math.sqrt( _mv.x * _mv.x + _mv.z * _mv.z ) );
    cam.update( dt, vehicle.spherePos, _camLead );

    particles.update( dt, vehicle );
    driftMarks.update( dt, vehicle );
    audio.update( dt, vehicle.linearSpeed / MAX_SPEED, input.z, vehicle.driftIntensity );

    if ( speedEl ) {

      const kmh = Math.round( Math.abs( vehicle.linearSpeed ) * MAX_SPEED * 25 );
      speedEl.textContent = `${ kmh } km/h`;

    }

    renderer.render( scene, cam.camera );

  }

  animate();

  // ── Public API ───────────────────────────────────────────────────────────────
  return {

    setVoxelMesh( _voxelMesh ) {

      if ( hintEl ) hintEl.textContent = 'WASD / Arrows to drive';

    },

    dispose() {

      disposed = true;
      window.removeEventListener( 'resize', _onResize );

    },

  };

}
