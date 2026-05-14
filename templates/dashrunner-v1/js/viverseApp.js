import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { VIVERSE_CONFIG } from './viverseConfig.js';
import { ViverseAuthController } from './viverseAuth.js';
import { ViverseLeaderboardController } from './viverseLeaderboard.js';
import { ViverseMultiplayerController } from './viverseMultiplayer.js';
import { LocalPlayer } from './game/LocalPlayer.js';
import { ViverseRemotePlayer } from './viverseRemotePlayer.js';
import { ParticleBurst, ScreenShake } from './effects/VisualEffects.js';

/**
 * VIVERSE Template Platform Engine (App.js)
 * 
 * This is the HIGH-RISK core of the template. It handles:
 * - Three.js Renderer/Scene/Camera lifecycle
 * - VIVERSE Auth & Profile management
 * - VIVERSE Multiplayer Syncing
 * - Main Loop coordination
 */
export class ViverseApp {
    constructor() {
        this.isRunning = false;
        this.isPaused = false;
        
        // Platform Controllers
        this.auth = new ViverseAuthController();
        this.leaderboard = null;
        this.multiplayer = new ViverseMultiplayerController();
        
        // Three.js Core
        this.initRenderer();
        this.initScene();
        this.initPostProcessing();
        
        // Players
        this.player = new LocalPlayer(this.scene);
        this.remotePlayer = new ViverseRemotePlayer(this.scene);
        this.remotePlayer.setVisible(false);
        this.particleBurst = new ParticleBurst(this.scene);
        this.screenShake = new ScreenShake(this.camera);

        // Gameplay Hook (to be injected)
        this.gameplay = null;

        this.clock = new THREE.Clock();
        this.animate = this.animate.bind(this);
        
        window.addEventListener('resize', () => this.onResize());
        this.animate();
    }

    initRenderer() {
        this.canvas = document.getElementById('game-canvas');
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.8;
    }

    initScene() {
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog(0x87ceeb, 50, 150);
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
        this.camera.position.set(0, 5, -8);
        this.camera.lookAt(0, 2, 20);

        // Shared world curvature (can be adjusted by gameplay)
        this.curvedWorldUniforms = {
            uCurvature: { value: 0.008 },
            uDistance: { value: 100.0 }
        };

        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        this.scene.add(this.ambientLight);

        this.sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
        this.sunLight.position.set(20, 30, 10);
        this.sunLight.castShadow = true;
        this.scene.add(this.sunLight);

        this.fillLight = new THREE.DirectionalLight(0x87ceeb, 0.4);
        this.fillLight.position.set(-10, 10, -10);
        this.scene.add(this.fillLight);

        this.rimLight = new THREE.DirectionalLight(0xffd700, 0.3);
        this.rimLight.position.set(0, 5, 30);
        this.scene.add(this.rimLight);
    }

    initPostProcessing() {
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.4, 0.85);
        this.composer.addPass(this.bloomPass);
    }

    injectGameplay(gameplayModule) {
        this.gameplay = gameplayModule;
        if (this.gameplay.onInject) this.gameplay.onInject(this);
    }

    async boot() {
        const ready = await this.auth.initialize();
        if (ready) {
            const loggedIn = await this.auth.checkAuth();
            if (loggedIn) {
                if (this.auth.avatarUrl) {
                    await this.player.loadAvatar(this.auth.avatarUrl);
                }
                await this.multiplayer.initialize(this.auth);
                this.leaderboard = new ViverseLeaderboardController(this.auth.accessToken);
                await this.leaderboard.initialize();
            }
        }
        return true;
    }

    start() {
        this.isRunning = true;
        this.isPaused = false;
        this.isGameOver = false;
        this.clock.start();
        if (this.gameplay?.onStart) this.gameplay.onStart();
    }

    restart() {
        this.start();
    }

    pause() {
        this.isPaused = true;
        this.clock.stop();
    }

    resume() {
        this.isPaused = false;
        this.clock.start();
    }

    endRun(finalScore = 0) {
        this.isRunning = false;
        this.isGameOver = true;
        if (typeof this.onGameOver === 'function') {
            this.onGameOver(finalScore);
        }
    }

    update(deltaTime) {
        if (!this.isRunning || this.isPaused) return;

        // The gameplay module owns local player simulation order so it can stay
        // consistent with the original DashRunner loop.
        this.remotePlayer.update(deltaTime);
        if (this.particleBurst) this.particleBurst.update(deltaTime);
        if (this.screenShake) this.screenShake.update(deltaTime);

        // Gameplay Hook Update
        if (this.gameplay?.onUpdate) {
            this.gameplay.onUpdate(deltaTime);
        }

        // Multiplayer Sync
        if (this.multiplayer.isConnected && this.isRunning) {
            this.multiplayer.broadcast({
                type: "player_sync",
                pos: this.player.mesh.position.toArray(),
                rot: this.player.mesh.quaternion.toArray()
            });
        }
    }

    animate() {
        requestAnimationFrame(this.animate);
        const dt = Math.min(this.clock.getDelta(), 0.1);
        this.update(dt);
        this.composer.render();
    }

    onResize() {
        const w = window.innerWidth, h = window.innerHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.composer.setSize(w, h);
    }
}
