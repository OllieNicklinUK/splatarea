export class ViverseService {
    constructor() {
        this.client = null;
        this.gameDashboardClient = null;
        this.appId = import.meta.env.VITE_VIVERSE_CLIENT_ID;
        this.leaderboardName = import.meta.env.VITE_VIVERSE_LEADERBOARD_NAME;
        this.accountId = null;
        this.accessToken = null;
        this.accessToken = null;
        this.profileName = null;
        this.avatarUrl = null;
        this.isReady = false;
        this.submittedResultKey = null;
    }

    async waitForSDK() {
        return new Promise((resolve) => {
            let attempts = 0;
            const check = () => {
                attempts++;
                const vSdk = window.viverse || window.VIVERSE_SDK || window.vSdk;
                const bridgeReady = vSdk && (vSdk.bridge ? vSdk.bridge.isReady !== false : true);
                if (vSdk?.client && bridgeReady) {
                    resolve(vSdk);
                } else if (attempts > 50) {
                    console.warn('VIVERSE SDK failed to load');
                    resolve(null);
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }

    async init() {
        const vSdk = await this.waitForSDK();
        if (!vSdk) return false;

        this.client = new vSdk.client({
            clientId: this.appId,
            domain: 'account.htcvive.com'
        });

        const DashboardClass = vSdk.gameDashboard || vSdk.GameDashboard;
        if (DashboardClass) {
            this.gameDashboardClass = DashboardClass;
        }

        // MANDATORY Iframe Handshake Delay: wait 1200ms after SDK detection before checkAuth
        await new Promise(resolve => setTimeout(resolve, 1200));

        this.isReady = true;
        return true;
    }

    async checkAuth() {
        if (!this.client) return false;

        const auth = await this.client.checkAuth();
        if (!auth?.access_token) return false;

        this.accessToken = auth.access_token;
        this.accountId = auth.account_id;

        if (this.gameDashboardClass) {
            this.gameDashboardClient = new this.gameDashboardClass({
                token: this.accessToken,
                clientId: this.appId,
                baseURL: "https://www.viveport.com/",
                communityBaseURL: "https://www.viverse.com/"
            });
        }

        let mergedProfile = null;
        const merge = (p) => {
            if (!p || typeof p !== 'object') return;
            mergedProfile = mergedProfile ? { ...mergedProfile, ...p } : { ...p };
        };

        const vSdk = window.viverse || window.VIVERSE_SDK || window.vSdk;
        if (vSdk?.avatar) {
            try {
                const avatarClient = new vSdk.avatar({
                    baseURL: 'https://sdk-api.viverse.com/',
                    accessToken: this.accessToken,
                    token: this.accessToken,
                    authorization: this.accessToken,
                    appId: this.appId,
                    clientId: this.appId,
                });
                merge(await avatarClient.getProfile());
            } catch (e) {
                console.warn("Avatar Client getProfile failed:", e);
            }
        }

        const hasIdentity = (p) => !!(p && (p.name || p.displayName || p.display_name || p.nickName || p.nickname || p.userName || p.email));
        const hasAvatar = (p) => !!(p && (p.activeAvatar?.avatarUrl || p.avatarUrl || p.avatar_url || p.profilePicUrl));
        const needsMoreProfile = (p) => !p || !hasIdentity(p) || !hasAvatar(p);

        if (needsMoreProfile(mergedProfile) && this.client?.getUserInfo) {
            try { merge(await this.client.getUserInfo()); } catch (_) {}
        }
        if (needsMoreProfile(mergedProfile) && this.client?.getUser) {
            try { merge(await this.client.getUser()); } catch (_) {}
        }
        if (needsMoreProfile(mergedProfile) && this.client?.getProfileByToken) {
            try { merge(await this.client.getProfileByToken(this.accessToken)); } catch (_) {}
        }

        this.profileName =
            mergedProfile?.displayName ||
            mergedProfile?.display_name ||
            mergedProfile?.name ||
            mergedProfile?.nickname ||
            mergedProfile?.userName ||
            mergedProfile?.email ||
            'VIVERSE Player';

        console.log("🔍 Final Merged Profile:", mergedProfile);

        this.avatarUrl = mergedProfile?.activeAvatar?.vrmUrl || mergedProfile?.activeAvatar?.avatarUrl || mergedProfile?.avatarUrl || mergedProfile?.avatar_url || mergedProfile?.profilePicUrl || null;

        console.log(`✅ Welcome to DashRunner, ${this.profileName}!`);
        console.log(`🖼️ Avatar URL found: ${this.avatarUrl}`);
        return true;
    }

    login() {
        if (!this.client) return;
        this.client.loginWithWorlds();
    }

    async submitScore(score) {
        if (!this.gameDashboardClient || !this.leaderboardName) {
            console.warn("Could not submit score, not ready or missing name.");
            return;
        }

        const resultKey = `match_${Date.now()}_${score}`;
        if (this.submittedResultKey === resultKey) return;
        this.submittedResultKey = resultKey;

        try {
            await this.gameDashboardClient.uploadLeaderboardScore(this.appId, [
                { name: this.leaderboardName, value: Math.floor(score) },
            ]);
            console.log(`🏆 Successfully uploaded score ${score} to ${this.leaderboardName}`);
        } catch (error) {
            console.error('Error submitting score to VIVERSE Leaderboard:', error);
        }
    }

    async getLeaderboardData() {
        if (!this.gameDashboardClient || !this.leaderboardName) return [];

        const configs = [
            { name: this.leaderboardName, range_start: 0, range_end: 9, region: "global", time_range: "alltime", around_user: false },
            { name: this.leaderboardName, range_start: 0, range_end: 9, region: "global", time_range: "alltime", around_user: true },
            { name: this.leaderboardName, range_start: 0, range_end: 9, region: "local", time_range: "alltime", around_user: false }
        ];

        let rankings = [];
        for (const conf of configs) {
            try {
                console.log(`Fetching leaderboard fallback config: ${conf.region} (around_user=${conf.around_user})`);
                const res = await this.gameDashboardClient.getLeaderboard(this.appId, conf);
                
                // Robust extraction as mandated by SKILL
                const extracted = res?.rankings || res?.ranking || res?.leaderboard_rankings || res?.data?.rankings || res?.data?.ranking || res?.leaderboard?.rankings || res?.leaderboard?.ranking || [];
                
                if (extracted.length > 0) {
                    rankings = extracted;
                    break;
                }
            } catch (e) {
                console.warn(`Leaderboard fetch failed for ${conf.region}:`, e);
            }
        }

        return rankings;
    }
}
