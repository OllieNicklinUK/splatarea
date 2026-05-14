/**
 * CollectibleManager.js - Simplified to just Pizza and Wine
 * 
 * Pizza: Points + Pizza counter (4 pizzas = 1 extra life)
 * Wine: Slows game down for 3 seconds (easier mode)
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

class Collectible {
    constructor(scene, type, sharedModels) {
        this.scene = scene;
        this.type = type;
        this.active = false;
        this.collected = false;
        this.collisionBox = new THREE.Box3();
        this.sharedModels = sharedModels;

        this.createMesh(type);
    }

    rebuildMesh() {
        // Capture old position before it gets overwritten
        const oldPos = this.mesh ? this.mesh.position.clone() : new THREE.Vector3(0, 1, 0);

        // Remove old mesh
        if (this.mesh) {
            this.scene.remove(this.mesh);
        }

        // Create new mesh (this updates this.mesh)
        this.createMesh(this.type);

        // Restore state
        if (this.active) {
            this.mesh.visible = true;
            this.mesh.position.copy(oldPos);
            // Update the reference to the new position vector
            this.lastPosition = this.mesh.position;
        }
    }

    createMesh(type) {
        const group = new THREE.Group();
        // ... (rest of createMesh logic is fine, it will use sharedModels if available)

        switch (type) {
            case 'pizza':
                // Use loaded pizza model or placeholder
                if (this.sharedModels.pizza) {
                    const pizzaClone = this.sharedModels.pizza.clone();
                    pizzaClone.scale.set(0.6, 0.6, 0.6);
                    pizzaClone.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            if (child.material) {
                                child.material = child.material.clone();
                                child.material.emissive = new THREE.Color(0xFFAA00);
                                child.material.emissiveIntensity = 0.4;
                            }
                        }
                    });
                    group.add(pizzaClone);
                } else {
                    // Fallback placeholder
                    const pizzaGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.1, 16);
                    const pizzaMat = new THREE.MeshStandardMaterial({
                        color: 0xFFAA00,
                        emissive: 0xFF6600,
                        emissiveIntensity: 0.4
                    });
                    const pizza = new THREE.Mesh(pizzaGeo, pizzaMat);
                    pizza.rotation.x = Math.PI / 2;
                    group.add(pizza);
                }

                // Add Glowing Ring for better visibility
                const ringGeo = new THREE.TorusGeometry(0.7, 0.05, 8, 32);
                const ringMat = new THREE.MeshBasicMaterial({ color: 0xFFFF00 });
                const ring = new THREE.Mesh(ringGeo, ringMat);
                ring.rotation.x = Math.PI / 2; // Flat relative to group (which is upright)
                // But wait, group is rotated later? No.
                // Animate this ring in update()
                this.ring = ring;
                group.add(ring);

                this.value = 100;
                this.isPizza = true;
                break;

            case 'wine':
                // Wine bottle - use loaded GLB model
                if (this.sharedModels.wine) {
                    const wineClone = this.sharedModels.wine.clone();
                    wineClone.scale.set(0.8, 0.8, 0.8); // Adjust scale as needed
                    wineClone.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            if (child.material) {
                                child.material = child.material.clone();
                                child.material.emissive = new THREE.Color(0x4B0082);
                                child.material.emissiveIntensity = 0.3;
                            }
                        }
                    });
                    group.add(wineClone);
                } else {
                    // Fallback placeholder - simple bottle shape
                    const bottleGeo = new THREE.CylinderGeometry(0.12, 0.15, 0.8, 12);
                    const bottleMat = new THREE.MeshStandardMaterial({
                        color: 0x1a4d1a,
                        metalness: 0.3,
                        roughness: 0.2,
                        emissive: 0x4B0082,
                        emissiveIntensity: 0.3
                    });
                    const bottle = new THREE.Mesh(bottleGeo, bottleMat);
                    bottle.position.y = 0.4;
                    group.add(bottle);
                }

                // Add Glowing Ring for wine too (Purple)
                const wRingGeo = new THREE.TorusGeometry(0.6, 0.05, 8, 32);
                const wRingMat = new THREE.MeshBasicMaterial({ color: 0xFF00FF });
                const wRing = new THREE.Mesh(wRingGeo, wRingMat);
                wRing.rotation.x = Math.PI / 2;
                this.ring = wRing;
                group.add(wRing);

                this.value = 50;
                this.isWine = true;
                this.slowdownDuration = 1.5; // Short slowdown
                break;
        }

        group.position.y = 1;
        this.mesh = group;
        this.mesh.visible = false;
        this.scene.add(this.mesh);

        // Store reference for rebuilding
        this.lastPosition = this.mesh.position;
    }

    activate(x, z) {
        this.active = true;
        this.collected = false;
        this.mesh.position.set(x, 1, z);
        this.mesh.visible = true;
        this.lastPosition = this.mesh.position;
    }

    deactivate() {
        this.active = false;
        this.mesh.visible = false;
    }

    update(deltaTime, speed) {
        if (!this.active) return;

        this.mesh.position.z -= speed * deltaTime;

        // Spin and bob animation
        this.mesh.rotation.y += deltaTime * 2;
        this.mesh.position.y = 1 + Math.sin(Date.now() * 0.004) * 0.15;

        // Ring animation (pulse)
        if (this.ring) {
            const scale = 1 + Math.sin(Date.now() * 0.01) * 0.1;
            this.ring.scale.set(scale, scale, scale);
        }
    }

    checkCollision(playerBox) {
        if (!this.active || this.collected) return false;

        const size = this.type === 'wine' ? 0.4 : 0.6;
        this.collisionBox.min.set(
            this.mesh.position.x - size,
            this.mesh.position.y - size,
            this.mesh.position.z - size
        );
        this.collisionBox.max.set(
            this.mesh.position.x + size,
            this.mesh.position.y + size,
            this.mesh.position.z + size
        );

        return this.collisionBox.intersectsBox(playerBox);
    }

    collect() {
        this.collected = true;
        this.active = false;
        this.mesh.visible = false;
    }

    isOffScreen() {
        return this.mesh.position.z < -10;
    }
}

export class CollectibleManager {
    constructor(scene, curvedWorldUniforms) {
        this.scene = scene;
        this.curvedWorldUniforms = curvedWorldUniforms;
        this.lanes = [-3, 0, 3];
        this.pool = [];
        this.poolSize = 40;
        this.spawnGap = 20; // Increased spacing by ~30%
        this.nextSpawnZ = 30;

        // Pizza counter for extra lives
        this.pizzaCount = 0;
        this.pizzasForLife = 4;

        // Shared models (loaded once)
        this.sharedModels = {
            pizza: null,
            wine: null
        };

        // Initialize pool immediately (with placeholders)
        this.initPool();

        // Load models in background (items will use placeholders until loaded)
        this.loadModels().then(() => {
            console.log('✨ Models loaded, rebuilding pool meshes...');
            this.rebuildPool();
        });
    }

    rebuildPool() {
        for (const item of this.pool) {
            item.rebuildMesh();
        }
    }

    async loadModels() {
        const loader = new GLTFLoader();

        try {
            const gltf = await loader.loadAsync('assets/Pizza.glb');
            this.sharedModels.pizza = gltf.scene;
            console.log('🍕 Pizza model loaded!');
        } catch (error) {
            console.warn('Could not load Pizza.glb, using placeholder:', error);
        }

        try {
            const gltf = await loader.loadAsync('assets/wine.glb');
            this.sharedModels.wine = gltf.scene;
            console.log('🍷 Wine model loaded!');
        } catch (error) {
            console.warn('Could not load wine.glb, using placeholder:', error);
        }
    }

    initPool() {
        // 70% pizzas, 30% wine bottles
        for (let i = 0; i < this.poolSize; i++) {
            const type = (i % 10 < 7) ? 'pizza' : 'wine';
            this.pool.push(new Collectible(this.scene, type, this.sharedModels));
        }
        console.log('🎮 Collectible pool initialized:', this.poolSize, 'items');
    }

    getFromPool(preferredType = null) {
        // Try to get preferred type first
        if (preferredType) {
            for (const item of this.pool) {
                if (!item.active && item.type === preferredType) return item;
            }
        }
        // Fallback to any inactive
        for (const item of this.pool) {
            if (!item.active) return item;
        }
        return null;
    }

    spawn(z) {
        // Decide what to spawn - 88% pizza, 12% wine (wine is rare!)
        const type = this.random() < 0.88 ? 'pizza' : 'wine';
        const item = this.getFromPool(type);

        if (item) {
            const lane = this.lanes[Math.floor(this.random() * this.lanes.length)];
            item.activate(lane, z);
        }
    }

    // Spawn a trail of pizzas
    spawnPizzaTrail(startLane, startZ, count = 3) {
        let z = startZ;
        for (let i = 0; i < count; i++) {
            const item = this.getFromPool('pizza');
            if (item) {
                item.activate(startLane, z);
                z += 4;
            }
        }
    }

    update(deltaTime, speed) {
        // Safety check
        if (this.pool.length === 0) return;

        // Move items
        for (const item of this.pool) {
            if (item.active) {
                item.update(deltaTime, speed);
                if (item.isOffScreen()) item.deactivate();
            }
        }

        // Spawn logic fixed to prevent sparseness
        const activeItems = this.pool.filter(i => i.active);

        let furthestZ = activeItems.length > 0
            ? Math.max(...activeItems.map(i => i.mesh.position.z))
            : 20;

        if (furthestZ < 60) {
            const nextZ = Math.max(30, furthestZ + this.spawnGap + this.random() * 6);

            // 10% chance for a trail
            if (this.random() < 0.1) {
                const lane = this.lanes[Math.floor(this.random() * this.lanes.length)];
                this.spawnPizzaTrail(lane, nextZ);
            } else {
                this.spawn(nextZ);
            }
        }
    }

    getActiveCollectibles() {
        return this.pool.filter(i => i.active);
    }

    collectPizza() {
        this.pizzaCount++;
        this.updatePizzaUI();

        if (this.pizzaCount >= this.pizzasForLife) {
            this.pizzaCount = 0;
            this.updatePizzaUI();
            return true; // Earned an extra life!
        }
        return false;
    }

    updatePizzaUI() {
        const pizzaCounter = document.getElementById('pizza-counter');
        if (pizzaCounter) {
            pizzaCounter.textContent = `🍕 ${this.pizzaCount}/${this.pizzasForLife}`;
        }
    }

    reset() {
        for (const item of this.pool) {
            item.deactivate();
        }
        this.nextSpawnZ = 30;
        this.pizzaCount = 0;
        this.updatePizzaUI();
    }

    random() {
        return this.prng ? this.prng.next() : Math.random();
    }
}
