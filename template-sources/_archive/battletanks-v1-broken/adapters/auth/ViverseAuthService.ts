import { VIVERSE_CONFIG } from "../../bootstrap/ViverseConfig";

export const VERSION_NAME = "1.0.0-template-baseline";

export class ViverseAuthService {
  private static instance: ViverseAuthService;
  private client: any = null;
  private user: any = null;
  private sdk: any = null;
  private initPromise: Promise<any> | null = null;

  private constructor() {
    console.log(`[ViverseAuthService] ${VERSION_NAME} starting`);
  }

  public static getInstance(): ViverseAuthService {
    if (!ViverseAuthService.instance) {
      ViverseAuthService.instance = new ViverseAuthService();
    }
    return ViverseAuthService.instance;
  }

  public async initialize(): Promise<any> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const vSdk = await this.waitForSdk();
        if (!vSdk) throw new Error("SDK detection failed");

        const resolvedSdk = vSdk || (window as any).vSdk || (window as any).viverse || (window as any).VIVERSE_SDK;
        this.sdk = resolvedSdk;

        if (resolvedSdk.bridge && resolvedSdk.bridge.isReady === false) {
          await new Promise((resolve) => {
            let attempts = 0;
            const check = () => {
              if (resolvedSdk.bridge.isReady !== false || attempts++ > 50) resolve(true);
              else requestAnimationFrame(check);
            };
            check();
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 1200));

        this.client = new resolvedSdk.client({
          clientId: VIVERSE_CONFIG.APP_ID,
          domain: VIVERSE_CONFIG.AUTH_DOMAIN
        });

        return resolvedSdk;
      } catch (error) {
        this.initPromise = null;
        throw error;
      }
    })();

    return this.initPromise;
  }

  private async waitForSdk(): Promise<any> {
    for (let i = 0; i < 150; i++) {
      const vSdk = (window as any).vSdk || (window as any).viverse || (window as any).VIVERSE_SDK;
      if (vSdk?.client) return vSdk;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  public async checkAuth(): Promise<any> {
    if (!this.client) await this.initialize();

    const currentSdk = (window as any).vSdk || (window as any).viverse || (window as any).VIVERSE_SDK || this.sdk;
    if (!currentSdk) throw new Error("VIVERSE SDK not found during checkAuth");

    const authResult = await this.client.checkAuth();
    const isAuthenticated = Boolean(
      authResult?.is_authenticated ??
      authResult?.isAuthenticated ??
      authResult?.authenticated ??
      authResult?.access_token ??
      authResult?.accessToken ??
      authResult?.account_id ??
      authResult?.accountId
    );

    if (!isAuthenticated) return null;

    const token = authResult.access_token || authResult.accessToken;
    const accountId = authResult.account_id || authResult.accountId;
    const displayName = authResult.user_name || authResult.display_name || authResult.email || authResult.name || "VIVERSE Player";
    const avatarUrl = authResult.picture || authResult.avatar_url || authResult.head_icon_url || null;

    this.user = { accessToken: token, accountId, displayName, avatarUrl };
    await this.enrichProfile(token, accountId, authResult, currentSdk);
    return this.user;
  }

  private async enrichProfile(token: string, _accountId: string, _authData: any, sdk: any) {
    const resolvedSdk = sdk || (window as any).vSdk || (window as any).viverse || (window as any).VIVERSE_SDK;
    if (!resolvedSdk) return;

    await new Promise((resolve) => setTimeout(resolve, 500));

    let mergedProfile: any = null;
    const merge = (profile: any) => {
      if (!profile || typeof profile !== "object") return;
      mergedProfile = mergedProfile ? { ...mergedProfile, ...profile } : { ...profile };
    };

    if (resolvedSdk.avatar) {
      try {
        const avatarClient = new resolvedSdk.avatar({
          baseURL: VIVERSE_CONFIG.AVATAR_BASE_URL,
          accessToken: token,
          token,
          authorization: token,
          appId: VIVERSE_CONFIG.APP_ID,
          clientId: VIVERSE_CONFIG.APP_ID
        });
        merge(await avatarClient.getProfile());
      } catch {}
    }

    if (this.client?.getUserInfo) {
      try {
        merge(await this.client.getUserInfo());
      } catch {}
    }

    const previewOrigin = typeof window !== "undefined" && /\.world\.viverse\.app$/i.test(window.location.hostname);
    if (!previewOrigin && !mergedProfile) {
      try {
        const resp = await fetch("https://account-profile.htcvive.com/SS/Profiles/v3/Me", {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (resp.ok) {
          merge(await resp.json());
        }
      } catch {}
    }

    if (mergedProfile) {
      const preferredName =
        mergedProfile.displayName ||
        mergedProfile.display_name ||
        mergedProfile.name ||
        mergedProfile.nickname ||
        mergedProfile.userName ||
        "";
      const looksLikeUuid = (value: string) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value?.trim() || "");

      if (preferredName && !looksLikeUuid(preferredName) && preferredName !== "VIVERSE Player") {
        this.user.displayName = preferredName;
      }

      this.user.avatarUrl =
        mergedProfile.activeAvatar?.headIconUrl ||
        mergedProfile.activeAvatar?.head_icon_url ||
        mergedProfile.headIconUrl ||
        mergedProfile.head_icon_url ||
        mergedProfile.avatarUrl ||
        mergedProfile.avatar_url ||
        this.user.avatarUrl;
    }
  }

  public async login() {
    if (!this.client) await this.initialize();
    if (this.client.loginWithWorlds) {
      this.client.loginWithWorlds();
    } else if (this.client.login) {
      this.client.login();
    } else {
      window.open("https://account.htcvive.com", "_blank");
    }
  }

  public async logout() {
    if (this.client) await this.client.logout();
    this.user = null;
  }

  public getUser() {
    return this.user;
  }
}
