// app.js — EDITABLE
// Poll widget with:
//   - VIVERSE Storage SDK  → persist each user's vote choice (cross-device)
//   - VIVERSE Leaderboard SDK → shared vote counts across all users
//   - Admin panel → live results + refresh, gated by adminAccountId
//
// Replace this file entirely to build a different tool.
// Receives auth state from main.js via onAuthChange().

import { APP_CONFIG } from './viverseConfig.js';

const POLL_CONFIG = window.__APP_CONFIG__?.poll || {
  question: 'What feature would you like to see next?',
  options: ['Leaderboard', 'Avatar Customization', 'New Game Mode', 'Better Mobile UI'],
  // Must match leaderboard API names configured in VIVERSE Studio for this app.
  // One leaderboard per option. Update rule = Best. Data type = Numerical.
  leaderboardNames: ['poll-opt-0', 'poll-opt-1', 'poll-opt-2', 'poll-opt-3'],
  // accountId of the user who can see the admin panel. Leave empty to disable.
  adminAccountId: ''
};

// localStorage fallback key (used when Storage SDK is unavailable)
const LS_VOTE_KEY = `viverse-poll-vote-${APP_CONFIG.appId || 'local'}`;

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  authStatus: 'idle',       // 'idle' | 'detecting' | 'ready'
  isAuthenticated: false,
  displayName: null,
  accountId: '',
  accessToken: '',
  appId: APP_CONFIG.appId || '',

  userVote: null,           // option index (string) the user voted for, or null
  voteCounts: {},           // { [optionIndex]: number }
  loadingVotes: false,
  voteCountsLoaded: false,

  adminView: false,

  cloudSaveClient: null,    // VIVERSE Storage SDK client
  dashboardClient: null,    // VIVERSE gameDashboard client

  error: null
};

// ─── Storage SDK (user's vote persistence) ────────────────────────────────────

async function initStorageClient(appId) {
  try {
    const v = window.viverse || window.VIVERSE_SDK;
    if (typeof v?.storage !== 'function') {
      console.warn('[poll] viverse.storage not available');
      return false;
    }
    const storageClient = new v.storage();
    state.cloudSaveClient = await storageClient.newCloudSaveClient(appId);
    return true;
  } catch (err) {
    console.warn('[poll] Storage SDK init failed:', err?.message);
    return false;
  }
}

async function loadUserVote(accessToken) {
  if (state.cloudSaveClient) {
    try {
      const saved = await state.cloudSaveClient.getPlayerData('poll-vote', accessToken);
      if (saved !== null && saved !== undefined) return String(saved);
    } catch (err) {
      console.warn('[poll] getPlayerData failed, falling back to localStorage:', err?.message);
    }
  }
  // localStorage fallback
  return localStorage.getItem(LS_VOTE_KEY) || null;
}

async function saveUserVote(optionIndex, accessToken) {
  // Always write localStorage as silent fallback
  try { localStorage.setItem(LS_VOTE_KEY, String(optionIndex)); } catch {}

  if (!state.cloudSaveClient) return;
  try {
    await state.cloudSaveClient.setPlayerData('poll-vote', String(optionIndex), accessToken);
  } catch (err) {
    console.warn('[poll] setPlayerData failed (localStorage was saved):', err?.message);
  }
}

// ─── Leaderboard SDK (shared vote counts) ────────────────────────────────────

function initDashboardClient(accessToken, appId) {
  try {
    const v = window.viverse || window.vSdk || window.VIVERSE_SDK;
    const DashboardClass = v?.gameDashboard || v?.GameDashboard;
    if (typeof DashboardClass !== 'function') {
      console.warn('[poll] viverse.gameDashboard not available');
      return false;
    }
    state.dashboardClient = new DashboardClass({
      token: accessToken,
      clientId: appId,
      baseURL: 'https://www.viveport.com/',
      communityBaseURL: 'https://www.viverse.com/'
    });
    return true;
  } catch (err) {
    console.warn('[poll] gameDashboard init failed:', err?.message);
    return false;
  }
}

async function submitVoteToLeaderboard(optionIndex, appId) {
  if (!state.dashboardClient) return;
  const lbName = (POLL_CONFIG.leaderboardNames || [])[Number(optionIndex)];
  if (!lbName) { console.warn('[poll] no leaderboard name for option', optionIndex); return; }

  try {
    await state.dashboardClient.uploadLeaderboardScore(appId, [
      { name: lbName, value: 1 }
    ]);
    console.log('[poll] vote submitted to leaderboard:', lbName);
  } catch (err) {
    console.warn('[poll] leaderboard upload failed:', err?.message);
  }
}

function extractRankings(res) {
  return (
    res?.rankings ||
    res?.ranking ||
    res?.leaderboard_rankings ||
    res?.data?.rankings ||
    res?.data?.ranking ||
    res?.leaderboard?.rankings ||
    res?.leaderboard?.ranking ||
    []
  );
}

async function fetchVoteCountForOption(optionIndex, appId) {
  const lbName = (POLL_CONFIG.leaderboardNames || [])[Number(optionIndex)];
  if (!lbName || !state.dashboardClient) return 0;

  const fetchConfigs = [
    { name: lbName, range_start: 0, range_end: 999, region: 'global', time_range: 'alltime', around_user: false },
    { name: lbName, range_start: 0, range_end: 999, region: 'global', time_range: 'alltime', around_user: true },
    { name: lbName, range_start: 0, range_end: 999, region: 'local',  time_range: 'alltime', around_user: false }
  ];

  for (const conf of fetchConfigs) {
    try {
      const res = await state.dashboardClient.getLeaderboard(appId, conf);
      const rankings = extractRankings(res);
      if (rankings.length > 0) return rankings.length;
    } catch {}
  }

  // Guest fallback
  if (typeof state.dashboardClient.getGuestLeaderboard === 'function') {
    for (const conf of fetchConfigs) {
      try {
        const res = await state.dashboardClient.getGuestLeaderboard(appId, conf);
        const rankings = extractRankings(res);
        if (rankings.length > 0) return rankings.length;
      } catch {}
    }
  }

  return 0;
}

async function fetchAllVoteCounts(appId) {
  if (!state.dashboardClient) return;
  state.loadingVotes = true;
  render();

  const counts = {};
  for (let i = 0; i < POLL_CONFIG.options.length; i++) {
    counts[String(i)] = await fetchVoteCountForOption(i, appId);
  }

  state.voteCounts = counts;
  state.loadingVotes = false;
  state.voteCountsLoaded = true;
  render();
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function castVote(optionIndex) {
  if (state.userVote !== null) return; // already voted — idempotency guard
  if (POLL_CONFIG.options[Number(optionIndex)] === undefined) return;
  if (!state.isAuthenticated) { window.__viverse_login?.(); return; }

  state.userVote = String(optionIndex);
  render(); // optimistic update

  await saveUserVote(optionIndex, state.accessToken);
  await submitVoteToLeaderboard(optionIndex, state.appId);
  await fetchAllVoteCounts(state.appId);
}

function toggleAdminView() {
  state.adminView = !state.adminView;
  render();
}

// ─── Rendering ────────────────────────────────────────────────────────────────

let rootEl = null;

function isAdmin() {
  const adminId = POLL_CONFIG.adminAccountId || window.__APP_CONFIG__?.adminAccountId || '';
  return Boolean(adminId && state.accountId && state.accountId === adminId);
}

function totalVotes() {
  return Object.values(state.voteCounts).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

function optionPct(i) {
  const total = totalVotes();
  const count = Number(state.voteCounts[String(i)] || 0);
  return total === 0 ? 0 : Math.round((count / total) * 100);
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function render() {
  if (!rootEl) return;
  const admin = isAdmin();
  const appId = APP_CONFIG.appId || '';
  const { authStatus, isAuthenticated, displayName, adminView } = state;
  const authPending = authStatus !== 'ready';

  rootEl.innerHTML = `
    <div class="poll-card">
      <header class="poll-header">
        <div class="poll-identity">
          ${isAuthenticated
            ? `<span class="pill pill--auth">✓ ${escHtml(displayName || 'Player')}</span>`
            : authPending
            ? `<span class="pill pill--pending">Checking login…</span>`
            : `<button class="pill pill--login" onclick="window.__viverse_login()">Login with VIVERSE</button>`}
        </div>
        <div class="poll-header-right">
          ${admin
            ? `<button class="admin-toggle ${adminView ? 'admin-toggle--active' : ''}"
                onclick="window.__poll_admin()">⚙ Admin</button>`
            : ''}
          <div class="poll-app-id" title="App ID">${escHtml(appId)}</div>
        </div>
      </header>

      ${adminView && admin ? renderAdminPanel() : renderPollBody()}
    </div>
  `;
}

function renderPollBody() {
  const { userVote, voteCounts, loadingVotes, voteCountsLoaded } = state;
  const hasVoted = userVote !== null;
  const total = totalVotes();

  return `
    <h1 class="poll-question">${escHtml(POLL_CONFIG.question)}</h1>

    <div class="poll-options">
      ${POLL_CONFIG.options.map((label, i) => {
        const id = String(i);
        const isChosen = userVote === id;
        const count = Number(voteCounts[id] || 0);
        const p = optionPct(i);
        const isWinner = hasVoted &&
          POLL_CONFIG.options.every((_, j) => Number(voteCounts[String(j)] || 0) <= count) &&
          count > 0;

        return `
          <button
            class="poll-option ${hasVoted ? 'poll-option--result' : 'poll-option--vote'}
                   ${isChosen ? 'poll-option--chosen' : ''} ${isWinner ? 'poll-option--winner' : ''}"
            ${hasVoted ? 'disabled' : `onclick="window.__poll_vote('${id}')"`}
            aria-pressed="${isChosen}"
          >
            <div class="poll-option__label">
              <span>${escHtml(label)}</span>
              <div class="poll-option__meta">
                ${isChosen ? '<span class="poll-option__badge">Your vote</span>' : ''}
                ${voteCountsLoaded
                  ? `<span class="poll-option__count">${count}</span>`
                  : loadingVotes
                  ? `<span class="poll-option__count poll-option__count--loading">…</span>`
                  : ''}
              </div>
            </div>
            ${hasVoted ? `
              <div class="poll-option__bar-wrap">
                <div class="poll-option__bar" style="width:${p}%"></div>
              </div>
              <div class="poll-option__pct">${p}%</div>
            ` : ''}
          </button>`;
      }).join('')}
    </div>

    <footer class="poll-footer">
      ${hasVoted
        ? `<span>${total} vote${total !== 1 ? 's' : ''} total</span>`
        : loadingVotes
        ? `<span class="poll-footer--muted">Loading votes…</span>`
        : `<span>Tap an option to vote</span>`}
    </footer>
  `;
}

function renderAdminPanel() {
  const { voteCounts, loadingVotes, voteCountsLoaded } = state;
  const total = totalVotes();

  return `
    <div class="admin-panel">
      <div class="admin-panel__header">
        <span class="admin-panel__title">📊 Vote Results</span>
        <button class="admin-refresh ${loadingVotes ? 'admin-refresh--busy' : ''}"
          onclick="window.__poll_refresh_counts()" ${loadingVotes ? 'disabled' : ''}>
          ${loadingVotes ? '⟳ Loading…' : '⟳ Refresh'}
        </button>
      </div>

      <div class="admin-question">${escHtml(POLL_CONFIG.question)}</div>

      <div class="admin-results">
        ${POLL_CONFIG.options.map((label, i) => {
          const count = Number(voteCounts[String(i)] || 0);
          const p = optionPct(i);
          return `
            <div class="admin-result-row">
              <div class="admin-result-label">${escHtml(label)}</div>
              <div class="admin-result-bar-wrap">
                <div class="admin-result-bar" style="width:${voteCountsLoaded ? p : 0}%"></div>
              </div>
              <div class="admin-result-count">
                ${voteCountsLoaded ? `${count} vote${count !== 1 ? 's' : ''} (${p}%)` : '—'}
              </div>
            </div>`;
        }).join('')}
      </div>

      <div class="admin-total">
        Total: <strong>${voteCountsLoaded ? total : '—'}</strong>
      </div>

      <div class="admin-note">
        ℹ Vote counts are read from the VIVERSE leaderboard (entry count per option, Best rule).
        To reset votes, remove and recreate the leaderboard entries in VIVERSE Studio.
      </div>
    </div>
  `;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function createApp(el) {
  rootEl = el;

  return {
    mount({ appId, appName }) {
      state.appId = appId || APP_CONFIG.appId;
      injectStyles();
      render();
      window.__poll_vote = (id) => castVote(id);
      window.__poll_admin = toggleAdminView;
      window.__poll_refresh_counts = () => fetchAllVoteCounts(state.appId);
    },

    async onAuthChange(authState) {
      const wasAuthenticated = state.isAuthenticated;
      state.authStatus = authState.status === 'ready' ? 'ready' : 'detecting';
      state.isAuthenticated = authState.isAuthenticated;
      state.displayName = authState.profile?.displayName || null;
      state.accountId = authState.profile?.accountId || '';
      state.accessToken = authState.profile?.accessToken || '';
      render();

      // On first successful auth: init clients, load saved vote, fetch counts
      if (!wasAuthenticated && state.isAuthenticated && state.accessToken) {
        const appId = state.appId;

        await initStorageClient(appId);
        const savedVote = await loadUserVote(state.accessToken);
        if (savedVote !== null) state.userVote = savedVote;

        initDashboardClient(state.accessToken, appId);
        await fetchAllVoteCounts(appId);
      }
    }
  };
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('poll-styles')) return;
  const style = document.createElement('style');
  style.id = 'poll-styles';
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

    .poll-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* ── Header ── */
    .poll-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .poll-identity { display: flex; align-items: center; }
    .poll-header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .poll-app-id { font-size: 10px; color: #484f58; font-family: monospace; }

    /* ── Pills ── */
    .pill {
      display: inline-flex; align-items: center;
      padding: 5px 12px; border-radius: 999px;
      font-size: 13px; font-weight: 600;
      border: none; cursor: default;
    }
    .pill--auth    { background: #1f3d2e; color: #3fb950; }
    .pill--pending { background: #1c2128; color: #8b949e; }
    .pill--login   { background: #1f6feb; color: #fff; cursor: pointer; transition: background .15s; }
    .pill--login:hover  { background: #388bfd; }
    .pill--login:active { background: #1158c7; }

    /* ── Admin toggle ── */
    .admin-toggle {
      background: transparent;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 12px;
      color: #8b949e;
      cursor: pointer;
      font-family: inherit;
      min-height: 28px;
      transition: border-color .15s, color .15s;
    }
    .admin-toggle:hover { border-color: #388bfd; color: #388bfd; }
    .admin-toggle--active { border-color: #388bfd; color: #388bfd; background: #1a2332; }

    /* ── Poll question ── */
    .poll-question {
      font-size: 17px; font-weight: 700;
      line-height: 1.4; color: #e6edf3;
    }

    /* ── Poll options ── */
    .poll-options { display: flex; flex-direction: column; gap: 10px; }

    .poll-option {
      width: 100%;
      background: #1c2128;
      border: 1.5px solid #30363d;
      border-radius: 10px;
      padding: 14px 16px;
      text-align: left;
      color: #e6edf3;
      font-size: 15px;
      font-family: inherit;
      cursor: pointer;
      transition: border-color .15s, background .15s;
      min-height: 52px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .poll-option:disabled { cursor: default; }
    .poll-option--vote:hover  { border-color: #388bfd; background: #1a2332; }
    .poll-option--vote:active { background: #172033; }
    .poll-option--result { border-color: #21262d; }
    .poll-option--chosen { border-color: #388bfd; background: #1a2332; }
    .poll-option--winner { border-color: #3fb950; }

    .poll-option__label {
      display: flex; align-items: center;
      justify-content: space-between; gap: 8px;
    }
    .poll-option__meta { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .poll-option__badge {
      font-size: 11px; font-weight: 600; color: #388bfd;
      background: #1f3558; padding: 2px 8px;
      border-radius: 999px; white-space: nowrap;
    }
    .poll-option__count {
      font-size: 11px; color: #484f58;
      font-variant-numeric: tabular-nums;
    }
    .poll-option__count--loading { opacity: 0.5; }

    .poll-option__bar-wrap {
      height: 4px; background: #21262d;
      border-radius: 2px; overflow: hidden;
    }
    .poll-option__bar {
      height: 100%;
      background: linear-gradient(90deg, #1f6feb, #388bfd);
      border-radius: 2px;
      transition: width .4s cubic-bezier(.4,0,.2,1);
    }
    .poll-option--winner .poll-option__bar {
      background: linear-gradient(90deg, #238636, #3fb950);
    }
    .poll-option__pct {
      font-size: 13px; font-weight: 700;
      color: #8b949e; text-align: right;
    }

    /* ── Footer ── */
    .poll-footer { font-size: 13px; color: #484f58; text-align: center; }
    .poll-footer--muted { opacity: 0.6; }

    /* ── Admin panel ── */
    .admin-panel {
      display: flex; flex-direction: column; gap: 14px;
    }
    .admin-panel__header {
      display: flex; align-items: center;
      justify-content: space-between; gap: 8px;
    }
    .admin-panel__title { font-size: 15px; font-weight: 700; }
    .admin-refresh {
      background: transparent;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 5px 12px;
      font-size: 12px;
      font-family: inherit;
      color: #8b949e;
      cursor: pointer;
      min-height: 30px;
      transition: border-color .15s, color .15s;
    }
    .admin-refresh:hover  { border-color: #388bfd; color: #388bfd; }
    .admin-refresh:disabled { opacity: 0.5; cursor: default; }
    .admin-refresh--busy  { color: #484f58; }

    .admin-question {
      font-size: 13px; color: #8b949e;
      line-height: 1.4;
    }

    .admin-results { display: flex; flex-direction: column; gap: 10px; }

    .admin-result-row { display: flex; flex-direction: column; gap: 5px; }
    .admin-result-label { font-size: 13px; color: #e6edf3; font-weight: 500; }
    .admin-result-bar-wrap {
      height: 6px; background: #21262d;
      border-radius: 3px; overflow: hidden;
    }
    .admin-result-bar {
      height: 100%;
      background: linear-gradient(90deg, #1f6feb, #388bfd);
      border-radius: 3px;
      transition: width .5s ease;
    }
    .admin-result-count {
      font-size: 12px; color: #8b949e;
      font-variant-numeric: tabular-nums;
    }

    .admin-total {
      font-size: 13px; color: #8b949e;
      padding-top: 4px;
      border-top: 1px solid #21262d;
    }
    .admin-total strong { color: #e6edf3; }

    .admin-note {
      font-size: 11px; color: #484f58;
      line-height: 1.5;
      padding: 10px 12px;
      background: #1c2128;
      border-radius: 8px;
      border: 1px solid #21262d;
    }
  `;
  document.head.appendChild(style);
}
