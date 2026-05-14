/**
 * ObstacleManager.js - Simplified to just White Flag and Kicking Nonna
 * 
 * White Flag: Static obstacle you need to avoid
 * Kicking Nonna: Animated FBX obstacle with looping kick animation
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

class Obstacle {
    constructor(scene, type, sharedModels) {
        this.scene = scene;
        this.type = type;
        this.active = false;
        this.hit = false;
        this.nearMissTriggered = false;
        this.mesh = null;
        this.collisionBox = new THREE.Box3();
        this.nearMissBox = new THREE.Box3();
        this.sharedModels = sharedModels;

        this.createMesh(type);
    }

    rebuildMesh() {
        const oldPos = this.mesh ? this.mesh.position.clone() : new THREE.Vector3(0, 0, 0);

        if (this.mesh) {
            this.scene.remove(this.mesh);
        }

        this.createMesh(this.type);

        if (this.active) {
            this.mesh.visible = true;
            this.mesh.position.copy(oldPos);
            this.lastPosition = this.mesh.position;
        }
    }

    createMesh(type) {
        const group = new THREE.Group();

        switch (type) {
            case 'whiteflag':
                // Barricade Flag - Spans across road - JUMP OVER THIS!
                const flagGroup = new THREE.Group();

                // Poles
                const poleGeo = new THREE.CylinderGeometry(0.1, 0.1, 2.5, 8);
                const poleMat = new THREE.MeshStandardMaterial({ color: 0x8B4513 });

                const leftPole = new THREE.Mesh(poleGeo, poleMat);
                leftPole.position.set(-4.5, 1.25, 0);
                flagGroup.add(leftPole);

                const rightPole = new THREE.Mesh(poleGeo, poleMat);
                rightPole.position.set(4.5, 1.25, 0);
                flagGroup.add(rightPole);

                // Lower Banner (Hurdle style)
                const bannerGeo = new THREE.PlaneGeometry(9, 1.2, 16, 4);
                const bannerMat = new THREE.MeshStandardMaterial({
                    color: 0xFFFFFF,
                    side: THREE.DoubleSide,
                    roughness: 0.9
                });
                const banner = new THREE.Mesh(bannerGeo, bannerMat);
                banner.position.y = 1.2; // Center at 1.2 (Top at 1.8, Bottom at 0.6)
                flagGroup.add(banner);

                this.flag = banner;
                this.flagGeo = bannerGeo;

                group.add(flagGroup);
                this.height = 1.8; // Low enough to jump over!
                this.width = 9;
                break;

            case 'hydrant':
                // Fire Hydrant GLB
                if (this.sharedModels.hydrant) {
                    const hydrant = this.sharedModels.hydrant.clone();
                    hydrant.scale.set(1.0, 1.0, 1.0); // Adjust scale if needed

                    hydrant.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                        }
                    });
                    group.add(hydrant);
                } else {
                    // Fallback Red Cylinder
                    const hydGeo = new THREE.CylinderGeometry(0.3, 0.4, 0.8, 12);
                    const hydMat = new THREE.MeshStandardMaterial({ color: 0xFF0000 });
                    const hyd = new THREE.Mesh(hydGeo, hydMat);
                    hyd.position.y = 0.4;
                    group.add(hyd);
                }
                this.height = 1.0;
                this.width = 0.8;
                break;
        }

        this.mesh = group;
        this.mesh.visible = false;
        this.scene.add(this.mesh);
        this.lastPosition = this.mesh.position;
    }

    activate(x, z) {
        this.active = true;
        this.hit = false;
        this.nearMissTriggered = false;

        // White flag spawns in CENTER always (covers all lanes)
        if (this.type === 'whiteflag') {
            this.mesh.position.set(0, 0, z);
        } else {
            this.mesh.position.set(x, 0, z);
        }

        this.mesh.visible = true;
        this.animTime = 0;
        this.lastPosition = this.mesh.position;
    }

    deactivate() {
        this.active = false;
        this.mesh.visible = false;
    }

    update(deltaTime, speed) {
        if (!this.active) return;

        this.mesh.position.z -= speed * deltaTime;
        this.animTime = (this.animTime || 0) + deltaTime;

        // Animate flag banner
        if (this.type === 'whiteflag' && this.flag && this.flagGeo) {
            const positions = this.flagGeo.attributes.position;
            for (let i = 0; i < positions.count; i++) {
                const x = positions.getX(i);
                const wave = Math.sin(this.animTime * 3 + x * 2) * 0.2;
                positions.setZ(i, wave);
            }
            positions.needsUpdate = true;
        }
    }

    checkCollision(playerBox) {
        if (!this.active || this.hit) return false;

        const halfWidth = (this.width || 1) / 2;
        const height = this.height || 2;

        // Standard collision from ground up (Removed slide-under logic)
        this.collisionBox.min.set(
            this.mesh.position.x - halfWidth,
            0,
            this.mesh.position.z - 0.5
        );
        this.collisionBox.max.set(
            this.mesh.position.x + halfWidth,
            height,
            this.mesh.position.z + 0.5
        );

        return this.collisionBox.intersectsBox(playerBox);
    }

    checkNearMiss(playerBox) {
        if (!this.active || this.hit) return false;

        const margin = 0.3;
        this.nearMissBox.copy(this.collisionBox);
        this.nearMissBox.expandByScalar(margin);

        return this.nearMissBox.intersectsBox(playerBox) && !this.collisionBox.intersectsBox(playerBox);
    }

    markHit() {
        this.hit = true;
    }

    isOffScreen() {
        return this.mesh.position.z < -10;
    }
}

export class ObstacleManager {
    constructor(scene, curvedWorldUniforms) {
        this.scene = scene;
        this.curvedWorldUniforms = curvedWorldUniforms;
        this.lanes = [-3, 0, 3];
        this.spawnDistance = 80;
        this.minSpawnGap = 40; // Reduced density by ~40% as requested
        this.nextSpawnZ = 30;

        this.obstacleTypes = ['whiteflag', 'hydrant'];
        this.pool = [];
        this.poolSize = 30;

        // Shared models
        this.sharedModels = {
            hydrant: null
        };

        // Initialize pool immediately
        this.initPool();

        // Load Models
        this.loadModels().then(() => {
            console.log('✨ Obstacle models loaded, rebuilding pool...');
            this.rebuildPool();
        });
    }

    async loadModels() {
        const loader = new GLTFLoader();
        try {
            const gltf = await loader.loadAsync('assets/fire_hydrant.glb');
            this.sharedModels.hydrant = gltf.scene;
            console.log('🚒 Fire Hydrant loaded!');
        } catch (error) {
            console.warn('Could not load fire_hydrant.glb:', error);
        }
    }

    rebuildPool() {
        for (const obs of this.pool) {
            obs.rebuildMesh();
        }
    }

    initPool() {
        for (let i = 0; i < this.poolSize; i++) {
            // Less flags because they block everything
            const type = (i % 5 === 0) ? 'whiteflag' : 'hydrant';
            this.pool.push(new Obstacle(this.scene, type, this.sharedModels));
        }
        console.log('🎮 Obstacle pool initialized');
    }

    getFromPool(preferredType) {
        if (preferredType) {
            const found = this.pool.find(o => !o.active && o.type === preferredType);
            if (found) return found;
        }
        return this.pool.find(o => !o.active);
    }

    spawn(z) {
        // Mostly hydrants, occasional giant flag
        const type = this.random() < 0.15 ? 'whiteflag' : 'hydrant';
        const obstacle = this.getFromPool(type);

        if (obstacle) {
            const lane = this.lanes[Math.floor(this.random() * this.lanes.length)];
            obstacle.activate(lane, z);
        }
    }

    spawnGauntlet(z) {
        // For hydrants, spawn a row of 2 (leaving 1 gap)
        const gapLane = Math.floor(this.random() * 3);

        for (let i = 0; i < 3; i++) {
            if (i !== gapLane) {
                const obs = this.getFromPool('hydrant');
                if (obs) obs.activate(this.lanes[i], z);
            }
        }
    }

    update(deltaTime, speed, playerLane) {
        if (this.pool.length === 0) return;

        // Move
        for (const obs of this.pool) {
            if (obs.active) {
                obs.update(deltaTime, speed);
                if (obs.isOffScreen()) obs.deactivate();
            }
        }

        // Spawn logic fixed to prevent sparseness
        const activeObs = this.pool.filter(o => o.active);

        // Find the furthest Z (or use a sensible default if empty)
        let furthestZ = activeObs.length > 0
            ? Math.max(...activeObs.map(o => o.mesh.position.z))
            : 20; // Default start if empty

        if (furthestZ < this.spawnDistance) {
            // Calculate next spawn Z relative to the furthest object!
            // This ensures consistent difficulty/density
            const nextZ = Math.max(30, furthestZ + this.minSpawnGap + this.random() * 5);

            if (this.random() < 0.1) { // Reduced gauntlet chance (was 0.2)
                this.spawnGauntlet(nextZ);
            } else {
                this.spawn(nextZ);
            }
        }
    }

    getActiveObstacles() {
        return this.pool.filter(o => o.active);
    }

    reset() {
        for (const obs of this.pool) obs.deactivate();
        this.nextSpawnZ = 30;
    }

    random() {
        return this.prng ? this.prng.next() : Math.random();
    }
}
