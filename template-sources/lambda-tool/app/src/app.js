// app.js — EDITABLE
// Market ticker tool. Uses Lambda to fetch crypto/stock prices without exposing API keys.
// Replace this file to build a different Lambda-backed tool.
// Auth context (accessToken + userId + appId) is passed in from main.js via onAuthChange().

import ViverseLambda from './viverseLambda.js';

const TICKER_CONFIG = window.__APP_CONFIG__?.ticker || {
  base: 'USD',
  symbols: ['TWD', 'EUR', 'JPY', 'GBP', 'HKD', 'SGD'],
  refreshIntervalSeconds: 3600
};

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  authStatus: 'idle',       // 'idle' | 'detecting' | 'ready'
  isAuthenticated: false,
  displayName: null,
  accessToken: '',
  userId: '',
  appId: '',
  prices: [],               // [{ symbol, price, change24h, changeDir }]
  loadingPrices: false,
  lastUpdated: null,
  error: null,
  refreshTimer: null
};

// ─── Lambda call ─────────────────────────────────────────────────────────────

async function fetchPrices() {
  if (!state.isAuthenticated || !state.accessToken || !state.userId || !state.appId) return;
  if (state.loadingPrices) return;

  state.loadingPrices = true;
  state.error = null;
  render();

  try {
    const result = await ViverseLambda.invoke(
      'prices_event',
      {
        base: TICKER_CONFIG.base || 'USD',
        symbols: TICKER_CONFIG.symbols
      },
      state.accessToken,
      { appId: state.appId, userId: state.userId }
    );

    if (!result?.success) {
      throw new Error(result?.error || 'prices_event returned no data');
    }

    state.prices = (result.prices || []).map((p) => ({
      symbol: String(p.symbol || ''),
      price: Number(p.price ?? 0),
      change24h: Number(p.change24h ?? 0),
      changeDir: Number(p.change24h ?? 0) >= 0 ? 'up' : 'down'
    }));
    state.lastUpdated = new Date();
    state.error = null;
  } catch (err) {
    console.error('[ticker] fetchPrices failed:', err?.message || err);
    state.error = err?.message || 'Failed to fetch prices';
  } finally {
    state.loadingPrices = false;
    render();
  }
}

function startRefreshTimer() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  const intervalMs = (TICKER_CONFIG.refreshIntervalSeconds || 60) * 1000;
  // Minimum 30s — invoke is job-style, not streaming
  const safeMs = Math.max(intervalMs, 30_000);
  state.refreshTimer = setInterval(fetchPrices, safeMs);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

let rootEl = null;

function formatPrice(price, currency) {
  if (price === 0) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: price < 1 ? 4 : 2,
    maximumFractionDigits: price < 1 ? 6 : 2
  }).format(price);
}

function formatChange(change) {
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

function formatTime(date) {
  if (!date) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function render() {
  if (!rootEl) return;
  const { authStatus, isAuthenticated, displayName, prices, loadingPrices, lastUpdated, error } = state;
  const authPending = authStatus !== 'ready';

  rootEl.innerHTML = `
    <div class="ticker-card">
      <header class="ticker-header">
        <div class="ticker-title">
          <span class="ticker-icon">💱</span>
          <span>${escHtml(window.__APP_CONFIG__?.appName || 'Currency Rates')}</span>
        </div>
        <div class="ticker-identity">
          ${
            isAuthenticated
              ? `<span class="pill pill--auth">✓ ${escHtml(displayName || 'Player')}</span>`
              : authPending
              ? `<span class="pill pill--pending">Checking login…</span>`
              : `<button class="pill pill--login" onclick="window.__viverse_login()">Login to view</button>`
          }
        </div>
      </header>

      ${!isAuthenticated && !authPending ? `
        <div class="ticker-gate">
          <div class="gate-icon">🔒</div>
          <p>Login with your VIVERSE account to view live prices.</p>
          <button class="btn-primary" onclick="window.__viverse_login()">Login with VIVERSE</button>
        </div>
      ` : authPending ? `
        <div class="ticker-loading">
          <div class="spinner"></div>
          <span>Authenticating…</span>
        </div>
      ` : `
        <div class="ticker-body">
          ${error ? `<div class="ticker-error">⚠️ ${escHtml(error)}</div>` : ''}

          ${prices.length === 0 && !loadingPrices ? `
            <div class="ticker-empty">
              <div class="spinner"></div>
              <span>Loading prices…</span>
            </div>
          ` : ''}

          <div class="price-list">
            ${prices.map((p) => `
              <div class="price-row">
                <div class="price-symbol">${escHtml(p.symbol)}</div>
                <div class="price-value">${formatPrice(p.price, TICKER_CONFIG.base || 'USD')}</div>
                ${p.change24h !== 0 ? `<div class="price-change price-change--${p.changeDir}">
                  ${p.changeDir === 'up' ? '▲' : '▼'} ${formatChange(p.change24h)}
                </div>` : '<div class="price-change"></div>'}
              </div>
            `).join('')}
          </div>

          ${prices.length > 0 ? `
            <div class="ticker-footer">
              <span>Base: ${escHtml(TICKER_CONFIG.base || 'USD')} · Updated ${formatTime(lastUpdated)}</span>
              <button
                class="btn-refresh ${loadingPrices ? 'btn-refresh--loading' : ''}"
                onclick="window.__ticker_refresh()"
                ${loadingPrices ? 'disabled' : ''}
              >
                ${loadingPrices ? '⟳ Fetching…' : '⟳ Refresh'}
              </button>
            </div>
          ` : ''}
        </div>
      `}
    </div>
  `;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function createApp(el) {
  rootEl = el;

  return {
    mount({ appId, appName }) {
      state.appId = appId;
      injectStyles();
      render();
      window.__ticker_refresh = fetchPrices;
    },

    onAuthChange(authState) {
      const wasAuthenticated = state.isAuthenticated;
      state.authStatus = authState.status === 'ready' ? 'ready' : 'detecting';
      state.isAuthenticated = authState.isAuthenticated;
      state.displayName = authState.profile?.displayName || null;
      state.accessToken = authState.profile?.accessToken || '';
      state.userId = authState.profile?.accountId || '';

      render();

      // First successful auth — fetch immediately and start timer
      if (!wasAuthenticated && state.isAuthenticated) {
        fetchPrices();
        startRefreshTimer();
      }
    }
  };
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('ticker-styles')) return;
  const style = document.createElement('style');
  style.id = 'ticker-styles';
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      min-height: 100dvh;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 16px;
    }

    #root { width: 100%; max-width: 480px; }

    .ticker-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Header */
    .ticker-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .ticker-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 16px;
      font-weight: 700;
    }
    .ticker-icon { font-size: 18px; }

    .pill {
      display: inline-flex; align-items: center;
      padding: 5px 12px; border-radius: 999px;
      font-size: 13px; font-weight: 600;
      border: none; cursor: default;
    }
    .pill--auth    { background: #1f3d2e; color: #3fb950; }
    .pill--pending { background: #1c2128; color: #8b949e; }
    .pill--login   { background: #1f6feb; color: #fff; cursor: pointer; transition: background 0.15s; }
    .pill--login:hover  { background: #388bfd; }
    .pill--login:active { background: #1158c7; }

    /* Login gate */
    .ticker-gate {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      padding: 32px 16px;
      text-align: center;
    }
    .gate-icon { font-size: 36px; }
    .ticker-gate p { color: #8b949e; font-size: 14px; line-height: 1.5; }

    .btn-primary {
      background: #1f6feb;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 12px 24px;
      font-size: 15px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      min-height: 44px;
      transition: background 0.15s;
    }
    .btn-primary:hover  { background: #388bfd; }
    .btn-primary:active { background: #1158c7; }

    /* Loading / empty */
    .ticker-loading, .ticker-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 32px;
      color: #8b949e;
      font-size: 14px;
    }
    .spinner {
      width: 18px; height: 18px;
      border: 2px solid #30363d;
      border-top-color: #388bfd;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Error */
    .ticker-error {
      background: #2d1b1b;
      border: 1px solid #6e2020;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      color: #f85149;
    }

    /* Price list */
    .price-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .price-row {
      display: grid;
      grid-template-columns: 80px 1fr auto;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      background: #1c2128;
      border: 1px solid #21262d;
      border-radius: 10px;
      min-height: 52px;
      transition: border-color 0.15s;
    }
    .price-row:hover { border-color: #30363d; }

    .price-symbol {
      font-size: 15px;
      font-weight: 700;
      color: #e6edf3;
      font-family: ui-monospace, monospace;
    }
    .price-value {
      font-size: 15px;
      font-weight: 600;
      color: #e6edf3;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .price-change {
      font-size: 13px;
      font-weight: 700;
      text-align: right;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .price-change--up   { color: #3fb950; }
    .price-change--down { color: #f85149; }

    /* Footer */
    .ticker-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 4px;
      font-size: 12px;
      color: #484f58;
    }

    .btn-refresh {
      background: transparent;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 5px 12px;
      font-size: 12px;
      font-family: inherit;
      color: #8b949e;
      cursor: pointer;
      transition: border-color 0.15s, color 0.15s;
      min-height: 30px;
    }
    .btn-refresh:hover  { border-color: #388bfd; color: #388bfd; }
    .btn-refresh:disabled { opacity: 0.5; cursor: default; }
    .btn-refresh--loading { color: #484f58; }
  `;
  document.head.appendChild(style);
}
