/**
 * Environment.js - Scrolling World with Curved Shader Effect
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class Environment {
    constructor(scene, curvedWorldUniforms) {
        this.scene = scene;
        this.curvedWorldUniforms = curvedWorldUniforms;

        this.floorTextureOffset = 0;
        this.houseModel = null;
        this.houses = [];

        this.simpleMode = false; // Default to mesh mode (3D houses)

        this.createGround();
        this.createBuildings();
        this.createDecorations();
        this.loadHouseModel();
    }

    setSimpleMode(enabled) {
        this.simpleMode = enabled;

        // Toggle abstract buildings
        if (this.buildings) {
            this.buildings.forEach(b => b.visible = enabled);
        }

        // Toggle GLB houses
        if (this.houses) {
            this.houses.forEach(h => h.visible = !enabled);
        }

        console.log(`🎨 Display Mode: ${enabled ? 'Simple (Squares)' : 'Mesh (Houses)'}`);
    }

    createGround() {
        // Cobblestone ground texture (procedural)
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');

        // Base color
        ctx.fillStyle = '#4a4a4a';
        ctx.fillRect(0, 0, 256, 256);

        // Cobblestones
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                const offsetX = (y % 2) * 16;
                ctx.fillStyle = `hsl(30, 10%, ${35 + this.random() * 15}%)`;
                ctx.beginPath();
                ctx.roundRect(x * 32 + offsetX + 2, y * 32 + 2, 28, 28, 4);
                ctx.fill();
            }
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(8, 40);
        this.floorTexture = texture;

        // Ground plane
        const groundGeo = new THREE.PlaneGeometry(30, 200);
        const groundMat = new THREE.MeshStandardMaterial({
            map: texture,
            roughness: 0.9,
            metalness: 0.1
        });

        this.ground = new THREE.Mesh(groundGeo, groundMat);
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.position.z = 60;
        this.ground.receiveShadow = true;
        this.scene.add(this.ground);

        // Lane markers
        const laneMarkerGeo = new THREE.PlaneGeometry(0.1, 200);
        const laneMarkerMat = new THREE.MeshBasicMaterial({
            color: 0xFFD700,
            transparent: true,
            opacity: 0.3
        });

        [-4.5, 4.5].forEach(x => {
            const marker = new THREE.Mesh(laneMarkerGeo, laneMarkerMat);
            marker.rotation.x = -Math.PI / 2;
            marker.position.set(x, 0.01, 60);
            this.scene.add(marker);
        });
    }

    createBuildings() {
        this.buildings = [];
        const buildingColors = [0xE8D4B8, 0xD4A574, 0xC4956A, 0xF5E6D3, 0xE0C8A8];

        // Create buildings along both sides
        for (let side = -1; side <= 1; side += 2) {
            for (let i = 0; i < 15; i++) {
                const width = 4 + this.random() * 3;
                const height = 6 + this.random() * 8;
                const depth = 4 + this.random() * 2;

                const geometry = new THREE.BoxGeometry(width, height, depth);
                const material = new THREE.MeshStandardMaterial({
                    color: buildingColors[Math.floor(this.random() * buildingColors.length)],
                    roughness: 0.9
                });

                const building = new THREE.Mesh(geometry, material);
                building.position.set(
                    side * (10 + this.random() * 3),
                    height / 2,
                    i * 15 + this.random() * 5
                );
                building.castShadow = true;
                building.receiveShadow = true;

                // Add windows
                this.addWindows(building, width, height, side);

                // Add roof
                this.addRoof(building, width, depth);

                this.scene.add(building);
                this.buildings.push(building);
            }
        }
    }

    addWindows(building, width, height, side) {
        const windowGeo = new THREE.PlaneGeometry(0.8, 1.2);
        const windowMat = new THREE.MeshStandardMaterial({
            color: 0x87CEEB,
            emissive: 0x333366,
            emissiveIntensity: 0.3,
            roughness: 0.3,
            metalness: 0.5
        });

        const rows = Math.floor(height / 2.5);
        const cols = Math.floor(width / 2);

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const window = new THREE.Mesh(windowGeo, windowMat);
                window.position.set(
                    (c - cols / 2 + 0.5) * 1.8,
                    (r - rows / 2 + 0.5) * 2.5 + 0.5,
                    side * 2.01
                );
                building.add(window);
            }
        }
    }

    addRoof(building, width, depth) {
        const roofGeo = new THREE.ConeGeometry(Math.max(width, depth) * 0.7, 2, 4);
        const roofMat = new THREE.MeshStandardMaterial({
            color: 0x8B4513,
            roughness: 0.8
        });
        const roof = new THREE.Mesh(roofGeo, roofMat);
        roof.position.y = building.geometry.parameters.height / 2 + 1;
        roof.rotation.y = Math.PI / 4;
        building.add(roof);
    }

    createDecorations() {
        // Lamp posts
        this.lamps = [];
        const lampGeo = new THREE.CylinderGeometry(0.1, 0.15, 4, 8);
        const lampMat = new THREE.MeshStandardMaterial({ color: 0x333333 });

        for (let i = 0; i < 10; i++) {
            [-7, 7].forEach(x => {
                const lamp = new THREE.Mesh(lampGeo, lampMat);
                lamp.position.set(x, 2, i * 20);
                this.scene.add(lamp);

                // Light globe
                const globeGeo = new THREE.SphereGeometry(0.2, 8, 8);
                const globeMat = new THREE.MeshStandardMaterial({
                    color: 0xFFD700,
                    emissive: 0xFFAA00,
                    emissiveIntensity: 0.8
                });
                const globe = new THREE.Mesh(globeGeo, globeMat);
                globe.position.y = 2.2;
                lamp.add(globe);

                this.lamps.push(lamp);
            });
        }
    }

    update(deltaTime, speed) {
        // Scroll floor texture at same rate as buildings
        // Ground is 200 units, texture repeats 40x, so each tile = 5 units
        // Offset per unit = 1/5 = 0.2
        this.floorTextureOffset -= speed * deltaTime * (40 / 200);
        this.floorTexture.offset.y = this.floorTextureOffset;

        // Move buildings backward and recycle
        for (const building of this.buildings) {
            building.position.z -= speed * deltaTime;

            if (building.position.z < -20) {
                building.position.z += 220;
            }
        }

        // Move lampposts backward and recycle
        for (const lamp of this.lamps) {
            lamp.position.z -= speed * deltaTime;

            if (lamp.position.z < -20) {
                lamp.position.z += 200;
            }
        }

        // Update houses
        this.updateHouses(deltaTime, speed);
    }

    reset() {
        this.floorTextureOffset = 0;
        this.floorTexture.offset.y = 0;
    }

    updateTheme(theme) {
        // Update building colors
        if (theme.buildings && this.buildings) {
            this.buildings.forEach(building => {
                const colorHex = theme.buildings[Math.floor(this.random() * theme.buildings.length)];
                building.material.color.set(colorHex);
            });
        }

        // Update lamp globes
        this.scene.traverse(obj => {
            if (obj.isMesh && obj.material && obj.material.emissive) {
                if (obj.geometry.type === 'SphereGeometry') {
                    obj.material.emissive.set(theme.lamps.emissive);
                    obj.material.emissiveIntensity = theme.lamps.emissiveIntensity;
                }
            }
        });
    }

    loadHouseModel() {
        const loader = new GLTFLoader();
        loader.load(
            'assets/House_of_Reduced.glb',
            (gltf) => {
                this.houseModel = gltf.scene;

                // Base scale for the house model (will be multiplied by random variation)
                this.houseBaseScale = 30; // 10x bigger!

                // Configurable house transform settings
                this.houseXOffset = 15; // Distance from center
                this.houseY = 0; // Height offset
                this.houseRotationOffset = 0; // Additional rotation

                // Enable shadows
                this.houseModel.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });

                // Now create houses along the road
                this.createHouses();
                console.log('🏠 House model loaded!');

                // Hide simple buildings if in mesh mode
                if (!this.simpleMode && this.buildings) {
                    this.buildings.forEach(b => b.visible = false);
                }
            },
            undefined,
            (error) => {
                console.warn('Could not load house model:', error);
            }
        );
    }

    createHouses() {
        if (!this.houseModel) return;

        const houseCount = 10;
        const spacing = 40;

        for (let i = 0; i < houseCount; i++) {
            // Clone the house model
            const house = this.houseModel.clone();

            // Alternate left and right sides
            const side = i % 2 === 0 ? 1 : -1;
            const xPos = side * (this.houseXOffset + this.random() * 3);
            const zPos = i * spacing + 20;

            house.position.set(xPos, this.houseY, zPos);

            // Face toward the road
            house.rotation.y = (side > 0 ? -Math.PI / 2 : Math.PI / 2) + this.houseRotationOffset;

            // Random scale variation based on base scale
            const scaleVar = 0.8 + this.random() * 0.4; // 0.8 to 1.2
            const finalScale = this.houseBaseScale * scaleVar;
            house.scale.set(finalScale, finalScale, finalScale);

            this.houses.push(house);
            this.scene.add(house);

            // Set initial visibility
            house.visible = !this.simpleMode;
        }
    }

    // Update house transforms (called from DevMode when sliders change)
    updateHouseTransforms() {
        if (!this.houses || this.houses.length === 0) return;

        for (let i = 0; i < this.houses.length; i++) {
            const house = this.houses[i];
            const side = i % 2 === 0 ? 1 : -1;

            // Update X position
            house.position.x = side * (this.houseXOffset + (i * 0.1)); // slight variation

            // Update Y position
            house.position.y = this.houseY;

            // Update rotation
            house.rotation.y = (side > 0 ? -Math.PI / 2 : Math.PI / 2) + this.houseRotationOffset;

            // Update scale
            const scaleVar = 0.8 + ((i * 0.05) % 0.4);
            const finalScale = this.houseBaseScale * scaleVar;
            house.scale.set(finalScale, finalScale, finalScale);
        }
    }

    updateHouses(deltaTime, speed) {
        for (const house of this.houses) {
            house.position.z -= speed * deltaTime;

            if (house.position.z < -30) {
                house.position.z += this.houses.length * 40;
            }
        }
    }

    random() {
        return this.prng ? this.prng.next() : Math.random();
    }
}
