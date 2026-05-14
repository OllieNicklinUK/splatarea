// app.js — EDITABLE
// Poll widget app. Replace this file entirely to build a different tool.
// Receives auth state from main.js via onAuthChange().

const POLL_CONFIG = window.__APP_CONFIG__?.poll || {
  question: 'What feature would you like to see next?',
  options: ['Leaderboard', 'Avatar Customization', 'New Game Mode', 'Better Mobile UI']
};

const STORAGE_KEY = `viverse-poll-${window.__APP_CONFIG__?.clientId || 'local'}`;

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  question: POLL_CONFIG.question,
  options: POLL_CONFIG.options.map((label, i) => ({ id: String(i), label, votes: 0 })),
  userVote: null,        // option id the current user voted for
  displayName: null,     // set after auth resolves
  isAuthenticated: false,
  authStatus: 'idle'     // 'idle' | 'detecting' | 'ready'
};

// ─── Persistence (localStorage — no secrets) ─────────────────────────────────

function loadVotes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved?.options) return;
    // Merge saved vote counts into state
    state.options = state.options.map((opt) => {
      const saved_opt = saved.options.find((s) => s.id === opt.id);
      return saved_opt ? { ...opt, votes: saved_opt.votes ?? 0 } : opt;
    });
    state.userVote = saved.userVote ?? null;
  } catch {}
}

function saveVotes() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ options: state.options, userVote: state.userVote })
    );
  } catch {}
}

// ─── Actions ──────────────────────────────────────────────────────────────────

function castVote(optionId) {
  if (state.userVote !== null) return; // already voted

  const opt = state.options.find((o) => o.id === optionId);
  if (!opt) return;

  opt.votes += 1;
  state.userVote = optionId;
  saveVotes();
  render();
}

// ─── Rendering ───────────────────────────────────────────────────────────────

let rootEl = null;

function totalVotes() {
  return state.options.reduce((sum, o) => sum + o.votes, 0);
}

function pct(votes) {
  const total = totalVotes();
  return total === 0 ? 0 : Math.round((votes / total) * 100);
}

function render() {
  if (!rootEl) return;

  const hasVoted = state.userVote !== null;
  const total = totalVotes();
  const authPending = state.authStatus !== 'ready';

  rootEl.innerHTML = `
    <div class="poll-card">
      <header class="poll-header">
        <div class="poll-identity">
          ${
            state.isAuthenticated
              ? `<span class="pill pill--auth">✓ ${escHtml(state.displayName || 'Player')}</span>`
              : authPending
              ? `<span class="pill pill--pending">Checking login…</span>`
              : `<button class="pill pill--login" onclick="window.__viverse_login()">Login with VIVERSE</button>`
          }
        </div>
        <div class="poll-app-id" title="App ID">${escHtml(window.__APP_CONFIG__?.clientId || '')}</div>
      </header>

      <h1 class="poll-question">${escHtml(state.question)}</h1>

      <div class="poll-options">
        ${state.options.map((opt) => {
          const p = pct(opt.votes);
          const isChosen = state.userVote === opt.id;
          const isWinner = hasVoted && state.options.every((o) => o.votes <= opt.votes) && opt.votes > 0;
          return `
            <button
              class="poll-option ${hasVoted ? 'poll-option--result' : 'poll-option--vote'} ${isChosen ? 'poll-option--chosen' : ''} ${isWinner ? 'poll-option--winner' : ''}"
              ${hasVoted ? 'disabled' : `onclick="window.__poll_vote('${opt.id}')"`}
              aria-pressed="${isChosen}"
            >
              <div class="poll-option__label">
                <span>${escHtml(opt.label)}</span>
                ${isChosen ? '<span class="poll-option__badge">Your vote</span>' : ''}
              </div>
              ${hasVoted ? `
                <div class="poll-option__bar-wrap">
                  <div class="poll-option__bar" style="width:${p}%"></div>
                </div>
                <div class="poll-option__pct">${p}%</div>
              ` : ''}
            </button>
          `;
        }).join('')}
      </div>

      <footer class="poll-footer">
        ${hasVoted
          ? `<span>${total} vote${total !== 1 ? 's' : ''} total</span>`
          : `<span>Tap an option to vote</span>`
        }
      </footer>
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

// ─── Public API (called by main.js) ──────────────────────────────────────────

export function createApp(el) {
  rootEl = el;

  return {
    mount({ appId, appName }) {
      loadVotes();
      injectStyles();
      render();
      // Expose vote handler to inline onclick
      window.__poll_vote = castVote;
    },

    onAuthChange(authState) {
      state.authStatus = authState.status === 'ready' ? 'ready' : 'detecting';
      state.isAuthenticated = authState.isAuthenticated;
      state.displayName = authState.profile?.displayName || null;
      render();
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

    #root {
      width: 100%;
      max-width: 480px;
    }

    .poll-card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Header */
    .poll-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .poll-identity { display: flex; align-items: center; }
    .poll-app-id { font-size: 10px; color: #484f58; font-family: monospace; }

    .pill {
      display: inline-flex;
      align-items: center;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      border: none;
      cursor: default;
    }
    .pill--auth   { background: #1f3d2e; color: #3fb950; }
    .pill--pending { background: #1c2128; color: #8b949e; }
    .pill--login  {
      background: #1f6feb;
      color: #fff;
      cursor: pointer;
      transition: background 0.15s;
    }
    .pill--login:hover  { background: #388bfd; }
    .pill--login:active { background: #1158c7; }

    /* Question */
    .poll-question {
      font-size: 17px;
      font-weight: 700;
      line-height: 1.4;
      color: #e6edf3;
    }

    /* Options */
    .poll-options {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

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
      transition: border-color 0.15s, background 0.15s;
      min-height: 52px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .poll-option:disabled { cursor: default; }

    /* Vote mode */
    .poll-option--vote:hover  { border-color: #388bfd; background: #1a2332; }
    .poll-option--vote:active { background: #172033; }

    /* Result mode */
    .poll-option--result { border-color: #21262d; }
    .poll-option--chosen { border-color: #388bfd; background: #1a2332; }
    .poll-option--winner { border-color: #3fb950; }

    .poll-option__label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .poll-option__badge {
      font-size: 11px;
      font-weight: 600;
      color: #388bfd;
      background: #1f3558;
      padding: 2px 8px;
      border-radius: 999px;
      white-space: nowrap;
    }

    /* Bar */
    .poll-option__bar-wrap {
      height: 4px;
      background: #21262d;
      border-radius: 2px;
      overflow: hidden;
    }
    .poll-option__bar {
      height: 100%;
      background: linear-gradient(90deg, #1f6feb, #388bfd);
      border-radius: 2px;
      transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .poll-option--winner .poll-option__bar {
      background: linear-gradient(90deg, #238636, #3fb950);
    }
    .poll-option__pct {
      font-size: 13px;
      font-weight: 700;
      color: #8b949e;
      text-align: right;
    }

    /* Footer */
    .poll-footer {
      font-size: 13px;
      color: #484f58;
      text-align: center;
    }
  `;
  document.head.appendChild(style);
}
