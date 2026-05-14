// main.js — HIGH-RISK (read fully before editing; patch surgically)
// App bootstrap: initializes auth then mounts the app.
// Auth outcome must never block app mount — app works with or without login.
// Edits allowed when needed — read fully, patch surgically, verify syntax.

import { APP_CONFIG } from './viverseConfig.js';
import { ViverseAuthController } from './viverseAuth.js';
import { createApp } from './app.js';

const root = document.getElementById('root');
if (!root) throw new Error('[main] #root element not found');

const app = createApp(root);

const auth = new ViverseAuthController((authState) => {
  app.onAuthChange(authState);
});

// Mount app immediately — do not wait for auth
app.mount({
  appId: APP_CONFIG.appId,
  appName: APP_CONFIG.appName
});

// Auth runs in parallel — result delivered via onAuthChange callback
auth.initialize().catch((err) => {
  console.warn('[main] Auth initialization error (non-fatal):', err?.message || err);
});

// Expose login handler for UI
window.__viverse_login = () => auth.login();
