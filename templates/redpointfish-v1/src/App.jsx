import React, { useState, useEffect, useMemo } from 'react';
import useViverseAuth from './hooks/useViverseAuth';
import useMultiplayer from './hooks/useMultiplayer';
import usePokerGame from './hooks/usePokerGame';
import useSinglePlayerGame from './hooks/useSinglePlayerGame';
import AuthOverlay from './components/AuthOverlay';
import ViverseDiagnostic from './components/ViverseDiagnostic';
import GameOverlay from './components/UI/GameOverlay';
import LeaderboardManager from './components/LeaderboardManager';

const APP_ID = import.meta.env.VITE_VIVERSE_CLIENT_ID || import.meta.env.VITE_VIVERSE_APP_ID;
const MULTIPLAYER_LEADERBOARD_NAME =
  import.meta.env.VITE_VIVERSE_LEADERBOARD_NAME_MULTIPLAYER ||
  import.meta.env.VITE_VIVERSE_LEADERBOARD_NAME ||
  'poker-score';
const SINGLEPLAYER_LEADERBOARD_NAME =
  import.meta.env.VITE_VIVERSE_LEADERBOARD_NAME_SINGLEPLAYER ||
  'poker-score-single';
const actorIdOf = (actor) =>
  actor?.account_id ||
  actor?.accountId ||
  actor?.properties?.account_id ||
  actor?.properties?.accountId ||
  actor?.id ||
  actor?.session_id ||
  actor?.sessionId ||
  actor?.actor_id ||
  actor?.actorId ||
  '';
const resolveMyPlayerId = (gameState, actor) => {
  const participantIds = Object.keys(gameState?.hands || {}).filter(Boolean);
  const aliases = Array.from(new Set([
    actorIdOf(actor),
    actor?.account_id,
    actor?.accountId,
    actor?.properties?.account_id,
    actor?.properties?.accountId,
    actor?.id,
    actor?.actor_id,
    actor?.actorId,
    actor?.session_id,
    actor?.sessionId
  ].filter(Boolean)));
  return participantIds.find((id) => aliases.includes(id)) || actorIdOf(actor) || participantIds[0] || '';
};

const App = () => {
  const { sdk, profile, accessToken, isAuthenticated, status, error, login, logout } = useViverseAuth();
  const multiplayer = useMultiplayer(sdk, isAuthenticated, profile, accessToken);
  const multiplayerGame = usePokerGame(multiplayer);
  const singlePlayer = useSinglePlayerGame(profile);

  const [gameMode, setGameMode] = useState('multiplayer');
  const [localError, setLocalError] = useState('');
  const [hasEnteredGame, setHasEnteredGame] = useState(false);

  const activePlayerCount = useMemo(() => {
    if (!multiplayer.room) return 0;
    return Math.max(
      multiplayer.roomPlayerCount(multiplayer.room),
      Array.isArray(multiplayer.actors) ? multiplayer.actors.length : 0
    );
  }, [multiplayer.room, multiplayer.actors, multiplayer.roomPlayerCount]);

  const localMyActor = useMemo(() => ({
    id: singlePlayer.humanId,
    displayName: profile?.displayName || 'You'
  }), [profile?.displayName, singlePlayer.humanId]);

  const localActors = useMemo(() => ([
    localMyActor,
    { id: singlePlayer.botId, displayName: 'Computer' }
  ]), [localMyActor, singlePlayer.botId]);

  const activeGameState = gameMode === 'single' ? singlePlayer.gameState : multiplayerGame.gameState;
  const activeIsMyTurn = gameMode === 'single' ? singlePlayer.isMyTurn : multiplayerGame.isMyTurn;
  const activeHandlePlayCard = gameMode === 'single' ? singlePlayer.handlePlayCard : multiplayerGame.handlePlayCard;
  const activeMyActor = gameMode === 'single' ? localMyActor : multiplayer.myActor;
  const activeActors = gameMode === 'single' ? localActors : multiplayer.actors;

  useEffect(() => {
    console.log('[VIVERSE] Bootstrapping with App ID:', APP_ID);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setGameMode('multiplayer');
      setHasEnteredGame(false);
      singlePlayer.leaveGame();
    }
  }, [isAuthenticated, singlePlayer]);

  useEffect(() => {
    if (gameMode !== 'multiplayer') return;
    if (multiplayer.actors.length >= 2 && !multiplayerGame.gameState.isStarted) {
      multiplayerGame.initializeGame();
    }
  }, [gameMode, multiplayer.actors, multiplayerGame]);

  useEffect(() => {
    if (gameMode !== 'multiplayer') return;
    if (!multiplayer.isInRoom) {
      setHasEnteredGame(false);
      return;
    }
    if (multiplayerGame.gameState.isStarted) {
      setHasEnteredGame(true);
    }
  }, [gameMode, multiplayerGame.gameState.isStarted, multiplayer.isInRoom]);

  useEffect(() => {
    if (gameMode !== 'multiplayer') return;
    if (!multiplayer.isInRoom || !multiplayerGame.gameState.winner) return;
    const timer = setTimeout(() => {
      handleLeaveRoom().catch(() => {});
    }, 8000);
    return () => clearTimeout(timer);
  }, [gameMode, multiplayerGame.gameState.winner, multiplayer.isInRoom]);

  const handleCreateRoom = async () => {
    setLocalError('');
    setGameMode('multiplayer');
    try {
      await multiplayer.createRoom('PlayRoom');
    } catch (e) {
      setLocalError(e?.message || 'Create room failed');
    }
  };

  const handleAutoMatch = async () => {
    setLocalError('');
    setGameMode('multiplayer');
    try {
      await multiplayer.autoMatch();
    } catch (e) {
      setLocalError(e?.message || 'Auto match failed');
    }
  };

  const handleJoinRoom = async (roomId) => {
    setLocalError('');
    setGameMode('multiplayer');
    try {
      await multiplayer.joinRoom(roomId);
    } catch (e) {
      setLocalError(e?.message || 'Join room failed');
    }
  };

  const handleLeaveRoom = async () => {
    setLocalError('');
    try {
      await multiplayer.leaveRoom();
    } catch (e) {
      setLocalError(e?.message || 'Leave room failed');
    }
  };

  const handleStartGame = async () => {
    setLocalError('');
    try {
      await multiplayer.startGame();
    } catch (e) {
      setLocalError(e?.message || 'Start game failed');
    }
  };

  const handleMultiplayerPlayAgain = async () => {
    setLocalError('');
    try {
      if (multiplayer.isHost && multiplayer.isInRoom && multiplayer.actors.length >= 2) {
        multiplayerGame.initializeGame();
        return;
      }
      await multiplayer.leaveRoom();
    } catch (e) {
      setLocalError(e?.message || 'Play again failed');
    }
  };

  const handleStartSingleGame = () => {
    setLocalError('');
    if (multiplayer.isInRoom) {
      setLocalError('Please leave multiplayer room before starting single-player mode');
      return;
    }
    setGameMode('single');
    singlePlayer.initializeGame();
  };

  const handleLeaveSingleGame = () => {
    setLocalError('');
    singlePlayer.leaveGame();
    setGameMode('multiplayer');
  };

  const handleSinglePlayAgain = () => {
    setLocalError('');
    singlePlayer.initializeGame();
  };

  const lobbyError = localError || multiplayer.error || '';
  const showMultiplayerGame = isAuthenticated && gameMode === 'multiplayer' && multiplayer.isInRoom && (multiplayerGame.gameState.isStarted || hasEnteredGame);
  const showSingleGame = isAuthenticated && gameMode === 'single' && singlePlayer.gameState.isStarted;
  const showGame = showMultiplayerGame || showSingleGame;

  const myActorId = resolveMyPlayerId(activeGameState, activeMyActor);
  const leaderboardResultKey = activeGameState.winner
    ? `${gameMode === 'single' ? 'sp' : 'mp'}:${activeGameState.winner}:${activeGameState.stateVersion}`
    : '';

  return (
    <div className="relative w-full min-h-screen bg-v-slate-900 overflow-x-hidden overflow-y-auto select-none">
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute top-[20%] right-[10%] w-[500px] h-[500px] bg-v-accent/10 blur-[150px] rounded-full" />
        <div className="absolute bottom-[20%] left-[10%] w-[400px] h-[400px] bg-v-success/5 blur-[120px] rounded-full" />
        <div className="absolute inset-0 bg-gradient-to-tr from-v-slate-900 via-transparent to-v-slate-900 opacity-80" />
      </div>

      <ViverseDiagnostic sdk={sdk} status={status} error={error} />

      <AuthOverlay
        profile={profile}
        isAuthenticated={isAuthenticated}
        status={status}
        login={login}
        logout={logout}
      />

      <div className="relative z-10 w-full min-h-screen">
        {!isAuthenticated ? (
          <div className="flex flex-col items-center justify-center w-full h-full text-center p-12 space-y-8">
            <h1 className="text-8xl font-black text-white italic tracking-tighter leading-none">
              RED POINT
              <br />
              <span className="text-v-accent">FISHING</span>
            </h1>
            <p className="max-w-md text-v-slate-400 font-medium">
              A premium multiplayer poker experience. Strategy, skill, and the pursuit of red points.
            </p>
            <button
              onClick={login}
              className="group relative px-10 py-5 bg-white text-v-slate-900 font-black rounded-full overflow-hidden hover:scale-105 transition-all shadow-2xl"
            >
              <div className="absolute inset-0 bg-v-accent opacity-0 group-hover:opacity-100 transition-opacity" />
              <span className="relative group-hover:text-white transition-colors uppercase tracking-widest">Connect Wallet & Play</span>
            </button>
          </div>
        ) : showGame ? (
          <>
            <GameOverlay
              gameState={activeGameState}
              myActor={activeMyActor}
              actors={activeActors}
              isMyTurn={activeIsMyTurn}
              handlePlayCard={activeHandlePlayCard}
              onLeaveGame={gameMode === 'single' ? handleLeaveSingleGame : handleLeaveRoom}
              onPlayAgain={gameMode === 'single' ? handleSinglePlayAgain : handleMultiplayerPlayAgain}
            />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center p-6">
            <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-black/40 backdrop-blur-xl border border-white/10 rounded-3xl p-6 space-y-5">
                <h2 className="text-2xl font-black text-white uppercase tracking-widest">Matchmaking</h2>
                <p className="text-v-slate-300 text-sm">
                  App ID: <span className="font-mono">{APP_ID}</span>
                </p>
                <p className="text-v-slate-300 text-sm">
                  Status: {multiplayer.isReady ? 'Ready' : 'Initializing'}
                  {multiplayer.isConnecting ? ' · Working...' : ''}
                </p>
                {multiplayer.isInRoom ? (
                  <div className="space-y-3">
                    <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <div className="text-white font-bold">{multiplayer.room?.name || 'Room'}</div>
                      <div className="text-v-slate-300 text-sm mt-1">Players: {activePlayerCount}/2</div>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <button
                        onClick={handleStartGame}
                        disabled={!multiplayer.isHost || activePlayerCount < 2 || multiplayer.isConnecting}
                        className="px-4 py-2 rounded-xl bg-v-success/80 text-white font-bold disabled:opacity-40"
                      >
                        Start Match
                      </button>
                      <button
                        onClick={handleLeaveRoom}
                        disabled={multiplayer.isConnecting}
                        className="px-4 py-2 rounded-xl bg-v-danger/80 text-white font-bold disabled:opacity-40"
                      >
                        Leave Room
                      </button>
                      <button
                        onClick={multiplayer.refreshRooms}
                        disabled={multiplayer.isConnecting}
                        className="px-4 py-2 rounded-xl bg-white/10 text-white font-bold disabled:opacity-40"
                      >
                        Refresh
                      </button>
                    </div>
                    {activePlayerCount < 2 && (
                      <p className="text-v-accent text-sm">Waiting for opponent to join...</p>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={handleAutoMatch}
                      disabled={!multiplayer.isReady || multiplayer.isConnecting}
                      className="px-4 py-2 rounded-xl bg-v-accent text-white font-bold disabled:opacity-40"
                    >
                      Auto Match
                    </button>
                    <button
                      onClick={handleCreateRoom}
                      disabled={!multiplayer.isReady || multiplayer.isConnecting}
                      className="px-4 py-2 rounded-xl bg-v-success/80 text-white font-bold disabled:opacity-40"
                    >
                      Create Room
                    </button>
                    <button
                      onClick={handleStartSingleGame}
                      disabled={multiplayer.isConnecting}
                      className="px-4 py-2 rounded-xl bg-cyan-500 text-slate-900 font-bold disabled:opacity-40"
                    >
                      Play vs Computer
                    </button>
                    <button
                      onClick={multiplayer.refreshRooms}
                      disabled={!multiplayer.isReady || multiplayer.isConnecting}
                      className="px-4 py-2 rounded-xl bg-white/10 text-white font-bold disabled:opacity-40"
                    >
                      Refresh Rooms
                    </button>
                  </div>
                )}

                {lobbyError && (
                  <div className="text-sm text-v-danger bg-v-danger/10 border border-v-danger/30 rounded-xl p-3">
                    {lobbyError}
                  </div>
                )}
              </div>

              <div className="bg-black/40 backdrop-blur-xl border border-white/10 rounded-3xl p-6">
                <h3 className="text-xl font-black text-white uppercase tracking-widest mb-4">Available Rooms</h3>
                <div className="space-y-3 max-h-[420px] overflow-y-auto custom-scrollbar pr-2">
                  {multiplayer.rooms.length === 0 ? (
                    <div className="text-v-slate-400 text-sm">No rooms found. Create one or use auto match.</div>
                  ) : (
                    multiplayer.rooms.map((room) => {
                      const rid = room.id;
                      const disabled = multiplayer.isConnecting || multiplayer.isInRoom || multiplayer.joiningRoomId === rid || room.playerCount >= 2;
                      return (
                        <div key={rid} className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center justify-between gap-3">
                          <div>
                            <div className="text-white font-bold">{room.name}</div>
                            <div className="text-v-slate-300 text-xs">{rid}</div>
                            <div className="text-v-slate-300 text-sm mt-1">Players: {room.playerCount}/2</div>
                          </div>
                          <button
                            onClick={() => handleJoinRoom(rid)}
                            disabled={disabled}
                            className="px-4 py-2 rounded-xl bg-v-accent text-white font-bold disabled:opacity-40"
                          >
                            Join
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {isAuthenticated && (
          <LeaderboardManager
            sdk={sdk}
            isAuthenticated={isAuthenticated}
            accessToken={accessToken}
            appId={APP_ID}
            multiplayerLeaderboardName={MULTIPLAYER_LEADERBOARD_NAME}
            singleplayerLeaderboardName={SINGLEPLAYER_LEADERBOARD_NAME}
            activeMode={gameMode}
            score={activeGameState.scores?.[myActorId] || 0}
            gameFinished={Boolean(activeGameState.winner)}
            resultKey={leaderboardResultKey}
          />
        )}
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        body { font-family: 'Inter', sans-serif; }
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.1); border-radius: 10px; }
      `
        }}
      />
    </div>
  );
};

export default App;
