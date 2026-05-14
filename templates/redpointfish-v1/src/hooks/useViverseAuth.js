import { useState, useEffect, useCallback, useRef } from 'react';

const VERSION_NAME = "1.5.7-authflow-tank-strict";

const useViverseAuth = () => {
    const [sdk, setSdk] = useState(null);
    const [authClient, setAuthClient] = useState(null);
    const [profile, setProfile] = useState(null);
    const [accessToken, setAccessToken] = useState(null);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [status, setStatus] = useState('detecting'); 
    const [error, setError] = useState(null);
    const initOnceRef = useRef(false);

    const APP_ID = import.meta.env.VITE_VIVERSE_CLIENT_ID || import.meta.env.VITE_VIVERSE_APP_ID || '';

    const detectSdk = useCallback(async () => {
        const startTime = Date.now();
        const timeout = 30000; 

        return new Promise((resolve, reject) => {
            const check = () => {
                const candidates = [
                    { name: 'window.viverse', value: window.viverse },
                    { name: 'window.VIVERSE_SDK', value: window.VIVERSE_SDK },
                    { name: 'window.vSdk', value: window.vSdk }
                ];
                const resolved = candidates.find((c) => c.value);
                const resolvedSdk = resolved?.value;
                if (resolvedSdk) {
                    console.log(`[AuthFlow] SDK detected after ${Date.now() - startTime}ms from ${resolved?.name}`);
                    resolve(resolvedSdk);
                } else if (Date.now() - startTime > timeout) {
                    reject(new Error('SDK Detection Timeout'));
                } else {
                    setTimeout(check, 200);
                }
            };
            check();
        });
    }, []);

    const createAuthClient = useCallback((resolvedSdk) => {
        if (typeof resolvedSdk?.client === 'function') {
            return new resolvedSdk.client({
                clientId: APP_ID,
                domain: 'account.htcvive.com'
            });
        }
        if (typeof resolvedSdk?.Client === 'function') {
            return new resolvedSdk.Client({
                clientId: APP_ID,
                domain: 'account.htcvive.com'
            });
        }
        return resolvedSdk || null;
    }, [APP_ID]);

    const fetchProfile = useCallback(async (client, token, authData = null, resolvedSdk = null) => {
        let merged = null;
        const sdkRef = resolvedSdk || sdk;
        const hasAvatar = (p) =>
            !!(p && (p.activeAvatar?.avatarUrl || p.avatarUrl || p.avatar_url || p.profilePicUrl));
        const merge = (p) => {
            if (!p || typeof p !== 'object') return;
            merged = merged ? { ...merged, ...p } : { ...p };
        };

        try {
            // Strategy 0: recover from auth handshake object
            merge(authData);
            if (authData && typeof authData === 'object') {
                console.log('[AuthFlow] Strategy-0 profile recovered from checkAuth payload');
            }

            const AvatarClass = sdkRef?.avatar || sdkRef?.Avatar;
            if (token && AvatarClass) {
                const avatarClient = new AvatarClass({
                    baseURL: "https://sdk-api.viverse.com/",
                    accessToken: token,
                    token: token,
                    authorization: token,
                    appId: APP_ID,
                    clientId: APP_ID
                });

                console.log('[AuthFlow] Strategy-1 avatar.getProfile()');
                const avatarProfile = await avatarClient.getProfile().catch(e => {
                    console.warn('[AuthFlow] avatar.getProfile failed, moving to fallback', e);
                    return null;
                });
                merge(avatarProfile);
            }

            if ((!merged || !hasAvatar(merged)) && typeof client?.getUserInfo === 'function') {
                console.log('[AuthFlow] Strategy-2 client.getUserInfo()');
                const userInfo = await client.getUserInfo().catch(() => null);
                merge(userInfo);
            }

            if ((!merged || !hasAvatar(merged)) && typeof client?.getUser === 'function') {
                console.log('[AuthFlow] Strategy-3 client.getUser()');
                const user = await client.getUser().catch(() => null);
                merge(user);
            }

            if ((!merged || !hasAvatar(merged)) && typeof client?.getProfileByToken === 'function' && token) {
                console.log('[AuthFlow] Strategy-4 client.getProfileByToken()');
                const profileByToken = await client.getProfileByToken(token).catch(() => null);
                merge(profileByToken);
            }

            const isIframe = window.self !== window.top;
            if ((!merged || !hasAvatar(merged)) && token && !isIframe) {
                console.log('[AuthFlow] Strategy-5 direct profile API');
                const direct = await fetch('https://account-profile.htcvive.com/SS/Profiles/v3/Me', {
                    headers: { Authorization: `Bearer ${token}` }
                }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
                merge(direct);
            } else if ((!merged || !hasAvatar(merged)) && token && isIframe) {
                console.log('[AuthFlow] Strategy-5 skipped in iframe (expected CORS constraints)');
            }

        } catch (err) {
            console.error('[AuthFlow] Profile fetch failed:', err);
        }
        console.log(`[AuthFlow] Profile resolution completed. hasProfile=${Boolean(merged)}`);
        return merged ? normalizeProfile(merged) : null;
    }, [APP_ID, sdk]);

    const normalizeProfile = (raw) => {
        const looksLikeUuid = (value) =>
            typeof value === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
        const userId = raw.account_id || raw.accountId || raw.id || raw.userId || raw.sub || '';
        const preferredName =
            raw.name ||
            raw.displayName ||
            raw.display_name ||
            raw.nickName ||
            raw.nickname ||
            raw.userName ||
            raw.email ||
            '';
        const displayName = preferredName && !looksLikeUuid(preferredName) ? preferredName : 'VIVERSE Player';
        const avatarUrl =
            raw.headIconUrl ||
            raw.activeAvatar?.headIconUrl ||
            raw.head_icon_url ||
            raw.headIcon ||
            '';
        
        return {
            displayName,
            avatarUrl,
            raw,
            userId
        };
    };

    const initialize = async () => {
        try {
            console.log(`[AuthFlow] Bootstrap version: ${VERSION_NAME}`);
            
            const resolvedSdk = await detectSdk();
            setSdk(resolvedSdk);
            setStatus('handshaking');
            console.log('[AuthFlow] Status -> handshaking');

            await new Promise(resolve => setTimeout(resolve, 1200));
            console.log('[AuthFlow] Mandatory handshake delay completed (1200ms)');

            if (resolvedSdk.bridge && !resolvedSdk.bridge.isReady) {
                console.log('[AuthFlow] Bridge reported not ready yet; continuing with guarded auth checks');
            }

            if (!APP_ID) {
                console.error('[AuthFlow] APP_ID is missing from environment');
                setError('APP_ID is missing');
                setStatus('failed');
                return;
            }

            const client = createAuthClient(resolvedSdk);
            if (!client) {
                throw new Error('VIVERSE auth client unavailable');
            }
            setAuthClient(client);
            const proto = Object.getPrototypeOf(client) || {};
            const methodList = Object.getOwnPropertyNames(proto)
                .filter((name) => typeof client[name] === 'function')
                .sort();
            console.log('[AuthFlow] Auth client methods:', methodList.join(', '));

            setStatus('checking_auth');
            console.log('[AuthFlow] Status -> checking_auth');
            const authResult = await client.checkAuth();
            
            const isAuth = Boolean(
                authResult?.is_authenticated ?? 
                authResult?.isAuthenticated ?? 
                authResult?.authenticated ?? 
                authResult?.access_token ?? 
                authResult?.accessToken ?? 
                authResult?.account_id ?? 
                authResult?.accountId
            );

            setIsAuthenticated(isAuth);
            console.log('[AuthFlow] checkAuth result:', {
                isAuthenticated: isAuth,
                hasAccessToken: Boolean(authResult?.access_token || authResult?.accessToken),
                hasAccountId: Boolean(authResult?.account_id || authResult?.accountId)
            });

            if (isAuth) {
                const token = authResult.access_token || authResult.accessToken || '';
                setAccessToken(token);
                
                const strategy0Profile = normalizeProfile(authResult);
                setProfile(strategy0Profile);
                console.log('[AuthFlow] Strategy-0 profile set:', {
                    displayName: strategy0Profile.displayName,
                    hasAvatar: Boolean(strategy0Profile.avatarUrl),
                    userId: strategy0Profile.userId || null
                });

                // Skill guidance: if bridge is not ready, wait briefly before profile strategies.
                if (resolvedSdk?.bridge?.isReady === false) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }

                const fullProfile = await fetchProfile(client, token, authResult, resolvedSdk);
                if (fullProfile) {
                    setProfile(fullProfile);
                    console.log('[AuthFlow] Full profile set:', {
                        displayName: fullProfile.displayName,
                        hasAvatar: Boolean(fullProfile.avatarUrl),
                        userId: fullProfile.userId || null
                    });
                }
            } else {
                console.log('[AuthFlow] User not authenticated yet; waiting for explicit login');
            }

            setStatus('ready');
            console.log('[AuthFlow] Status -> ready');
        } catch (err) {
            console.error('[AuthFlow] Initialization Error:', err);
            setError(err.message);
            setStatus('failed');
        }
    };

    useEffect(() => {
        if (initOnceRef.current) return;
        initOnceRef.current = true;
        initialize();
        // Intentionally one-shot bootstrap to avoid repeated auth/checkAuth cycles from callback identity churn.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const login = async () => {
        if (!authClient) return;
        try {
            console.log('[AuthFlow] Login requested');
            if (authClient.loginWithWorlds) {
                await authClient.loginWithWorlds();
            } else if (authClient.loginWithAuthPage) {
                await authClient.loginWithAuthPage();
            } else if (authClient.login) {
                await authClient.login();
            } else {
                window.open('https://account.htcvive.com/', '_blank');
            }
        } catch (err) {
            console.error('[AuthFlow] Login Error:', err);
        }
    };

    const logout = async () => {
        if (authClient?.logout) await authClient.logout();
        setIsAuthenticated(false);
        setProfile(null);
        setAccessToken(null);
    };

    return { sdk, authClient, profile, accessToken, isAuthenticated, status, error, login, logout };
};

export default useViverseAuth;
