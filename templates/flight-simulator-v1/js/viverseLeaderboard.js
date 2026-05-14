import { VIVERSE_CONFIG } from './viverseConfig.js';

/**
 * VIVERSE Leaderboard Controller — Flight Simulator
 *
 * Submits ring-collection score and fetches global rankings
 * via the VIVERSE gameDashboard API.
 * Implements idempotent submit guard per viverse-leaderboard skill.
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

        // Prefer getToken() when an auth client is available; otherwise use accessToken directly
        let dashboardToken = this.accessToken;
        const DashboardClass = vSdk.gameDashboard || vSdk.GameDashboard;
        if (!DashboardClass) return false;

        this.client = new DashboardClass({
            token: dashboardToken,
            clientId: this.appId,
            baseURL: 'https://www.viveport.com/',          // MANDATORY
            communityBaseURL: 'https://www.viverse.com/'   // MANDATORY
        });
        this.isReady = true;
        console.log('[FlightSimLeaderboard] initialized');
        return true;
    }

    async submitScore(score) {
        if (!this.client || !VIVERSE_CONFIG.leaderboardName) return;

        // Idempotent submit guard (viverse-leaderboard skill requirement)
        const resultKey = `score_${Date.now()}_${score}`;
        if (this.submittedResultKey === resultKey) return;
        this.submittedResultKey = resultKey;

        try {
            await this.client.uploadLeaderboardScore(this.appId, [
                { name: VIVERSE_CONFIG.leaderboardName, value: Math.floor(score) }
            ]);
            console.log(`[FlightSimLeaderboard] Submitted score: ${score} → ${VIVERSE_CONFIG.leaderboardName}`);
        } catch (error) {
            console.error('[FlightSimLeaderboard] Submit error:', error);
        }
    }

    resetSubmitGuard() {
        this.submittedResultKey = null;
    }

    async getRankings() {
        if (!this.client || !VIVERSE_CONFIG.leaderboardName) return [];

        // Query order from viverse-leaderboard skill
        const attempts = [
            { region: 'global', around_user: false },
            { region: 'global', around_user: true },
            { region: 'local',  around_user: false }
        ];

        for (const attempt of attempts) {
            try {
                const res = await this.client.getLeaderboard(this.appId, {
                    name: VIVERSE_CONFIG.leaderboardName,
                    range_start: 0,
                    range_end: 9,
                    region: attempt.region,
                    time_range: 'alltime',
                    around_user: attempt.around_user
                });

                // Robust extraction from all known SDK response shapes
                const rankings =
                    res?.rankings ||
                    res?.ranking ||
                    res?.leaderboard_rankings ||
                    res?.data?.rankings ||
                    res?.data?.ranking ||
                    res?.leaderboard?.rankings ||
                    res?.leaderboard?.ranking ||
                    [];
                if (rankings.length > 0) return rankings;
            } catch (e) {
                console.warn(`[FlightSimLeaderboard] fetch failed (${attempt.region}):`, e);
            }
        }

        // Guest leaderboard fallback
        if (typeof this.client.getGuestLeaderboard === 'function') {
            for (const attempt of attempts) {
                try {
                    const res = await this.client.getGuestLeaderboard(this.appId, {
                        name: VIVERSE_CONFIG.leaderboardName,
                        range_start: 0,
                        range_end: 9,
                        region: attempt.region,
                        time_range: 'alltime',
                        around_user: attempt.around_user
                    });
                    const rankings =
                        res?.rankings || res?.ranking || res?.leaderboard_rankings ||
                        res?.data?.rankings || res?.data?.ranking ||
                        res?.leaderboard?.rankings || res?.leaderboard?.ranking || [];
                    if (rankings.length > 0) return rankings;
                } catch {}
            }
        }

        return [];
    }
}
