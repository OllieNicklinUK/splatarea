import { VIVERSE_CONFIG } from './viverseConfig.js';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        })
    ]);
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

    const avatarUrl =
        raw.activeAvatar?.vrmUrl ||
        raw.activeAvatar?.vrm_url ||
        raw.activeAvatar?.avatarUrl ||
        raw.activeAvatar?.avatar_url ||
        raw.activeAvatar?.modelUrl ||
        raw.activeAvatar?.model_url ||
        raw.activeAvatar?.assetUrl ||
        raw.activeAvatar?.asset_url ||
        raw.activeAvatar?.url ||
        raw.avatar?.vrmUrl ||
        raw.avatar?.vrm_url ||
        raw.avatar?.avatarUrl ||
        raw.avatar?.avatar_url ||
        raw.avatar?.modelUrl ||
        raw.avatar?.model_url ||
        raw.avatar?.assetUrl ||
        raw.avatar?.asset_url ||
        raw.vrmUrl ||
        raw.vrm_url ||
        raw.modelUrl ||
        raw.model_url ||
        raw.assetUrl ||
        raw.asset_url ||
        raw.avatarUrl ||
        raw.avatar_url ||
        raw.activeAvatar?.headIconUrl ||
        raw.activeAvatar?.head_icon_url ||
        raw.headIconUrl ||
        raw.head_icon_url ||
        raw.profilePicUrl ||
        '';

    return {
        displayName,
        avatarUrl,
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
        profile?.activeAvatar?.vrmUrl ||
        profile?.activeAvatar?.vrm_url ||
        profile?.activeAvatar?.avatarUrl ||
        profile?.activeAvatar?.avatar_url ||
        profile?.activeAvatar?.modelUrl ||
        profile?.activeAvatar?.model_url ||
        profile?.activeAvatar?.assetUrl ||
        profile?.activeAvatar?.asset_url ||
        profile?.activeAvatar?.headIconUrl ||
        profile?.activeAvatar?.head_icon_url ||
        profile?.avatar?.vrmUrl ||
        profile?.avatar?.vrm_url ||
        profile?.avatar?.avatarUrl ||
        profile?.avatar?.avatar_url ||
        profile?.avatar?.modelUrl ||
        profile?.avatar?.model_url ||
        profile?.avatar?.assetUrl ||
        profile?.avatar?.asset_url ||
        profile?.vrmUrl ||
        profile?.vrm_url ||
        profile?.modelUrl ||
        profile?.model_url ||
        profile?.assetUrl ||
        profile?.asset_url ||
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
            appId: VIVERSE_CONFIG.clientId
        };
        this.initPromise = null;

        this.client = null;
        this.accessToken = null;
        this.accountId = null;
        this.profileName = 'VIVERSE Player';
        this.avatarUrl = null;
        this.isReady = false;

        console.log(`[DashRunnerAuth] ${VIVERSE_CONFIG.versionName} bootstrap`);
    }

    setState(patch) {
        this.state = { ...this.state, ...patch };
        this.onStateChange({ ...this.state });
    }

    setStateListener(listener = () => {}) {
        this.onStateChange = listener;
        this.onStateChange({ ...this.state });
    }

    async initialize() {
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            console.log('[DashRunnerAuth] initialize()');
            this.setState({ status: 'detecting', error: '' });
            const sdk = await this.waitForSDK();
            this.setState({ sdk, status: 'handshaking' });

            if (!sdk) {
                this.setState({
                    status: 'ready',
                    error: 'VIVERSE SDK not detected. Preview auth unavailable.'
                });
                return false;
            }

            await delay(1200);

            const ClientClass = sdk?.client || sdk?.Client;
            if (typeof ClientClass !== 'function') {
                this.setState({
                    status: 'ready',
                    error: 'VIVERSE auth client unavailable in preview.'
                });
                return false;
            }

            if (!VIVERSE_CONFIG.clientId) {
                this.setState({
                    status: 'ready',
                    error: 'Missing VIVERSE App ID in runtime config.'
                });
                return false;
            }

            this.client = new ClientClass({
                clientId: VIVERSE_CONFIG.clientId,
                domain: VIVERSE_CONFIG.authDomain
            });
            this.isReady = true;
            this.setState({ authClient: this.client, status: 'checking_auth' });
            return true;
        })().catch((error) => {
            this.initPromise = null;
            this.setState({
                status: 'ready',
                error: error?.message || 'Auth initialization failed'
            });
            return false;
        });

        return this.initPromise;
    }

    async waitForSDK() {
        for (let i = 0; i < 120; i += 1) {
            const sdk = detectSdkGlobal();
            const bridgeReady = sdk && (sdk.bridge ? sdk.bridge.isReady !== false : true);
            if ((sdk?.client || sdk?.Client) && bridgeReady) return sdk;
            await delay(250);
        }
        return null;
    }

    async checkAuth() {
        if (!this.client) return false;

        try {
            console.log('[DashRunnerAuth] checkAuth() start');
            this.setState({ status: 'checking_auth', error: '' });
            const auth = await withTimeout(this.client.checkAuth(), 8000, 'checkAuth');
            const baseProfile = normalizeProfile(auth);
            const token = baseProfile?.accessToken || '';
            const accountId = baseProfile?.accountId || '';

            if (!token && !accountId) {
                this.setState({ status: 'ready', isAuthenticated: false, profile: null });
                return false;
            }

            this.accessToken = token;
            this.accountId = accountId;

            const enrichedProfile = await withTimeout(
                this.recoverProfile(auth),
                8000,
                'recoverProfile'
            );
            const finalProfile = {
                ...baseProfile,
                ...enrichedProfile,
                accessToken: token || enrichedProfile?.accessToken || '',
                accountId: accountId || enrichedProfile?.accountId || ''
            };

            this.profileName = finalProfile.displayName || 'VIVERSE Player';
            this.avatarUrl = finalProfile.avatarUrl || null;

            this.setState({
                status: 'ready',
                isAuthenticated: true,
                profile: finalProfile,
                authClient: this.client
            });

            console.log(`👤 Profile Recovered: ${this.profileName}`);
            console.log('🧾 Avatar field candidates:', {
                activeAvatar: finalProfile.raw?.activeAvatar || null,
                avatar: finalProfile.raw?.avatar || null,
                vrmUrl: finalProfile.raw?.vrmUrl || finalProfile.raw?.vrm_url || null,
                avatarUrl: finalProfile.raw?.avatarUrl || finalProfile.raw?.avatar_url || null,
                modelUrl: finalProfile.raw?.modelUrl || finalProfile.raw?.model_url || null,
                assetUrl: finalProfile.raw?.assetUrl || finalProfile.raw?.asset_url || null,
                headIconUrl: finalProfile.raw?.headIconUrl || finalProfile.raw?.head_icon_url || null,
                profilePicUrl: finalProfile.raw?.profilePicUrl || null
            });
            if (this.avatarUrl) console.log(`🖼️ Avatar URL: ${this.avatarUrl}`);
            return true;
        } catch (error) {
            this.setState({
                status: 'ready',
                isAuthenticated: false,
                profile: null,
                error: error?.message || 'Auth check failed'
            });
            console.error('DashRunner auth check failed:', error);
            return false;
        }
    }

    async recoverProfile(authResult) {
        let mergedProfile = normalizeProfile(authResult) || {};
        const merge = (profile) => {
            const normalized = normalizeProfile(profile);
            if (!normalized) return;
            if (mergedProfile.displayName && mergedProfile.displayName !== 'VIVERSE Player' && normalized.displayName === 'VIVERSE Player') {
                normalized.displayName = mergedProfile.displayName;
            }
            mergedProfile = {
                ...mergedProfile,
                ...normalized,
                raw: { ...mergedProfile.raw, ...normalized.raw }
            };
        };

        const sdk = detectSdkGlobal();
        const AvatarClass = sdk?.avatar || sdk?.Avatar;
        if (this.accessToken && typeof AvatarClass === 'function') {
            try {
                const avatarClient = new AvatarClass({
                    baseURL: VIVERSE_CONFIG.avatarApiBase,
                    accessToken: this.accessToken,
                    token: this.accessToken,
                    authorization: this.accessToken,
                    appId: VIVERSE_CONFIG.clientId,
                    clientId: VIVERSE_CONFIG.clientId
                });
                merge(await avatarClient.getProfile());
            } catch (error) {
                console.warn('Avatar SDK Profile failed:', error);
            }
        }

        if (needsMoreProfile(mergedProfile) && typeof this.client?.getUserInfo === 'function') {
            try { merge(await this.client.getUserInfo()); } catch {}
        }
        if (needsMoreProfile(mergedProfile) && typeof this.client?.getUser === 'function') {
            try { merge(await this.client.getUser()); } catch {}
        }
        if (needsMoreProfile(mergedProfile) && typeof this.client?.getProfileByToken === 'function') {
            try { merge(await this.client.getProfileByToken(this.accessToken)); } catch {}
        }

        return mergedProfile;
    }

    login() {
        if (!this.client) return;
        if (typeof this.client.loginWithWorlds === 'function') {
            this.client.loginWithWorlds();
            return;
        }
        if (typeof this.client.login === 'function') {
            this.client.login();
        }
    }
}
