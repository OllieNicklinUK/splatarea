import * as THREE from 'three';

export class AIController {
    constructor(player, obstacleManager) {
        this.player = player;
        this.obstacleManager = obstacleManager;
        
        // Reflex variables
        this.reactionTime = 0.4; // AI takes 0.4 seconds to react to a decision
        this.decisionTimer = 0;
        this.currentInput = { jump: false, slide: false, left: false, right: false };
        this.queuedInput = { jump: false, slide: false, left: false, right: false };
        
        // Difficulty tuning
        this.lookAheadDistance = 45; // How far ahead the AI scans
        this.mistakeChance = 0.1; // 10% chance to fail to react in time (reaction time spike)
    }

    update(deltaTime, currentSpeed) {
        // Reset inputs every frame
        this.currentInput = { jump: false, slide: false, left: false, right: false };

        // Process decision delay
        if (this.decisionTimer > 0) {
            this.decisionTimer -= deltaTime;
            if (this.decisionTimer <= 0) {
                // Apply queued decision once reaction time expires
                Object.assign(this.currentInput, this.queuedInput);
                // Clear queue
                this.queuedInput = { jump: false, slide: false, left: false, right: false };
            }
            return this.currentInput; // Still processing thought
        }

        // If no thought is queued and we aren't currently jumping/sliding, analyze track
        if (!this.player.isJumping && !this.player.isSliding) {
            this.analyzeAndReact();
        }

        return this.currentInput;
    }

    analyzeAndReact() {
        const obstacles = this.obstacleManager.getActiveObstacles();
        let closestObstacle = null;
        let minZ = Infinity;

        // Find closest obstacle in ANY lane
        for (const obs of obstacles) {
            if (obs.mesh.position.z > this.player.mesh.position.z && obs.mesh.position.z < minZ) {
                minZ = obs.mesh.position.z;
                closestObstacle = obs;
            }
        }

        // If an obstacle is approaching within view
        if (closestObstacle && minZ < this.player.mesh.position.z + this.lookAheadDistance) {
            // Check if it's in our lane OR if it's a whiteflag (covers all lanes)
            const obsLane = this.getLaneIndexFromX(closestObstacle.mesh.position.x);
            const inOurLane = (obsLane === this.player.laneIndex);
            
            if (inOurLane || closestObstacle.type === 'whiteflag') {
                this.makeDecision(closestObstacle);
            }
        }
    }

    makeDecision(obstacle) {
        // Queue a reaction stroke!
        const reactionDelay = Math.random() < this.mistakeChance ? 1.0 : this.reactionTime;
        this.decisionTimer = reactionDelay;

        // 1. Whiteflag -> Must Jump
        if (obstacle.type === 'whiteflag') {
            this.queuedInput.jump = true;
            return;
        }

        // 2. Hydrant in our lane -> Change Lane
        // Simple logic: If we are center, go left or right randomly.
        // If we are left/right, go center.
        if (this.player.laneIndex === 1) { // Center
            this.queuedInput[Math.random() < 0.5 ? 'left' : 'right'] = true;
        } else if (this.player.laneIndex === 0) { // Left
            this.queuedInput.right = true;
        } else if (this.player.laneIndex === 2) { // Right
            this.queuedInput.left = true;
        }
    }

    getLaneIndexFromX(x) {
        if (x < -1) return 0;
        if (x > 1) return 2;
        return 1;
    }
}
