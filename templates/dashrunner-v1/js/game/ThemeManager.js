/**
 * ThemeManager.js - Visual Theme System
 * Handles switching between Night, Day, and future themes
 */

import * as THREE from 'three';

export const THEMES = {
    night: {
        name: 'Sunset Night',
        sky: {
            topColor: '#1a1a2e',
            midColor: '#4a1942',
            bottomColor: '#C41E3A'
        },
        fog: {
            color: 0x4a1942,
            near: 30,
            far: 100
        },
        ambient: {
            color: 0xffffff,
            intensity: 0.7
        },
        sun: {
            color: 0xffd580,
            intensity: 1.2,
            position: { x: 20, y: 30, z: 10 }
        },
        fill: {
            color: 0xff6b35,
            intensity: 0.3
        },
        rim: {
            color: 0x4a90d9,
            intensity: 0.4
        },
        buildings: ['#E8D4B8', '#D4A574', '#C4956A', '#F5E6D3', '#E0C8A8'],
        ground: '#4a4a4a',
        lamps: {
            emissive: 0xFFAA00,
            emissiveIntensity: 0.8
        },
        exposure: 1.8,
        bloom: { strength: 0.5, radius: 0.4, threshold: 0.85 }
    },

    day: {
        name: 'Sunny Tuscany',
        sky: {
            topColor: '#1e90ff',
            midColor: '#87ceeb',
            bottomColor: '#f0e68c'
        },
        fog: {
            color: 0x87ceeb,
            near: 50,
            far: 150
        },
        ambient: {
            color: 0xffffff,
            intensity: 1.0
        },
        sun: {
            color: 0xfffacd,
            intensity: 1.8,
            position: { x: 30, y: 50, z: 20 }
        },
        fill: {
            color: 0x87ceeb,
            intensity: 0.4
        },
        rim: {
            color: 0xffd700,
            intensity: 0.3
        },
        buildings: ['#FFF8DC', '#FAEBD7', '#FFE4C4', '#FFDAB9', '#F5DEB3'],
        ground: '#8B7355',
        lamps: {
            emissive: 0x333333,
            emissiveIntensity: 0.1
        },
        exposure: 2.0,
        bloom: { strength: 0.3, radius: 0.3, threshold: 0.9 }
    },

    golden: {
        name: 'Golden Hour',
        sky: {
            topColor: '#4169e1',
            midColor: '#ff8c00',
            bottomColor: '#ff4500'
        },
        fog: {
            color: 0xff8c00,
            near: 40,
            far: 120
        },
        ambient: {
            color: 0xfff0d0,
            intensity: 0.8
        },
        sun: {
            color: 0xffa500,
            intensity: 2.0,
            position: { x: 50, y: 15, z: 30 }
        },
        fill: {
            color: 0xff6347,
            intensity: 0.5
        },
        rim: {
            color: 0xffd700,
            intensity: 0.6
        },
        buildings: ['#FFD4A3', '#FFCC80', '#FFB347', '#FFA07A', '#FF8C69'],
        ground: '#8B6914',
        lamps: {
            emissive: 0xFFD700,
            emissiveIntensity: 0.5
        },
        exposure: 1.6,
        bloom: { strength: 0.7, radius: 0.5, threshold: 0.75 }
    }
};

export class ThemeManager {
    constructor(game) {
        this.game = game;
        this.currentTheme = 'day'; // Default to day
        this.themes = THEMES;
    }

    setTheme(themeName) {
        if (!this.themes[themeName]) {
            console.warn(`Theme "${themeName}" not found`);
            return;
        }

        this.currentTheme = themeName;
        const theme = this.themes[themeName];

        console.log(`🎨 Switching to theme: ${theme.name}`);

        // Update sky
        this.updateSky(theme);

        // Update fog
        this.game.scene.fog.color.set(theme.fog.color);
        this.game.scene.fog.near = theme.fog.near;
        this.game.scene.fog.far = theme.fog.far;

        // Update lights
        this.updateLights(theme);

        // Update post-processing
        this.game.renderer.toneMappingExposure = theme.exposure;
        this.game.bloomPass.strength = theme.bloom.strength;
        this.game.bloomPass.radius = theme.bloom.radius;
        this.game.bloomPass.threshold = theme.bloom.threshold;

        // Update environment (if available)
        if (this.game.environment) {
            this.game.environment.updateTheme(theme);
        }
    }

    updateSky(theme) {
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 256;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 256);
        gradient.addColorStop(0, theme.sky.topColor);
        gradient.addColorStop(0.5, theme.sky.midColor);
        gradient.addColorStop(1, theme.sky.bottomColor);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 2, 256);

        const skyTexture = new THREE.CanvasTexture(canvas);
        this.game.scene.background = skyTexture;
    }

    updateLights(theme) {
        // Ambient
        if (this.game.ambientLight) {
            this.game.ambientLight.color.set(theme.ambient.color);
            this.game.ambientLight.intensity = theme.ambient.intensity;
        }

        // Sun
        if (this.game.sunLight) {
            this.game.sunLight.color.set(theme.sun.color);
            this.game.sunLight.intensity = theme.sun.intensity;
            this.game.sunLight.position.set(
                theme.sun.position.x,
                theme.sun.position.y,
                theme.sun.position.z
            );
        }

        // Fill
        if (this.game.fillLight) {
            this.game.fillLight.color.set(theme.fill.color);
            this.game.fillLight.intensity = theme.fill.intensity;
        }

        // Rim
        if (this.game.rimLight) {
            this.game.rimLight.color.set(theme.rim.color);
            this.game.rimLight.intensity = theme.rim.intensity;
        }
    }

    nextTheme() {
        const themeNames = Object.keys(this.themes);
        const currentIndex = themeNames.indexOf(this.currentTheme);
        const nextIndex = (currentIndex + 1) % themeNames.length;
        this.setTheme(themeNames[nextIndex]);
    }

    getThemeNames() {
        return Object.keys(this.themes).map(key => ({
            id: key,
            name: this.themes[key].name
        }));
    }
}
