/**
 * CameraController.js - Smooth Camera Following with Lag
 */

import * as THREE from 'three';

export class CameraController {
    constructor(camera, player) {
        this.camera = camera;
        this.player = player;

        // Camera offset from player
        this.offset = new THREE.Vector3(0, 5, -10);
        this.lookAheadOffset = new THREE.Vector3(0, 2, 15);

        // Smoothing factors
        this.positionLag = 3;
        this.heightLag = 2;
        this.lookAtLag = 5;

        // Target positions
        this.targetPosition = new THREE.Vector3();
        this.targetLookAt = new THREE.Vector3();
        this.currentLookAt = new THREE.Vector3(0, 2, 20);

        // Screen shake
        this.shakeIntensity = 0;
        this.shakeDuration = 0;
    }

    reset() {
        this.camera.position.set(0, 5, -10);
        this.currentLookAt.set(0, 2, 20);
        this.camera.lookAt(this.currentLookAt);
        this.shakeIntensity = 0;
    }

    shake(intensity = 0.5, duration = 0.3) {
        this.shakeIntensity = intensity;
        this.shakeDuration = duration;
    }

    update(deltaTime, player) {
        // Calculate target position based on player
        this.targetPosition.set(
            player.mesh.position.x * 0.3, // Slight follow on X
            this.offset.y + player.mesh.position.y * 0.3, // Follow jumps slightly
            this.offset.z
        );

        // Lerp camera position
        this.camera.position.x += (this.targetPosition.x - this.camera.position.x) * this.positionLag * deltaTime;
        this.camera.position.y += (this.targetPosition.y - this.camera.position.y) * this.heightLag * deltaTime;

        // Calculate look-at target
        this.targetLookAt.set(
            player.mesh.position.x * 0.5,
            this.lookAheadOffset.y + player.mesh.position.y * 0.2,
            this.lookAheadOffset.z
        );

        // Lerp look-at
        this.currentLookAt.lerp(this.targetLookAt, this.lookAtLag * deltaTime);

        // Apply screen shake
        if (this.shakeDuration > 0) {
            this.shakeDuration -= deltaTime;
            const shake = new THREE.Vector3(
                (Math.random() - 0.5) * this.shakeIntensity,
                (Math.random() - 0.5) * this.shakeIntensity,
                0
            );
            this.camera.position.add(shake);
        }

        this.camera.lookAt(this.currentLookAt);
    }
}
