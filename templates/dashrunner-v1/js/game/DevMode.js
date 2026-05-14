/**
 * DevMode.js - Comprehensive Developer Settings Panel
 * Futuristic UI for complete control over all game parameters
 */

import * as THREE from 'three';
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19/+esm';

export class DevMode {
    constructor(game) {
        this.game = game;
        this.gui = null;
        this.isVisible = false;

        // Detect if in VIVERSE iframe - completely disable dev mode
        this.isInViverse = window.self !== window.top;

        // In VIVERSE: Don't create dev panel at all, just load settings
        if (this.isInViverse) {
            console.log('🎮 VIVERSE mode - Dev panel disabled');
            this.settings = this.createDefaultSettings();
            this.initSettings();
            return; // Exit early - no GUI, no keyboard shortcuts
        }

        // Settings object (starts with hardcoded schema, then loads JSON)
        this.settings = this.createDefaultSettings();

        // Start async initialization
        this.initSettings();

        // Create the GUI (only in development)
        this.createGUI();

        // Dev panel hidden by default
        // this.show();

        // Keyboard toggle (only in dev)
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Backquote' || e.code === 'F1') {
                e.preventDefault();
                this.toggle();
            }
            // Inspection Mode (Shift + I)
            if (e.code === 'KeyI' && e.shiftKey) {
                this.triggerInspectionMode();
            }
        });
    }

    triggerInspectionMode() {
        if (!this.game) return;

        console.log('🔍 TRIGGERING INSPECTION MODE');

        let z = this.game.player.mesh.position.z + 20;
        const gap = 8;

        // Clear area
        if (this.game.obstacleManager) this.game.obstacleManager.reset();
        if (this.game.collectibleManager) this.game.collectibleManager.reset();
        if (this.game.obstacleManager) this.game.obstacleManager.nextSpawnZ = z + 100; // Stop automatic spawning
        if (this.game.collectibleManager) this.game.collectibleManager.nextSpawnZ = z + 100;

        // Spawn one of EACH type in a row

        // 1. Pizza
        const pizza = this.game.collectibleManager.getFromPool('pizza');
        if (pizza) pizza.activate(0, z);
        z += gap;

        // 2. Wine
        const wine = this.game.collectibleManager.getFromPool('wine');
        if (wine) wine.activate(0, z);
        z += gap;

        // 3. White Flag
        const flag = this.game.obstacleManager.getFromPool('whiteflag');
        if (flag) flag.activate(0, z);
        z += gap;

        // 4. Hydrant
        const hydrant = this.game.obstacleManager.getFromPool('hydrant');
        if (hydrant) hydrant.activate(0, z);

        console.log('🔍 Spawned: Pizza -> Wine -> Flag -> Hydrant');

        // Slow down game so user can look
        this.game.baseSpeed = 5;
        this.game.currentSpeed = 5;
    }

    async initSettings() {
        // 1. Load defaults from server JSON (allows easy editing)
        try {
            const response = await fetch('settings/default.json');
            if (response.ok) {
                const serverDefaults = await response.json();
                // Merge server defaults into current settings
                this.mergeSettings(this.settings, serverDefaults);
                console.log('📄 Loaded settings/default.json');
            } else {
                console.warn('⚠️ Could not load settings/default.json, using hardcoded defaults');
            }
        } catch (e) {
            console.warn('⚠️ Error loading settings.json:', e);
        }

        // 2. Load user manual overrides from LocalStorage (if any)
        this.loadUserDefaults();

        // 3. Apply everything to the game
        this.applyAllSettings();
        console.log('✅ All settings applied!');

        // 4. Update GUI to match new values
        if (this.gui) {
            this.gui.destroy();
            this.createGUI();
            this.hide();
        }

        // 5. Handle Auto-Start / God Mode
        if (this.settings.debug.godMode && this.game) {
            this.game.godMode = true;
            console.log('🛡️ God Mode enabled!');

            // Auto-start game (skip start screen)
            const startScreen = document.getElementById('start-screen');
            if (startScreen && !startScreen.classList.contains('hidden')) {
                startScreen.classList.add('hidden');
                this.game.start();
                console.log('🚀 Auto-started game (God Mode)');
            }
        }

        // Re-apply once more after delay to catch any late-loading systems (like Environment)
        setTimeout(() => {
            if (this.game.environment) {
                this.applyAllSettings();
            }
        }, 1500);



        console.log('🛠️ DevMode initialized. Press ` or F1 to toggle.');
    }

    createDefaultSettings() {
        return {
            // === GAMEPLAY ===
            gameplay: {
                baseSpeed: 19.5,  // Matches Game.js defaults
                maxSpeed: 52,     // Matches Game.js defaults
                speedIncrement: 0.002,
                lives: 3,
                invulnerableTime: 2000
            },

            // === PLAYER PHYSICS ===
            player: {
                jumpForce: 18,
                doubleJumpForce: 14,
                gravity: -40,
                laneChangeSpeed: 10,
                laneWidth: 3,
                slideDuration: 0.6,
                slideHeight: 0.8,
                scale: 1.5
            },

            // === CHASER (Grandma - disabled by default) ===
            chaser: {
                enabled: false,  // OFF by default, toggle in DevMode
                scale: 2.0,
                minDistance: -6,
                maxDistance: -2,
                chaseSpeed: 2,
                threatDecay: 0.02,
                threatIncrease: 0.2,
                bobAmount: 0.1,
                bobSpeed: 8
            },

            // === CAMERA ===
            camera: {
                fov: 75,
                positionY: 5,
                positionZ: -8,
                lookAtY: 2,
                lookAtZ: 20,
                positionLag: 3,
                heightLag: 2,
                lookAtLag: 5
            },

            // === LIGHTING ===
            lighting: {
                ambientIntensity: 1.0,
                ambientColor: '#ffffff',
                sunIntensity: 1.8,
                sunColor: '#fffacd',
                sunX: 30,
                sunY: 50,
                sunZ: 20,
                fillIntensity: 0.4,
                fillColor: '#87ceeb',
                rimIntensity: 0.3,
                rimColor: '#ffd700'
            },

            // === FOG ===
            fog: {
                enabled: true,
                color: '#87ceeb',
                near: 50,
                far: 150
            },

            // === POST-PROCESSING ===
            postProcessing: {
                exposure: 2.0,
                bloomStrength: 0.3,
                bloomRadius: 0.3,
                bloomThreshold: 0.9,
                vignetteEnabled: true,
                vignetteDarkness: 0.4
            },

            // === OBSTACLES ===
            obstacles: {
                spawnDistance: 80,
                minSpawnGap: 15,
                poolSize: 30
            },

            // === COLLECTIBLES ===
            collectibles: {
                spawnGap: 8,
                coinValue: 50,
                ravioliValue: 100,
                recipeValue: 250
            },

            // === ENVIRONMENT ===
            environment: {
                buildingCount: 15,
                buildingMinHeight: 6,
                buildingMaxHeight: 14,
                lampSpacing: 20,
                floorRepeatX: 8,
                floorRepeatY: 40
            },

            // === GRAPHICS ===
            graphics: {
                simpleMode: false, // Default to mesh mode (3D houses)
                houseScale: 30,    // Base scale for houses
                houseXOffset: 15,  // Distance from road center
                houseY: 0,         // Height offset
                houseRotation: 0   // Additional rotation
            },

            // === DEBUG ===
            debug: {
                showCollisionBoxes: false,
                showFPS: true,
                godMode: true, // DEV: Start with God Mode enabled
                slowMotion: false,
                slowMotionFactor: 0.25
            }
        };
    }

    createGUI() {
        this.gui = new GUI({
            title: '🛠️ CRAZY NONNA DEV MODE',
            width: 340
        });

        // Apply futuristic styling
        this.applyFuturisticStyles();

        // Tools
        this.gui.add({ openEditor: () => window.open('assets.html', '_blank') }, 'openEditor').name('📦 Open Asset Editor');

        // === GAMEPLAY FOLDER ===
        const gameplayFolder = this.gui.addFolder('🎮 Gameplay');
        gameplayFolder.add(this.settings.gameplay, 'baseSpeed', 5, 100, 0.5)
            .name('Base Speed')
            .onChange(v => {
                this.game.baseSpeed = v;
                // ALWAYS update currentSpeed for real-time effect (up OR down)
                if (this.game.isRunning) {
                    this.game.currentSpeed = v;
                }
                console.log(`🎮 Speed changed: baseSpeed=${v}, currentSpeed=${this.game.currentSpeed}`);
            });
        gameplayFolder.add(this.settings.gameplay, 'maxSpeed', 20, 80, 1)
            .name('Max Speed')
            .onChange(v => {
                this.game.maxSpeed = v;
                console.log(`🎮 Max speed set to: ${v}`);
            });
        gameplayFolder.add(this.settings.gameplay, 'speedIncrement', 0.001, 0.01, 0.001)
            .name('Speed Increment')
            .onChange(v => {
                this.game.speedIncrement = v;
                console.log(`🎮 Speed increment set to: ${v}`);
            });
        gameplayFolder.add(this.settings.gameplay, 'lives', 1, 10, 1)
            .name('Starting Lives')
            .onChange(v => {
                this.game.maxLives = v;
                console.log(`🎮 Max lives set to: ${v}`);
            });
        gameplayFolder.add(this.settings.gameplay, 'invulnerableTime', 500, 5000, 100)
            .name('Invuln Time (ms)')
            .onChange(v => {
                this.game.invulnerableTime = v;
                console.log(`🎮 Invuln time set to: ${v}ms`);
            });

        // === PLAYER FOLDER ===
        const playerFolder = this.gui.addFolder('🏃 Player Physics');
        playerFolder.add(this.settings.player, 'jumpForce', 10, 30, 1)
            .name('Jump Force')
            .onChange(v => { if (this.game.player) this.game.player.jumpForce = v; });
        playerFolder.add(this.settings.player, 'doubleJumpForce', 8, 25, 1)
            .name('Double Jump')
            .onChange(v => { if (this.game.player) this.game.player.doubleJumpForce = v; });
        playerFolder.add(this.settings.player, 'gravity', -80, -20, 1)
            .name('Gravity')
            .onChange(v => { if (this.game.player) this.game.player.gravity = v; });
        playerFolder.add(this.settings.player, 'laneChangeSpeed', 5, 20, 1)
            .name('Lane Speed')
            .onChange(v => { if (this.game.player) this.game.player.laneChangeSpeed = v; });
        playerFolder.add(this.settings.player, 'slideDuration', 0.2, 2, 0.1)
            .name('Slide Duration')
            .onChange(v => { if (this.game.player) this.game.player.slideDuration = v; });

        // === CHARACTER FOLDER (New!) ===
        const charFolder = this.gui.addFolder('👨‍🍳 Character Appearance');
        charFolder.add(this.settings.player, 'scale', 0.5, 5.0, 0.1)
            .name('Big Chef Size') // Renamed for clarity
            .onChange(v => {
                if (this.game.player && this.game.player.characterModel) {
                    this.game.player.characterModel.scale.set(v, v, v);
                }
            });
        charFolder.open(); // Open by default so they see it!
        playerFolder.add(this.settings.player, 'slideDuration', 0.2, 2, 0.1)
            .name('Slide Duration')
            .onChange(v => { if (this.game.player) this.game.player.slideDuration = v; });

        // === CHASER FOLDER ===
        const chaserFolder = this.gui.addFolder('👵 Chaser (Nonna)');
        chaserFolder.add(this.settings.chaser, 'enabled')
            .name('Enabled')
            .onChange(v => { if (this.game.chaser) this.game.chaser.setActive(v); });
        chaserFolder.add(this.settings.chaser, 'scale', 0.5, 4, 0.1)
            .name('Scale')
            .onChange(v => { if (this.game.chaser?.model) this.game.chaser.model.scale.setScalar(v); });
        chaserFolder.add(this.settings.chaser, 'minDistance', -15, -3, 0.5)
            .name('Safe Distance')
            .onChange(v => { if (this.game.chaser) this.game.chaser.minDistance = v; });
        chaserFolder.add(this.settings.chaser, 'maxDistance', -8, 0, 0.5)
            .name('Danger Distance')
            .onChange(v => { if (this.game.chaser) this.game.chaser.maxDistance = v; });
        chaserFolder.add(this.settings.chaser, 'chaseSpeed', 0.5, 10, 0.5)
            .name('Chase Speed')
            .onChange(v => { if (this.game.chaser) this.game.chaser.chaseSpeed = v; });
        chaserFolder.add(this.settings.chaser, 'threatDecay', 0.005, 0.1, 0.005)
            .name('Threat Decay');
        chaserFolder.add(this.settings.chaser, 'threatIncrease', 0.1, 0.5, 0.05)
            .name('Threat Increase');

        // === CAMERA FOLDER ===
        const cameraFolder = this.gui.addFolder('📷 Camera');
        cameraFolder.add(this.settings.camera, 'fov', 40, 120, 1)
            .name('FOV')
            .onChange(v => {
                this.game.camera.fov = v;
                this.game.camera.updateProjectionMatrix();
            });
        cameraFolder.add(this.settings.camera, 'positionY', 1, 15, 0.5)
            .name('Height');
        cameraFolder.add(this.settings.camera, 'positionZ', -20, 0, 0.5)
            .name('Distance');
        cameraFolder.add(this.settings.camera, 'positionLag', 1, 10, 0.5)
            .name('Position Lag');
        cameraFolder.add(this.settings.camera, 'lookAtLag', 1, 10, 0.5)
            .name('Look Lag');

        // === LIGHTING FOLDER ===
        const lightingFolder = this.gui.addFolder('💡 Lighting');
        lightingFolder.add(this.settings.lighting, 'ambientIntensity', 0, 6, 0.1)
            .name('Ambient')
            .onChange(v => { if (this.game.ambientLight) this.game.ambientLight.intensity = v; });
        lightingFolder.addColor(this.settings.lighting, 'ambientColor')
            .name('Ambient Color')
            .onChange(v => { if (this.game.ambientLight) this.game.ambientLight.color.set(v); });
        lightingFolder.add(this.settings.lighting, 'sunIntensity', 0, 3, 0.1)
            .name('Sun')
            .onChange(v => { if (this.game.sunLight) this.game.sunLight.intensity = v; });
        lightingFolder.addColor(this.settings.lighting, 'sunColor')
            .name('Sun Color')
            .onChange(v => { if (this.game.sunLight) this.game.sunLight.color.set(v); });
        lightingFolder.add(this.settings.lighting, 'sunX', -50, 50, 1)
            .name('Sun X')
            .onChange(v => { if (this.game.sunLight) this.game.sunLight.position.x = v; });
        lightingFolder.add(this.settings.lighting, 'sunY', 10, 100, 1)
            .name('Sun Y')
            .onChange(v => { if (this.game.sunLight) this.game.sunLight.position.y = v; });

        // === FOG FOLDER ===
        const fogFolder = this.gui.addFolder('🌫️ Fog');
        fogFolder.add(this.settings.fog, 'enabled')
            .name('Enabled')
            .onChange(v => {
                if (v) {
                    this.game.scene.fog = new THREE.Fog(
                        this.settings.fog.color,
                        this.settings.fog.near,
                        this.settings.fog.far
                    );
                } else {
                    this.game.scene.fog = null;
                }
            });
        fogFolder.addColor(this.settings.fog, 'color')
            .name('Color')
            .onChange(v => { if (this.game.scene.fog) this.game.scene.fog.color.set(v); });
        fogFolder.add(this.settings.fog, 'near', 10, 100, 5)
            .name('Near')
            .onChange(v => { if (this.game.scene.fog) this.game.scene.fog.near = v; });
        fogFolder.add(this.settings.fog, 'far', 50, 300, 10)
            .name('Far')
            .onChange(v => { if (this.game.scene.fog) this.game.scene.fog.far = v; });

        // === POST-PROCESSING FOLDER ===
        const postFolder = this.gui.addFolder('✨ Post-Processing');
        postFolder.add(this.settings.postProcessing, 'exposure', 0.5, 4, 0.1)
            .name('Exposure')
            .onChange(v => this.game.renderer.toneMappingExposure = v);
        postFolder.add(this.settings.postProcessing, 'bloomStrength', 0, 2, 0.1)
            .name('Bloom Strength')
            .onChange(v => { if (this.game.bloomPass) this.game.bloomPass.strength = v; });
        postFolder.add(this.settings.postProcessing, 'bloomRadius', 0, 1, 0.1)
            .name('Bloom Radius')
            .onChange(v => { if (this.game.bloomPass) this.game.bloomPass.radius = v; });
        postFolder.add(this.settings.postProcessing, 'bloomThreshold', 0, 1, 0.05)
            .name('Bloom Threshold')
            .onChange(v => { if (this.game.bloomPass) this.game.bloomPass.threshold = v; });

        // === GRAPHICS FOLDER ===
        if (this.settings.graphics) {
            const graphicsFolder = this.gui.addFolder('🎨 Graphics');
            graphicsFolder.add(this.settings.graphics, 'simpleMode')
                .name('Simple Mode (Squares)')
                .onChange(v => {
                    if (this.game.environment) {
                        this.game.environment.setSimpleMode(v);
                    }
                });

            // House Transform Controls
            graphicsFolder.add(this.settings.graphics, 'houseScale', 5, 100, 1)
                .name('🏠 House Scale')
                .onChange(v => {
                    if (this.game.environment) {
                        this.game.environment.houseBaseScale = v;
                        this.game.environment.updateHouseTransforms();
                    }
                });

            graphicsFolder.add(this.settings.graphics, 'houseXOffset', 5, 40, 1)
                .name('🏠 House X Offset')
                .onChange(v => {
                    if (this.game.environment) {
                        this.game.environment.houseXOffset = v;
                        this.game.environment.updateHouseTransforms();
                    }
                });

            graphicsFolder.add(this.settings.graphics, 'houseY', -10, 20, 0.5)
                .name('🏠 House Y Height')
                .onChange(v => {
                    if (this.game.environment) {
                        this.game.environment.houseY = v;
                        this.game.environment.updateHouseTransforms();
                    }
                });

            graphicsFolder.add(this.settings.graphics, 'houseRotation', -Math.PI, Math.PI, 0.1)
                .name('🏠 House Rotation')
                .onChange(v => {
                    if (this.game.environment) {
                        this.game.environment.houseRotationOffset = v;
                        this.game.environment.updateHouseTransforms();
                    }
                });
        }

        // === CHAOS CONTROLS === (For the X Demo!)
        const chaosFolder = this.gui.addFolder('🔥 CHAOS CONTROLS');

        chaosFolder.add({ obstacleGap: 8 }, 'obstacleGap', 3, 20, 1)
            .name('Obstacle Gap')
            .onChange(v => {
                if (this.game.obstacleManager) {
                    this.game.obstacleManager.minSpawnGap = v;
                    console.log(`🔥 Obstacle gap: ${v}`);
                }
            });

        chaosFolder.add({ catRate: 3 }, 'catRate', 1, 15, 0.5)
            .name('Cat Spawn Rate (s)')
            .onChange(v => {
                if (this.game.randomEvents) {
                    this.game.randomEvents.catInterval = v;
                    console.log(`🐱 Cat rate: ${v}s`);
                }
            });

        chaosFolder.add({ birdRate: 5 }, 'birdRate', 2, 20, 1)
            .name('Bird Flock Rate (s)')
            .onChange(v => {
                if (this.game.randomEvents) {
                    this.game.randomEvents.birdInterval = v;
                    console.log(`🐦 Bird rate: ${v}s`);
                }
            });

        chaosFolder.add({ collectibleGap: 4 }, 'collectibleGap', 2, 15, 1)
            .name('Collectible Gap')
            .onChange(v => {
                if (this.game.collectibleManager) {
                    this.game.collectibleManager.spawnGap = v;
                    console.log(`💰 Collectible gap: ${v}`);
                }
            });

        chaosFolder.add({
            spawnCatNow: () => {
                if (this.game.randomEvents) {
                    this.game.randomEvents.spawnCat(this.game.player?.mesh?.position?.z || 0 + 30);
                }
            }
        }, 'spawnCatNow').name('🐱 Spawn Cat NOW!');

        chaosFolder.add({
            spawnBirdsNow: () => {
                if (this.game.randomEvents && this.game.player) {
                    const pos = this.game.player.mesh.position.clone();
                    pos.z += 15;
                    this.game.randomEvents.spawnBirds(pos, 6);
                }
            }
        }, 'spawnBirdsNow').name('🐦 Spawn Birds NOW!');

        // === INSPECTION MODE (New!) ===
        chaosFolder.add({
            inspect: () => this.triggerInspectionMode()
        }, 'inspect').name('🔍 INSPECT OBJECTS (Shift+I)');

        // === DEBUG FOLDER ===
        const debugFolder = this.gui.addFolder('🐛 Debug');
        debugFolder.add(this.settings.debug, 'showFPS')
            .name('Show FPS')
            .onChange(v => this.toggleFPSCounter(v));
        debugFolder.add(this.settings.debug, 'godMode')
            .name('God Mode')
            .onChange(v => this.game.godMode = v);
        debugFolder.add(this.settings.debug, 'slowMotion')
            .name('Slow Motion');
        debugFolder.add(this.settings.debug, 'slowMotionFactor', 0.1, 1, 0.05)
            .name('Slow Factor');
        debugFolder.add({ reset: () => this.resetToDefaults() }, 'reset')
            .name('🔄 Reset All');

        // === PRESETS ===
        const presetsFolder = this.gui.addFolder('💾 Presets');

        // Build preset list for dropdown
        const presetList = this.getPresetList ? this.getPresetList() : [];
        const presetOptions = { 'Select...': 'Select...' };
        if (Array.isArray(presetList)) {
            presetList.forEach(p => presetOptions[p] = p);
        }

        const presetObj = { current: 'Select...' };
        presetsFolder.add(presetObj, 'current', presetOptions)
            .name('Load Preset')
            .onChange(v => this.loadPreset(v));

        presetsFolder.add({ saveDef: () => this.saveAsDefault() }, 'saveDef')
            .name('💾 Save as Default');

        presetsFolder.add({ saveNew: () => this.saveNewPreset() }, 'saveNew')
            .name('➕ Save New Preset...');

        presetsFolder.add({ reset: () => this.factoryReset() }, 'reset')
            .name('🏭 Factory Reset');

        presetsFolder.add({ export: () => this.exportSettings() }, 'export')
            .name('📤 Export JSON');
        presetsFolder.add({ import: () => this.importSettings() }, 'import')
            .name('📥 Import JSON');

        // === THEME SWITCHER ===
        const themeFolder = this.gui.addFolder('🎨 Themes');
        themeFolder.add({ theme: 'day' }, 'theme', ['day', 'night', 'golden'])
            .name('Current Theme')
            .onChange(v => this.game.themeManager.setTheme(v));

        // Close all folders initially
        this.gui.close();
    }

    applyFuturisticStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .lil-gui {
                --background-color: rgba(10, 15, 30, 0.95) !important;
                --text-color: #00ffff !important;
                --title-background-color: rgba(0, 200, 255, 0.2) !important;
                --title-text-color: #00ffff !important;
                --widget-color: rgba(0, 150, 200, 0.3) !important;
                --hover-color: rgba(0, 200, 255, 0.4) !important;
                --focus-color: #00ffff !important;
                --number-color: #ff6b6b !important;
                --string-color: #a8e6cf !important;
                font-family: 'Courier New', monospace !important;
                border: 1px solid rgba(0, 200, 255, 0.3) !important;
                box-shadow: 0 0 20px rgba(0, 200, 255, 0.2), inset 0 0 40px rgba(0, 100, 150, 0.1) !important;
                backdrop-filter: blur(10px) !important;
            }
            .lil-gui .title {
                text-transform: uppercase !important;
                letter-spacing: 2px !important;
                font-weight: bold !important;
                text-shadow: 0 0 10px #00ffff !important;
            }
            .lil-gui .controller {
                border-left: 2px solid transparent !important;
                transition: all 0.2s ease !important;
            }
            .lil-gui .controller:hover {
                border-left-color: #00ffff !important;
                background: rgba(0, 200, 255, 0.1) !important;
            }
            .lil-gui input[type="checkbox"] {
                accent-color: #00ffff !important;
            }
            .lil-gui button {
                background: linear-gradient(135deg, rgba(0, 150, 200, 0.4), rgba(0, 100, 150, 0.4)) !important;
                border: 1px solid rgba(0, 200, 255, 0.5) !important;
                text-transform: uppercase !important;
                letter-spacing: 1px !important;
                transition: all 0.2s ease !important;
            }
            .lil-gui button:hover {
                background: linear-gradient(135deg, rgba(0, 200, 255, 0.6), rgba(0, 150, 200, 0.6)) !important;
                box-shadow: 0 0 15px rgba(0, 200, 255, 0.5) !important;
            }
            #fps-counter {
                position: fixed;
                top: 10px;
                right: 150px;
                background: rgba(0, 0, 0, 0.7);
                color: #00ff00;
                padding: 5px 10px;
                font-family: monospace;
                font-size: 14px;
                z-index: 9999;
                border: 1px solid #00ff00;
            }
        `;
        document.head.appendChild(style);
    }

    toggleFPSCounter(show) {
        let counter = document.getElementById('fps-counter');
        if (show && !counter) {
            counter = document.createElement('div');
            counter.id = 'fps-counter';
            counter.textContent = 'FPS: --';
            document.body.appendChild(counter);

            let lastTime = performance.now();
            let frameCount = 0;

            const updateFPS = () => {
                frameCount++;
                const now = performance.now();
                if (now - lastTime >= 1000) {
                    counter.textContent = `FPS: ${frameCount}`;
                    frameCount = 0;
                    lastTime = now;
                }
                if (this.settings.debug.showFPS) {
                    requestAnimationFrame(updateFPS);
                }
            };
            requestAnimationFrame(updateFPS);
        } else if (!show && counter) {
            counter.remove();
        }
    }

    loadUserDefaults() {
        try {
            const userDefaults = localStorage.getItem('crazyNonna_user_default');
            if (userDefaults) {
                const parsed = JSON.parse(userDefaults);

                // IMPORTANT: Ignore saved chaser settings to force the new default (OFF)
                // Remove this line later if you want to allow saving 'enabled: true' again
                if (parsed.chaser) {
                    delete parsed.chaser.enabled;
                }

                this.mergeSettings(this.settings, parsed);
                console.log('📂 Loaded User Defaults:', {
                    gameplay: this.settings.gameplay,
                    graphics: this.settings.graphics,
                    debug: this.settings.debug
                });
            } else {
                console.log('📂 No saved defaults found, using factory defaults');
            }
        } catch (e) { console.error('Error loading default overrides:', e); }
    }

    saveAsDefault() {
        // Save current settings as the new "Default"
        const data = JSON.stringify(this.settings, null, 2);
        localStorage.setItem('crazyNonna_user_default', data);

        // Log what was saved for debugging
        console.log('💾 Saved as New Default:', {
            gameplay: this.settings.gameplay,
            graphics: this.settings.graphics,
            debug: this.settings.debug
        });
        alert('Settings saved as your new Default! These settings will load automatically on refresh.');
    }

    saveNewPreset() {
        const name = prompt('Enter preset name (this will also download a file):');
        if (name) {
            // 1. Prepare data
            const data = JSON.stringify(this.settings, null, 2);

            // 2. Save to LocalStorage (still useful for quick loading)
            localStorage.setItem(`crazyNonna_preset_${name}`, data);
            let list = this.getPresetList();
            if (!list.includes(name)) {
                list.push(name);
                localStorage.setItem('crazyNonna_presets_list', JSON.stringify(list));
            }
            this.updatePresetDropdown();

            // 3. DOWNLOAD SETTINGS AS JSON FILE
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `crazyNonna_preset_${name}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            console.log(`💾 Preset "${name}" saved and downloaded!`);
        }
    }

    getPresetList() {
        try {
            const list = localStorage.getItem('crazyNonna_presets_list');
            return list ? JSON.parse(list) : ['Default']; // Always have Default at least?
        } catch (e) { return []; }
    }

    updatePresetDropdown() {
        // Refresh GUI
        this.gui.destroy();
        this.createGUI();
        this.gui.open();
        this.gui.folders.forEach(f => {
            if (f._title === '💾 Presets') f.open();
        });
    }

    factoryReset() {
        if (confirm('Reset EVERYTHING to factory defaults? This clears your custom default.')) {
            localStorage.removeItem('crazyNonna_user_default');
            this.resetToDefaults();
            alert('Factory defaults restored.');
        }
    }

    // New loadPreset that handles dropdown event
    loadPreset(name) {
        if (!name || name === 'Select...') return;

        const preset = localStorage.getItem(`crazyNonna_preset_${name}`);
        if (preset) {
            try {
                const loadedSettings = JSON.parse(preset);
                const base = this.createDefaultSettings();
                this.mergeSettings(base, loadedSettings);

                this.settings = base;
                this.applyAllSettings();

                this.gui.destroy();
                this.createGUI();
                this.gui.open();
                console.log(`📂 Preset loaded: ${name}`);
            } catch (e) {
                console.error('Error loading preset:', e);
            }
        }
    }



    _old_loadPreset(name) {
        const preset = localStorage.getItem(`crazyNonna_preset_${name}`);
        if (preset) {
            try {
                const loadedSettings = JSON.parse(preset);
                // Deep merge loaded settings into defaults effectively
                // This ensures new sections (like graphics) aren't lost if loading an old preset
                this.settings = this.mergeSettings(this.createDefaultSettings(), loadedSettings);

                this.applyAllSettings();
                this.gui.destroy();
                this.createGUI();
                console.log(`📂 Preset loaded: ${name}`);
            } catch (e) {
                console.error('Error loading preset:', e);
                alert('Error loading preset. Resetting to defaults.');
                this.resetToDefaults();
            }
        } else {
            alert(`No preset found with name: ${name}`);
        }
    }

    // Helper to deeply merge settings objects
    mergeSettings(target, source) {
        for (const key of Object.keys(source)) {
            if (source[key] instanceof Object && key in target) {
                Object.assign(source[key], this.mergeSettings(target[key], source[key]));
            }
        }
        Object.assign(target || {}, source);
        return target;
    }

    exportSettings() {
        const data = JSON.stringify(this.settings, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'crazy_nonna_settings.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    importSettings() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    this.settings = JSON.parse(ev.target.result);
                    this.applyAllSettings();
                    this.gui.destroy();
                    this.createGUI();
                    console.log('📥 Settings imported!');
                } catch (err) {
                    alert('Invalid settings file!');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    applyAllSettings() {
        const g = this.game;
        const s = this.settings;

        // Gameplay - apply ALL gameplay settings
        g.baseSpeed = s.gameplay.baseSpeed;
        g.maxSpeed = s.gameplay.maxSpeed;
        g.speedIncrement = s.gameplay.speedIncrement;
        g.maxLives = s.gameplay.lives;
        g.invulnerableTime = s.gameplay.invulnerableTime;

        // ALWAYS sync currentSpeed with baseSpeed when loading settings
        // The game.start() method will reset it anyway, but this ensures
        // the value is correct before start() is called
        g.currentSpeed = s.gameplay.baseSpeed;

        // Player
        if (g.player) {
            g.player.jumpForce = s.player.jumpForce;
            g.player.doubleJumpForce = s.player.doubleJumpForce;
            g.player.gravity = s.player.gravity;
            g.player.laneChangeSpeed = s.player.laneChangeSpeed;
            g.player.slideDuration = s.player.slideDuration;
            // Apply scale if model exists
            if (g.player.characterModel) {
                const scale = s.player.scale || 1.5;
                g.player.characterModel.scale.set(scale, scale, scale);
            }
        }

        // Graphics - including ALL house transform settings
        if (g.environment && s.graphics) {
            g.environment.setSimpleMode(s.graphics.simpleMode);
            g.environment.houseBaseScale = s.graphics.houseScale;
            g.environment.houseXOffset = s.graphics.houseXOffset;
            g.environment.houseY = s.graphics.houseY;
            g.environment.houseRotationOffset = s.graphics.houseRotation;
            g.environment.updateHouseTransforms();
        }

        // Chaser
        if (g.chaser) {
            g.chaser.setActive(s.chaser.enabled);
            g.chaser.minDistance = s.chaser.minDistance;
            g.chaser.maxDistance = s.chaser.maxDistance;
            g.chaser.chaseSpeed = s.chaser.chaseSpeed;
            if (g.chaser.model) {
                g.chaser.model.scale.setScalar(s.chaser.scale);
            }
        }

        // Camera - apply ALL camera settings
        g.camera.fov = s.camera.fov;
        g.camera.updateProjectionMatrix();
        if (g.cameraController) {
            g.cameraController.targetY = s.camera.positionY;
            g.cameraController.targetZ = s.camera.positionZ;
            g.cameraController.positionLag = s.camera.positionLag;
            g.cameraController.lookAtLag = s.camera.lookAtLag;
        }

        // Lighting - apply ALL lighting settings
        if (g.ambientLight) {
            g.ambientLight.intensity = s.lighting.ambientIntensity;
            g.ambientLight.color.set(s.lighting.ambientColor);
        }
        if (g.sunLight) {
            g.sunLight.intensity = s.lighting.sunIntensity;
            g.sunLight.color.set(s.lighting.sunColor);
            g.sunLight.position.set(s.lighting.sunX, s.lighting.sunY, s.lighting.sunZ);
        }

        // Fog
        if (s.fog) {
            if (s.fog.enabled) {
                g.scene.fog = new THREE.Fog(s.fog.color, s.fog.near, s.fog.far);
            } else {
                g.scene.fog = null;
            }
        }

        // Post-processing
        g.renderer.toneMappingExposure = s.postProcessing.exposure;
        if (g.bloomPass) {
            g.bloomPass.strength = s.postProcessing.bloomStrength;
            g.bloomPass.radius = s.postProcessing.bloomRadius;
            g.bloomPass.threshold = s.postProcessing.bloomThreshold;
        }

        // Debug - God Mode = infinite lives only, NOT invulnerability
        if (s.debug) {
            g.godMode = s.debug.godMode;
            // Note: isInvulnerable is only for brief protection after getting hit
            // God Mode just prevents losing lives, doesn't skip collisions
            this.toggleFPSCounter(s.debug.showFPS);
        }

        console.log('✅ All settings applied!');
    }

    resetToDefaults() {
        this.settings = this.createDefaultSettings();
        this.applyAllSettings();
        this.gui.destroy();
        this.createGUI();
        console.log('🔄 Reset to defaults!');
    }

    show() {
        this.isVisible = true;
        this.gui.domElement.style.display = '';
        this.gui.open();
    }

    hide() {
        this.isVisible = false;
        this.gui.domElement.style.display = 'none';
    }

    toggle() {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }
}
