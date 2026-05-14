const HOSTNAME_APP_ID_PATTERN = /^([a-z0-9]{10})(?:-preview)?\.world\.viverse\.app$/i;

function resolveAppId() {
  const cfg = window.__ARCHER_CONFIG__ || {};
  const explicit = String(cfg.clientId || cfg.appId || '').trim();
  if (/^[a-z0-9]{10}$/i.test(explicit)) return explicit;
  const hostMatch = window.location.hostname.match(HOSTNAME_APP_ID_PATTERN);
  if (hostMatch) return hostMatch[1].toLowerCase();
  return '';
}

export const VIVERSE_CONFIG = {
  appId:         resolveAppId(),
  authDomain:    'account.htcvive.com',
  avatarBaseUrl: 'https://sdk-api.viverse.com/',
  leaderboardName: String((window.__ARCHER_CONFIG__ || {}).leaderboardName || 'archer-high-score'),
  versionName:     String((window.__ARCHER_CONFIG__ || {}).versionName    || '0.1.0-single-player'),
};
