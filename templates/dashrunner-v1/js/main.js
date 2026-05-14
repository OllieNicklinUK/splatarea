import { ViverseApp } from './viverseApp.js';
import { Gameplay } from './game/Gameplay.js';
import { ViverseAuthController } from './viverseAuth.js';
import { ViverseLeaderboardController } from './viverseLeaderboard.js';

document.addEventListener('DOMContentLoaded', async () => {
    let app = null;
    let gameplay = null;
    let authReady = false;
    let authLoggedIn = false;

    const startScreen = document.getElementById('start-screen');
    const startButton = document.getElementById('start-button');
    const loginButton = document.getElementById('login-button');
    const gameOverScreen = document.getElementById('game-over-screen');
    const restartButton = document.getElementById('restart-button');
    const pauseScreen = document.getElementById('pause-screen');
    const highScoreDisplay = document.getElementById('high-score');
    const lobbyBtnStart = document.getElementById('lobby-btn-start');
    const leaderboardBtnStart = document.getElementById('leaderboard-btn-start');
    const leaderboardBtnEnd = document.getElementById('leaderboard-btn-end');
    const leaderboardScreen = document.getElementById('leaderboard-screen');
    const leaderboardList = document.getElementById('leaderboard-list');
    const leaderboardLoading = document.getElementById('leaderboard-loading');
    const lobbyScreen = document.getElementById('lobby-screen');
    const lobbyList = document.getElementById('lobby-list');
    const lobbyLoading = document.getElementById('lobby-loading');
    const createRoomBtn = document.getElementById('create-room-btn');
    const raceAIBtn = document.getElementById('race-ai-btn');
    const startRaceBtn = document.getElementById('start-race-btn');
    const leaveRoomBtn = document.getElementById('leave-room-btn');
    const subtitle = startScreen.querySelector('.subtitle');

    let lobbyRefreshInterval = null;

    const authStatusText = {
        idle: '🍝 Initializing VIVERSE... 🍝',
        detecting: '🍝 Detecting VIVERSE SDK... 🍝',
        handshaking: '🍝 Handshaking with VIVERSE bridge... 🍝',
        checking_auth: '🍝 Checking VIVERSE login... 🍝',
        ready: ''
    };

    const auth = new ViverseAuthController((state) => {
        if (!subtitle) return;
        if (state.error) {
            subtitle.textContent = state.error;
            return;
        }
        if (state.status === 'ready' && state.isAuthenticated && state.profile?.displayName) {
            subtitle.textContent = `🍝 Welcome, ${state.profile.displayName}! 🍝`;
            return;
        }
        if (authStatusText[state.status]) {
            subtitle.textContent = authStatusText[state.status];
        }
    });

    highScoreDisplay.textContent = localStorage.getItem('crazyNonnaHighScore') || 0;
    lobbyBtnStart.classList.add('hidden');
    leaderboardBtnStart.classList.add('hidden');

    async function ensureApp() {
        if (app) return app;

        app = new ViverseApp();
        gameplay = new Gameplay();
        app.injectGameplay(gameplay);
        app.auth = auth;
        window.app = app;

        if (authLoggedIn) {
            if (auth.avatarUrl) {
                await app.player.loadAvatar(auth.avatarUrl);
            }
            await app.multiplayer.initialize(auth);
            app.leaderboard = new ViverseLeaderboardController(auth.accessToken);
            await app.leaderboard.initialize();
        }

        app.onGameOver = async (finalScore) => {
            document.getElementById('final-score').textContent = Math.floor(finalScore);

            const highScore = parseInt(localStorage.getItem('crazyNonnaHighScore') || '0', 10);
            if (finalScore > highScore) {
                localStorage.setItem('crazyNonnaHighScore', String(Math.floor(finalScore)));
                highScoreDisplay.textContent = Math.floor(finalScore);
                document.getElementById('new-record').classList.remove('hidden');
                await app.leaderboard?.submitScore(finalScore);
            } else {
                document.getElementById('new-record').classList.add('hidden');
            }

            gameOverScreen.classList.remove('hidden');
        };

        app.multiplayer.onPlayersUpdated = renderLobbyState;
        app.multiplayer.onGameStart = async () => {
            await ensureApp();
            lobbyScreen.classList.add('hidden');
            startScreen.classList.add('hidden');
            window.focus();
            app.start();
        };

        return app;
    }

    async function initializeAuth() {
        authReady = await auth.initialize();
        authLoggedIn = authReady ? await auth.checkAuth() : false;

        if (authLoggedIn) {
            subtitle.textContent = `🍝 Welcome, ${auth.profileName}! 🍝`;
            startButton.classList.remove('hidden');
            loginButton.classList.add('hidden');
            loginButton.style.display = 'none';
            lobbyBtnStart.classList.remove('hidden');
            leaderboardBtnStart.classList.remove('hidden');
            window.focus();
            return;
        }

        if (auth.state.error) {
            subtitle.textContent = auth.state.error;
        } else if (!authReady) {
            subtitle.textContent = '🍝 VIVERSE SDK unavailable. Running local mode. 🍝';
        } else {
            subtitle.textContent = '🍝 Login required to save scores! 🍝';
            loginButton.classList.remove('hidden');
        }

        startButton.classList.remove('hidden');
    }

    function stopLobbyRefresh() {
        if (lobbyRefreshInterval) {
            clearInterval(lobbyRefreshInterval);
            lobbyRefreshInterval = null;
        }
    }

    async function beginSoloRun() {
        await ensureApp();
        startScreen.classList.add('hidden');
        gameOverScreen.classList.add('hidden');
        window.focus();
        app.start();
    }

    async function showLeaderboard() {
        await ensureApp();
        leaderboardScreen.classList.remove('hidden');
        leaderboardList.innerHTML = '';
        leaderboardLoading.textContent = 'Fetching scores from VIVERSE...';

        const data = await app.leaderboard?.getRankings?.() || [];
        if (!data.length) {
            leaderboardLoading.textContent = 'No scores found. Be the first!';
            return;
        }

        leaderboardLoading.textContent = '';
        data.forEach((entry, index) => {
            const userRef = entry.user || entry.profile || entry.account || entry;
            const name = userRef.displayName || userRef.display_name || userRef.userName || userRef.user_name || userRef.name || entry.name || 'Anonymous';
            const avatar = userRef.avatarUrl || userRef.avatar_url || userRef.profilePicUrl || userRef.avatar || 'https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y';
            const score = entry.value || entry.score || 0;

            const li = document.createElement('li');
            li.innerHTML = `
                <span class="leaderboard-rank">#${index + 1}</span>
                <img class="leaderboard-avatar" src="${avatar}" onerror="this.src='https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y'" />
                <span class="leaderboard-name">${name}</span>
                <span class="leaderboard-score">${Math.floor(score)}</span>
            `;
            leaderboardList.appendChild(li);
        });
    }

    async function refreshRoomList() {
        await ensureApp();
        if (app.multiplayer.roomId) return;
        const rooms = await app.multiplayer.getRoomList();
        lobbyList.innerHTML = '';
        if (!rooms.length) {
            lobbyLoading.textContent = 'No open races found.';
            return;
        }

        lobbyLoading.textContent = `${rooms.length} races found.`;
        rooms.forEach((room) => {
            const li = document.createElement('li');
            const pCount = room.playerCount || room.player_count || (room.actors ? room.actors.length : 0);
            const roomId = room.id || room.roomId || room.game_session;
            li.innerHTML = `
                <span class="leaderboard-name">${room.name}</span>
                <span class="leaderboard-score">${pCount}/2</span>
                ${pCount < 2 ? `<button class="game-button join-btn" data-id="${roomId}" style="font-size: 1rem; padding: 5px 15px;">JOIN</button>` : '<span>FULL</span>'}
            `;
            lobbyList.appendChild(li);
        });

        document.querySelectorAll('.join-btn').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                const roomId = e.currentTarget.getAttribute('data-id');
                e.currentTarget.textContent = 'JOINING...';
                try {
                    await ensureApp();
                    await app.multiplayer.joinRoom(roomId);
                    renderLobbyState();
                } catch (error) {
                    console.error(error);
                    e.currentTarget.textContent = 'ERROR';
                }
            });
        });
    }

    async function renderLobbyState() {
        await ensureApp();
        if (!app.multiplayer.roomId) {
            createRoomBtn.classList.remove('hidden');
            raceAIBtn.classList.remove('hidden');
            startRaceBtn.classList.add('hidden');
            leaveRoomBtn.classList.add('hidden');
            lobbyLoading.textContent = 'Looking for races...';
            refreshRoomList();
            stopLobbyRefresh();
            lobbyRefreshInterval = setInterval(refreshRoomList, 3000);
            return;
        }

        stopLobbyRefresh();
        createRoomBtn.classList.add('hidden');
        raceAIBtn.classList.add('hidden');
        leaveRoomBtn.classList.remove('hidden');
        lobbyList.innerHTML = '';

        const actors = app.multiplayer.room?.actors?.length || 1;
        lobbyLoading.textContent = `In Room: ${app.multiplayer.room?.name || 'Race'} (${actors}/2 Players)`;

        startRaceBtn.classList.remove('hidden');
        if (app.multiplayer.isHost) {
            if (actors >= 2) {
                startRaceBtn.textContent = '🚀 START RACE NOW';
                startRaceBtn.disabled = false;
            } else {
                startRaceBtn.textContent = '⏱ WAITING FOR PLAYER 2...';
                startRaceBtn.disabled = true;
            }
        } else {
            startRaceBtn.textContent = '⏱ Waiting for host to start...';
            startRaceBtn.disabled = true;
        }
    }

    startButton.addEventListener('click', beginSoloRun);
    loginButton.addEventListener('click', () => {
        loginButton.textContent = 'Redirecting...';
        auth.login();
    });
    restartButton.addEventListener('click', async () => {
        await ensureApp();
        gameOverScreen.classList.add('hidden');
        app.restart();
        window.focus();
    });

    leaderboardBtnStart.addEventListener('click', showLeaderboard);
    leaderboardBtnEnd.addEventListener('click', showLeaderboard);
    document.getElementById('close-leaderboard-button').addEventListener('click', () => {
        leaderboardScreen.classList.add('hidden');
    });

    lobbyBtnStart.addEventListener('click', async () => {
        await renderLobbyState();
        lobbyScreen.classList.remove('hidden');
    });
    createRoomBtn.addEventListener('click', async () => {
        createRoomBtn.textContent = 'CREATING...';
        try {
            await ensureApp();
            await app.multiplayer.createRoom();
            renderLobbyState();
        } catch (error) {
            console.error(error);
            createRoomBtn.textContent = 'ERROR';
        }
        createRoomBtn.textContent = 'CREATE NEW MATCH';
    });
    leaveRoomBtn.addEventListener('click', async () => {
        await ensureApp();
        leaveRoomBtn.textContent = 'LEAVING...';
        await app.multiplayer.leaveRoom();
        renderLobbyState();
        leaveRoomBtn.textContent = '🚪 LEAVE ROOM';
    });
    startRaceBtn.addEventListener('click', async () => {
        await ensureApp();
        if (!app.multiplayer.isHost || (app.multiplayer.room?.actors?.length || 0) < 2) return;
        startRaceBtn.textContent = 'STARTING...';
        await app.multiplayer.startGame();
        lobbyScreen.classList.add('hidden');
        startScreen.classList.add('hidden');
        window.focus();
        app.start();
    });
    raceAIBtn.addEventListener('click', beginSoloRun);
    document.getElementById('close-lobby-btn').addEventListener('click', () => {
        stopLobbyRefresh();
        lobbyScreen.classList.add('hidden');
    });

    document.addEventListener('keydown', async (e) => {
        if (!startScreen.classList.contains('hidden') && (e.code === 'Enter' || e.code === 'Space')) {
            await beginSoloRun();
        }

        if (!gameOverScreen.classList.contains('hidden') && (e.code === 'Enter' || e.code === 'Space')) {
            await ensureApp();
            gameOverScreen.classList.add('hidden');
            app.restart();
        }

        if (app && e.code === 'Escape' && app.isRunning) {
            if (app.isPaused) {
                pauseScreen.classList.add('hidden');
                app.resume();
            } else {
                pauseScreen.classList.remove('hidden');
                app.pause();
            }
        }

        if (gameplay && e.code === 'KeyT' && gameplay.themeManager) {
            gameplay.themeManager.nextTheme();
            gameplay.updateThemeDisplay();
        }
    });

    await initializeAuth();
});
