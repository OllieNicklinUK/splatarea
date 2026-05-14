const HOSTNAME_APP_ID_PATTERN = /^([a-z0-9]{10})(?:-preview)?\.world\.viverse\.app$/i;

function resolveAppId() {
    const runtimeConfig = window.__DASHRUNNER_CONFIG__ || {};
    const explicit = String(
        runtimeConfig.clientId ||
        runtimeConfig.appId ||
        import.meta.env.VITE_VIVERSE_CLIENT_ID ||
        ''
    ).trim();

    if (/^[a-z0-9]{10}$/i.test(explicit)) return explicit.toLowerCase();

    const hostMatch = window.location.hostname.match(HOSTNAME_APP_ID_PATTERN);
    if (hostMatch) return hostMatch[1].toLowerCase();

    return '';
}

export const VIVERSE_CONFIG = {
    clientId: resolveAppId(),
    authDomain: 'account.htcvive.com',
    avatarApiBase: 'https://sdk-api.viverse.com/',
    leaderboardName: String(
        (window.__DASHRUNNER_CONFIG__ || {}).leaderboardName ||
        import.meta.env.VITE_VIVERSE_LEADERBOARD_NAME ||
        'DashRunnerLeaderboard'
    ),
    gameName: 'Multiplayer Dash Runner',
    versionName: String((window.__DASHRUNNER_CONFIG__ || {}).versionName || '0.1.0-preview-auth'),
    debugMode: false,
    defaultAvatarUrl: 'assets/idle.glb',
    defaultAnimationPath: 'assets/Walk_vrma.glb'
};
