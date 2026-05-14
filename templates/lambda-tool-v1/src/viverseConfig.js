// viverseConfig.js — HIGH-RISK (read fully before editing; patch surgically)
// Resolves App ID from runtime config or VIVERSE hostname.
// Edits allowed when needed — read fully, patch surgically, verify syntax.

const HOSTNAME_APP_ID_PATTERN = /^([a-z0-9]{10})(?:-preview)?\.world\.viverse\.app$/i;

function resolveAppId() {
  const runtimeConfig = window.__APP_CONFIG__ || {};
  const explicit = String(runtimeConfig.clientId || runtimeConfig.appId || '').trim();
  if (/^[a-z0-9]{10}$/i.test(explicit)) return explicit;

  const hostMatch = window.location.hostname.match(HOSTNAME_APP_ID_PATTERN);
  if (hostMatch) return hostMatch[1].toLowerCase();

  return '';
}

export const APP_CONFIG = {
  appId: resolveAppId(),
  appName: String((window.__APP_CONFIG__ || {}).appName || 'VIVERSE App'),
  authDomain: 'account.htcvive.com',
  avatarBaseUrl: 'https://sdk-api.viverse.com/',
  versionName: String((window.__APP_CONFIG__ || {}).versionName || '1.0.0')
};
