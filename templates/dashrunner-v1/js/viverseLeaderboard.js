import { VIVERSE_CONFIG } from './viverseConfig.js';

/**
 * VIVERSE Leaderboard Controller
 * 
 * Handles score submission and global/local ranking retrieval
 * using the VIVERSE Game Dashboard API.
 */
export class ViverseLeaderboardController {
    constructor(accessToken) {
        this.accessToken = accessToken;
        this.appId = VIVERSE_CONFIG.clientId;
        this.client = null;
        this.isReady = false;
        this.submittedResultKey = null;
    }

    async initialize() {
        const vSdk = window.viverse || window.VIVERSE_SDK || window.vSdk;
        if (!vSdk || !this.accessToken) return false;

        const DashboardClass = vSdk.gameDashboard || vSdk.GameDashboard;
        if (DashboardClass) {
            this.client = new DashboardClass({
                token: this.accessToken,
                clientId: this.appId,
                baseURL: "https://www.viveport.com/", // Fixed platform endpoint
                communityBaseURL: "https://www.viverse.com/"
            });
            this.isReady = true;
            return true;
        }
        return false;
    }

    async submitScore(score) {
        if (!this.client || !VIVERSE_CONFIG.leaderboardName) return;

        const resultKey = `score_${Date.now()}_${score}`;
        if (this.submittedResultKey === resultKey) return;
        this.submittedResultKey = resultKey;

        try {
            await this.client.uploadLeaderboardScore(this.appId, [
                { name: VIVERSE_CONFIG.leaderboardName, value: Math.floor(score) },
            ]);
            console.log(`🏆 Score ${score} submitted to ${VIVERSE_CONFIG.leaderboardName}`);
        } catch (error) {
            console.error('Leaderboard Submit Error:', error);
        }
    }

    async getRankings() {
        if (!this.client || !VIVERSE_CONFIG.leaderboardName) return [];

        const attempts = [
            { region: "global", around_user: false },
            { region: "global", around_user: true },
            { region: "local",  around_user: false }
        ];

        for (const attempt of attempts) {
            try {
                const res = await this.client.getLeaderboard(this.appId, {
                    name: VIVERSE_CONFIG.leaderboardName,
                    range_start: 0,
                    range_end: 9,
                    region: attempt.region,
                    time_range: "alltime",
                    around_user: attempt.around_user
                });

                // Robust extraction from various SDK response formats
                const rankings = res?.rankings || res?.ranking || res?.data?.rankings || [];
                if (rankings.length > 0) return rankings;
            } catch (e) {
                console.warn(`Leaderboard fetch fail (${attempt.region}):`, e);
            }
        }
        return [];
    }
}
