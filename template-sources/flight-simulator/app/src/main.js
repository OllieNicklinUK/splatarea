import { Game } from './core/Game.js';
import { eventBus, Events } from './core/EventBus.js';
import { gameState } from './core/GameState.js';
import { initAudioBridge } from './audio/AudioBridge.js';
import { ViverseAuthController } from '../js/viverseAuth.js';
import { ViverseLeaderboardController } from '../js/viverseLeaderboard.js';

// Wire audio events to AudioManager
initAudioBridge();

// ── Profile chip UI ─────────────────────────────────────────────────────────
const profileChip = document.getElementById('profile-chip');
const profileName = document.getElementById('profile-name');
const loginBtn = document.getElementById('login-btn');

function setProfileChip(name, isGuest) {
    if (!profileChip) return;
    profileChip.classList.remove('hidden');
    if (profileName) profileName.textContent = isGuest ? 'Sign In' : name;
    profileChip.classList.toggle('guest', isGuest);
}

// ── Auth — launches async, does NOT block game loop ──────────────────────────
let leaderboard = null;

const auth = new ViverseAuthController((state) => {
    if (state.status !== 'ready') return;

    if (state.isAuthenticated && state.profile?.displayName) {
        setProfileChip(state.profile.displayName, false);
        if (loginBtn) loginBtn.classList.add('hidden');
        if (game.menu) game.menu.setAuthStatus('Fly through the rings');

        // Init leaderboard once we have an access token
        leaderboard = new ViverseLeaderboardController(auth.accessToken);
        leaderboard.initialize().catch(console.warn);
    } else {
        setProfileChip('Sign In', true);
        if (loginBtn) loginBtn.classList.remove('hidden');
        if (game.menu) game.menu.setAuthStatus('Login to save your score!');
    }
});

auth.initialize()
    .then(async (ready) => {
        if (ready) await auth.checkAuth();
    })
    .catch(() => setProfileChip('Sign In', true));

if (loginBtn) {
    loginBtn.addEventListener('click', () => auth.login());
}

// ── Game starts immediately, independent of auth ─────────────────────────────
const game = new Game();

// ── Submit score on game over ─────────────────────────────────────────────────
eventBus.on(Events.GAME_OVER, async ({ score }) => {
    if (leaderboard && score > 0) {
        await leaderboard.submitScore(score);
    }
});

// Reset idempotent guard when a new game starts
eventBus.on(Events.GAME_START, () => {
    if (leaderboard) leaderboard.resetSubmitGuard();
});
eventBus.on(Events.GAME_RESTART, () => {
    if (leaderboard) leaderboard.resetSubmitGuard();
});

// ── Leaderboard panel ─────────────────────────────────────────────────────────
const lbBtn = document.getElementById('leaderboard-btn');
const lbPanel = document.getElementById('leaderboard-panel');
const lbClose = document.getElementById('leaderboard-close');
const lbList = document.getElementById('leaderboard-list');
const lbLoading = document.getElementById('leaderboard-loading');

async function openLeaderboard() {
    if (!lbPanel) return;
    lbPanel.classList.remove('hidden');
    if (lbList) lbList.innerHTML = '';
    if (lbLoading) lbLoading.classList.remove('hidden');

    const rankings = leaderboard ? await leaderboard.getRankings() : [];

    if (lbLoading) lbLoading.classList.add('hidden');
    if (!lbList) return;

    if (rankings.length === 0) {
        lbList.innerHTML = '<li class="lb-empty">No scores yet. Be the first!</li>';
        return;
    }

    rankings.forEach((entry, i) => {
        const name = entry.display_name || entry.displayName || entry.name || `Player ${i + 1}`;
        const score = entry.score ?? entry.value ?? 0;
        const li = document.createElement('li');
        li.className = 'lb-entry';
        li.innerHTML = `<span class="lb-rank">#${i + 1}</span><span class="lb-name">${name}</span><span class="lb-score">${score} rings</span>`;
        lbList.appendChild(li);
    });
}

if (lbBtn) lbBtn.addEventListener('click', openLeaderboard);
if (lbClose) lbClose.addEventListener('click', () => lbPanel?.classList.add('hidden'));

// ── Expose globals for debugging ─────────────────────────────────────────────
window.__GAME__ = game;
window.__GAME_STATE__ = gameState;
window.__EVENT_BUS__ = eventBus;
window.__EVENTS__ = Events;
