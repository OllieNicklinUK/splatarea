import { Player } from './Player.js';

/**
 * VIVERSE Local Player Controller
 *
 * Keep the modular template surface, but delegate to the original DashRunner
 * player implementation so jump, lane, and collision behavior stay identical.
 */
export class LocalPlayer extends Player {
    constructor(scene, isAI = false) {
        super(scene, null, isAI);
    }

    async loadAvatar(url) {
        if (url) {
            console.log(`🖼️ Attempting VIVERSE avatar load: ${url}`);
            this.loadModel(url, { fallbackToChef: true });
        } else {
            console.warn('⚠️ No VIVERSE avatar URL provided, keeping Chef fallback');
        }
        return Promise.resolve();
    }
}
