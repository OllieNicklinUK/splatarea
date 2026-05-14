const VERSION_NAME = '1.0.0-flight-simulator';

const HOSTNAME_APP_ID_PATTERN = /^([a-z0-9]{10})(?:-preview)?\.world\.viverse\.app$/i;

function resolveAppId() {
    const runtimeConfig = window.__FLIGHT_SIM_CONFIG__ || {};
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
        (window.__FLIGHT_SIM_CONFIG__ || {}).leaderboardName ||
        import.meta.env.VITE_VIVERSE_LEADERBOARD_NAME ||
        'FlightSimLeaderboard'
    ),
    gameName: 'Flight Simulator',
    versionName: VERSION_NAME,
    debugMode: false,
};

console.log(`[FlightSim] ${VERSION_NAME} bootstrap — appId: ${VIVERSE_CONFIG.clientId || '(none)'}`);
