// viverseAuth.js — HIGH-RISK (read fully before editing; patch surgically)
// VIVERSE auth bootstrap with resilient profile fallback chain.
// Edits allowed when needed — read fully, patch surgically, verify syntax.

import { APP_CONFIG } from './viverseConfig.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectSdkGlobal() {
  return window.viverse || window.VIVERSE_SDK || window.vSdk || null;
}

function looksLikeUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())
  );
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const preferredName =
    raw.displayName ||
    raw.display_name ||
    raw.name ||
    raw.nickName ||
    raw.nickname ||
    raw.userName ||
    raw.email ||
    '';

  const displayName =
    preferredName && !looksLikeUuid(preferredName) ? preferredName : 'VIVERSE Player';

  return {
    displayName,
    avatarUrl:
      raw.activeAvatar?.headIconUrl ||
      raw.activeAvatar?.head_icon_url ||
      raw.headIconUrl ||
      raw.head_icon_url ||
      raw.avatarUrl ||
      raw.avatar_url ||
      raw.profilePicUrl ||
      '',
    accountId: raw.account_id || raw.accountId || raw.id || raw.sub || '',
    accessToken: raw.access_token || raw.accessToken || '',
    raw
  };
}

function hasIdentity(profile) {
  return Boolean(
    profile?.displayName ||
      profile?.display_name ||
      profile?.name ||
      profile?.nickName ||
      profile?.nickname ||
      profile?.userName ||
      profile?.email
  );
}

function hasAvatar(profile) {
  return Boolean(
    profile?.activeAvatar?.headIconUrl ||
      profile?.activeAvatar?.head_icon_url ||
      profile?.headIconUrl ||
      profile?.head_icon_url ||
      profile?.avatarUrl ||
      profile?.avatar_url ||
      profile?.profilePicUrl
  );
}

function needsMoreProfile(profile) {
  return !profile || !hasIdentity(profile) || !hasAvatar(profile);
}

export class ViverseAuthController {
  constructor(onStateChange = () => {}) {
    this.onStateChange = onStateChange;
    this.state = {
      status: 'idle',
      sdk: null,
      authClient: null,
      isAuthenticated: false,
      profile: null,
      error: '',
      appId: APP_CONFIG.appId
    };
    this.initPromise = null;
    console.log(`[ViverseAuth] ${APP_CONFIG.appName} ${APP_CONFIG.versionName} bootstrap`);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.onStateChange({ ...this.state });
  }

  async initialize() {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.setState({ status: 'detecting', error: '' });

      try {
        const sdk = await this.waitForSdk();
        this.setState({ sdk, status: 'handshaking' });

        if (!sdk) {
          this.setState({
            status: 'ready',
            error: 'VIVERSE SDK not detected. App continues without auth.'
          });
          return null;
        }

        if (sdk.bridge?.isReady === false) {
          await this.waitForBridge(sdk, 30);
        }

        await delay(1200);

        if (!APP_CONFIG.appId) {
          this.setState({
            status: 'ready',
            error: 'Missing VIVERSE App ID. App continues without auth.'
          });
          return null;
        }

        const ClientClass = sdk?.client || sdk?.Client;
        if (typeof ClientClass !== 'function') {
          this.setState({
            status: 'ready',
            error: 'VIVERSE auth client unavailable. App continues without auth.'
          });
          return null;
        }

        const authClient = new ClientClass({
          clientId: APP_CONFIG.appId,
          domain: APP_CONFIG.authDomain
        });

        this.setState({ authClient, status: 'checking_auth' });
        const authResult = await authClient.checkAuth();
        const baseProfile = normalizeProfile(authResult);
        const token = baseProfile?.accessToken || '';
        const accountId = baseProfile?.accountId || '';
        const isAuthenticated = Boolean(token || accountId);

        if (!isAuthenticated) {
          this.setState({ status: 'ready', isAuthenticated: false, profile: null });
          return null;
        }

        const enrichedProfile = await this.enrichProfile({
          sdk,
          authClient,
          authResult,
          token
        });

        const finalProfile = {
          ...baseProfile,
          ...enrichedProfile,
          accessToken: token || enrichedProfile?.accessToken || '',
          accountId: accountId || enrichedProfile?.accountId || ''
        };

        if (!finalProfile.displayName || finalProfile.displayName === 'VIVERSE Player') {
          finalProfile.displayName = baseProfile?.displayName || 'VIVERSE Player';
        }

        this.setState({
          status: 'ready',
          isAuthenticated: true,
          profile: finalProfile,
          sdk,
          authClient
        });

        return finalProfile;
      } catch (error) {
        this.initPromise = null;
        this.setState({
          status: 'ready',
          error: error?.message || 'Auth initialization failed'
        });
        return null;
      }
    })();

    return this.initPromise;
  }

  async waitForSdk() {
    for (let i = 0; i < 120; i += 1) {
      const sdk = detectSdkGlobal();
      if (sdk?.client || sdk?.Client) return sdk;
      await delay(250);
    }
    return null;
  }

  async waitForBridge(sdk, maxFrames = 50) {
    for (let i = 0; i < maxFrames; i += 1) {
      if (sdk?.bridge?.isReady !== false) return;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  async enrichProfile({ sdk, authClient, authResult, token }) {
    let mergedProfile = normalizeProfile(authResult) || {};

    const merge = (profile) => {
      const normalized = normalizeProfile(profile);
      if (!normalized) return;
      if (mergedProfile.displayName && mergedProfile.displayName !== 'VIVERSE Player') {
        if (normalized.displayName === 'VIVERSE Player') {
          normalized.displayName = mergedProfile.displayName;
        }
      }
      mergedProfile = {
        ...mergedProfile,
        ...normalized,
        raw: { ...mergedProfile.raw, ...normalized.raw }
      };
    };

    const resolvedSdk = sdk || detectSdkGlobal();
    if (resolvedSdk?.bridge?.isReady === false) await delay(500);

    const AvatarClass = resolvedSdk?.avatar || resolvedSdk?.Avatar;
    if (token && typeof AvatarClass === 'function') {
      try {
        const avatarClient = new AvatarClass({
          baseURL: APP_CONFIG.avatarBaseUrl,
          accessToken: token,
          token,
          authorization: token,
          appId: APP_CONFIG.appId,
          clientId: APP_CONFIG.appId
        });
        merge(await avatarClient.getProfile());
      } catch {}
    }

    if (needsMoreProfile(mergedProfile) && typeof authClient?.getUserInfo === 'function') {
      try { merge(await authClient.getUserInfo()); } catch {}
    }
    if (needsMoreProfile(mergedProfile) && typeof authClient?.getUser === 'function') {
      try { merge(await authClient.getUser()); } catch {}
    }
    if (needsMoreProfile(mergedProfile) && typeof authClient?.getProfileByToken === 'function') {
      try { merge(await authClient.getProfileByToken(token)); } catch {}
    }

    const previewOrigin =
      typeof window !== 'undefined' &&
      /\.world\.viverse\.app$/i.test(window.location.hostname);
    if (needsMoreProfile(mergedProfile) && token && !previewOrigin) {
      try {
        const response = await fetch('https://account-profile.htcvive.com/SS/Profiles/v3/Me', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (response.ok) merge(await response.json());
      } catch {}
    }

    return mergedProfile;
  }

  async login() {
    if (!this.state.authClient) await this.initialize();
    const client = this.state.authClient;
    if (!client) return;
    if (typeof client.loginWithWorlds === 'function') { client.loginWithWorlds(); return; }
    if (typeof client.login === 'function') client.login();
  }

  getClient() { return this.state.authClient; }
  getSdk() { return this.state.sdk; }
  getProfile() { return this.state.profile; }
}
