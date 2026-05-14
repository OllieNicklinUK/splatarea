// main.js — IMMUTABLE
// App bootstrap: auth first, then mount with auth context for Lambda.
// Auth is required — Lambda invoke needs accessToken + userId.
// Renders a login gate when unauthenticated. Never a blank screen.
// Do not modify this file.

import { APP_CONFIG } from './viverseConfig.js';
import { ViverseAuthController } from './viverseAuth.js';
import { createApp } from './app.js';

const root = document.getElementById('root');
if (!root) throw new Error('[main] #root element not found');

const app = createApp(root);

// Mount immediately with login gate — no blank screen
app.mount({
  appId: APP_CONFIG.appId,
  appName: APP_CONFIG.appName
});

const auth = new ViverseAuthController((authState) => {
  app.onAuthChange(authState);
});

auth.initialize().catch((err) => {
  console.warn('[main] Auth initialization error (non-fatal):', err?.message || err);
});

// Expose login/logout for UI
window.__viverse_login = () => auth.login();
