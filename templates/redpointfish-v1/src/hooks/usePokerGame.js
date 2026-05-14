import { useState, useEffect, useCallback, useMemo } from 'react';
import { createDeck, shuffleDeck } from '../utils/deck';
import { canCapture, getCardPointValue } from '../constants/poker';

const INITIAL_GAME_STATE = {
  deck: [],
  hands: {}, // {actorId: []}
  playerNames: {}, // {actorId: displayName}
  field: [],
  turn: 0,
  captured: {}, // {actorId: []}
  scores: {}, // {actorId: 0}
  isStarted: false,
  winner: null,
  stateVersion: 0,
  lastAction: null
};

const actorIdOf = (actor) => {
  if (!actor || typeof actor !== 'object') return '';
  const props = actor.properties && typeof actor.properties === 'object' ? actor.properties : {};
  return (
    actor.account_id ||
    actor.accountId ||
    props.account_id ||
    props.accountId ||
    actor.id ||
    actor.actor_id ||
    actor.actorId ||
    actor.session_id ||
    actor.sessionId ||
    ''
  );
};

const usePokerGame = (multiplayer) => {
  const { mc, actors, myActor, profile, sendMessage } = multiplayer;
  const actorIds = useMemo(() => {
    const ids = actors.map((a) => actorIdOf(a)).filter(Boolean);
    return Array.from(new Set(ids)).sort();
  }, [actors]);
  const hostId = actorIds[0] || '';
  const myId = actorIdOf(myActor);
  const isHost = Boolean(myId && hostId && myId === hostId);

  const [gameState, setGameState] = useState(INITIAL_GAME_STATE);

  const applyIfNewerState = useCallback((incoming) => {
    if (!incoming || typeof incoming !== 'object') return;
    setGameState((prev) => {
      const prevVersion = Number(prev?.stateVersion || 0);
      const nextVersion = Number(incoming?.stateVersion || 0);
      if (nextVersion <= prevVersion) return prev;
      return incoming;
    });
  }, []);

  const incremented = useCallback((state) => ({
    ...state,
    stateVersion: Number(state?.stateVersion || 0) + 1
  }), []);

  const participantIds = useMemo(() => {
    const fromHands = Object.keys(gameState?.hands || {}).filter(Boolean).sort();
    if (fromHands.length >= 2) return fromHands;
    return actorIds;
  }, [actorIds, gameState?.hands]);

  const isMyTurn = useMemo(() => {
    if (!gameState.isStarted || participantIds.length < 2) return false;
    const currentTurnActorId = participantIds[gameState.turn % participantIds.length];
    return currentTurnActorId === actorIdOf(myActor);
  }, [gameState.isStarted, gameState.turn, myActor, participantIds]);

  const applyPlayToState = useCallback((baseState, playerId, cardId, targetCardId = null) => {
    const newState = JSON.parse(JSON.stringify(baseState));
    const hand = newState.hands?.[playerId] || [];
    const cardIndex = hand.findIndex((c) => c.id === cardId);
    if (cardIndex === -1) return null;

    const playedCard = hand.splice(cardIndex, 1)[0];
    let capturedCards = [];
    let captureTargetCard = null;

    if (targetCardId) {
      const fieldIndex = newState.field.findIndex((c) => c.id === targetCardId);
      if (fieldIndex !== -1 && canCapture(playedCard, newState.field[fieldIndex])) {
        captureTargetCard = newState.field.splice(fieldIndex, 1)[0];
        capturedCards = [playedCard, captureTargetCard];
      } else {
        newState.field.push(playedCard);
      }
    } else {
      newState.field.push(playedCard);
    }

    if (capturedCards.length > 0) {
      newState.captured[playerId].push(...capturedCards);
      newState.scores[playerId] = newState.captured[playerId].reduce(
        (acc, card) => acc + getCardPointValue(card), 0
      );
    }

    if (newState.deck.length > 0) {
      const drawnCard = newState.deck.splice(0, 1)[0];
      let matchIdx = -1;
      for (let i = 0; i < newState.field.length; i++) {
        if (canCapture(drawnCard, newState.field[i])) {
          matchIdx = i;
          break;
        }
      }

      if (matchIdx !== -1) {
        const targetCard = newState.field.splice(matchIdx, 1)[0];
        newState.captured[playerId].push(drawnCard, targetCard);
        newState.scores[playerId] = newState.captured[playerId].reduce(
          (acc, card) => acc + getCardPointValue(card), 0
        );
        newState.lastAction = {
          actorId: playerId,
          type: 'draw_capture',
          playedCard,
          playedCapture: Boolean(capturedCards.length),
          playedTargetCard: captureTargetCard,
          drawnCard,
          drawnTargetCard: targetCard
        };
      } else {
        newState.field.push(drawnCard);
        newState.lastAction = {
          actorId: playerId,
          type: 'draw_drop',
          playedCard,
          playedCapture: Boolean(capturedCards.length),
          playedTargetCard: captureTargetCard,
          drawnCard
        };
      }
    } else {
      newState.lastAction = {
        actorId: playerId,
        type: capturedCards.length ? 'play_capture' : 'play_drop',
        playedCard,
        playedCapture: Boolean(capturedCards.length),
        playedTargetCard: captureTargetCard
      };
    }

    newState.turn += 1;
    const playerIds = Object.keys(newState.hands || {});
    const allHandsEmpty = playerIds.every((id) => (newState.hands[id] || []).length === 0);
    if (allHandsEmpty) {
      const ids = Object.keys(newState.scores);
      let maxScore = -1;
      let winnerId = null;
      ids.forEach((id) => {
        if (newState.scores[id] > maxScore) {
          maxScore = newState.scores[id];
          winnerId = id;
        }
      });
      newState.winner = winnerId;
      newState.lastAction = {
        ...(newState.lastAction || {}),
        type: 'match_end',
        winnerId
      };
    }

    return incremented(newState);
  }, [incremented]);

  const initializeGame = useCallback(() => {
    if (!myId || actorIds.length < 2) return;
    
    // Host/dealer initializes
    if (!isHost) return;

    const deck = shuffleDeck(createDeck());
    const hands = {};
    actorIds.forEach(id => {
      hands[id] = deck.splice(0, 8);
    });
    const field = deck.splice(0, 4);
    
    const newState = {
      deck,
      hands,
      playerNames: {},
      field,
      turn: 0,
      captured: {},
      scores: {},
      isStarted: true,
      winner: null,
      stateVersion: 1,
    };
    actorIds.forEach(id => {
      newState.captured[id] = [];
      newState.scores[id] = 0;
      const actor = actors.find((a) => actorIdOf(a) === id);
      const fallbackName = `Player-${String(id).slice(-4)}`;
      newState.playerNames[id] = actor?.displayName || actor?.name || fallbackName;
    });

    setGameState(newState);
    sendMessage('gameStateUpdate', newState);
  }, [actorIds, isHost, myId, sendMessage, actors]);

  const handlePlayCard = useCallback((cardId, targetCardId = null) => {
    if (!isMyTurn) return;
    if (!myId) return;
    const next = applyPlayToState(gameState, myId, cardId, targetCardId);
    if (!next) return;
    setGameState(next);
    sendMessage('gameStateUpdate', next);
  }, [applyPlayToState, gameState, isMyTurn, myId, sendMessage]);

  useEffect(() => {
    if (!mc || !myId) return;
    const displayName = profile?.displayName || myActor?.displayName || 'Player';
    if (!displayName) return;
    const aliasIds = Array.from(new Set([
      myId,
      myActor?.account_id,
      myActor?.accountId,
      myActor?.properties?.account_id,
      myActor?.properties?.accountId,
      myActor?.id,
      myActor?.actor_id,
      myActor?.actorId,
      myActor?.session_id,
      myActor?.sessionId
    ].filter(Boolean)));
    const payload = { playerId: myId, aliasIds, displayName };
    sendMessage('profileSync', payload);
    const timer = setInterval(() => sendMessage('profileSync', payload), 5000);
    return () => clearInterval(timer);
  }, [mc, myActor?.displayName, myId, profile?.displayName, sendMessage]);

  useEffect(() => {
    if (!mc) return;

    const handleUpdate = (eventOrRaw) => {
      const payload = eventOrRaw?.data ?? eventOrRaw;
      const msg = typeof payload === 'string'
        ? (() => { try { return JSON.parse(payload); } catch { return {}; } })()
        : payload || {};
      const type = msg.type || eventOrRaw?.type;
      const data = msg.data ?? msg.payload ?? eventOrRaw?.data;
      if (type === 'gameStateUpdate' && data) {
        applyIfNewerState(data);
        return;
      }
      if (type === 'profileSync' && data?.playerId && data?.displayName) {
        const isGeneric = (name) => {
          const n = String(name || '').trim().toLowerCase();
          return !n || n === 'player' || n === 'viverse player' || /^player-\w{1,6}$/.test(n);
        };
        setGameState((prev) => {
          const keys = Array.from(new Set([data.playerId, ...(Array.isArray(data.aliasIds) ? data.aliasIds : [])].filter(Boolean)));
          if (!keys.length) return prev;
          const nextNames = { ...(prev.playerNames || {}) };
          let changed = false;
          for (const key of keys) {
            const current = nextNames[key];
            if (current === data.displayName) continue;
            // Never downgrade an existing specific name with a generic placeholder.
            if (!isGeneric(current) && isGeneric(data.displayName)) continue;
            nextNames[key] = data.displayName;
            changed = true;
          }
          if (!changed) return prev;
          return {
            ...prev,
            playerNames: nextNames
          };
        });
        return;
      }

    };

    const unsub = [];
    if (typeof mc?.general?.onMessage === 'function') {
      mc.general.onMessage(handleUpdate);
      if (typeof mc.general.offMessage === 'function') {
        unsub.push(() => mc.general.offMessage(handleUpdate));
      }
    }
    if (typeof mc?.on === 'function') {
      mc.on('message', handleUpdate);
      unsub.push(() => { try { mc.off?.('message', handleUpdate); } catch {} });
    } else if (typeof mc?.addEventListener === 'function') {
      mc.addEventListener('message', handleUpdate);
      unsub.push(() => { try { mc.removeEventListener?.('message', handleUpdate); } catch {} });
    }

    return () => {
      for (const fn of unsub) {
        try { fn(); } catch {}
      }
    };
  }, [applyIfNewerState, mc]);

  useEffect(() => {
    // Host periodically replays authoritative state so late listeners can catch up.
    if (!mc || !isHost || !gameState.isStarted || participantIds.length < 2) return;
    const timer = setInterval(() => {
      sendMessage('gameStateUpdate', gameState);
    }, 1200);
    return () => clearInterval(timer);
  }, [gameState, isHost, mc, participantIds.length, sendMessage]);

  useEffect(() => {
    // New room session must not inherit previous room's terminal state.
    if (!multiplayer?.isInRoom) {
      setGameState(INITIAL_GAME_STATE);
    }
  }, [multiplayer?.isInRoom]);

  return { gameState, isMyTurn, handlePlayCard, initializeGame };
};

export default usePokerGame;
