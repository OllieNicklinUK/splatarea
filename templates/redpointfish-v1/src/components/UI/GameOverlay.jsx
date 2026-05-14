import React, { useEffect, useMemo, useState } from 'react';
import { canCapture, getCardPointValue } from '../../constants/poker';

const GameOverlay = ({ gameState, myActor, actors, isMyTurn, handlePlayCard, onLeaveGame, onPlayAgain }) => {
  const actorKeyOf = (actor) =>
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
  const safeActors = Array.isArray(actors) ? actors.filter((a) => a && typeof a === 'object') : [];
  const resolvedMyActor = useMemo(() => {
    if (myActor && typeof myActor === 'object') return myActor;
    return safeActors.find((a) => a.isSelf) || null;
  }, [myActor, safeActors]);
  const myActorId = actorKeyOf(resolvedMyActor);
  const participantIds = useMemo(
    () => Object.keys(gameState?.hands || {}).filter(Boolean),
    [gameState?.hands]
  );
  const myAliases = useMemo(
    () => Array.from(new Set([
      myActorId,
      resolvedMyActor?.account_id,
      resolvedMyActor?.accountId,
      resolvedMyActor?.properties?.account_id,
      resolvedMyActor?.properties?.accountId,
      resolvedMyActor?.id,
      resolvedMyActor?.actor_id,
      resolvedMyActor?.actorId,
      resolvedMyActor?.session_id,
      resolvedMyActor?.sessionId
    ].filter(Boolean))),
    [myActorId, resolvedMyActor]
  );
  const myPlayerId = useMemo(
    () => participantIds.find((id) => myAliases.includes(id)) || myActorId || participantIds[0] || '',
    [myActorId, myAliases, participantIds]
  );
  const opponentId = useMemo(
    () => participantIds.find((id) => id !== myPlayerId) || '',
    [myPlayerId, participantIds]
  );
  const actorNames = useMemo(() => {
    const isGenericName = (name) => {
      const n = String(name || '').trim().toLowerCase();
      return !n || n === 'player' || n === 'viverse player' || /^player-\w{1,8}$/.test(n);
    };
    const out = { ...(gameState?.playerNames || {}) };
    for (const a of safeActors) {
      const id = actorKeyOf(a);
      if (!id) continue;
      const incoming = a.displayName || a.name || '';
      const existing = out[id] || '';
      if (!existing) {
        out[id] = incoming || `Player-${String(id).slice(-4)}`;
        continue;
      }
      // Prevent generic runtime actor labels from downgrading a synced specific name.
      if (!isGenericName(existing) && isGenericName(incoming)) continue;
      out[id] = incoming || existing;
    }
    return out;
  }, [gameState?.playerNames, safeActors]);
  const opponentName =
    actorNames[opponentId] || (opponentId ? `Player-${String(opponentId).slice(-4)}` : 'Waiting for player...');
  const scoreEntries = Object.entries(gameState?.scores || {});
  const resolveScore = (...ids) => {
    for (const id of ids.filter(Boolean)) {
      if (Object.prototype.hasOwnProperty.call(gameState?.scores || {}, id)) {
        return Number(gameState.scores[id] || 0);
      }
    }
    return null;
  };
  const myScore =
    resolveScore(myPlayerId, ...myAliases) ??
    (scoreEntries.length ? Number(scoreEntries[0][1] || 0) : 0);
  const opponentScoreKey =
    (opponentId && opponentId !== myPlayerId ? opponentId : '') ||
    scoreEntries.find(([id]) => id !== myPlayerId && !myAliases.includes(id))?.[0] ||
    scoreEntries.find(([id]) => id !== myPlayerId)?.[0] ||
    '';
  const opponentScore =
    resolveScore(opponentScoreKey) ??
    scoreEntries.find(([id]) => id !== myPlayerId && !myAliases.includes(id))?.[1] ??
    0;
  const currentHand = gameState.hands?.[myPlayerId] || [];
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [toast, setToast] = useState('');
  const [actionHint, setActionHint] = useState('');
  const [actionVersion, setActionVersion] = useState(0);

  const selectedCard = currentHand.find((c) => c.id === selectedCardId) || null;

  const suitSymbol = (suit) => (suit === 'hearts' || suit === 'diamonds' ? '♥' : '♠');
  const suitColorClass = (suit) => (suit === 'hearts' || suit === 'diamonds' ? 'text-red-600' : 'text-black');
  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 1800);
  };
  useEffect(() => {
    const action = gameState?.lastAction;
    const version = Number(gameState?.stateVersion || 0);
    if (!action || !version || version === actionVersion) return;
    const ownerName = actorNames[action.actorId] || (action.actorId ? `Player-${String(action.actorId).slice(-4)}` : 'Player');
    const c = (card) => (card ? `${card.value}${suitSymbol(card.suit)}` : '');
    if (action.type === 'draw_capture') {
      setActionHint(`${ownerName}: drew ${c(action.drawnCard)} and auto-captured ${c(action.drawnTargetCard)}`);
    } else if (action.type === 'draw_drop') {
      setActionHint(`${ownerName}: drew ${c(action.drawnCard)} and placed it on table`);
    } else if (action.type === 'play_capture') {
      setActionHint(`${ownerName}: captured with ${c(action.playedCard)}`);
    } else if (action.type === 'play_drop') {
      setActionHint(`${ownerName}: dropped ${c(action.playedCard)} to table`);
    } else if (action.type === 'redeal') {
      setActionHint(`Round redeal: ${action.cardsPerPlayer || 0} card(s) each`);
    } else if (action.type === 'match_end') {
      setActionHint('Match finished');
    }
    setActionVersion(version);
    const t = setTimeout(() => setActionHint(''), 2400);
    return () => clearTimeout(t);
  }, [actionVersion, actorNames, gameState?.lastAction, gameState?.stateVersion]);
  const doPlay = (targetId = null) => {
    if (!isMyTurn || !selectedCardId) return;
    handlePlayCard(selectedCardId, targetId);
    setSelectedCardId(null);
  };

  return (
    <div className="absolute inset-0 z-20 pointer-events-none flex flex-col justify-between p-8">
      {/* Top Bar: Opponent Info & Field */}
      <div className="flex justify-between items-start pointer-events-auto gap-2">
        <div className="bg-black/40 backdrop-blur-xl border border-white/10 p-4 rounded-2xl flex items-center gap-4">
          <div className="w-12 h-12 bg-v-accent/20 rounded-xl flex items-center justify-center text-v-accent font-bold">
            OP
          </div>
          <div>
            <div className="text-xs text-white/50 uppercase tracking-widest font-black">Opponent</div>
            <div className="text-lg font-black text-white">
              {opponentName}
            </div>
            <div className="text-sm font-bold text-v-accent">
               Score: {Number(opponentScore || 0)}
            </div>
          </div>
        </div>

        <div className="bg-white/5 backdrop-blur-md border border-white/10 px-6 py-2 rounded-full text-white font-black tracking-widest uppercase">
          {isMyTurn ? 'Your Turn' : "Opponent's Turn"}
        </div>

        <div className="bg-black/40 backdrop-blur-xl border border-white/10 p-4 rounded-2xl flex flex-col items-end gap-2">
          <div className="text-xs text-white/50 uppercase tracking-widest font-black">Deck</div>
          <div className="text-2xl font-black text-white">{gameState.deck.length}</div>
          <button
            onClick={onLeaveGame}
            className="px-3 py-1 rounded-lg bg-v-danger/80 text-white text-[11px] font-black"
          >
            Leave Game
          </button>
        </div>
      </div>
      {actionHint && (
        <div className="self-center bg-v-accent/85 text-white text-xs font-bold px-3 py-2 rounded-xl pointer-events-none">
          {actionHint}
        </div>
      )}

      {/* Field Cards */}
      <div className="flex justify-center items-center gap-4 pointer-events-auto">
        {gameState.field.map((card) => (
          <div
            key={card.id}
            className={`w-24 h-36 bg-white rounded-lg border-2 flex flex-col items-center justify-center font-black text-xl shadow-2xl relative cursor-pointer hover:scale-105 transition-transform ${
              selectedCard && canCapture(selectedCard, card) ? 'border-v-accent' : 'border-white/20'
            } ${suitColorClass(card.suit)}`}
            onClick={() => {
              if (!isMyTurn || !selectedCardId) return;
              if (!selectedCard) return;
              if (!canCapture(selectedCard, card)) {
                showToast('Cannot capture: card values do not match rule');
                return;
              }
              doPlay(card.id);
            }}
          >
            <div className={`absolute top-1 left-2 text-sm font-black ${suitColorClass(card.suit)}`}>
              {card.value}{suitSymbol(card.suit)}
            </div>
            {card.value}
            <div className={`absolute bottom-1 right-2 text-sm font-black ${suitColorClass(card.suit)}`}>
              {suitSymbol(card.suit)}
            </div>
            <div className="text-[8px] mt-2 text-v-accent">
               {getCardPointValue(card) > 0 ? `+${getCardPointValue(card)} pts` : ''}
            </div>
          </div>
        ))}
      </div>

      {/* Bottom Bar: Player Hand */}
      <div className="flex flex-col items-center gap-4 pointer-events-auto">
        <div className="bg-black/40 backdrop-blur-xl border border-white/10 p-4 rounded-3xl flex items-center gap-4 mb-4">
           <div className="text-left">
              <div className="text-xs text-white/50 uppercase tracking-widest font-black">Your Score</div>
              <div className="text-2xl font-black text-v-success">{Number(myScore || 0)}</div>
           </div>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-4 max-w-full">
          {currentHand.map((card) => (
            <div
              key={card.id}
              className={`relative w-20 h-28 bg-white rounded-lg border-2 flex flex-col items-center justify-center font-black text-lg shadow-xl cursor-pointer hover:-translate-y-4 transition-all ${
                selectedCardId === card.id
                  ? 'border-v-accent ring-2 ring-v-accent/60'
                  : isMyTurn ? 'border-v-accent/50' : 'border-white/20'
              } ${suitColorClass(card.suit)} ${
                !isMyTurn ? 'opacity-70' : ''
              }`}
              onClick={() => {
                if (!isMyTurn) return;
                setSelectedCardId((prev) => (prev === card.id ? null : card.id));
              }}
            >
              <div className={`absolute top-1 left-2 text-xs font-black ${suitColorClass(card.suit)}`}>
                {card.value}{suitSymbol(card.suit)}
              </div>
              {card.value}
              <div className={`absolute bottom-1 right-2 text-xs font-black ${suitColorClass(card.suit)}`}>
                {suitSymbol(card.suit)}
              </div>
            </div>
          ))}
        </div>
        {isMyTurn && selectedCard && (
          <div className="flex gap-2 items-center bg-black/40 border border-white/10 rounded-2xl p-2">
            <div className="text-xs text-white/80 px-2">
              Selected: {selectedCard.value}{suitSymbol(selectedCard.suit)}
            </div>
            <button
              onClick={() => doPlay(null)}
              className="px-3 py-1 rounded-lg bg-v-accent text-white text-xs font-black"
            >
              Drop To Table
            </button>
            <div className="text-[11px] text-v-slate-300">Tap a field card to capture.</div>
          </div>
        )}
        {toast && (
          <div className="bg-v-danger/90 text-white text-xs font-bold px-3 py-2 rounded-xl">
            {toast}
          </div>
        )}
      </div>

      {/* Winner Overlay */}
      {gameState.winner && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xl flex items-center justify-center z-50 pointer-events-auto p-6">
          <div className="w-full max-w-md bg-black/50 border border-white/15 rounded-3xl p-8 text-center shadow-2xl">
          <h1 className="text-5xl md:text-6xl font-black text-white mb-6 italic tracking-tight">
            {gameState.winner === myPlayerId ? 'VICTORY' : 'DEFEAT'}
          </h1>
          <div className="space-y-3 mb-8">
            <div className="text-xl font-bold text-white">
                Final Score: <span className="text-cyan-300">{Number(myScore || 0)}</span>
              </div>
              <div className="text-lg font-bold text-white/80">
                Opponent Score: <span className="text-white">{Number(opponentScore || 0)}</span>
              </div>
            </div>
            <button
              onClick={onPlayAgain}
              className="w-full px-8 py-3 bg-cyan-500 hover:bg-cyan-400 text-slate-900 font-black rounded-xl transition-colors"
            >
              PLAY AGAIN
            </button>
            <button
              onClick={onLeaveGame}
              className="w-full mt-3 px-8 py-2 bg-white/10 hover:bg-white/20 text-white font-bold rounded-xl transition-colors"
            >
              BACK TO LOBBY
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GameOverlay;
