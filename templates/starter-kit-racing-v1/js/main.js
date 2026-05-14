import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer, enableCollision, registerAll, updateWorld, rigidBody, box, MotionType } from 'crashcat';
import { Vehicle } from './Vehicle.js';
import { Camera } from './Camera.js';
import { Controls } from './Controls.js';
import { buildTrack, decodeCells, computeSpawnPosition, computeTrackBounds, encodeCells } from './Track.js';
import { buildWallColliders, createSphereBody } from './Physics.js';
import { SmokeTrails } from './Particles.js';
import { GameAudio } from './Audio.js';
import { VIVERSE_CONFIG } from './viverseConfig.js';
import { ViverseAuthController } from './ViverseAuthController.js';
import { LeaderboardPanel } from './LeaderboardPanel.js';
import { RaceManager } from './RaceManager.js';
import { generateRandomLoopCells } from './randomLoop.js';


const renderer = new THREE.WebGLRenderer( { antialias: true, outputBufferType: THREE.HalfFloatType } );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( window.devicePixelRatio );
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const bloomPass = new UnrealBloomPass( new THREE.Vector2( window.innerWidth, window.innerHeight ) );
bloomPass.strength = 0.02;
bloomPass.radius = 0.02;
bloomPass.threshold = 0.5;

renderer.setEffects( [ bloomPass ] );

document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0xadb2ba );
scene.fog = new THREE.Fog( 0xadb2ba, 30, 55 );

const dirLight = new THREE.DirectionalLight( 0xffffff, 5 );
dirLight.position.set( 11.4, 15, -5.3 );
dirLight.castShadow = true;
dirLight.shadow.mapSize.setScalar( 4096 );
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 60;
scene.add( dirLight );

const hemiLight = new THREE.HemisphereLight( 0xc8d8e8, 0x7a8a5a, 1.5 );
scene.add( hemiLight );


window.addEventListener( 'resize', () => {

	renderer.setSize( window.innerWidth, window.innerHeight );

} );

const loader = new GLTFLoader();
const modelNames = [
	'vehicle-truck-yellow', 'vehicle-truck-green', 'vehicle-truck-purple', 'vehicle-truck-red',
	'track-straight', 'track-corner', 'track-bump', 'track-finish',
	'decoration-empty', 'decoration-forest', 'decoration-tents',
];

const models = {};

async function loadModels() {

	const promises = modelNames.map( ( name ) =>
		new Promise( ( resolve, reject ) => {

			loader.load( `models/${ name }.glb`, ( gltf ) => {

				gltf.scene.traverse( ( child ) => {

					if ( child.isMesh ) {

						child.material.side = THREE.FrontSide;

					}

				} );

				// Godot imports vehicle models at root_scale=0.5
				if ( name.startsWith( 'vehicle-' ) ) {

					gltf.scene.scale.setScalar( 0.5 );

				}

				models[ name ] = gltf.scene;
				resolve();

			}, undefined, reject );

		} )
	);

	await Promise.all( promises );

}

async function init() {

	registerAll();
	await loadModels();

	const authRoot = document.getElementById( 'auth-root' );
	const leaderboardRoot = document.getElementById( 'leaderboard-root' );
	const raceHudTime = document.getElementById( 'race-time' );
	const raceHudLap = document.getElementById( 'race-lap' );
	const raceHudStatus = document.getElementById( 'race-status' );
	const resultRoot = document.getElementById( 'result-root' );
	const resultTime = document.getElementById( 'result-time' );
	const resultScore = document.getElementById( 'result-score' );
	const resultAction = document.getElementById( 'result-action' );
	const appIdNode = document.getElementById( 'viverse-appid' );
	const leaderboardNameNode = document.getElementById( 'leaderboard-name' );
	const randomMapButton = document.getElementById( 'random-map-button' );
	const mapModeNode = document.getElementById( 'map-mode' );

	if ( appIdNode ) appIdNode.textContent = VIVERSE_CONFIG.clientId || 'missing';
	if ( leaderboardNameNode ) leaderboardNameNode.textContent = VIVERSE_CONFIG.leaderboardName;

	const mapParam = new URLSearchParams( window.location.search ).get( 'map' );
	let customCells = null;
	let spawn = null;

	if ( mapParam ) {

		try {

			customCells = decodeCells( mapParam );
			spawn = computeSpawnPosition( customCells );

		} catch ( e ) {

			console.warn( 'Invalid map parameter, using default track' );

		}

	}

	if ( mapModeNode ) mapModeNode.textContent = customCells ? 'Random / Custom Loop' : 'Default Loop';

	// Compute track bounds and size physics/shadows to fit
	const bounds = computeTrackBounds( customCells );
	const hw = bounds.halfWidth;
	const hd = bounds.halfDepth;
	const groundSize = Math.max( hw, hd ) * 2 + 20;

	const shadowExtent = Math.max( hw, hd ) + 10;
	dirLight.shadow.camera.left = - shadowExtent;
	dirLight.shadow.camera.right = shadowExtent;
	dirLight.shadow.camera.top = shadowExtent;
	dirLight.shadow.camera.bottom = - shadowExtent;
	dirLight.shadow.camera.updateProjectionMatrix();

	scene.fog.near = groundSize * 0.4;
	scene.fog.far = groundSize * 0.8;

	buildTrack( scene, models, customCells );


	const worldSettings = createWorldSettings();
	worldSettings.gravity = [ 0, - 9.81, 0 ];

	const BPL_MOVING = addBroadphaseLayer( worldSettings );
	const BPL_STATIC = addBroadphaseLayer( worldSettings );
	const OL_MOVING = addObjectLayer( worldSettings, BPL_MOVING );
	const OL_STATIC = addObjectLayer( worldSettings, BPL_STATIC );

	enableCollision( worldSettings, OL_MOVING, OL_STATIC );
	enableCollision( worldSettings, OL_MOVING, OL_MOVING );

	const world = createWorld( worldSettings );
	world._OL_MOVING = OL_MOVING;
	world._OL_STATIC = OL_STATIC;

	buildWallColliders( world, null, customCells );

	const roadHalf = groundSize / 2;
	rigidBody.create( world, {
		shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
		motionType: MotionType.STATIC,
		objectLayer: OL_STATIC,
		position: [ bounds.centerX, - 0.125, bounds.centerZ ],
		friction: 5.0,
		restitution: 0.0,
	} );

	const sphereBody = createSphereBody( world, spawn ? spawn.position : null );

	const vehicle = new Vehicle();
	vehicle.rigidBody = sphereBody;
	vehicle.physicsWorld = world;
	if ( spawn ) vehicle.setSpawn( new THREE.Vector3( ...spawn.position ), spawn.angle );

	if ( spawn ) {

		const [ sx, sy, sz ] = spawn.position;
		vehicle.spherePos.set( sx, sy, sz );
		vehicle.prevModelPos.set( sx, 0, sz );
		vehicle.container.rotation.y = spawn.angle;

	}

	const vehicleGroup = vehicle.init( models[ 'vehicle-truck-yellow' ] );
	scene.add( vehicleGroup );

	dirLight.target = vehicleGroup;

	const cam = new Camera();
	cam.targetPosition.copy( vehicle.spherePos );

	const controls = new Controls();
	let leaderboardPanel = null;
	const authController = new ViverseAuthController( {
		onStateChange: ( authState ) => {

			authRoot.innerHTML = `
				<div class="auth-card">
					<div class="auth-kicker">VIVERSE</div>
					<div class="auth-title">${ authState.profile?.displayName || 'Guest Driver' }</div>
					<div class="auth-meta">Status: ${ authState.status }${ authState.appId ? '' : ' · missing App ID' }</div>
					<div class="auth-actions">
						<button class="auth-button" type="button" data-action="${ authState.isAuthenticated ? 'logout' : 'login' }" ${ authState.status === 'detecting' || authState.status === 'handshaking' ? 'disabled' : '' }>${ authState.isAuthenticated ? 'Logout' : 'Login' }</button>
					</div>
					${ authState.error ? `<div class="auth-error">${ authState.error }</div>` : '' }
				</div>
			`;

			const button = authRoot.querySelector( '.auth-button' );
			if ( button ) {

				button.addEventListener( 'click', () => {

					if ( authState.isAuthenticated ) {

						authController.logout();

					} else {

						authController.login();

					}

				} );

			}

			if ( leaderboardPanel ) leaderboardPanel.render();

		}
	} );

	const particles = new SmokeTrails( scene );

	const audio = new GameAudio();
	audio.init( cam.camera );

	const _forward = new THREE.Vector3();

	const contactListener = {
		onContactAdded( bodyA, bodyB ) {

			if ( bodyA !== sphereBody && bodyB !== sphereBody ) return;

			_forward.set( 0, 0, 1 ).applyQuaternion( vehicle.container.quaternion );
			_forward.y = 0;
			_forward.normalize();

			const impactVelocity = Math.abs( vehicle.modelVelocity.dot( _forward ) );
			audio.playImpact( impactVelocity );

		}
	};

	const timer = new THREE.Timer();
	const raceManager = new RaceManager( {
		vehicle,
		cells: customCells,
		lapsToFinish: VIVERSE_CONFIG.lapsToFinish,
		onUpdate: ( raceState ) => {

			raceHudTime.textContent = raceState.displayTime;
			raceHudLap.textContent = `${ Math.min( raceState.lapCount, raceState.lapsToFinish ) } / ${ raceState.lapsToFinish }`;
			raceHudStatus.textContent = raceState.raceFinished ? 'Finished' : ( raceState.raceStarted ? 'Racing' : 'Ready' );

		},
		onFinish: ( result ) => {

			resultTime.textContent = result.displayTime;
			resultScore.textContent = String( result.scoreValue );
			resultRoot.hidden = false;
			if ( leaderboardPanel ) leaderboardPanel.setRaceResult( result );

		}
	} );

	leaderboardPanel = new LeaderboardPanel( {
		root: leaderboardRoot,
		authController,
		appId: VIVERSE_CONFIG.clientId,
		leaderboardName: VIVERSE_CONFIG.leaderboardName
	} );

	randomMapButton.addEventListener( 'click', () => {

		const url = new URL( window.location.href );
		const encoded = encodeCells( generateRandomLoopCells() );
		url.searchParams.set( 'map', encoded );
		window.location.replace( url.toString() );

	} );

	resultAction.addEventListener( 'click', () => {

		resultRoot.hidden = true;
		vehicle.resetToSpawn();
		raceManager.reset();

	} );

	window.addEventListener( 'keydown', ( event ) => {

		if ( event.code !== 'KeyR' ) return;
		event.preventDefault();
		resultRoot.hidden = true;
		vehicle.resetToSpawn();
		raceManager.reset();

	}, { passive: false } );

	authController.initialize();

	function animate() {

		requestAnimationFrame( animate );

		timer.update();
		const dt = Math.min( timer.getDelta(), 1 / 30 );

		const input = controls.update();

		updateWorld( world, contactListener, dt );

		vehicle.update( dt, input );
		raceManager.update( dt, input );

		dirLight.position.set(
			vehicle.spherePos.x + 11.4,
			15,
			vehicle.spherePos.z - 5.3
		);

		cam.update( dt, vehicle.spherePos );
		particles.update( dt, vehicle );
		audio.update( dt, vehicle.linearSpeed, input.z, vehicle.driftIntensity );

		renderer.render( scene, cam.camera );

	}

	animate();

}

init();
