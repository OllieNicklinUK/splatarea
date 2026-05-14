/**
 * BoostSystem.js - Boost Bar and Power-up Management
 * Collects energy, activates speed boost when full
 */

export class BoostSystem {
    constructor(game) {
        this.game = game;

        // Boost state
        this.boostEnergy = 0;
        this.maxEnergy = 100;
        this.energyPerCollect = 10;
        this.decayRate = 2; // Energy lost per second when not collecting

        // Boost activation
        this.isBoostActive = false;
        this.boostDuration = 5; // seconds
        this.boostTimer = 0;
        this.boostSpeedMultiplier = 1.5;

        // UI elements
        this.boostFill = document.getElementById('boost-fill');
        this.boostLabel = document.getElementById('boost-label');
    }

    addEnergy(amount = null) {
        const energy = amount || this.energyPerCollect;
        this.boostEnergy = Math.min(this.maxEnergy, this.boostEnergy + energy);
        this.updateUI();

        // Check if boost is ready
        if (this.boostEnergy >= this.maxEnergy && !this.isBoostActive) {
            this.activateBoost();
        }
    }

    activateBoost() {
        this.isBoostActive = true;
        this.boostTimer = this.boostDuration;
        this.boostEnergy = this.maxEnergy;

        // Apply speed boost
        this.game.currentSpeed *= this.boostSpeedMultiplier;

        // Visual feedback
        if (this.boostFill) {
            this.boostFill.classList.add('full');
        }

        console.log('⚡ BOOST ACTIVATED!');
    }

    deactivateBoost() {
        this.isBoostActive = false;
        this.boostEnergy = 0;

        // Remove speed boost
        this.game.currentSpeed /= this.boostSpeedMultiplier;

        // Visual feedback
        if (this.boostFill) {
            this.boostFill.classList.remove('full');
        }

        console.log('⚡ Boost ended');
    }

    update(deltaTime) {
        if (this.isBoostActive) {
            this.boostTimer -= deltaTime;

            // Update energy as timer (visual countdown)
            this.boostEnergy = (this.boostTimer / this.boostDuration) * this.maxEnergy;

            if (this.boostTimer <= 0) {
                this.deactivateBoost();
            }
        } else {
            // Slow decay when not boosting
            this.boostEnergy = Math.max(0, this.boostEnergy - this.decayRate * deltaTime);
        }

        this.updateUI();
    }

    updateUI() {
        if (this.boostFill) {
            const percent = (this.boostEnergy / this.maxEnergy) * 100;
            this.boostFill.style.width = `${percent}%`;
        }

        if (this.boostLabel) {
            if (this.isBoostActive) {
                this.boostLabel.textContent = `⚡ BOOSTING! ${this.boostTimer.toFixed(1)}s`;
                this.boostLabel.style.color = '#ffff00';
            } else if (this.boostEnergy >= this.maxEnergy * 0.9) {
                this.boostLabel.textContent = '⚡ BOOST READY!';
                this.boostLabel.style.color = '#00ff00';
            } else {
                this.boostLabel.textContent = '⚡ BOOST';
                this.boostLabel.style.color = '#00ffff';
            }
        }
    }

    reset() {
        this.boostEnergy = 0;
        this.isBoostActive = false;
        this.boostTimer = 0;
        this.updateUI();
        if (this.boostFill) {
            this.boostFill.classList.remove('full');
        }
    }
}
