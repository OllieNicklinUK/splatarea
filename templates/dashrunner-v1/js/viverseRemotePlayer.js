import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * VIVERSE Remote Player Component
 * 
 * Handles rendering and interpolation of remote avatars in the scene.
 * This is an Immutable component in the template platform layer.
 */
export class ViverseRemotePlayer {
    constructor(scene) {
        this.scene = scene;
        this.mesh = new THREE.Group();
        this.scene.add(this.mesh);

        this.characterModel = null;
        this.mixer = null;
        this.animations = {};
        
        // Target state for interpolation
        this.targetPosition = new THREE.Vector3();
        this.targetRotation = new THREE.Quaternion();
        this.groundY = 0;

        this.createPlaceholder();
    }

    createPlaceholder() {
        this.placeholder = new THREE.Mesh(
            new THREE.BoxGeometry(0.8, 2, 0.5),
            new THREE.MeshStandardMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.3 })
        );
        this.placeholder.position.y = 1;
        this.mesh.add(this.placeholder);
    }

    async loadAvatar(url) {
        if (!url) {
            // Default fallback if no URL provided
            url = 'public/assets/CHEF_Walking_withSkin.glb';
        }

        const loader = new GLTFLoader();
        try {
            const gltf = await loader.loadAsync(url);
            
            // Cleanup placeholder
            if (this.placeholder) {
                this.mesh.remove(this.placeholder);
                this.placeholder = null;
            }

            this.characterModel = gltf.scene;
            this.characterModel.scale.set(1.5, 1.5, 1.5);
            
            // Standard PBR lighting compliance
            this.characterModel.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                    // Blue tint to differentiate opponents
                    if (child.material) {
                        child.material.color.setHex(0xa0c4ff);
                    }
                }
            });

            this.mesh.add(this.characterModel);

            if (gltf.animations?.length > 0) {
                this.mixer = new THREE.AnimationMixer(this.characterModel);
                gltf.animations.forEach(clip => {
                    this.animations[clip.name] = this.mixer.clipAction(clip);
                });
                // Default to first loopable animation
                const runAnim = gltf.animations.find(n => n.name.toLowerCase().includes('run')) || gltf.animations[0];
                this.animations[runAnim.name].play();
            }
        } catch (e) {
            console.error('Remote avatar load failed:', e);
        }
    }

    setSyncData(x, y, z, quaternionArr) {
        this.targetPosition.set(x, y, z);
        if (quaternionArr) {
            this.targetRotation.fromArray(quaternionArr);
        }
    }

    update(deltaTime) {
        // Smooth interpolation (10 units per second)
        const lerpFactor = Math.min(deltaTime * 10, 1.0);
        
        this.mesh.position.lerp(this.targetPosition, lerpFactor);
        this.mesh.quaternion.slerp(this.targetRotation, lerpFactor);

        if (this.mixer) {
            this.mixer.update(deltaTime);
        }
    }

    setVisible(visible) {
        this.mesh.visible = visible;
    }

    reset() {
        this.mesh.position.set(0, 0, 0);
        this.mesh.rotation.set(0, 0, 0);
        this.targetPosition.set(0, 0, 0);
        this.targetRotation.set(0, 0, 0, 1);
    }
}
