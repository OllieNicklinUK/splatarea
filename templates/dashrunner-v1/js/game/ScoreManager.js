/**
 * ScoreManager.js - Score, Combos, and UI Updates
 */

export class ScoreManager {
    constructor() {
        this.score = 0;
        this.distanceScore = 0;
        this.collectibleScore = 0;
        this.multiplier = 1;
        this.maxMultiplier = 5;

        this.nearMissStreak = 0;
        this.comboTimer = 0;
        this.comboDuration = 2;

        this.scoreElement = document.getElementById('score');
        this.comboDisplay = document.getElementById('combo-display');
        this.comboText = document.getElementById('combo-text');
        this.comboMultiplier = document.getElementById('combo-multiplier');
    }

    reset() {
        this.score = 0;
        this.distanceScore = 0;
        this.collectibleScore = 0;
        this.multiplier = 1;
        this.nearMissStreak = 0;
        this.comboTimer = 0;
        this.updateUI();
        this.hideCombo();
    }

    addDistance(distance) {
        this.distanceScore += distance * this.multiplier;
        this.score = this.distanceScore + this.collectibleScore;
    }

    addCollectible(value = 100) {
        this.collectibleScore += value * this.multiplier;
        this.score = this.distanceScore + this.collectibleScore;
    }

    triggerNearMiss() {
        this.nearMissStreak++;
        this.comboTimer = this.comboDuration;

        // Increase multiplier
        this.multiplier = Math.min(this.maxMultiplier, 1 + this.nearMissStreak * 0.5);

        this.showCombo();
    }

    showCombo() {
        const messages = ['CLOSE CALL!', 'MAMMA MIA!', 'PERFETTO!', 'INCREDIBILE!', 'FANTASTICO!'];
        const msg = messages[Math.min(this.nearMissStreak - 1, messages.length - 1)];

        this.comboText.textContent = msg;
        this.comboMultiplier.textContent = `x${this.multiplier.toFixed(1)}`;
        this.comboDisplay.classList.remove('hidden');

        // Hide after animation
        setTimeout(() => this.hideCombo(), 1000);
    }

    hideCombo() {
        this.comboDisplay.classList.add('hidden');
    }

    update(deltaTime) {
        // Decay combo
        if (this.comboTimer > 0) {
            this.comboTimer -= deltaTime;
            if (this.comboTimer <= 0) {
                this.multiplier = 1;
                this.nearMissStreak = 0;
            }
        }

        this.updateUI();
    }

    updateUI() {
        this.scoreElement.textContent = Math.floor(this.score);
    }
}
