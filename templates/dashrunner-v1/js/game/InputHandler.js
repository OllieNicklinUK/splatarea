/**
 * InputHandler.js - Keyboard Input Management
 */

export class InputHandler {
    constructor() {
        this.frameInput = { left: false, right: false, jump: false, slide: false };
        this.keysHeld = {};
        this.prevKeysHeld = {};

        window.addEventListener('keydown', (e) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) {
                e.preventDefault();
                this.keysHeld[e.code] = true;
            }
        });

        window.addEventListener('keyup', (e) => {
            this.keysHeld[e.code] = false;
        });
    }

    getInput() {
        const leftPressed = this.keysHeld.ArrowRight || this.keysHeld.KeyD;
        const rightPressed = this.keysHeld.ArrowLeft || this.keysHeld.KeyA;
        const jumpPressed = this.keysHeld.ArrowUp || this.keysHeld.KeyW || this.keysHeld.Space;
        const slidePressed = this.keysHeld.ArrowDown || this.keysHeld.KeyS;

        this.frameInput.left = leftPressed && !this.prevKeysHeld.left;
        this.frameInput.right = rightPressed && !this.prevKeysHeld.right;
        this.frameInput.jump = jumpPressed && !this.prevKeysHeld.jump;
        this.frameInput.slide = slidePressed && !this.prevKeysHeld.slide;

        this.prevKeysHeld = { left: leftPressed, right: rightPressed, jump: jumpPressed, slide: slidePressed };
        return this.frameInput;
    }

    reset() {
        this.keysHeld = {};
        this.prevKeysHeld = {};
    }
}
