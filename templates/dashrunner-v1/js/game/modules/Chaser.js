/**
 * Chaser.js - The Crazy Nonna that chases the player!
 * Loads animated GLB model and follows behind the runner
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class Chaser {
    constructor(scene) {
        this.scene = scene;
        this.model = null;
        this.mixer = null;
        this.animations = {};
        this.currentAction = null;

        // Chaser position (behind player but in front of camera)
        // Camera is at Z=-8, player at Z=0, so chaser goes between -6 and -2
        this.baseZ = -6; // Starting distance (safe)
        this.currentZ = this.baseZ;
        this.targetX = 0;
        this.currentX = 0;

        // Chase behavior - DISABLED by default (toggle in DevMode)
        this.isActive = false;
        this.chaseSpeed = 2; // How fast it follows player's lane
        this.bobAmount = 0.1;
        this.bobSpeed = 8;
        this.time = 0;

        // Threat level (gets closer when player messes up)
        this.threatLevel = 0; // 0-1, affects how close nonna gets
        this.minDistance = -6; // Safe distance (further from player)
        this.maxDistance = -2; // Dangerously close!

        // Load the model (but hidden initially)
        this.loadModel();
    }

    loadModel() {
        const loader = new GLTFLoader();

        loader.load(
            'assets/Meshy_AI_Meshy_Merged_Animations.glb',
            (gltf) => {
                this.model = gltf.scene;

                // Scale and position
                this.model.scale.set(2, 2, 2);
                this.model.position.set(0, 0, this.baseZ);
                this.model.rotation.y = 0; // Face toward player (toward camera)

                // Enable shadows
                this.model.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });

                this.scene.add(this.model);

                // Hide by default (toggle with setActive)
                this.model.visible = this.isActive;

                // Set up animations
                if (gltf.animations && gltf.animations.length > 0) {
                    this.mixer = new THREE.AnimationMixer(this.model);

                    // Store all animations
                    gltf.animations.forEach((clip) => {
                        const action = this.mixer.clipAction(clip);
                        this.animations[clip.name] = action;
                        console.log(`🎬 Loaded animation: ${clip.name}`);
                    });

                    // Play the first animation (or find a run/chase animation)
                    this.playAnimation();
                }

                console.log('👵 Crazy Nonna Chaser loaded!');
            },
            (progress) => {
                const percent = (progress.loaded / progress.total * 100).toFixed(1);
                console.log(`Loading Nonna: ${percent}%`);
            },
            (error) => {
                console.error('Error loading Nonna chaser:', error);
            }
        );
    }

    playAnimation(name = null) {
        if (!this.mixer) return;

        const animNames = Object.keys(this.animations);
        if (animNames.length === 0) return;

        // Try to find a run/chase/walk animation, otherwise use first
        let targetAnim = name;
        if (!targetAnim) {
            const runAnims = animNames.filter(n =>
                n.toLowerCase().includes('run') ||
                n.toLowerCase().includes('chase') ||
                n.toLowerCase().includes('walk') ||
                n.toLowerCase().includes('jog')
            );
            targetAnim = runAnims.length > 0 ? runAnims[0] : animNames[0];
        }

        const action = this.animations[targetAnim];
        if (action) {
            if (this.currentAction && this.currentAction !== action) {
                this.currentAction.fadeOut(0.3);
            }
            action.reset().fadeIn(0.3).play();
            this.currentAction = action;
            console.log(`🎬 Playing animation: ${targetAnim}`);
        }
    }

    // Call this when player gets hit to make nonna get closer
    increaseThreat(amount = 0.15) {
        this.threatLevel = Math.min(1, this.threatLevel + amount);
    }

    // Call this over time to slowly back off
    decreaseThreat(amount = 0.01) {
        this.threatLevel = Math.max(0, this.threatLevel - amount);
    }

    // Follow the player's lane position
    setTargetX(playerX) {
        this.targetX = playerX;
    }

    update(deltaTime, playerX = 0) {
        if (!this.model || !this.isActive) return;

        this.time += deltaTime;

        // Update animation mixer
        if (this.mixer) {
            this.mixer.update(deltaTime);
        }

        // Follow player's X position (with lag)
        this.targetX = playerX;
        this.currentX += (this.targetX - this.currentX) * this.chaseSpeed * deltaTime;

        // Calculate Z based on threat level
        this.currentZ = THREE.MathUtils.lerp(
            this.minDistance,
            this.maxDistance,
            this.threatLevel
        );

        // Apply position with bobbing
        const bob = Math.sin(this.time * this.bobSpeed) * this.bobAmount;
        this.model.position.set(
            this.currentX,
            bob,
            this.currentZ
        );

        // Slight side-to-side sway for menacing effect
        const sway = Math.sin(this.time * 3) * 0.05;
        this.model.rotation.z = sway;

        // Gradually decrease threat over time
        this.decreaseThreat(deltaTime * 0.02);
    }

    reset() {
        this.threatLevel = 0;
        this.currentX = 0;
        this.currentZ = this.baseZ;
        if (this.model) {
            this.model.position.set(0, 0, this.baseZ);
        }
        // Restart animation
        this.playAnimation();
    }

    setActive(active) {
        this.isActive = active;
        if (this.model) {
            this.model.visible = active;
        }
    }

    // Get available animations (for debugging)
    getAnimationNames() {
        return Object.keys(this.animations);
    }
}
