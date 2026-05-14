import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { PhysicsClient } from './ws-client.js';
import { ParticleRenderer, SmashRing } from './renderer.js';
import { VRMCrowd } from './VRMCrowd.js';

// ── Scene setup ──

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050810);
scene.fog = new THREE.FogExp2(0x050810, 0.018);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 300);
camera.position.set(0, 18, 32);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2.1;
controls.target.set(0, 3, 0);

// ── Lighting ──

const ambient = new THREE.AmbientLight(0x112244, 1.5);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xffeedd, 3);
sun.position.set(15, 30, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 100;
sun.shadow.camera.left = sun.shadow.camera.bottom = -30;
sun.shadow.camera.right = sun.shadow.camera.top = 30;
scene.add(sun);

const fill = new THREE.DirectionalLight(0x4466ff, 0.8);
fill.position.set(-10, 5, -10);
scene.add(fill);

// ── Ground ──

const groundGeo = new THREE.PlaneGeometry(80, 80, 20, 20);
const groundMat = new THREE.MeshStandardMaterial({
  color: 0x0a0f1a,
  roughness: 0.9,
  metalness: 0.1,
});
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Grid overlay
const grid = new THREE.GridHelper(80, 40, 0x1a2a4a, 0x0d1525);
grid.position.y = 0.01;
scene.add(grid);

// ── Physics renderers ──

const particles = new ParticleRenderer(scene, 5000);
const crowd = new VRMCrowd(scene);
const smashRing = new SmashRing(scene);

// ── Status UI ──

const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');

function setStatus(mode, text) {
  dot.className = 'dot ' + mode;
  statusText.textContent = text;
}

// ── Physics client ──

const client = new PhysicsClient({
  onState: (msg) => {
    if (msg.particles) particles.update(msg.particles);
    // VRM crowd is driven by Three.js NPC logic — not server agent positions
  },
  onConnect: () => setStatus('connected', 'Newton physics — live'),
  onDisconnect: () => setStatus('mock', 'Server offline — reconnecting...'),
});

setStatus('', 'Connecting to Newton server...');

// ── Click to smash ──

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const smashPoint = new THREE.Vector3();

renderer.domElement.addEventListener('click', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.ray.intersectPlane(groundPlane, smashPoint)) {
    const pos = [smashPoint.x, smashPoint.y, smashPoint.z];
    client.smash(pos, params.smashRadius, params.smashForce);
    crowd.smash(pos);
    smashRing.trigger(pos);
  }
});

// ── GUI ──

const params = {
  smashRadius: 3.0,
  smashForce: 60.0,
  reset: () => client.reset(),
};

const gui = new GUI({ title: 'Newton Demo' });
gui.add(params, 'smashRadius', 1, 8, 0.5).name('Smash Radius');
gui.add(params, 'smashForce', 10, 150, 5).name('Smash Force');
gui.add(params, 'reset').name('Reset Simulation');

// ── Resize ──

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ── Loop ──

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  controls.update();
  crowd.update(dt);
  smashRing.tick(dt);
  renderer.render(scene, camera);
}

animate();
