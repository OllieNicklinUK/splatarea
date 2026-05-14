/**
 * Player.js - Nonna Character Controller
 * Handles movement, animations, and physics for the player character
 */

import * as THREE from 'three';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

export class Player {
    constructor(scene, curvedWorldUniforms, isAI = false) {
        this.scene = scene;
        this.curvedWorldUniforms = curvedWorldUniforms;
        this.isAI = isAI;
        this.loadRequestId = 0;
        this.activeModelUrl = null;

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

        // Load default character
        this.loadDefaultChef();
    }

    loadDefaultChef() {
        console.log('👨‍🍳 Loading fallback Chef avatar');
        return this.loadModel('assets/CHEF_Running_withSkin.glb', { fallbackToChef: false });
    }

    loadModel(url, options = {}) {
        const { fallbackToChef = true } = options;
        const isVRM = !url.includes('CHEF');
        const requestId = ++this.loadRequestId;
        this.activeModelUrl = url;
        console.log(`🧩 Loading avatar model: ${url} (isVRM=${isVRM})`);

        // Import GLTFLoader dynamically
        import('three/addons/loaders/GLTFLoader.js').then(({ GLTFLoader }) => {
            if (requestId !== this.loadRequestId) {
                console.log(`⏭️ Skipping stale loader setup for ${url}`);
                return;
            }
            const loader = new GLTFLoader();

            // Register VRM plugin for VRM files — activates the constraint system
            // that connects Normalized_Avatar_* (identity rest) → Avatar_* (skin-bound)
            if (isVRM) {
                loader.register((parser) => new VRMLoaderPlugin(parser));
                console.log('🔌 VRMLoaderPlugin registered');
            }

            loader.load(
                url,
                (gltf) => {
                    if (requestId !== this.loadRequestId) {
                        console.log(`⏭️ Ignoring stale model load result for ${url}`);
                        return;
                    }
                    // Clean up existing character mesh but NOT the animations
                    if (this.characterModel) {
                        this.mesh.remove(this.characterModel);
                        this.characterModel = null;
                        this.mixer = null;
                    }
                    // Clean up previous VRM instance
                    this.vrm = null;
                    this.vrmProceduralRun = false;

                    // REMOVE the placeholder box!
                    if (this.placeholder) {
                        this.mesh.remove(this.placeholder);
                        this.placeholder.geometry.dispose();
                        this.placeholder.material.dispose();
                        this.placeholder = null;
                    }

                    // --- VRM-specific setup using @pixiv/three-vrm ---
                    if (isVRM && gltf.userData.vrm) {
                        const vrm = gltf.userData.vrm;
                        this.vrm = vrm;
                        console.log('✅ VIVERSE avatar loaded as VRM');

                        // VRMUtils.removeUnnecessaryVertices(vrm.scene);
                        // VRMUtils.removeUnnecessaryJoints(vrm.scene);

                        this.characterModel = vrm.scene;
                        this.characterModel.scale.set(1.5, 1.5, 1.5);
                        this.characterModel.rotation.y = Math.PI; // VRMs face -Z

                        this.characterModel.position.set(0, 0, 0);
                        this.mesh.add(this.characterModel);
                        this.characterModel.updateWorldMatrix(true, true);

                        // Foot alignment using VRM humanoid API
                        const leftFoot = vrm.humanoid.getRawBoneNode('leftFoot');
                        const rightFoot = vrm.humanoid.getRawBoneNode('rightFoot');
                        let footLocalY = null;
                        [leftFoot, rightFoot].forEach(foot => {
                            if (!foot) return;
                            foot.updateWorldMatrix(true, false);
                            const localPos = new THREE.Vector3();
                            this.characterModel.worldToLocal(
                                localPos.setFromMatrixPosition(foot.matrixWorld)
                            );
                            if (footLocalY === null || localPos.y < footLocalY) {
                                footLocalY = localPos.y;
                            }
                        });
                        if (footLocalY !== null && isFinite(footLocalY)) {
                            this.characterModel.position.y = -footLocalY;
                            console.log(`📐 VRM foot aligned: lifted ${(-footLocalY).toFixed(3)}m`);
                        }

                        // Force visibility and disable frustum culling
                        // VRM loader may set up first-person layers/annotations that hide meshes
                        let meshCount = 0;
                        this.characterModel.traverse((child) => {
                            child.visible = true;
                            child.layers.set(0); // Force default render layer
                            if (child.isMesh) {
                                child.castShadow = true;
                                child.receiveShadow = true;
                                child.frustumCulled = false;
                                meshCount++;

                                // Convert MToon materials to standard PBR materials.
                                const convertMat = (mtoon) => {
                                    const std = new THREE.MeshStandardMaterial();
                                    if (mtoon.map) std.map = mtoon.map;
                                    if (mtoon.normalMap) std.normalMap = mtoon.normalMap;
                                    if (mtoon.color) std.color.copy(mtoon.color);
                                    if (mtoon.emissive) std.emissive.copy(mtoon.emissive);
                                    if (mtoon.emissiveMap) std.emissiveMap = mtoon.emissiveMap;
                                    std.transparent = mtoon.transparent || false;
                                    std.opacity = mtoon.opacity !== undefined ? mtoon.opacity : 1.0;
                                    std.alphaTest = mtoon.alphaTest || 0;
                                    std.side = THREE.DoubleSide;
                                    std.depthWrite = true;
                                    std.visible = true;
                                    std.roughness = 0.7;
                                    std.metalness = 0.0;
                                    return std;
                                };

                                if (child.material) {
                                    if (Array.isArray(child.material)) {
                                        child.material = child.material.map(m => convertMat(m));
                                    } else {
                                        child.material = convertMat(child.material);
                                    }
                                }
                            }
                        });
                        console.log(`👁️ VRM: converted ${meshCount} meshes to standard materials`);

                        // --- Native VRMA Animation Loading ---
                        import('@pixiv/three-vrm-animation').then(({ VRMAnimationLoaderPlugin, createVRMAnimationClip }) => {
                            if (requestId !== this.loadRequestId) {
                                console.log(`⏭️ Ignoring stale VRMA setup for ${url}`);
                                return;
                            }
                            const animLoader = new GLTFLoader();
                            animLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));

                            animLoader.load(
                                'assets/Walk_vrma.glb',
                                (animGltf) => {
                                    if (requestId !== this.loadRequestId) {
                                        console.log(`⏭️ Ignoring stale VRMA load result for ${url}`);
                                        return;
                                    }
                                    const vrmAnimations = animGltf.userData.vrmAnimations;
                                    if (vrmAnimations && vrmAnimations.length > 0) {
                                        const vrmAnimation = vrmAnimations[0];
                                        // Create a standard Three.js AnimationClip matched to THIS specific VRM
                                        const clip = createVRMAnimationClip(vrmAnimation, vrm);
                                        clip.name = 'Run_02'; // Override name so Game.js knows it can play it

                                        this.mixer = new THREE.AnimationMixer(vrm.scene);
                                        const action = this.mixer.clipAction(clip);
                                        action.setEffectiveTimeScale(2.5); // Speed up walk to a run!
                                        
                                        this.animations = { 'Run_02': action, 'Armature|running|baselayer': action };
                                        action.play();
                                        console.log(`🏃 Loaded and playing Native VRMA: Walk.vrma`);
                                    } else {
                                        console.warn('⚠️ No VRM animations found in Walk.vrma');
                                    }
                                },
                                undefined,
                                (error) => console.error('Error loading VRMA:', error)
                            );
                        });

                        // Tint Red if AI
                        if (this.isAI) {
                            this.characterModel.traverse((child) => {
                                if (child.isMesh && child.material) {
                                    child.material.color.setHex(0xff7675);
                                }
                            });
                        }

                    } else {
                        // --- Non-VRM (Chef model) setup ---
                        this.characterModel = gltf.scene;
                        if (isVRM) {
                            console.warn('⚠️ Avatar URL loaded, but response was not a VRM. Using generic GLTF flow.');
                        } else {
                            console.log('✅ Chef fallback model loaded');
                        }
                        this.characterModel.scale.set(1.5, 1.5, 1.5);
                        this.characterModel.rotation.y = 0;
                        this.characterModel.position.set(0, 0, 0);
                        this.mesh.add(this.characterModel);
                        this.characterModel.updateWorldMatrix(true, true);

                        // Force visibility
                        this.characterModel.traverse((child) => {
                            child.visible = true;
                            if (child.isMesh) {
                                child.castShadow = true;
                                child.receiveShadow = true;
                                child.frustumCulled = false;
                            }
                        });

                        // Animation Setup for Chef
                        let clipsToUse = gltf.animations;
                        if (clipsToUse && clipsToUse.length > 0) {
                            // Cache the Chef's working animations for future VRM swaps
                            this.cachedAnimations = clipsToUse;

                            this.mixer = new THREE.AnimationMixer(this.characterModel);
                            this.animations = {};
                            clipsToUse.forEach((clip) => {
                                const action = this.mixer.clipAction(clip);
                                this.animations[clip.name] = action;
                                console.log(`🏃 Chef animation loaded: ${clip.name}`);
                            });

                            const animNames = Object.keys(this.animations);
                            if (animNames.length > 0) {
                                const runAnim = animNames.find(n =>
                                    n.toLowerCase().includes('run') ||
                                    n.toLowerCase().includes('walk')
                                ) || animNames[0];
                                this.animations[runAnim].play();
                                console.log(`🏃 Playing: ${runAnim}`);
                            }

                            if (this.isAI) {
                                this.characterModel.traverse((child) => {
                                    if (child.isMesh && child.material) {
                                        child.material.color.setHex(0xff7675);
                                    }
                                });
                            }
                        }
                    }

                    console.log('👨‍🍳 Character model loaded!');
                },
                (progress) => {
                    if (requestId !== this.loadRequestId) {
                        return;
                    }
                    const percent = progress.total ? (progress.loaded / progress.total * 100).toFixed(1) : 'unknown';
                    console.log(`Loading Model: ${percent}%`);
                },
                (error) => {
                    if (requestId !== this.loadRequestId) {
                        console.log(`⏭️ Ignoring stale model error for ${url}`);
                        return;
                    }
                    console.error(`❌ Error loading model from ${url}:`, error);
                    if (fallbackToChef && !url.includes('CHEF')) {
                        console.warn('↩️ Falling back to Chef because avatar model load failed');
                        this.loadDefaultChef();
                        return;
                    }
                    if (!this.characterModel) this.createFallbackCharacter();
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
        this.laneIndex = 1;
        this.targetLaneIndex = 1;
        this.position.set(0, 0, 0);
        this.targetX = 0;
        this.mesh.position.set(0, 0, 0);
        this.isJumping = false;
        this.isSliding = false;
        this.jumpVelocity = 0;
        this.canDoubleJump = true;
        this.currentHeight = this.normalHeight;
        this.animationState = 'running';
        this.tiltAngle = 0;
        this.targetTiltAngle = 0;
        this.mesh.rotation.set(0, 0, 0);
        this.isInvulnerable = false;
    }

    jump() {
        if (!this.isJumping && !this.isSliding) {
            // First jump
            this.isJumping = true;
            this.jumpVelocity = this.jumpForce;
            this.animationState = 'jumping';
            this.canDoubleJump = true;
        } else if (this.isJumping && this.canDoubleJump) {
            // Double jump - rolling pin helicopter!
            this.jumpVelocity = this.doubleJumpForce;
            this.canDoubleJump = false;
            this.triggerHelicopterSpin();
        }
    }

    triggerHelicopterSpin() {
        // Spin the rolling pin rapidly
        this.helicopterSpinActive = true;
        this.helicopterSpinTimer = 0.5; // seconds
    }

    slide() {
        if (!this.isSliding && !this.isJumping) {
            this.isSliding = true;
            this.slideTimer = this.slideDuration;
            this.currentHeight = this.slideHeight;
            this.animationState = 'sliding';
        } else if (this.isJumping) {
            // Fast drop if in air
            this.jumpVelocity = -20;
        }
    }

    changeLane(direction) {
        const newLane = this.targetLaneIndex + direction;
        if (newLane >= 0 && newLane < this.lanes.length) {
            this.targetLaneIndex = newLane;
            this.targetX = this.lanes[this.targetLaneIndex];

            // Set tilt
            this.targetTiltAngle = -direction * 0.3;
        }
    }

    // Direct lane setting (for body tracker)
    setLane(laneIndex) {
        if (laneIndex >= 0 && laneIndex < this.lanes.length && laneIndex !== this.targetLaneIndex) {
            const direction = laneIndex - this.targetLaneIndex;
            this.targetLaneIndex = laneIndex;
            this.targetX = this.lanes[this.targetLaneIndex];

            // Set tilt based on movement direction
            this.targetTiltAngle = -Math.sign(direction) * 0.3;
        }
    }

    update(deltaTime, input, speed) {
        // Process input
        if (input.jump) {
            this.jump();
        }
        if (input.slide) {
            this.slide();
        }
        if (input.left) {
            this.changeLane(-1);
        }
        if (input.right) {
            this.changeLane(1);
        }

        // Update lane position (lerp)
        const dx = this.targetX - this.mesh.position.x;
        this.mesh.position.x += dx * this.laneChangeSpeed * deltaTime;

        // Update tilt
        this.tiltAngle += (this.targetTiltAngle - this.tiltAngle) * 5 * deltaTime;
        if (Math.abs(dx) < 0.1) {
            this.targetTiltAngle = 0;
        }

        // Update lane index when close enough
        if (Math.abs(dx) < 0.5) {
            this.laneIndex = this.targetLaneIndex;
        }

        // Jump physics
        if (this.isJumping) {
            this.jumpVelocity += this.gravity * deltaTime;
            this.mesh.position.y += this.jumpVelocity * deltaTime;

            // Landing
            if (this.mesh.position.y <= this.groundY) {
                this.mesh.position.y = this.groundY;
                this.isJumping = false;
                this.jumpVelocity = 0;
                this.canDoubleJump = true;
                this.animationState = 'running';
                this.emitDustParticles();
            }
        }

        // Slide timer
        if (this.isSliding) {
            this.slideTimer -= deltaTime;
            if (this.slideTimer <= 0) {
                this.isSliding = false;
                this.currentHeight = this.normalHeight;
                this.animationState = 'running';
            }
        }

        // Update animation mixer
        if (this.mixer) {
            this.mixer.update(deltaTime);
        }

        // Update VRM constraint system (propagates Normalized bones → Avatar bones → skin)
        if (this.vrm) {
            this.vrm.update(deltaTime);
        }

        // Helicopter spin animation (only for geometric character)
        if (this.helicopterSpinActive && this.rollingPin && !this.characterModel) {
            this.helicopterSpinTimer -= deltaTime;
            this.rollingPin.rotation.y += deltaTime * 30;
            if (this.helicopterSpinTimer <= 0) {
                this.helicopterSpinActive = false;
            }
        } else if (this.rollingPin && !this.characterModel) {
            // Normal rolling pin bobbing
            this.rollingPin.rotation.y = Math.sin(Date.now() * 0.01) * 0.2;
        }

        // Running animation (only for geometric character - GLB has its own)
        if (this.animationState === 'running' && !this.characterModel) {
            const runCycle = Math.sin(Date.now() * 0.02) * 0.2;
            if (this.leftLeg) this.leftLeg.rotation.x = runCycle;
            if (this.rightLeg) this.rightLeg.rotation.x = -runCycle;
            if (this.body) this.body.rotation.z = Math.sin(Date.now() * 0.01) * 0.05;
            if (this.rollingPin) this.rollingPin.position.y = 1.2 + Math.abs(Math.sin(Date.now() * 0.02)) * 0.1;
        }

        // Slide animation
        if (this.animationState === 'sliding') {
            this.mesh.rotation.x = 0.3;
            this.mesh.scale.y = 0.6;
        } else {
            this.mesh.rotation.x = 0;
            this.mesh.scale.y = 1;
        }

        // Apply tilt
        this.mesh.rotation.z = this.tiltAngle;

        // Invulnerability flashing
        if (this.isInvulnerable) {
            this.invulnerableFlashTimer += deltaTime;
            this.mesh.visible = Math.sin(this.invulnerableFlashTimer * 20) > 0;
        } else {
            this.mesh.visible = true;
        }

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
