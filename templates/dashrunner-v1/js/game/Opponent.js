/**
 * Player.js - Nonna Character Controller
 * Handles movement, animations, and physics for the player character
 */

import * as THREE from 'three';

export class Opponent {
    constructor(scene, curvedWorldUniforms) {
        this.scene = scene;
        this.curvedWorldUniforms = curvedWorldUniforms;

        // Lane system
        this.lanes = [-3, 0, 3]; // Left, Center, Right
        this.laneIndex = 1; // Start in center
        this.targetLaneIndex = 1;
        this.laneChangeSpeed = 10;

        // Position
        this.position = new THREE.Vector3(0, 0, 0);
        this.targetX = 0;

        // Jump physics
        this.isJumping = false;
        this.isSliding = false;
        this.jumpVelocity = 0;
        this.gravity = -40;
        this.jumpForce = 18; // Higher jump!
        this.doubleJumpForce = 14;
        this.canDoubleJump = true;
        this.groundY = 0;

        // Slide
        this.slideTimer = 0;
        this.slideDuration = 0.6;
        this.normalHeight = 2;
        this.slideHeight = 0.8;
        this.currentHeight = this.normalHeight;

        // Visual effects
        this.isInvulnerable = false;
        this.invulnerableFlashTimer = 0;

        // Animation state
        this.animationState = 'running'; // running, jumping, sliding, hit
        this.tiltAngle = 0;
        this.targetTiltAngle = 0;

        // Create character mesh
        this.createNonna();

        // Collision box (will be updated based on state)
        this.collisionBox = new THREE.Box3();
    }

    createNonna() {
        // Create a temporary placeholder mesh while loading
        this.mesh = new THREE.Group();
        this.mesh.position.set(0, 0, 0);
        this.scene.add(this.mesh);

        // Store placeholder reference so we can remove it later
        this.placeholder = new THREE.Mesh(
            new THREE.BoxGeometry(0.8, 2, 0.5),
            new THREE.MeshStandardMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.3 })
        );
        this.placeholder.position.y = 1;
        this.mesh.add(this.placeholder);

        // Import GLTFLoader dynamically
        import('three/addons/loaders/GLTFLoader.js').then(({ GLTFLoader }) => {
            const loader = new GLTFLoader();

            loader.load(
                'assets/CHEF_Running_withSkin.glb',
                (gltf) => {
                    // REMOVE the placeholder box!
                    if (this.placeholder) {
                        this.mesh.remove(this.placeholder);
                        this.placeholder.geometry.dispose();
                        this.placeholder.material.dispose();
                        this.placeholder = null;
                    }

                    // Add the loaded model to our group
                    this.characterModel = gltf.scene;
                    this.characterModel.scale.set(1.5, 1.5, 1.5);
                    this.characterModel.rotation.y = 0;  // Face forward (away from camera)

                    // Enable shadows
                    this.characterModel.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                        }
                    });

                    this.mesh.add(this.characterModel);

                    // Set up animations
                    if (gltf.animations && gltf.animations.length > 0) {
                        this.mixer = new THREE.AnimationMixer(this.characterModel);

                        gltf.animations.forEach((clip) => {
                            const action = this.mixer.clipAction(clip);
                            this.animations = this.animations || {};
                            this.animations[clip.name] = action;
                            console.log(`🏃 Chef animation loaded: ${clip.name}`);
                        });

                        // Play running animation
                        const animNames = Object.keys(this.animations);
                        if (animNames.length > 0) {
                            const runAnim = animNames.find(n => n.toLowerCase().includes('run') || n.toLowerCase().includes('walk')) || animNames[0];
                            this.animations[runAnim].play();
                        }
                        
                        // Tint the opponent so they look slightly different!
                        this.characterModel.traverse((child) => {
                            if (child.isMesh && child.material) {
                                child.material.color.setHex(0xa0c4ff); // A nice blue tint for the opponent!
                            }
                        });
                    }

                    console.log('👨‍🍳 Chef character loaded!');
                },
                (progress) => {
                    const percent = (progress.loaded / progress.total * 100).toFixed(1);
                    console.log(`Loading Chef: ${percent}%`);
                },
                (error) => {
                    console.error('Error loading Chef:', error);
                    this.createFallbackCharacter();
                }
            );
        });

        // These will be overwritten when model loads, but needed for animation references
        this.body = this.placeholder;
        this.leftLeg = this.placeholder;
        this.rightLeg = this.placeholder;
        this.rollingPin = this.placeholder;

        // Create particle system for effects
        this.createParticles();
    }

    createFallbackCharacter() {
        // Simple fallback if GLB fails to load
        const bodyGeo = new THREE.CylinderGeometry(0.4, 0.6, 1.5, 8);
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0xFFFFFF });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 0.75;
        this.mesh.add(body);

        const headGeo = new THREE.SphereGeometry(0.35, 16, 16);
        const head = new THREE.Mesh(headGeo, new THREE.MeshStandardMaterial({ color: 0xFFDBB4 }));
        head.position.y = 1.8;
        this.mesh.add(head);
    }

    createParticles() {
        // Dust particles for landing/sliding
        const particleCount = 20;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const velocities = [];

        for (let i = 0; i < particleCount * 3; i++) {
            positions[i] = 0;
        }

        for (let i = 0; i < particleCount; i++) {
            velocities.push({
                x: (Math.random() - 0.5) * 2,
                y: Math.random() * 2,
                z: (Math.random() - 0.5) * 2,
                life: 0
            });
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const material = new THREE.PointsMaterial({
            color: 0xD4A574,
            size: 0.15,
            transparent: true,
            opacity: 0.8
        });

        this.dustParticles = new THREE.Points(geometry, material);
        this.dustParticles.visible = false;
        this.dustVelocities = velocities;
        this.scene.add(this.dustParticles);
    }

    emitDustParticles() {
        this.dustParticles.visible = true;
        const positions = this.dustParticles.geometry.attributes.position.array;

        for (let i = 0; i < this.dustVelocities.length; i++) {
            positions[i * 3] = this.mesh.position.x;
            positions[i * 3 + 1] = 0;
            positions[i * 3 + 2] = this.mesh.position.z;

            this.dustVelocities[i].x = (Math.random() - 0.5) * 3;
            this.dustVelocities[i].y = Math.random() * 2 + 1;
            this.dustVelocities[i].z = (Math.random() - 0.5) * 3 - 1;
            this.dustVelocities[i].life = 1;
        }

        this.dustParticles.geometry.attributes.position.needsUpdate = true;
    }

    updateParticles(deltaTime) {
        if (!this.dustParticles.visible) return;

        const positions = this.dustParticles.geometry.attributes.position.array;
        let anyAlive = false;

        for (let i = 0; i < this.dustVelocities.length; i++) {
            if (this.dustVelocities[i].life > 0) {
                anyAlive = true;
                this.dustVelocities[i].life -= deltaTime * 2;

                positions[i * 3] += this.dustVelocities[i].x * deltaTime;
                positions[i * 3 + 1] += this.dustVelocities[i].y * deltaTime;
                positions[i * 3 + 2] += this.dustVelocities[i].z * deltaTime;

                this.dustVelocities[i].y -= 5 * deltaTime; // gravity
            }
        }

        this.dustParticles.geometry.attributes.position.needsUpdate = true;
        this.dustParticles.material.opacity = Math.max(...this.dustVelocities.map(v => v.life)) * 0.8;

        if (!anyAlive) {
            this.dustParticles.visible = false;
        }
    }

    reset() {
        this.netTargetX = 0;
        this.netTargetY = 0;
        this.netTargetZ = 0;
        
        this.laneIndex = 1;
        this.targetLaneIndex = 1;
        this.position.set(0, 0, 0);
        this.mesh.position.set(0, 0, 0);
        this.animationState = 'running';
        this.tiltAngle = 0;
        this.mesh.rotation.set(0, 0, 0);
        this.mesh.visible = true;
    }

    setNetworkTarget(x, y, z) {
        this.netTargetX = x;
        this.netTargetY = y;
        this.netTargetZ = z;
    }

    update(deltaTime) {
        // LERP Position for smooth network syncing
        const lerpFactor = 10 * deltaTime;
        this.mesh.position.x += (this.netTargetX - this.mesh.position.x) * lerpFactor;
        
        // Only lerp Y heavily if they are jumping
        const targetY = this.netTargetY > 0.1 ? this.netTargetY : this.groundY;
        this.mesh.position.y += (targetY - this.mesh.position.y) * lerpFactor;
        
        // Lerp Z position (which represents distance advantage/disadvantage)
        this.mesh.position.z += (this.netTargetZ - this.mesh.position.z) * lerpFactor;

        // Visual tilt based on lateral movement
        const dx = this.netTargetX - this.mesh.position.x;
        const targetTilt = dx > 0.1 ? -0.3 : (dx < -0.1 ? 0.3 : 0);
        this.tiltAngle += (targetTilt - this.tiltAngle) * 5 * deltaTime;
        this.mesh.rotation.z = this.tiltAngle;

        // Animation state heuristics
        if (this.mesh.position.y > this.groundY + 0.5) {
            this.animationState = 'jumping';
        } else {
            this.animationState = 'running';
        }

        // Helicopter spin animation
        if (this.mixer) {
            this.mixer.update(deltaTime);
        }

        // Apply tilt
        this.mesh.rotation.z = this.tiltAngle;

        // Update particles
        this.updateParticles(deltaTime);

        // Update position reference
        this.position.copy(this.mesh.position);
    }

    getCollisionBox() {
        const height = this.isSliding ? this.slideHeight : this.normalHeight;
        const halfWidth = 0.4;
        const halfDepth = 0.4;

        this.collisionBox.min.set(
            this.mesh.position.x - halfWidth,
            this.mesh.position.y,
            this.mesh.position.z - halfDepth
        );
        this.collisionBox.max.set(
            this.mesh.position.x + halfWidth,
            this.mesh.position.y + height,
            this.mesh.position.z + halfDepth
        );

        return this.collisionBox;
    }

    setInvulnerable(value) {
        this.isInvulnerable = value;
        this.invulnerableFlashTimer = 0;
    }

    playHitAnimation() {
        // Quick shake/hit reaction
        this.animationState = 'hit';
        const originalPos = this.mesh.position.clone();

        const shake = () => {
            this.mesh.position.x = originalPos.x + (Math.random() - 0.5) * 0.2;
        };

        const interval = setInterval(shake, 50);
        setTimeout(() => {
            clearInterval(interval);
            this.mesh.position.x = originalPos.x;
            this.animationState = 'running';
        }, 300);
    }
}
