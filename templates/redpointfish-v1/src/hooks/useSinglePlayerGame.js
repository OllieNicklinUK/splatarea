import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDeck, shuffleDeck } from '../utils/deck';
import { canCapture, getCardPointValue, getCardFaceValue } from '../constants/poker';

const HUMAN_ID = 'local-player';
const BOT_ID = 'cpu-bot';

const INITIAL_GAME_STATE = {
  deck: [],
  hands: {},
  playerNames: {},
  field: [],
  turn: 0,
  captured: {},
  scores: {},
  isStarted: false,
  winner: null,
  stateVersion: 0,
  lastAction: null
};

const cloneState = (state) => JSON.parse(JSON.stringify(state));

const incremented = (state) => ({
  ...state,
  stateVersion: Number(state?.stateVersion || 0) + 1
});

const pickBotAction = (state) => {
  const hand = state?.hands?.[BOT_ID] || [];
  const field = state?.field || [];
  if (!hand.length) return null;

  let bestCapture = null;
  for (const handCard of hand) {
    for (const fieldCard of field) {
      if (!canCapture(handCard, fieldCard)) continue;
      const gain = getCardPointValue(handCard) + getCardPointValue(fieldCard);
      const face = getCardFaceValue(handCard.value);
      if (
        !bestCapture ||
        gain > bestCapture.gain ||
        (gain === bestCapture.gain && face > bestCapture.face)
      ) {
        bestCapture = {
          cardId: handCard.id,
          targetCardId: fieldCard.id,
          gain,
          face
        };
      }
    }
  }
  if (bestCapture) return { cardId: bestCapture.cardId, targetCardId: bestCapture.targetCardId };

  const fallback = [...hand].sort((a, b) => {
    const pointDiff = getCardPointValue(a) - getCardPointValue(b);
    if (pointDiff !== 0) return pointDiff;
    return getCardFaceValue(a.value) - getCardFaceValue(b.value);
  })[0];
  return fallback ? { cardId: fallback.id, targetCardId: null } : null;
};

const applyPlayToState = (baseState, playerId, cardId, targetCardId = null) => {
  const newState = cloneState(baseState);
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
};

const useSinglePlayerGame = (profile) => {
  const [gameState, setGameState] = useState(INITIAL_GAME_STATE);
  const botTurnTimerRef = useRef(null);

  const participantIds = useMemo(
    () => Object.keys(gameState?.hands || {}).filter(Boolean),
    [gameState?.hands]
  );

  const isMyTurn = useMemo(() => {
    if (!gameState.isStarted || participantIds.length < 2) return false;
    const currentTurnActorId = participantIds[gameState.turn % participantIds.length];
    return currentTurnActorId === HUMAN_ID;
  }, [gameState.isStarted, gameState.turn, participantIds]);

  const initializeGame = useCallback(() => {
    const deck = shuffleDeck(createDeck());
    const hands = {
      [HUMAN_ID]: deck.splice(0, 8),
      [BOT_ID]: deck.splice(0, 8)
    };
    const field = deck.splice(0, 4);
    const newState = {
      deck,
      hands,
      playerNames: {
        [HUMAN_ID]: profile?.displayName || 'You',
        [BOT_ID]: 'Computer'
      },
      field,
      turn: 0,
      captured: {
        [HUMAN_ID]: [],
        [BOT_ID]: []
      },
      scores: {
        [HUMAN_ID]: 0,
        [BOT_ID]: 0
      },
      isStarted: true,
      winner: null,
      stateVersion: 1,
      lastAction: {
        actorId: HUMAN_ID,
        type: 'redeal',
        cardsPerPlayer: 8
      }
    };
    setGameState(newState);
  }, [profile?.displayName]);

  const leaveGame = useCallback(() => {
    setGameState(INITIAL_GAME_STATE);
  }, []);

  const handlePlayCard = useCallback((cardId, targetCardId = null) => {
    setGameState((prev) => {
      if (!prev.isStarted || prev.winner) return prev;
      const ids = Object.keys(prev.hands || {}).filter(Boolean);
      if (ids.length < 2) return prev;
      const currentTurnActorId = ids[prev.turn % ids.length];
      if (currentTurnActorId !== HUMAN_ID) return prev;
      const next = applyPlayToState(prev, HUMAN_ID, cardId, targetCardId);
      return next || prev;
    });
  }, []);

  useEffect(() => {
    if (!gameState.isStarted || gameState.winner) return;
    if (!participantIds.length) return;
    const currentTurnActorId = participantIds[gameState.turn % participantIds.length];
    if (currentTurnActorId !== BOT_ID) return;

    const move = pickBotAction(gameState);
    if (!move?.cardId) return;

    if (botTurnTimerRef.current) {
      clearTimeout(botTurnTimerRef.current);
      botTurnTimerRef.current = null;
    }
    botTurnTimerRef.current = setTimeout(() => {
      setGameState((prev) => {
        if (!prev.isStarted || prev.winner) return prev;
        const ids = Object.keys(prev.hands || {}).filter(Boolean);
        const turnActorId = ids[prev.turn % ids.length];
        if (turnActorId !== BOT_ID) return prev;
        const next = applyPlayToState(prev, BOT_ID, move.cardId, move.targetCardId);
        return next || prev;
      });
      botTurnTimerRef.current = null;
    }, 500 + Math.floor(Math.random() * 400));

    return () => {
      if (botTurnTimerRef.current) {
        clearTimeout(botTurnTimerRef.current);
        botTurnTimerRef.current = null;
      }
    };
  }, [gameState, participantIds]);

  return {
    gameState,
    isMyTurn,
    handlePlayCard,
    initializeGame,
    leaveGame,
    humanId: HUMAN_ID,
    botId: BOT_ID
  };
};

export default useSinglePlayerGame;
