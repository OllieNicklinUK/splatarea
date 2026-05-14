/**
 * RandomEvents.js - Fun random events like cats, birds, etc.
 * Adds life and unpredictability to the game
 */

import * as THREE from 'three';

class RunningCat {
    constructor(scene) {
        this.scene = scene;
        this.mesh = null;
        this.active = false;
        this.speed = 0;
        this.direction = 1; // 1 = left to right, -1 = right to left

        this.createMesh();
    }

    createMesh() {
        const group = new THREE.Group();

        // Cat body
        const bodyGeo = new THREE.CapsuleGeometry(0.3, 0.6, 4, 8);
        const catMaterial = new THREE.MeshStandardMaterial({
            color: 0x333333,
            roughness: 0.8
        });
        const body = new THREE.Mesh(bodyGeo, catMaterial);
        body.rotation.z = Math.PI / 2;
        body.position.y = 0.35;
        group.add(body);

        // Head
        const headGeo = new THREE.SphereGeometry(0.25, 8, 8);
        const head = new THREE.Mesh(headGeo, catMaterial);
        head.position.set(0.5, 0.5, 0);
        group.add(head);

        // Ears
        const earGeo = new THREE.ConeGeometry(0.1, 0.2, 4);
        const ear1 = new THREE.Mesh(earGeo, catMaterial);
        ear1.position.set(0.55, 0.7, 0.1);
        group.add(ear1);
        const ear2 = new THREE.Mesh(earGeo, catMaterial);
        ear2.position.set(0.55, 0.7, -0.1);
        group.add(ear2);

        // Tail
        const tailGeo = new THREE.CylinderGeometry(0.05, 0.03, 0.6, 6);
        const tail = new THREE.Mesh(tailGeo, catMaterial);
        tail.position.set(-0.6, 0.5, 0);
        tail.rotation.z = Math.PI / 3;
        group.add(tail);
        this.tail = tail;

        // Legs
        const legGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.3, 6);
        const positions = [[0.3, 0.15, 0.15], [0.3, 0.15, -0.15], [-0.3, 0.15, 0.15], [-0.3, 0.15, -0.15]];
        this.legs = [];
        positions.forEach(pos => {
            const leg = new THREE.Mesh(legGeo, catMaterial);
            leg.position.set(...pos);
            group.add(leg);
            this.legs.push(leg);
        });

        // Eyes (glowing)
        const eyeGeo = new THREE.SphereGeometry(0.05, 6, 6);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        const eye1 = new THREE.Mesh(eyeGeo, eyeMat);
        eye1.position.set(0.7, 0.55, 0.1);
        group.add(eye1);
        const eye2 = new THREE.Mesh(eyeGeo, eyeMat);
        eye2.position.set(0.7, 0.55, -0.1);
        group.add(eye2);

        group.visible = false;
        this.mesh = group;
        this.scene.add(group);
    }

    activate(z, direction = 1) {
        this.active = true;
        this.direction = direction;
        this.speed = 15 + Math.random() * 10;

        const startX = direction > 0 ? -15 : 15;
        this.mesh.position.set(startX, 0, z);
        this.mesh.rotation.y = direction > 0 ? 0 : Math.PI;
        this.mesh.visible = true;
        this.time = 0;
    }

    deactivate() {
        this.active = false;
        this.mesh.visible = false;
    }

    update(deltaTime, worldSpeed) {
        if (!this.active) return;

        this.time += deltaTime;

        // Move sideways
        this.mesh.position.x += this.speed * this.direction * deltaTime;

        // Move with world
        this.mesh.position.z -= worldSpeed * deltaTime;

        // Animate legs
        const runCycle = Math.sin(this.time * 20) * 0.5;
        this.legs[0].rotation.x = runCycle;
        this.legs[1].rotation.x = -runCycle;
        this.legs[2].rotation.x = -runCycle;
        this.legs[3].rotation.x = runCycle;

        // Animate tail
        this.tail.rotation.x = Math.sin(this.time * 10) * 0.3;

        // Deactivate when off screen
        if (Math.abs(this.mesh.position.x) > 20 || this.mesh.position.z < -10) {
            this.deactivate();
        }
    }
}

class FlyingBird {
    constructor(scene) {
        this.scene = scene;
        this.mesh = null;
        this.active = false;

        this.createMesh();
    }

    createMesh() {
        const group = new THREE.Group();

        // Body
        const bodyGeo = new THREE.SphereGeometry(0.15, 8, 8);
        const birdMat = new THREE.MeshStandardMaterial({ color: 0x4169e1 });
        const body = new THREE.Mesh(bodyGeo, birdMat);
        group.add(body);

        // Wings
        const wingGeo = new THREE.BoxGeometry(0.4, 0.02, 0.15);
        this.leftWing = new THREE.Mesh(wingGeo, birdMat);
        this.leftWing.position.set(-0.2, 0, 0);
        group.add(this.leftWing);

        this.rightWing = new THREE.Mesh(wingGeo, birdMat);
        this.rightWing.position.set(0.2, 0, 0);
        group.add(this.rightWing);

        // Beak
        const beakGeo = new THREE.ConeGeometry(0.05, 0.1, 4);
        const beakMat = new THREE.MeshBasicMaterial({ color: 0xffa500 });
        const beak = new THREE.Mesh(beakGeo, beakMat);
        beak.rotation.x = -Math.PI / 2;
        beak.position.z = 0.15;
        group.add(beak);

        group.visible = false;
        this.mesh = group;
        this.scene.add(group);
    }

    activate(startPos) {
        this.active = true;
        this.mesh.position.copy(startPos);
        this.mesh.visible = true;
        this.time = 0;
        this.speed = 8 + Math.random() * 5;
    }

    deactivate() {
        this.active = false;
        this.mesh.visible = false;
    }

    update(deltaTime, worldSpeed) {
        if (!this.active) return;

        this.time += deltaTime;

        // Fly upward and away
        this.mesh.position.y += this.speed * deltaTime;
        this.mesh.position.z -= worldSpeed * deltaTime;
        this.mesh.position.x += Math.sin(this.time * 3) * 0.1;

        // Flap wings
        const flap = Math.sin(this.time * 15) * 0.5;
        this.leftWing.rotation.z = -flap;
        this.rightWing.rotation.z = flap;

        // Deactivate when too high
        if (this.mesh.position.y > 20 || this.mesh.position.z < -10) {
            this.deactivate();
        }
    }
}

export class RandomEvents {
    constructor(scene) {
        this.scene = scene;

        // Cat pool - MORE CATS!
        this.cats = [];
        for (let i = 0; i < 8; i++) {
            this.cats.push(new RunningCat(scene));
        }

        // Bird pool - FLOCK OF BIRDS!
        this.birds = [];
        for (let i = 0; i < 15; i++) {
            this.birds.push(new FlyingBird(scene));
        }

        // Event timing - MUCH MORE FREQUENT!
        this.catTimer = 0;
        this.catInterval = 3 + Math.random() * 4; // Way more cats!

        this.birdTimer = 0;
        this.birdInterval = 5 + Math.random() * 5; // Periodic bird flocks!

        this.time = 0;
    }

    spawnCat(z) {
        const cat = this.cats.find(c => !c.active);
        if (cat) {
            const direction = Math.random() > 0.5 ? 1 : -1;
            cat.activate(z, direction);
            console.log('🐱 Cat spawned!');
        }
    }

    spawnBirds(position, count = 3) {
        let spawned = 0;
        for (const bird of this.birds) {
            if (!bird.active && spawned < count) {
                const offset = new THREE.Vector3(
                    (Math.random() - 0.5) * 2,
                    Math.random() * 0.5,
                    (Math.random() - 0.5) * 2
                );
                bird.activate(position.clone().add(offset));
                spawned++;
            }
        }
        if (spawned > 0) {
            console.log('🐦 Birds flew away!');
        }
    }

    update(deltaTime, worldSpeed, playerZ = 0) {
        this.time += deltaTime;

        // Cat spawning - MORE FREQUENT!
        this.catTimer += deltaTime;
        if (this.catTimer >= this.catInterval) {
            this.catTimer = 0;
            this.catInterval = 3 + Math.random() * 4;
            // Spawn cat ahead of player
            this.spawnCat(playerZ + 30 + Math.random() * 20);
        }

        // Bird spawning - periodic flocks!
        this.birdTimer += deltaTime;
        if (this.birdTimer >= this.birdInterval) {
            this.birdTimer = 0;
            this.birdInterval = 5 + Math.random() * 5;
            // Spawn a flock of birds
            const birdPos = new THREE.Vector3(
                (Math.random() - 0.5) * 10,
                0.5,
                playerZ + 20 + Math.random() * 15
            );
            this.spawnBirds(birdPos, 4 + Math.floor(Math.random() * 4));
        }

        // Update cats
        for (const cat of this.cats) {
            cat.update(deltaTime, worldSpeed);
        }

        // Update birds
        for (const bird of this.birds) {
            bird.update(deltaTime, worldSpeed);
        }
    }

    reset() {
        this.catTimer = 0;
        for (const cat of this.cats) {
            cat.deactivate();
        }
        for (const bird of this.birds) {
            bird.deactivate();
        }
    }
}
