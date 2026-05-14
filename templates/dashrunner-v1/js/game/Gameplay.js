import { Environment } from './Environment.js';
import { ScoreManager } from './ScoreManager.js';
import { InputHandler } from './InputHandler.js';
import { CameraController } from './CameraController.js';
import { ThemeManager } from './ThemeManager.js';
import { Chaser } from './modules/Chaser.js';
import { ObstacleManager } from './modules/ObstacleManager.js';
import { CollectibleManager } from './modules/CollectibleManager.js';

/**
 * VIVERSE Runner Gameplay Module (Gameplay.js)
 *
 * This keeps the modular template entry point, but mirrors the original
 * DashRunner runtime order so publish builds feel like the reference sample.
 */
export class Gameplay {
    constructor() {
        this.app = null;
        this.input = new InputHandler();
        this.score = new ScoreManager();

        this.baseSpeed = 19.5;
        this.currentSpeed = this.baseSpeed;
        this.maxSpeed = 52;
        this.speedIncrement = 0.002;

        this.lives = 3;
        this.maxLives = 3;
        this.isInvulnerable = false;
        this.invulnerableTime = 2000;

        // Genre state
        this.targetLane = 1;

        this.wineSlowdownActive = false;
        this.wineSlowdownTimer = 0;
        this.wineSlowdownMultiplier = 0.5;
    }

    onInject(app) {
        this.app = app;
        this.env = new Environment(app.scene, app.curvedWorldUniforms);
        this.obstacles = new ObstacleManager(app.scene, app.curvedWorldUniforms);
        this.collectibles = new CollectibleManager(app.scene, app.curvedWorldUniforms);
        this.chaser = new Chaser(app.scene);
        this.cam = new CameraController(app.camera, app.player);
        this.themeManager = new ThemeManager(app);
        this.themeManager.setTheme('day');

        this.app.multiplayer.onMessageReceived = (data) => {
            // Identity Filtering: Discard self-broadcast loopback
            if (data.senderId === this.app.multiplayer.actorSessionId) return;

            if (data.type === 'player_sync' && Array.isArray(data.pos)) {
                this.app.remotePlayer.setSyncData(data.pos[0], data.pos[1], data.pos[2], data.rot);
                this.app.remotePlayer.setVisible(true);
            }
        };

        // Profile Syncing: Load the opponent's avatar model when they join
        this.app.multiplayer.onPlayersUpdated = (count) => {
            const actors = this.app.multiplayer.room?.actors || [];
            const opponent = actors.find(a => a.session_id !== this.app.multiplayer.actorSessionId);

            if (opponent && opponent.properties?.avatarUrl) {
                console.log(`👤 Competing against: ${opponent.name}`);
                this.app.remotePlayer.loadAvatar(opponent.properties.avatarUrl);
            }
        };
    }

    onStart() {
        this.currentSpeed = this.baseSpeed;
        this.lives = this.maxLives;
        this.isInvulnerable = false;
        this.wineSlowdownActive = false;
        this.wineSlowdownTimer = 0;

        this.input.reset();
        this.score.reset();
        this.app.player.reset();
        this.app.remotePlayer.reset();
        this.obstacles.reset();
        this.collectibles.reset();
        this.chaser.reset();
        if (this.app.particleBurst) this.app.particleBurst.reset();
        if (this.app.screenShake) this.app.screenShake.reset();
        this.updateLivesUI();
        this.updateSpeedUI();
        this.updateThemeDisplay();
    }

    onUpdate(dt) {
        const inputState = this.input.getInput();
        const player = this.app.player;
        const effectiveSpeed = this.getEffectiveSpeed();

        this.updateWineSlowdown(dt);

        player.update(dt, inputState, effectiveSpeed);
        // Sync targetLane for obstacle avoidance prediction
        this.targetLane = player.laneIndex;
        this.cam.update(dt, player);
        this.env.update(dt, effectiveSpeed);
        this.obstacles.update(dt, effectiveSpeed, this.targetLane);
        this.collectibles.update(dt, effectiveSpeed);
        this.chaser.update(dt, player.mesh.position.x);

        this.checkCollisions();

        this.score.addDistance(effectiveSpeed * dt);
        this.score.update(dt);

        if (this.currentSpeed < this.maxSpeed) {
            this.currentSpeed += this.speedIncrement;
        }

        this.updateSpeedUI();
    }

    getEffectiveSpeed() {
        let speed = this.currentSpeed;
        if (this.wineSlowdownActive) {
            speed *= this.wineSlowdownMultiplier;
        }
        return speed;
    }

    updateWineSlowdown(deltaTime) {
        if (!this.wineSlowdownActive) return;

        this.wineSlowdownTimer -= deltaTime;
        if (this.wineSlowdownTimer <= 0) {
            this.wineSlowdownActive = false;
            this.wineSlowdownTimer = 0;
            document.getElementById('game-container')?.classList.remove('wine-slowdown');
        }
    }

    activateWineSlowdown(duration = 1.5) {
        this.wineSlowdownActive = true;
        this.wineSlowdownTimer = duration;
        document.getElementById('game-container')?.classList.add('wine-slowdown');
    }

    loseLife() {
        if (this.isInvulnerable) return;

        this.lives -= 1;
        this.updateLivesUI();
        this.app.player.playHitAnimation();

        if (this.app.screenShake) {
            this.app.screenShake.mediumShake();
        }
        if (this.app.particleBurst) {
            this.app.particleBurst.emit(this.app.player.mesh.position);
        }

        document.getElementById('game-container')?.classList.add('flash-red');
        setTimeout(() => {
            document.getElementById('game-container')?.classList.remove('flash-red');
        }, 300);

        if (this.lives <= 0) {
            this.gameOver();
            return;
        }

        if (this.chaser) {
            this.chaser.increaseThreat(0.2);
        }

        this.isInvulnerable = true;
        this.app.player.setInvulnerable(true);
        setTimeout(() => {
            this.isInvulnerable = false;
            this.app.player.setInvulnerable(false);
        }, this.invulnerableTime);
    }

    gameOver() {
        this.app.endRun(this.score.score);
    }

    checkCollisions() {
        const playerBox = this.app.player.getCollisionBox();

        if (!this.isInvulnerable) {
            for (const obstacle of this.obstacles.getActiveObstacles()) {
                if (obstacle.checkCollision(playerBox)) {
                    this.loseLife();
                    obstacle.markHit();
                    break;
                }
            }
        }

        for (const obstacle of this.obstacles.getActiveObstacles()) {
            if (obstacle.checkNearMiss(playerBox) && !obstacle.nearMissTriggered) {
                this.score.triggerNearMiss();
                obstacle.nearMissTriggered = true;
                if (this.app.screenShake) {
                    this.app.screenShake.lightShake();
                }
            }
        }

        for (const collectible of this.collectibles.getActiveCollectibles()) {
            if (!collectible.checkCollision(playerBox)) continue;

            this.score.addCollectible(collectible.value);
            if (this.app.particleBurst) {
                this.app.particleBurst.emit(collectible.mesh.position);
            }
            collectible.collect();

            if (collectible.isPizza) {
                const earnedLife = this.collectibles.collectPizza();
                if (earnedLife && this.lives < this.maxLives) {
                    this.lives += 1;
                    this.updateLivesUI();
                }
            }

            if (collectible.isWine) {
                this.activateWineSlowdown(collectible.slowdownDuration || 1.5);
            }
        }
    }

    updateLivesUI() {
        const hearts = document.querySelectorAll('#lives-display .heart');
        hearts.forEach((heart, index) => {
            if (index < this.lives) {
                heart.classList.remove('lost');
            } else {
                heart.classList.add('lost');
                heart.classList.add('pulse');
                setTimeout(() => heart.classList.remove('pulse'), 300);
            }
        });
    }

    updateSpeedUI() {
        const speedFill = document.getElementById('speed-fill');
        if (!speedFill) return;
        const speedPercent = ((this.currentSpeed - this.baseSpeed) / (this.maxSpeed - this.baseSpeed)) * 100;
        speedFill.style.width = `${20 + speedPercent * 0.8}%`;
    }

    updateThemeDisplay() {
        const themeName = document.getElementById('theme-name');
        const currentTheme = this.themeManager?.themes?.[this.themeManager?.currentTheme];
        if (themeName && currentTheme) {
            themeName.textContent = currentTheme.name;
        }
    }
}
