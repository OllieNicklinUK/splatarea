import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

class AssetEditor {
    constructor() {
        this.config = { obstacles: [], collectibles: [] };
        this.currentAsset = null;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.previewMesh = null;
        this.playerDummy = null;
        this.animationId = null;
        this.isSimulating = false;

        this.initThreeJS();
        this.initUI();
        this.loadConfig();
    }

    initThreeJS() {
        const container = document.getElementById('canvas-container');

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x111111);

        // Grid
        const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
        this.scene.add(gridHelper);

        // Lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
        dirLight.position.set(5, 10, 7);
        this.scene.add(dirLight);

        // Camera
        this.camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 100);
        this.camera.position.set(3, 3, 5);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(this.renderer.domElement);

        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;

        // Player Dummy (for physics preview)
        const playerGeo = new THREE.BoxGeometry(0.5, 1.0, 0.5);
        const playerMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, transparent: true, opacity: 0.5 });
        this.playerDummy = new THREE.Mesh(playerGeo, playerMat);
        this.playerDummy.visible = false;
        this.scene.add(this.playerDummy);

        // Animation Loop
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);

        // Handle Resize
        window.addEventListener('resize', () => {
            this.camera.aspect = container.clientWidth / container.clientHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(container.clientWidth, container.clientHeight);
        });
    }

    initUI() {
        // Sidebar inputs
        document.getElementById('add-asset-btn').addEventListener('click', () => this.addNewAsset());
        document.getElementById('download-btn').addEventListener('click', () => this.downloadConfig());
        document.getElementById('save-btn').addEventListener('click', () => this.saveToLocalStorage());

        // Property inputs
        const inputs = [
            'prop-name', 'prop-type', 'prop-points', 'prop-model-type',
            'prop-geometry', 'prop-color', 'prop-emissive', 'prop-model-path',
            'prop-scale', 'prop-effect'
        ];

        inputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('change', (e) => this.updateCurrentAsset(e.target.id, e.target.value));
                el.addEventListener('input', (e) => {
                    // Real-time update for some fields
                    if (id === 'prop-color' || id === 'prop-emissive') {
                        this.updateCurrentAsset(id, e.target.value);
                    }
                });
            }
        });

        // Viewport controls
        document.getElementById('reset-cam-btn').addEventListener('click', () => {
            this.camera.position.set(3, 3, 5);
            this.controls.reset();
        });

        document.getElementById('preview-anim-btn').addEventListener('click', () => this.simulateCollision());

        document.getElementById('toggle-grid-btn').addEventListener('click', () => {
            const grid = this.scene.children.find(c => c instanceof THREE.GridHelper);
            if (grid) grid.visible = !grid.visible;
        });

        // GLB File Picker
        const fileUploader = document.getElementById('file-uploader');
        document.getElementById('browse-btn').addEventListener('click', () => fileUploader.click());
        fileUploader.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                // In a real app we'd upload this. Here we just set the name and pretend.
                // Or we can use a local object URL for preview.
                const path = `assets/${file.name}`;
                document.getElementById('prop-model-path').value = path;
                this.updateCurrentAsset('prop-model-path', path);

                // For preview ONLY, use object URL
                const url = URL.createObjectURL(file);
                this.previewGLB(url);
            }
        });
    }

    async loadConfig() {
        try {
            const response = await fetch('game-config.json');
            if (response.ok) {
                this.config = await response.json();
                this.renderAssetList();
                // Select first item
                if (this.config.obstacles.length > 0) {
                    this.selectAsset(this.config.obstacles[0]);
                }
            } else {
                console.warn('Config not found, starting fresh.');
            }
        } catch (e) {
            console.error('Error loading config:', e);
        }
    }

    renderAssetList() {
        const list = document.getElementById('asset-list');
        list.innerHTML = '';

        const allAssets = [
            ...this.config.obstacles.map(a => ({ ...a, _category: 'obstacle' })),
            ...this.config.collectibles.map(a => ({ ...a, _category: 'collectible' }))
        ];

        allAssets.forEach(asset => {
            const item = document.createElement('div');
            item.className = `asset-item ${this.currentAsset && this.currentAsset.id === asset.id ? 'active' : ''}`;
            item.onclick = () => this.selectAsset(asset);

            const icon = asset._category === 'obstacle' ? '🚧' : '💎';

            item.innerHTML = `
                <div class="asset-icon">${icon}</div>
                <div class="asset-info">
                    <div class="asset-name">${asset.name || asset.id}</div>
                    <div class="asset-type">${asset.type}</div>
                </div>
            `;
            list.appendChild(item);
        });
    }

    selectAsset(asset) {
        // Find the actual reference in config
        if (asset._category === 'obstacle') {
            this.currentAsset = this.config.obstacles.find(a => a.id === asset.id);
        } else {
            this.currentAsset = this.config.collectibles.find(a => a.id === asset.id);
        }

        this.renderAssetList(); // update active state
        this.populateInspector();
        this.update3DView();
    }

    populateInspector() {
        if (!this.currentAsset) return;

        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val !== undefined ? val : '';
        };

        setVal('prop-id', this.currentAsset.id);
        setVal('prop-name', this.currentAsset.name);
        setVal('prop-type', this.currentAsset.type);
        setVal('prop-points', this.currentAsset.points);
        setVal('prop-model-type', this.currentAsset.modelType);

        // Primitives
        setVal('prop-geometry', this.currentAsset.geometry);
        setVal('prop-color', this.currentAsset.color || '#ffffff');
        setVal('prop-emissive', this.currentAsset.emissive || '#000000');

        // GLB
        setVal('prop-model-path', this.currentAsset.modelPath);
        setVal('prop-scale', this.currentAsset.scale || 1.0);

        setVal('prop-effect', this.currentAsset.effect);

        // Toggle sections
        const isGlb = this.currentAsset.modelType === 'glb';
        document.getElementById('primitive-settings').style.display = isGlb ? 'none' : 'block';
        document.getElementById('glb-settings').classList.toggle('hidden', !isGlb);
    }

    updateCurrentAsset(field, value) {
        if (!this.currentAsset) return;

        switch (field) {
            case 'prop-name': this.currentAsset.name = value; break;
            case 'prop-type': this.currentAsset.type = value; break;
            case 'prop-points': this.currentAsset.points = parseInt(value); break;
            case 'prop-model-type':
                this.currentAsset.modelType = value;
                this.populateInspector(); // show/hide sections
                this.update3DView();
                break;
            case 'prop-geometry': this.currentAsset.geometry = value; this.update3DView(); break;
            case 'prop-color': this.currentAsset.color = value; this.update3DView(); break;
            case 'prop-emissive': this.currentAsset.emissive = value; this.update3DView(); break;
            case 'prop-scale': this.currentAsset.scale = parseFloat(value); this.update3DView(); break;
            case 'prop-model-path':
                this.currentAsset.modelPath = value;
                this.update3DView();
                break;
        }

        this.renderAssetList();
    }

    update3DView() {
        if (!this.currentAsset) return;

        // Clear existing mesh
        if (this.previewMesh) {
            this.scene.remove(this.previewMesh);
            this.previewMesh = null;
        }

        if (this.currentAsset.modelType === 'glb') {
            const path = this.currentAsset.modelPath;
            if (path) {
                // Check if it's a blob url (from file picker) or relative path
                this.previewGLB(path);
            }
        } else {
            // Primitive
            let geo;
            switch (this.currentAsset.geometry) {
                case 'box': geo = new THREE.BoxGeometry(1.5, 1.5, 1.5); break;
                case 'sphere': geo = new THREE.SphereGeometry(0.8, 32, 32); break;
                case 'cylinder': geo = new THREE.CylinderGeometry(0.6, 0.6, 1.5, 32); break;
                case 'torus': geo = new THREE.TorusGeometry(0.5, 0.2, 16, 32); break;
                default: geo = new THREE.BoxGeometry(1, 1, 1);
            }

            const mat = new THREE.MeshStandardMaterial({
                color: this.currentAsset.color || 0xcccccc,
                emissive: this.currentAsset.emissive || 0x000000,
                emissiveIntensity: 0.5,
                roughness: 0.7,
                metalness: 0.2
            });

            this.previewMesh = new THREE.Mesh(geo, mat);
            this.previewMesh.position.y = 0.75; // lift up
            this.scene.add(this.previewMesh);
        }
    }

    previewGLB(url) {
        const loader = new GLTFLoader();
        loader.load(url, (gltf) => {
            if (this.previewMesh) this.scene.remove(this.previewMesh);

            const model = gltf.scene;
            const scale = this.currentAsset.scale || 1.0;
            model.scale.set(scale, scale, scale);

            // Center the model?
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());

            model.position.x = -center.x;
            model.position.y = -box.min.y; // Sit on floor
            model.position.z = -center.z;

            this.previewMesh = new THREE.Group();
            this.previewMesh.add(model);
            this.scene.add(this.previewMesh);
        }, undefined, (error) => {
            console.error('Error loading GLB:', error);
        });
    }

    simulateCollision() {
        if (this.isSimulating) return;
        this.isSimulating = true;

        this.playerDummy.visible = true;
        this.playerDummy.position.set(0, 0.5, 10);

        let startTime = performance.now();
        const duration = 1000; // ms to reach center

        const animateSim = (time) => {
            if (!this.isSimulating) return;

            const elapsed = time - startTime;
            const progress = Math.min(elapsed / duration, 1.0);

            // Move player
            this.playerDummy.position.z = 10 - (progress * 10);

            if (progress >= 1.0) {
                // HIT!
                this.triggerHitEffect();
                this.isSimulating = false;
                this.playerDummy.visible = false;
                return;
            }

            requestAnimationFrame(animateSim);
        };

        requestAnimationFrame((t) => {
            startTime = t;
            animateSim(t);
        });
    }

    triggerHitEffect() {
        // Flash screen or mesh
        const originalColor = new THREE.Color().copy(this.scene.background);
        this.scene.background.set(0x552222); // Red flash

        setTimeout(() => {
            this.scene.background.copy(originalColor);
        }, 100);

        // Shake camera
        const shakeIntensity = 0.5;
        const originalCamPos = this.camera.position.clone();

        let shakeframes = 10;
        const shake = () => {
            if (shakeframes <= 0) {
                this.camera.position.copy(originalCamPos);
                return;
            }
            this.camera.position.x = originalCamPos.x + (Math.random() - 0.5) * shakeIntensity;
            this.camera.position.y = originalCamPos.y + (Math.random() - 0.5) * shakeIntensity;
            shakeframes--;
            requestAnimationFrame(shake);
        };
        shake();

        // Log points
        console.log(`💥 CRASH! Points: ${this.currentAsset.points} | Effect: ${this.currentAsset.effect}`);
    }

    animate() {
        requestAnimationFrame(this.animate);
        this.controls.update();

        // Spin preview object slightly
        if (this.previewMesh && !this.isSimulating) {
            this.previewMesh.rotation.y += 0.005;
        }

        this.renderer.render(this.scene, this.camera);
    }

    downloadConfig() {
        const data = JSON.stringify(this.config, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'game-config.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    saveToLocalStorage() {
        localStorage.setItem('crazyNonna_assets_config', JSON.stringify(this.config));
        alert('Config saved to local storage! (Game will need integration to read this)');
    }

    addNewAsset() {
        const newAsset = {
            id: 'new_item_' + Date.now(),
            name: 'New Item',
            type: 'obstacle',
            modelType: 'primitive',
            geometry: 'box',
            points: 0,
            effect: 'none'
        };
        this.config.obstacles.push(newAsset);
        this.selectAsset(newAsset);
    }
}

// Initialize on load
window.addEventListener('load', () => {
    new AssetEditor();
});
