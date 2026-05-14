/**
 * VisualEffects.js - Speed Lines, Particle Bursts, Screen Shake, Dynamic Sky
 * Visual juice to make the game feel amazing!
 */

import * as THREE from 'three';

export class SpeedLines {
    constructor(scene) {
        this.scene = scene;
        this.lines = [];
        this.lineCount = 60;  // DOUBLE the lines!
        this.isActive = false;
        this.speedThreshold = 15; // Start earlier

        this.createSpeedLines();
    }

    createSpeedLines() {
        const lineMaterial = new THREE.LineBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.6
        });

        for (let i = 0; i < this.lineCount; i++) {
            const points = [
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0, 0, -2)
            ];
            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const line = new THREE.Line(geometry, lineMaterial.clone());

            line.visible = false;
            line.userData = {
                baseX: (Math.random() - 0.5) * 15,
                baseY: Math.random() * 8,
                speed: 0.5 + Math.random() * 0.5,
                length: 1 + Math.random() * 2
            };

            this.scene.add(line);
            this.lines.push(line);
        }
    }

    update(deltaTime, currentSpeed, playerX) {
        const intensity = Math.max(0, (currentSpeed - this.speedThreshold) / 20);
        this.isActive = intensity > 0;

        for (let i = 0; i < this.lines.length; i++) {
            const line = this.lines[i];
            const data = line.userData;

            if (this.isActive && Math.random() < intensity * 0.3) {
                line.visible = true;

                // Position around player view
                line.position.x = playerX + data.baseX;
                line.position.y = data.baseY;
                line.position.z = 10 + Math.random() * 40;

                // Scale based on speed
                line.scale.z = data.length * intensity;

                // Opacity based on intensity
                line.material.opacity = 0.3 + intensity * 0.4;
            }

            if (line.visible) {
                line.position.z -= currentSpeed * data.speed * deltaTime;

                // Reset when behind camera
                if (line.position.z < -5) {
                    line.visible = false;
                }
            }
        }
    }

    reset() {
        for (const line of this.lines) {
            line.visible = false;
        }
    }
}

export class ParticleBurst {
    constructor(scene) {
        this.scene = scene;
        this.bursts = [];
        this.maxBursts = 10;  // MORE BURSTS!

        this.createBurstPool();
    }

    createBurstPool() {
        for (let i = 0; i < this.maxBursts; i++) {
            const burst = this.createBurst();
            burst.mesh.visible = false;
            burst.active = false;
            this.bursts.push(burst);
        }
    }

    createBurst() {
        const particleCount = 50;  // MORE PARTICLES!
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const colors = new Float32Array(particleCount * 3);
        const sizes = new Float32Array(particleCount);

        for (let i = 0; i < particleCount; i++) {
            positions[i * 3] = 0;
            positions[i * 3 + 1] = 0;
            positions[i * 3 + 2] = 0;

            // Gold/yellow colors
            colors[i * 3] = 1;
            colors[i * 3 + 1] = 0.8 + Math.random() * 0.2;
            colors[i * 3 + 2] = Math.random() * 0.3;

            sizes[i] = 0.2 + Math.random() * 0.3;
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

        const material = new THREE.PointsMaterial({
            size: 0.3,
            vertexColors: true,
            transparent: true,
            opacity: 1,
            blending: THREE.AdditiveBlending
        });

        const mesh = new THREE.Points(geometry, material);
        this.scene.add(mesh);

        // Velocity data for each particle
        const velocities = [];
        for (let i = 0; i < particleCount; i++) {
            velocities.push({
                x: (Math.random() - 0.5) * 8,
                y: Math.random() * 6 + 2,
                z: (Math.random() - 0.5) * 8
            });
        }

        return {
            mesh,
            velocities,
            life: 0,
            maxLife: 1.0,
            active: false,
            origin: new THREE.Vector3()
        };
    }

    emit(position, color = null) {
        // Find inactive burst
        const burst = this.bursts.find(b => !b.active);
        if (!burst) return;

        burst.active = true;
        burst.life = burst.maxLife;
        burst.origin.copy(position);
        burst.mesh.visible = true;

        // Reset positions
        const positions = burst.mesh.geometry.attributes.position.array;
        for (let i = 0; i < positions.length; i += 3) {
            positions[i] = position.x;
            positions[i + 1] = position.y;
            positions[i + 2] = position.z;
        }
        burst.mesh.geometry.attributes.position.needsUpdate = true;

        // Randomize velocities
        for (const vel of burst.velocities) {
            vel.x = (Math.random() - 0.5) * 10;
            vel.y = Math.random() * 8 + 3;
            vel.z = (Math.random() - 0.5) * 10;
        }

        // Update colors if specified
        if (color) {
            const colors = burst.mesh.geometry.attributes.color.array;
            for (let i = 0; i < colors.length; i += 3) {
                colors[i] = color.r;
                colors[i + 1] = color.g;
                colors[i + 2] = color.b;
            }
            burst.mesh.geometry.attributes.color.needsUpdate = true;
        }
    }

    update(deltaTime) {
        for (const burst of this.bursts) {
            if (!burst.active) continue;

            burst.life -= deltaTime;

            if (burst.life <= 0) {
                burst.active = false;
                burst.mesh.visible = false;
                continue;
            }

            const positions = burst.mesh.geometry.attributes.position.array;
            const particleCount = positions.length / 3;

            for (let i = 0; i < particleCount; i++) {
                const vel = burst.velocities[i];

                positions[i * 3] += vel.x * deltaTime;
                positions[i * 3 + 1] += vel.y * deltaTime;
                positions[i * 3 + 2] += vel.z * deltaTime;

                // Gravity
                vel.y -= 15 * deltaTime;
            }

            burst.mesh.geometry.attributes.position.needsUpdate = true;

            // Fade out
            burst.mesh.material.opacity = burst.life / burst.maxLife;
        }
    }

    reset() {
        for (const burst of this.bursts) {
            burst.active = false;
            burst.mesh.visible = false;
        }
    }
}

export class ScreenShake {
    constructor(camera) {
        this.camera = camera;
        this.originalPosition = new THREE.Vector3();
        this.shakeIntensity = 0;
        this.shakeDuration = 0;
        this.shakeFrequency = 30;
        this.time = 0;
    }

    shake(intensity = 0.5, duration = 0.3) {
        this.shakeIntensity = intensity;
        this.shakeDuration = duration;
        this.originalPosition.copy(this.camera.position);
    }

    // Light shake for near misses
    lightShake() {
        this.shake(0.15, 0.15);
    }

    // Medium shake for hits
    mediumShake() {
        this.shake(0.4, 0.25);
    }

    // Heavy shake for big events
    heavyShake() {
        this.shake(0.8, 0.4);
    }

    update(deltaTime) {
        if (this.shakeDuration <= 0) return;

        this.time += deltaTime;
        this.shakeDuration -= deltaTime;

        const decay = this.shakeDuration > 0 ? 1 : 0;
        const offsetX = Math.sin(this.time * this.shakeFrequency) * this.shakeIntensity * decay;
        const offsetY = Math.cos(this.time * this.shakeFrequency * 1.3) * this.shakeIntensity * decay * 0.7;

        this.camera.position.x = this.originalPosition.x + offsetX;
        this.camera.position.y = this.originalPosition.y + offsetY;

        if (this.shakeDuration <= 0) {
            this.shakeIntensity = 0;
        }
    }

    reset() {
        this.shakeDuration = 0;
        this.shakeIntensity = 0;
    }
}

export class DynamicSky {
    constructor(scene) {
        this.scene = scene;
        this.time = 0;
        this.clouds = [];
        this.sunAngle = 0;

        this.createClouds();
    }

    createClouds() {
        const cloudCount = 25;  // MORE CLOUDS!
        const cloudMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.8,
            fog: false
        });

        for (let i = 0; i < cloudCount; i++) {
            const cloud = this.createCloudMesh(cloudMaterial);

            cloud.position.set(
                (Math.random() - 0.5) * 100,
                15 + Math.random() * 20,
                Math.random() * 150
            );

            cloud.userData = {
                speed: 2 + Math.random() * 3,
                baseY: cloud.position.y,
                bobSpeed: 0.5 + Math.random() * 0.5,
                bobAmount: 0.5 + Math.random() * 0.5
            };

            cloud.scale.setScalar(2 + Math.random() * 3);

            this.scene.add(cloud);
            this.clouds.push(cloud);
        }
    }

    createCloudMesh(material) {
        const cloud = new THREE.Group();

        // Create fluffy cloud from multiple spheres
        const puffCount = 5 + Math.floor(Math.random() * 4);
        const puffGeo = new THREE.SphereGeometry(1, 8, 8);

        for (let i = 0; i < puffCount; i++) {
            const puff = new THREE.Mesh(puffGeo, material.clone());
            puff.position.set(
                (Math.random() - 0.5) * 3,
                (Math.random() - 0.5) * 1,
                (Math.random() - 0.5) * 2
            );
            puff.scale.setScalar(0.6 + Math.random() * 0.8);
            cloud.add(puff);
        }

        return cloud;
    }

    update(deltaTime, gameSpeed = 15) {
        this.time += deltaTime;

        // Move clouds
        for (const cloud of this.clouds) {
            const data = cloud.userData;

            // Move with world
            cloud.position.z -= gameSpeed * deltaTime * 0.3;

            // Gentle floating
            cloud.position.y = data.baseY + Math.sin(this.time * data.bobSpeed) * data.bobAmount;

            // Recycle clouds
            if (cloud.position.z < -30) {
                cloud.position.z = 150 + Math.random() * 50;
                cloud.position.x = (Math.random() - 0.5) * 100;
            }
        }

        // Animate sun position (subtle)
        this.sunAngle = Math.sin(this.time * 0.1) * 0.2;
    }

    getSunDirection() {
        return new THREE.Vector3(
            Math.cos(this.sunAngle) * 30,
            50 + Math.sin(this.sunAngle) * 10,
            20
        );
    }

    setCloudOpacity(opacity) {
        for (const cloud of this.clouds) {
            cloud.traverse(child => {
                if (child.isMesh) {
                    child.material.opacity = opacity;
                }
            });
        }
    }

    reset() {
        this.time = 0;
        for (let i = 0; i < this.clouds.length; i++) {
            const cloud = this.clouds[i];
            cloud.position.z = Math.random() * 150;
        }
    }
}
