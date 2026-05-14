import { VIVERSE_CONFIG } from "./viverseConfig.js";

export class ViverseLeaderboardController {
  constructor() {
    this.client = null;
    this.rankings = [];
    this.lastResultKey = "";
    this.status = "idle";
    this.error = "";
  }

  async initialize({ sdk, authClient, accessToken }) {
    this.error = "";

    const DashboardClass = sdk?.gameDashboard || sdk?.GameDashboard;
    if (typeof DashboardClass !== "function") {
      this.status = "unavailable";
      throw new Error("SDK leaderboard constructor unavailable");
    }

    let dashboardToken = accessToken || "";
    if (authClient && typeof authClient.getToken === "function") {
      try {
        const tokenResult = await authClient.getToken();
        dashboardToken =
          typeof tokenResult === "string"
            ? tokenResult
            : tokenResult?.access_token || tokenResult?.accessToken || dashboardToken;
      } catch {}
    }

    if (!dashboardToken) {
      this.status = "guest";
      throw new Error("Leaderboard requires authenticated token");
    }

    this.client = new DashboardClass({
      token: dashboardToken,
      clientId: VIVERSE_CONFIG.appId,
      baseURL: "https://www.viveport.com/",
      communityBaseURL: "https://www.viverse.com/"
    });
    this.status = "ready";
    return this.client;
  }

  async submitWin({ resultKey, value = 1 }) {
    if (!this.client) throw new Error("Leaderboard client not initialized");
    if (!resultKey) throw new Error("resultKey is required");
    if (this.lastResultKey === resultKey) return false;

    await this.client.uploadLeaderboardScore(VIVERSE_CONFIG.appId, [
      { name: VIVERSE_CONFIG.leaderboardName, value }
    ]);

    this.lastResultKey = resultKey;
    return true;
  }

  resetResultGuard() {
    this.lastResultKey = "";
  }

  async fetchTop() {
    if (!this.client) throw new Error("Leaderboard client not initialized");
    const configs = [
      { name: VIVERSE_CONFIG.leaderboardName, range_start: 0, range_end: 9, region: "global", time_range: "alltime", around_user: false },
      { name: VIVERSE_CONFIG.leaderboardName, range_start: 0, range_end: 9, region: "global", time_range: "alltime", around_user: true },
      { name: VIVERSE_CONFIG.leaderboardName, range_start: 0, range_end: 9, region: "local", time_range: "alltime", around_user: false }
    ];

    this.status = "loading";
    this.error = "";

    for (const config of configs) {
      try {
        const response = await this.client.getLeaderboard(VIVERSE_CONFIG.appId, config);
        const rankings =
          response?.rankings ||
          response?.ranking ||
          response?.leaderboard_rankings ||
          response?.data?.rankings ||
          response?.data?.ranking ||
          response?.leaderboard?.rankings ||
          response?.leaderboard?.ranking ||
          [];
        if (rankings.length > 0) {
          this.rankings = rankings;
          this.status = "ready";
          return rankings;
        }
      } catch (error) {
        this.error = error?.message || "Leaderboard fetch failed";
      }
    }

    if (typeof this.client.getGuestLeaderboard === "function") {
      for (const config of configs) {
        try {
          const response = await this.client.getGuestLeaderboard(VIVERSE_CONFIG.appId, config);
          const rankings =
            response?.rankings ||
            response?.ranking ||
            response?.leaderboard_rankings ||
            response?.data?.rankings ||
            response?.data?.ranking ||
            response?.leaderboard?.rankings ||
            response?.leaderboard?.ranking ||
            [];
          if (rankings.length > 0) {
            this.rankings = rankings;
            this.status = "ready";
            return rankings;
          }
        } catch (error) {
          this.error = error?.message || "Leaderboard fetch failed";
        }
      }
    }

    this.rankings = [];
    this.status = this.error ? "error" : "empty";
    return [];
  }
}
