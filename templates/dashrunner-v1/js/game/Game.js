/**
 * Game.js - Main Game Controller
 * Handles the game loop, scene setup, and coordination of all systems
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import { Player } from './Player.js';
import { Opponent } from './Opponent.js';
import { AIController } from './AIController.js';
import { InputHandler } from './InputHandler.js';
import { ObstacleManager } from './ObstacleManager.js';
import { CameraController } from './CameraController.js';
import { Environment } from './Environment.js';
import { ScoreManager } from './ScoreManager.js';
import { CollectibleManager } from './CollectibleManager.js';
import { ThemeManager } from './ThemeManager.js';
import { Chaser } from './Chaser.js';
import { BoostSystem } from './BoostSystem.js';
import { RandomEvents } from './RandomEvents.js';
import { CurvedWorldShader } from '../effects/CurvedWorldShader.js';
import { VignetteShader } from '../effects/VignetteShader.js';
import { SpeedLines, ParticleBurst, ScreenShake, DynamicSky } from '../effects/VisualEffects.js';
import { PRNG } from './PRNG.js';

export class Game {
    constructor() {
        // Game state
        this.isRunning = false;
        this.isPaused = false;
        this.isGameOver = false;

        // Game settings
        this.baseSpeed = 19.5; // 30% faster!
        this.currentSpeed = this.baseSpeed;
        this.maxSpeed = 52; // 30% faster max too!
        this.speedIncrement = 0.002;

        // Lives
        this.lives = 3;
        this.maxLives = 3;
        this.isInvulnerable = false;
        this.godMode = false; // Disabled for production leaderboard integration
        this.invulnerableTime = 2000; // ms

        // Wine slowdown effect
        this.wineSlowdownActive = false;
        this.wineSlowdownTimer = 0;
        this.wineSlowdownMultiplier = 0.5; // 50% speed during slowdown

        // Initialize Three.js
        this.initRenderer();
        this.initScene();
        this.initLighting();
        this.initPostProcessing();

        // Initialize game systems
        this.inputHandler = new InputHandler();
        this.player = new Player(this.scene, this.curvedWorldUniforms, false); // Normal player
        this.aiPlayer = new Player(this.scene, this.curvedWorldUniforms, true); // AI Clone
        this.aiPlayer.mesh.visible = false;

        this.opponent = new Opponent(this.scene, this.curvedWorldUniforms);
        this.opponent.mesh.visible = false; // Hide until multiplayer starts
        this.cameraController = new CameraController(this.camera, this.player);
        this.environment = new Environment(this.scene, this.curvedWorldUniforms);
        this.obstacleManager = new ObstacleManager(this.scene, this.curvedWorldUniforms);
        this.collectibleManager = new CollectibleManager(this.scene, this.curvedWorldUniforms);
        this.scoreManager = new ScoreManager();

        // Theme system
        this.themeManager = new ThemeManager(this);
        this.themeManager.setTheme('day'); // Default to bright daytime

        // Chaser (Crazy Nonna that follows you!)
        this.chaser = new Chaser(this.scene);

        // Visual Effects
        this.speedLines = new SpeedLines(this.scene);
        this.particleBurst = new ParticleBurst(this.scene);
        this.screenShake = new ScreenShake(this.camera);
        this.dynamicSky = new DynamicSky(this.scene);

        // Boost System
        this.boostSystem = new BoostSystem(this);

        // Random Events (cats, birds, etc.)
        this.randomEvents = new RandomEvents(this.scene);

        // Clock for delta time
        this.clock = new THREE.Clock();

        // Bind game loop
        this.gameLoop = this.gameLoop.bind(this);

        // Start render loop (but not game logic)
        this.animate();

        // Handle window resize
        window.addEventListener('resize', () => this.onResize());
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
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.8;
    }

    initScene() {
        this.scene = new THREE.Scene();

        // Gradient sky background
        const topColor = new THREE.Color(0x1a1a2e);
        const bottomColor = new THREE.Color(0x4a1942);

        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 256;
        const context = canvas.getContext('2d');
        const gradient = context.createLinearGradient(0, 0, 0, 256);
        gradient.addColorStop(0, '#1a1a2e');
        gradient.addColorStop(0.5, '#4a1942');
        gradient.addColorStop(1, '#C41E3A');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 2, 256);

        const skyTexture = new THREE.CanvasTexture(canvas);
        this.scene.background = skyTexture;

        // Fog for depth
        this.scene.fog = new THREE.Fog(0x4a1942, 30, 100);

        // Camera
        this.camera = new THREE.PerspectiveCamera(
            75,
            window.innerWidth / window.innerHeight,
            0.1,
            200
        );
        this.camera.position.set(0, 5, -8);
        this.camera.lookAt(0, 2, 20);

        // Curved world uniforms (shared across all materials)
        this.curvedWorldUniforms = {
            uCurvature: { value: 0.008 },
            uDistance: { value: 100.0 }
        };
    }

    initLighting() {
        // Ambient light
        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        this.scene.add(this.ambientLight);

        // Main directional light (sun)
        this.sunLight = new THREE.DirectionalLight(0xffd580, 1.2);
        this.sunLight.position.set(20, 30, 10);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.width = 2048;
        this.sunLight.shadow.mapSize.height = 2048;
        this.sunLight.shadow.camera.near = 0.5;
        this.sunLight.shadow.camera.far = 100;
        this.sunLight.shadow.camera.left = -30;
        this.sunLight.shadow.camera.right = 30;
        this.sunLight.shadow.camera.top = 30;
        this.sunLight.shadow.camera.bottom = -30;
        this.scene.add(this.sunLight);

        // Fill light (warm)
        this.fillLight = new THREE.DirectionalLight(0xff6b35, 0.3);
        this.fillLight.position.set(-10, 10, -10);
        this.scene.add(this.fillLight);

        // Rim light (cool)
        this.rimLight = new THREE.DirectionalLight(0x4a90d9, 0.4);
        this.rimLight.position.set(0, 5, 30);
        this.scene.add(this.rimLight);
    }

    initPostProcessing() {
        this.composer = new EffectComposer(this.renderer);

        // Render pass
        const renderPass = new RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);

        // Bloom pass
        this.bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            0.5,  // strength
            0.4,  // radius
            0.85  // threshold
        );
        this.composer.addPass(this.bloomPass);

        // Vignette pass
        this.vignettePass = new ShaderPass(VignetteShader);
        this.vignettePass.uniforms.darkness.value = 0.8;
        this.vignettePass.uniforms.offset.value = 1.2;
        this.composer.addPass(this.vignettePass);
    }

    start(isMultiplayer = false, seed = null, isAI = false) {
        this.isRunning = true;
        this.isPaused = false;
        this.isGameOver = false;
        this.currentSpeed = this.baseSpeed;
        this.lives = this.maxLives;
        this.isInvulnerable = false;
        this.isMultiplayer = isMultiplayer;
        this.networkSyncTimer = 0;
        this.isAI = isAI;

        if ((isMultiplayer || isAI) && seed != null) {
            this.prng = new PRNG(seed);
        } else {
            this.prng = null;
        }

        if (isMultiplayer && this.multiplayerService) {
            this.opponent.mesh.visible = true;
            this.opponent.reset();
            
            this.multiplayerService.onMessageReceived = (data) => {
                if (data.type === "player_sync") {
                    this.opponent.setNetworkTarget(data.x, data.y, data.z - this.scoreManager.distance);
                } else if (data.type === "seed") {
                    console.log(`🔗 Synchronizing Track Seed from Host: ${data.value}`);
                    this.prng = new PRNG(data.value);
                    this.environment.prng = this.prng;
                    this.obstacleManager.prng = this.prng;
                    this.collectibleManager.prng = this.prng;
                }
            };
        } else {
            this.opponent.mesh.visible = false;
        }

        if (isAI) {
            this.aiPlayer.mesh.visible = true;
            this.aiPlayer.reset();
            this.aiController = new AIController(this.aiPlayer, this.obstacleManager);
        } else {
            this.aiPlayer.mesh.visible = false;
        }

        this.environment.prng = this.prng;
        this.obstacleManager.prng = this.prng;
        this.collectibleManager.prng = this.prng;

        // Reset systems
        this.player.reset();
        this.obstacleManager.reset();
        this.collectibleManager.reset();
        this.scoreManager.reset();
        this.cameraController.reset();
        if (this.chaser) {
            this.chaser.reset();
        }

        // Reset visual effects
        if (this.speedLines) this.speedLines.reset();
        if (this.particleBurst) this.particleBurst.reset();
        if (this.screenShake) this.screenShake.reset();
        if (this.dynamicSky) this.dynamicSky.reset();

        // Reset boost and random events
        if (this.boostSystem) this.boostSystem.reset();
        if (this.randomEvents) this.randomEvents.reset();

        this.updateLivesUI();

        // Start clock
        this.clock.start();

        console.log(`🏃‍♀️ Game Started! (God Mode: ${this.godMode})`);
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

    gameOver() {
        this.isRunning = false;
        this.isGameOver = true;

        // Update final score
        const finalScore = this.scoreManager.score;
        document.getElementById('final-score').textContent = Math.floor(finalScore);

        // Check for high score
        const highScore = parseInt(localStorage.getItem('crazyNonnaHighScore') || 0);
        if (finalScore > highScore) {
            localStorage.setItem('crazyNonnaHighScore', Math.floor(finalScore));
            document.getElementById('high-score').textContent = Math.floor(finalScore);
            document.getElementById('new-record').classList.remove('hidden');

            // The VIVERSE leaderboard is configured to 'Update', meaning it replaces the old score
            // We must only submit when we know we have achieved a higher score locally
            if (this.viverseService) {
                this.viverseService.submitScore(finalScore);
            }
        } else {
            document.getElementById('new-record').classList.add('hidden');
        }

        // Show game over screen
        document.getElementById('game-over-screen').classList.remove('hidden');

        console.log('💀 Game Over! Score:', Math.floor(finalScore));
    }

    loseLife() {
        if (this.isInvulnerable) return;

        // If NOT in God Mode, take damage
        if (!this.godMode) {
            this.lives--;
            this.updateLivesUI();
        } else {
            console.log('🛡️ Hit blocked by God Mode!');
        }

        // VISUALS ALWAYS HAPPEN (even in God Mode)
        this.player.playHitAnimation();

        // Screen shake on hit!
        if (this.screenShake) {
            this.screenShake.mediumShake();
        }

        // Flash screen red
        document.getElementById('game-container').classList.add('flash-red');
        setTimeout(() => {
            document.getElementById('game-container').classList.remove('flash-red');
        }, 300);

        if (this.lives <= 0 && !this.godMode) {
            this.gameOver();
        } else {
            // Nonna gets closer when you get hit!
            if (this.chaser) {
                this.chaser.increaseThreat(0.2);
            }

            // Brief invulnerability
            this.isInvulnerable = true;
            this.player.setInvulnerable(true);
            setTimeout(() => {
                this.isInvulnerable = false;
                this.player.setInvulnerable(false);
            }, this.invulnerableTime);
        }
    }

    updateLivesUI() {
        const hearts = document.querySelectorAll('#lives-display .heart');
        hearts.forEach((heart, index) => {
            if (index < this.lives) {
                heart.classList.remove('lost');
            } else {
                heart.classList.add('lost');
                heart.classList.add('pulse');
                setTimeout(() => heart.classList.remove('pulse'), 300);
            }
        });
    }

    updateSpeedUI() {
        const speedPercent = ((this.currentSpeed - this.baseSpeed) / (this.maxSpeed - this.baseSpeed)) * 100;
        document.getElementById('speed-fill').style.width = `${20 + speedPercent * 0.8}%`;
    }

    activateWineSlowdown(duration = 3) {
        this.wineSlowdownActive = true;
        this.wineSlowdownTimer = duration;
        console.log('🍷 Wine collected! Slowing down for', duration, 'seconds');

        // Visual feedback - add wine effect class
        document.getElementById('game-container').classList.add('wine-slowdown');
    }

    updateWineSlowdown(deltaTime) {
        if (!this.wineSlowdownActive) return;

        this.wineSlowdownTimer -= deltaTime;

        if (this.wineSlowdownTimer <= 0) {
            this.wineSlowdownActive = false;
            this.wineSlowdownTimer = 0;
            document.getElementById('game-container').classList.remove('wine-slowdown');
            console.log('🍷 Wine effect ended!');
        }
    }

    getEffectiveSpeed() {
        let speed = this.currentSpeed;

        // Apply wine slowdown
        if (this.wineSlowdownActive) {
            speed *= this.wineSlowdownMultiplier;
        }

        // Apply boost speedup
        if (this.boostSystem && this.boostSystem.isBoosting) {
            speed *= this.boostSystem.boostSpeedMultiplier || 1.5;
        }

        return speed;
    }

    checkCollisions() {
        const obstacles = this.obstacleManager.getActiveObstacles();

        // 1. MAIN PLAYER COLLISIONS
        const playerBox = this.player.getCollisionBox();

        // Check obstacle collisions (skip if invulnerable - brief protection after hit)
        if (!this.isInvulnerable) {
            for (const obstacle of obstacles) {
                if (obstacle.checkCollision(playerBox)) {
                    this.loseLife(); // Handles damage/god mode logic internally
                    obstacle.markHit();
                    break; // Only take one hit at a time
                }
            }
        }

        // 2. AI PLAYER COLLISIONS
        if (this.isAI && this.aiPlayer && !this.aiPlayer.isInvulnerable) {
            const aiBox = this.aiPlayer.getCollisionBox();
            for (const obstacle of obstacles) {
                if (obstacle.checkCollision(aiBox)) {
                    // AI got hit! Visual only, doesn't end player's game!
                    console.log("🤖 AI tripped on obstacle!");
                    this.aiPlayer.playHitAnimation();
                    this.aiPlayer.setInvulnerable(true);
                    setTimeout(() => this.aiPlayer.setInvulnerable(false), 2000);
                    // It slows them down slightly by disabling their slide or jump inputs temporarily!
                    if (this.aiController) {
                        this.aiController.decisionTimer += 1.0; // Stun delay
                    }
                    break; 
                }
            }
        }

        // 3. COLLECTIBLE COLLISIONS (Player only)
        const collectibles = this.collectibleManager.getActiveCollectibles();
        for (const collectible of collectibles) {
            if (collectible.checkCollision(playerBox)) {
                this.scoreManager.addCollectible(collectible.value);

                // Particle burst on collect!
                if (this.particleBurst) {
                    this.particleBurst.emit(collectible.mesh.position);
                }

                collectible.collect();

                // PIZZA - counts toward extra life
                if (collectible.isPizza) {
                    const earnedLife = this.collectibleManager.collectPizza();
                    if (earnedLife && this.lives < this.maxLives) {
                        this.lives++;
                        this.updateLivesUI();
                        console.log('🍕🍕🍕🍕 4 PIZZAS = EXTRA LIFE!');
                        // Big celebration effect
                        if (this.screenShake) this.screenShake.mediumShake();
                        document.getElementById('game-container').classList.add('flash-green');
                        setTimeout(() => {
                            document.getElementById('game-container').classList.remove('flash-green');
                        }, 500);
                    }
                    // Flash gold for pizza
                    document.getElementById('game-container').classList.add('flash-gold');
                    setTimeout(() => {
                        document.getElementById('game-container').classList.remove('flash-gold');
                    }, 200);
                }

                // WINE - slows down the game for 3 seconds (easier mode)
                if (collectible.isWine) {
                    this.activateWineSlowdown(collectible.slowdownDuration || 3);
                    // Flash purple for wine
                    document.getElementById('game-container').classList.add('flash-purple');
                    setTimeout(() => {
                        document.getElementById('game-container').classList.remove('flash-purple');
                    }, 300);
                }
            }
        }

        // Check near-misses for combo (ALWAYS check for gameplay feel)
        for (const obstacle of obstacles) {
            if (obstacle.checkNearMiss(playerBox) && !obstacle.nearMissTriggered) {
                this.scoreManager.triggerNearMiss();
                obstacle.nearMissTriggered = true;

                // Light screen shake on near miss!
                if (this.screenShake) {
                    this.screenShake.lightShake();
                }
            }
        }
    }

    update(deltaTime) {
        if (!this.isRunning || this.isPaused) return;

        // Clamp delta time to prevent huge jumps
        deltaTime = Math.min(deltaTime, 0.1);

        // Update wine slowdown timer
        this.updateWineSlowdown(deltaTime);

        // Get effective speed (with wine slowdown / boost applied)
        const effectiveSpeed = this.getEffectiveSpeed();

        // Process input
        const input = this.inputHandler.getInput();

        // Update player
        this.player.update(deltaTime, input, effectiveSpeed);

        // Update camera
        this.cameraController.update(deltaTime, this.player);

        // Update environment (scrolling ground, buildings)
        this.environment.update(deltaTime, effectiveSpeed);

        // Multiplayer Sync Loop (if networked)
        if (this.isMultiplayer && this.multiplayerService && !this.isGameOver) {
            this.networkSyncTimer += deltaTime;
            if (this.networkSyncTimer > 0.05) { // 20 FPS network sync for smoother tracking
                this.multiplayerService.sendMessage({
                    type: "player_sync",
                    x: this.player.mesh.position.x,
                    y: this.player.mesh.position.y,
                    z: this.scoreManager.distance
                });
                this.networkSyncTimer = 0;
            }
            this.opponent.update(deltaTime);
        }

        // AI Control Loop (if playing vs AI locally)
        if (this.isAI && this.aiPlayer && this.aiController && !this.isGameOver) {
            const aiInput = this.aiController.update(deltaTime, effectiveSpeed);
            this.aiPlayer.update(deltaTime, aiInput, effectiveSpeed);
        }

        // Update obstacles
        this.obstacleManager.update(deltaTime, effectiveSpeed, this.player.laneIndex);

        // Update collectibles
        this.collectibleManager.update(deltaTime, effectiveSpeed);

        // Update chaser (follows player)
        if (this.chaser) {
            this.chaser.update(deltaTime, this.player.mesh.position.x);
        }

        // Check collisions
        this.checkCollisions();

        // Update score (distance-based)
        this.scoreManager.addDistance(effectiveSpeed * deltaTime);
        this.scoreManager.update(deltaTime);

        // Increase speed over time
        if (this.currentSpeed < this.maxSpeed) {
            this.currentSpeed += this.speedIncrement;
        }

        // Update UI
        this.updateSpeedUI();

        // Update visual effects
        if (this.speedLines) {
            this.speedLines.update(deltaTime, this.currentSpeed, this.player.mesh.position.x);
        }
        if (this.particleBurst) {
            this.particleBurst.update(deltaTime);
        }
        if (this.screenShake) {
            this.screenShake.update(deltaTime);
        }
        if (this.dynamicSky) {
            this.dynamicSky.update(deltaTime, this.currentSpeed);
        }

        // Update boost system
        if (this.boostSystem) {
            this.boostSystem.update(deltaTime);
        }

        // Update random events (cats, birds, etc.)
        if (this.randomEvents) {
            this.randomEvents.update(deltaTime, this.currentSpeed, this.player.mesh.position.z);
        }
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        const deltaTime = this.clock.getDelta();

        // Update game logic
        this.update(deltaTime);

        // Render
        this.composer.render();
    }

    gameLoop() {
        // Legacy - now using animate()
    }

    onResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
        this.composer.setSize(width, height);

        this.bloomPass.resolution.set(width, height);
    }
}
