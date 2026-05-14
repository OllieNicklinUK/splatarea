const HOSTNAME_APP_ID_PATTERN = /^([a-z0-9]{10})(?:-preview)?\.world\.viverse\.app$/i;

const runtimeConfig = window.__STARTER_KIT_RACING_CONFIG__ || {};

function resolveAppId() {

	const explicit = String( runtimeConfig.clientId || runtimeConfig.appId || '' ).trim();
	if ( /^[a-z0-9]{10}$/i.test( explicit ) ) return explicit;

	const hostMatch = window.location.hostname.match( HOSTNAME_APP_ID_PATTERN );
	if ( hostMatch ) return hostMatch[ 1 ].toLowerCase();

	return '';

}

export const VIVERSE_CONFIG = {
	clientId: resolveAppId(),
	leaderboardName: String( runtimeConfig.leaderboardName || 'starter-kit-racing-time' ).trim(),
	lapsToFinish: Math.max( 1, Number( runtimeConfig.lapsToFinish || 3 ) || 3 ),
	versionName: '1.0.0-starter-racing-auth-leaderboard'
};
