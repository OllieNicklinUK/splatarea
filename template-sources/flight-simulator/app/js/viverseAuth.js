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
        raw.displayName || raw.display_name || raw.name ||
        raw.nickName || raw.nickname || raw.userName || raw.email || '';

    const displayName =
        preferredName && !looksLikeUuid(preferredName) ? preferredName : 'VIVERSE Player';

    const avatarUrl =
        raw.activeAvatar?.headIconUrl || raw.activeAvatar?.head_icon_url ||
        raw.activeAvatar?.vrmUrl || raw.activeAvatar?.vrm_url ||
        raw.activeAvatar?.avatarUrl || raw.activeAvatar?.avatar_url ||
        raw.activeAvatar?.modelUrl || raw.activeAvatar?.model_url ||
        raw.activeAvatar?.assetUrl || raw.activeAvatar?.asset_url ||
        raw.avatar?.headIconUrl || raw.avatar?.head_icon_url ||
        raw.avatar?.vrmUrl || raw.avatar?.vrm_url ||
        raw.avatar?.avatarUrl || raw.avatar?.avatar_url ||
        raw.headIconUrl || raw.head_icon_url ||
        raw.vrmUrl || raw.vrm_url ||
        raw.profilePicUrl || raw.avatarUrl || raw.avatar_url || '';

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
        profile?.activeAvatar?.vrmUrl || profile?.activeAvatar?.avatarUrl ||
        profile?.activeAvatar?.headIconUrl || profile?.avatarUrl ||
        profile?.avatar_url || profile?.profilePicUrl
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
        this._sdk = null;  // SDK instance captured in initialize() — used by recoverProfile()
        this.accessToken = null;
        this.accountId = null;
        this.profileName = 'VIVERSE Player';
        this.isReady = false;

        console.log(`[FlightSimAuth] ${VIVERSE_CONFIG.versionName} bootstrap`);
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
            console.log('[FlightSimAuth] initialize()');
            this.setState({ status: 'detecting', error: '' });
            const sdk = await this.waitForSDK();
            this.setState({ sdk, status: 'handshaking' });

            if (!sdk) {
                this.setState({ status: 'ready', error: 'VIVERSE SDK not detected.' });
                return false;
            }

            // Store SDK instance for use in recoverProfile() (compliance gate 10)
            this._sdk = sdk;

            // Mandatory 1200ms iframe handshake delay (viverse-auth skill compliance gate)
            await delay(1200);

            // Diagnostic: log what the SDK actually exposes
            console.log('[FlightSimAuth] SDK keys:', Object.keys(sdk).join(', '));

            const ClientClass = sdk?.client || sdk?.Client;
            console.log('[FlightSimAuth] ClientClass type:', typeof ClientClass);

            if (!VIVERSE_CONFIG.clientId) {
                this.setState({ status: 'ready', error: 'Missing VIVERSE App ID.' });
                return false;
            }

            if (typeof ClientClass === 'function') {
                // Constructor — instantiate it
                this.client = new ClientClass({
                    clientId: VIVERSE_CONFIG.clientId,
                    domain: VIVERSE_CONFIG.authDomain  // MANDATORY: account.htcvive.com
                });
            } else if (ClientClass && typeof ClientClass.checkAuth === 'function') {
                // Already a pre-instantiated client object — use directly
                console.log('[FlightSimAuth] Using pre-instantiated SDK client');
                this.client = ClientClass;
            } else {
                console.error('[FlightSimAuth] VIVERSE auth client unavailable. SDK keys:', Object.keys(sdk).join(', '));
                this.setState({ status: 'ready', error: 'VIVERSE auth client unavailable.' });
                return false;
            }

            this.isReady = true;
            this.setState({ authClient: this.client, status: 'checking_auth' });
            return true;
        })().catch((error) => {
            this.initPromise = null;
            this.setState({ status: 'ready', error: error?.message || 'Auth init failed' });
            return false;
        });

        return this.initPromise;
    }

    async waitForSDK() {
        for (let i = 0; i < 120; i++) {
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
            console.log('[FlightSimAuth] checkAuth()');
            this.setState({ status: 'checking_auth', error: '' });

            // Retry up to 3x — initialize-auth message may arrive after our first attempt
            let auth = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                auth = await withTimeout(this.client.checkAuth(), 8000, 'checkAuth');
                if (auth) break;
                if (attempt < 3) {
                    console.log(`[FlightSimAuth] checkAuth attempt ${attempt} returned null, retrying in 1s...`);
                    await delay(1000);
                }
            }

            console.log('[FlightSimAuth] checkAuth result:', auth
                ? `access_token=${!!auth.access_token}, account_id=${!!auth.account_id}`
                : 'null — user not authenticated');

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

            this.setState({
                status: 'ready',
                isAuthenticated: true,
                profile: finalProfile,
                authClient: this.client
            });

            console.log(`[FlightSimAuth] Logged in: ${this.profileName}`);
            return true;
        } catch (error) {
            this.setState({ status: 'ready', isAuthenticated: false, profile: null, error: error?.message || 'Auth check failed' });
            console.error('[FlightSimAuth] checkAuth failed:', error);
            return false;
        }
    }

    async recoverProfile(authResult) {
        let mergedProfile = normalizeProfile(authResult) || {};

        const merge = (profile) => {
            const normalized = normalizeProfile(profile);
            if (!normalized) return;
            // Do not overwrite a resolved name with a generic one (compliance gate 12)
            if (mergedProfile.displayName && mergedProfile.displayName !== 'VIVERSE Player' && normalized.displayName === 'VIVERSE Player') {
                normalized.displayName = mergedProfile.displayName;
            }
            mergedProfile = { ...mergedProfile, ...normalized, raw: { ...mergedProfile.raw, ...normalized.raw } };
        };

        // Use the SDK captured in initialize() — compliance gate 10 (same init-cycle instance)
        const sdk = this._sdk || detectSdkGlobal();

        // Compliance gate 11: 500ms bridge-ready delay before profile enrichment
        if (sdk?.bridge?.isReady === false) {
            console.log('[FlightSimAuth] Bridge not ready — waiting 500ms before profile chain');
            await delay(500);
        }

        // 1) Avatar SDK primary path
        const AvatarClass = sdk?.avatar || sdk?.Avatar;
        if (this.accessToken && typeof AvatarClass === 'function') {
            try {
                const avatarClient = new AvatarClass({
                    baseURL: VIVERSE_CONFIG.avatarApiBase,  // MANDATORY: https://sdk-api.viverse.com/
                    accessToken: this.accessToken,
                    token: this.accessToken,
                    authorization: this.accessToken,  // MANDATORY: pass all three
                    appId: VIVERSE_CONFIG.clientId,
                    clientId: VIVERSE_CONFIG.clientId
                });
                merge(await avatarClient.getProfile());
            } catch (e) {
                console.warn('[FlightSimAuth] Avatar SDK profile failed:', e);
            }
        }

        // 2-4) Fallback chain
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
