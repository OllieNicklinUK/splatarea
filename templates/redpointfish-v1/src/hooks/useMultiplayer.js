import { useState, useEffect, useCallback, useRef } from 'react';

const APP_ID = import.meta.env.VITE_VIVERSE_CLIENT_ID || import.meta.env.VITE_VIVERSE_APP_ID || '';
const VERSION_NAME = '1.6.0-multiplayer-room-lifecycle';

const asObject = (value) => (value && typeof value === 'object' ? value : {});

const roomIdOf = (room) => {
  const safeRoom = asObject(room);
  return safeRoom.id || safeRoom.roomId || safeRoom.game_session || '';
};
const roomNameOf = (room) => {
  const safeRoom = asObject(room);
  return safeRoom.name || safeRoom.room_name || 'Room';
};
const roomPlayerCount = (room = {}) => {
  const safeRoom = asObject(room);
  const fromActors = Array.isArray(safeRoom.actors) ? safeRoom.actors.length : 0;
  const fromCount = Number(safeRoom.playerCount ?? safeRoom.player_count ?? 0);
  return Math.max(fromActors, Number.isFinite(fromCount) ? fromCount : 0);
};

const actorIdOf = (actor) => {
  if (!actor || typeof actor !== 'object') return '';
  return (
    actor.id ||
    actor.actor_id ||
    actor.actorId ||
    actor.session_id ||
    actor.sessionId ||
    actor.account_id ||
    actor.accountId ||
    ''
  );
};

const normalizeActor = (actor) => {
  const safeActor = asObject(actor);
  const props = asObject(safeActor.properties);
  return {
    ...safeActor,
    accountId:
      safeActor.account_id ||
      safeActor.accountId ||
      props.account_id ||
      props.accountId ||
      '',
    id: actorIdOf(safeActor),
    avatarUrl: safeActor.avatarUrl || safeActor.avatar_url || props.avatarUrl || props.avatar_url || '',
    displayName:
      safeActor.displayName ||
      safeActor.name ||
      props.displayName ||
      props.name ||
      safeActor.user_name ||
      safeActor.username ||
      'Player'
  };
};

const normalizeActors = (list = []) =>
  (Array.isArray(list) ? list : []).map((a) => normalizeActor(a)).filter((a) => a.id);

const normalizeRoom = (room) => {
  const safeRoom = asObject(room);
  return {
    ...safeRoom,
    id: roomIdOf(safeRoom),
    name: roomNameOf(safeRoom),
    playerCount: roomPlayerCount(safeRoom)
  };
};

const normalizeRooms = (list = []) =>
  (Array.isArray(list) ? list : []).map((room) => normalizeRoom(room)).filter((room) => room.id);

const useMultiplayer = (sdk, isAuthenticated, profile, accessToken) => {
  const [rooms, setRooms] = useState([]);
  const [activeRoom, setActiveRoom] = useState(null);
  const [mc, setMc] = useState(null);
  const [actors, setActors] = useState([]);
  const [myActor, setMyActor] = useState(null);
  const [isReady, setIsReady] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [joiningRoomId, setJoiningRoomId] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [error, setError] = useState(null);

  const mmClientRef = useRef(null);
  const mpClientRef = useRef(null);
  const actorSessionIdRef = useRef('');
  const roomSyncTimerRef = useRef(null);
  const activeRoomIdRef = useRef('');
  const hiddenSinceRef = useRef(0);
  const ownedRoomIdsRef = useRef(new Set());

  const withTimeout = useCallback(async (promiseLike, ms = 10000) => {
    return await Promise.race([
      Promise.resolve(promiseLike),
      new Promise((_, reject) => setTimeout(() => reject(new Error('operation_timeout')), ms))
    ]);
  }, []);

  const safeCall = useCallback(async (fn) => {
    try {
      return await Promise.resolve(fn());
    } catch (_) {
      return null;
    }
  }, []);

  const extractRoomFromAny = useCallback((raw) => {
    const candidates = [
      raw,
      raw?.room,
      raw?.data,
      raw?.data?.room,
      raw?.result,
      raw?.result?.room,
      raw?.payload,
      raw?.payload?.room
    ];
    for (const candidate of candidates) {
      const normalized = normalizeRoom(candidate || {});
      if (normalized?.id) return normalized;
    }
    return null;
  }, []);

  const callFirst = useCallback(async (target, candidates, ...args) => {
    for (const name of candidates) {
      const fn = target?.[name];
      if (typeof fn !== 'function') continue;
      try {
        return await withTimeout(fn.apply(target, args), 12000);
      } catch (e) {
        console.warn(`[Multiplayer] ${name} failed:`, e);
      }
    }
    return null;
  }, [withTimeout]);

  const refreshRooms = useCallback(async () => {
    const mm = mmClientRef.current;
    if (!mm) return [];
    try {
      const list = await withTimeout((mm.getAvailableRooms?.() || mm.getRoomList?.() || []), 10000);
      const normalized = normalizeRooms(Array.isArray(list) ? list : (list?.rooms || []));
      setRooms(normalized);

      setActiveRoom((prev) => {
        const activeId = roomIdOf(prev || {});
        if (!activeId) return prev;
        const matched = normalized.find((room) => room.id === activeId);
        return matched || prev;
      });
      return normalized;
    } catch (e) {
      console.warn('[Multiplayer] Failed to refresh rooms:', e);
      return [];
    }
  }, [withTimeout]);

  const refreshActors = useCallback(async () => {
    const mp = mpClientRef.current;
    const mm = mmClientRef.current;
    const sessionId = actorSessionIdRef.current;

    let rawActors = [];
    const actorSources = [
      () => mp?.getMyRoomActors?.(),
      () => mp?.getActorList?.(),
      () => mm?.getMyRoomActors?.(),
      () => mm?.getActorList?.()
    ];
    for (const source of actorSources) {
      const list = await safeCall(source);
      if (Array.isArray(list) && list.length > 0) {
        rawActors = list;
        break;
      }
    }
    if (!rawActors.length) {
      rawActors = activeRoom?.actors || [];
    }

    const normalized = normalizeActors(rawActors);
    const normalizedWithSelf = normalized.map((a) => ({
      ...a,
      isSelf: Boolean(sessionId && (a.session_id || a.sessionId || a.id) === sessionId)
    }));
    setActors(normalizedWithSelf);
    setActiveRoom((prev) => {
      if (!prev?.id) return prev;
      return {
        ...prev,
        actors: normalizedWithSelf,
        playerCount: Math.max(roomPlayerCount(prev), normalizedWithSelf.length)
      };
    });

    let me = null;
    if (sessionId) {
      me = normalizedWithSelf.find((a) => (a.session_id || a.sessionId || a.id) === sessionId) || null;
    }
    if (!me && profile?.userId) {
      me = normalizedWithSelf.find(
        (a) => (a.account_id || a.accountId || '') === profile.userId
      ) || null;
    }
    if (me) setMyActor(me);
    return normalizedWithSelf;
  }, [activeRoom, profile?.userId, safeCall]);

  const initRealtime = useCallback(async (roomLike) => {
    const roomId = roomIdOf(roomLike || {});
    if (!roomId) throw new Error('roomId is required');

    const MClient =
      (sdk?.play || sdk?.Play || window.play?.Play || window.Play)?.MultiplayerClient ||
      window.play?.MultiplayerClient;

    if (typeof MClient !== 'function') {
      throw new Error('Multiplayer SDK missing');
    }

    if (mpClientRef.current?.disconnect) {
      await mpClientRef.current.disconnect().catch(() => {});
    }

    const sessionId = actorSessionIdRef.current;
    let multiplayerClient;
    try {
      multiplayerClient = new MClient(roomId, {
        app_id: APP_ID,
        token: accessToken,
        authorization: accessToken,
        accessToken,
        session_id: sessionId
      });
    } catch (_) {
      multiplayerClient = new MClient(roomId, APP_ID, sessionId);
    }

    if (multiplayerClient.init) {
      await multiplayerClient.init({ modules: { general: { enabled: true } } });
    }

    const onConnected = async () => {
      console.log('[Multiplayer] MultiplayerClient connected');
      await refreshActors();
    };

    if (multiplayerClient.on) {
      multiplayerClient.on('connected', onConnected);
      multiplayerClient.on('actorJoined', refreshActors);
      multiplayerClient.on('actorLeft', refreshActors);
    } else if (multiplayerClient.addEventListener) {
      multiplayerClient.addEventListener('connected', onConnected);
      multiplayerClient.addEventListener('actorJoined', refreshActors);
      multiplayerClient.addEventListener('actorLeft', refreshActors);
    }

    if (typeof multiplayerClient.connect === 'function') {
      multiplayerClient.connect();
    } else {
      await onConnected();
    }

    mpClientRef.current = multiplayerClient;
    setMc(multiplayerClient);
    return multiplayerClient;
  }, [accessToken, refreshActors, sdk]);

  const ensureMatchmaking = useCallback(async () => {
    if (mmClientRef.current) return mmClientRef.current;
    if (!sdk || !isAuthenticated || !profile || !accessToken) return null;
    if (!APP_ID) throw new Error('APP_ID is missing');

    const PlaySDK = sdk.play || sdk.Play || window.play?.Play || window.Play;
    if (!PlaySDK) throw new Error('Play SDK unavailable');

    console.log(`[Multiplayer] Initializing matchmaking (Version: ${VERSION_NAME})`);

    const playClient = new PlaySDK();
    const matchmakingClient = await playClient.newMatchmakingClient(APP_ID);
    if (!matchmakingClient) throw new Error('Matchmaking client initialization failed');

    mmClientRef.current = matchmakingClient;

    const proto = Object.getPrototypeOf(matchmakingClient) || {};
    const methodList = Object.getOwnPropertyNames(proto)
      .filter((name) => typeof matchmakingClient[name] === 'function')
      .sort();
    console.log('[Multiplayer] Matchmaking methods:', methodList.join(', '));

    const connectSignal = new Promise((resolve) => {
      let resolved = false;
      const done = (value) => {
        if (!resolved) {
          resolved = true;
          resolve(value);
        }
      };
      const onConnect = () => done(true);
      if (matchmakingClient.on) {
        matchmakingClient.on('onConnect', onConnect);
        matchmakingClient.on('connect', onConnect);
      } else if (matchmakingClient.addEventListener) {
        matchmakingClient.addEventListener('onConnect', onConnect);
        matchmakingClient.addEventListener('connect', onConnect);
      }
      setTimeout(() => done(false), 5000);
    });

    if (typeof matchmakingClient.connect === 'function') {
      await matchmakingClient.connect().catch((e) => {
        console.warn('[Multiplayer] connect() failed:', e);
      });
    }

    const connected = await connectSignal;
    if (!connected && !matchmakingClient.connected && !matchmakingClient.isConnected) {
      console.warn('[Multiplayer] Matchmaking connection not confirmed, continuing guarded flow');
    }

    if (typeof matchmakingClient.setActor !== 'function') {
      throw new Error('Matchmaking client setActor API unavailable');
    }

    const actorSessionId = `${profile.userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    actorSessionIdRef.current = actorSessionId;

    await matchmakingClient.setActor({
      session_id: actorSessionId,
      name: profile.displayName || 'Player',
      properties: {
        displayName: profile.displayName || 'Player',
        avatarUrl: profile.avatarUrl || '',
        accountId: profile.userId || '',
        account_id: profile.userId || ''
      }
    });

    setIsReady(true);
    await refreshRooms();
    return matchmakingClient;
  }, [accessToken, isAuthenticated, profile, refreshRooms, sdk]);

  const joinRoom = useCallback(async (targetRoomId) => {
    const roomId = String(targetRoomId || '').trim();
    if (!roomId) return null;

    setIsConnecting(true);
    setJoiningRoomId(roomId);
    setError(null);

    try {
      const mm = await ensureMatchmaking();
      if (!mm) return null;

      const joined = await callFirst(mm, ['joinRoom', 'join', 'enterRoom'], roomId);
      const joinedRoom = extractRoomFromAny(joined);
      if (!joinedRoom?.id) throw new Error('Room join failed');

      setActiveRoom(joinedRoom);
      setIsHost(false);
      await initRealtime(joinedRoom);
      await refreshActors();
      await refreshRooms();
      return joinedRoom;
    } finally {
      setIsConnecting(false);
      setJoiningRoomId('');
    }
  }, [callFirst, ensureMatchmaking, extractRoomFromAny, initRealtime, refreshActors, refreshRooms]);

  const createRoom = useCallback(async (namePrefix = 'PlayRoom') => {
    setIsConnecting(true);
    setError(null);

    try {
      const mm = await ensureMatchmaking();
      if (!mm) return null;

      const sessionId = actorSessionIdRef.current;
      const roomName = `${namePrefix}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const payload = {
        name: roomName,
        room_name: roomName,
        mode: 'Room',
        maxPlayers: 2,
        max_actors: 2,
        minPlayers: 1
      };

      const proto = Object.getPrototypeOf(mm) || {};
      const methodList = Object.getOwnPropertyNames(proto).filter((name) => typeof mm[name] === 'function');
      const dynamicCreateCandidates = methodList.filter((name) => /create/i.test(name) && /room|session|game/i.test(name));

      let created = await callFirst(mm, ['createRoom', ...dynamicCreateCandidates, 'createGameSession', 'createSession', 'hostRoom', 'newRoom'], payload);
      if (!created) {
        created = await callFirst(mm, ['joinRoom', 'join', 'enterRoom'], roomName);
      }

      let createdRoom = extractRoomFromAny(created);
      let createdRoomId = roomIdOf(createdRoom || {});

      if (!createdRoomId) {
        const latest = await refreshRooms();
        const byName = latest.find((room) => room.name === roomName);
        if (byName?.id) {
          createdRoom = byName;
          createdRoomId = byName.id;
        }
      }
      if (!createdRoomId) throw new Error('Room creation failed');

      await callFirst(mm, ['joinRoom', 'join', 'enterRoom'], createdRoomId);

      let attached = false;
      for (let i = 0; i < 6; i++) {
        const actorsNow = normalizeActors((await safeCall(() => mm.getMyRoomActors?.())) || createdRoom?.actors || []);
        if (actorsNow.some((a) => (a.session_id || a.sessionId || a.id) === sessionId)) {
          attached = true;
          break;
        }
        await safeCall(() =>
          mm.setActor?.({
            session_id: sessionId,
            name: profile.displayName || 'Player',
            properties: {
              displayName: profile.displayName || 'Player',
              avatarUrl: profile.avatarUrl || '',
              accountId: profile.userId || '',
              account_id: profile.userId || ''
            }
          })
        );
        await callFirst(mm, ['joinRoom', 'join', 'enterRoom'], createdRoomId);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!attached) throw new Error('Host session not bound to room after create/join retries');

      const active = normalizeRoom({ ...(createdRoom || {}), id: createdRoomId });
      ownedRoomIdsRef.current.add(createdRoomId);
      setActiveRoom(active);
      setIsHost(true);
      await initRealtime(active);
      await refreshActors();
      await refreshRooms();
      return active;
    } finally {
      setIsConnecting(false);
    }
  }, [callFirst, ensureMatchmaking, extractRoomFromAny, initRealtime, profile, refreshActors, refreshRooms, safeCall]);

  const autoMatch = useCallback(async () => {
    setIsConnecting(true);
    setError(null);

    try {
      const mm = await ensureMatchmaking();
      if (!mm) return null;

      const latestRooms = await refreshRooms();
      const openRoom = latestRooms
        .filter((room) => room.id)
        .sort((a, b) => roomPlayerCount(a) - roomPlayerCount(b))
        .find((room) => roomPlayerCount(room) < 2);

      if (openRoom?.id) {
        return await joinRoom(openRoom.id);
      }
      try {
        return await createRoom('PlayRoom');
      } catch (createErr) {
        const latestRetry = await refreshRooms();
        const fallbackOpen = latestRetry
          .filter((room) => room.id && roomPlayerCount(room) < 2)
          .sort((a, b) => roomPlayerCount(a) - roomPlayerCount(b))[0];
        if (fallbackOpen?.id) {
          return await joinRoom(fallbackOpen.id);
        }
        throw createErr;
      }
    } catch (e) {
      setError(e?.message || 'Auto match failed');
      throw e;
    } finally {
      setIsConnecting(false);
    }
  }, [createRoom, ensureMatchmaking, joinRoom, refreshRooms]);

  const startGame = useCallback(async () => {
    const mm = mmClientRef.current;
    if (!mm || !isHost || !activeRoom) return;

    const latestRooms = await refreshRooms();
    const refreshedRoom = latestRooms.find((room) => room.id === activeRoom.id) || activeRoom;
    const currentActors = await refreshActors();
    const liveCount = Math.max(
      Array.isArray(currentActors) ? currentActors.length : 0,
      roomPlayerCount(refreshedRoom || {})
    );
    if (liveCount < 2) {
      throw new Error('Need 2 players before starting');
    }

    if (typeof mm.startGame === 'function') {
      await mm.startGame();
    }
  }, [activeRoom, isHost, refreshRooms, refreshActors]);

  const leaveRoom = useCallback(async () => {
    setIsConnecting(true);
    setError(null);

    try {
      const mm = mmClientRef.current;
      const roomId = roomIdOf(activeRoom || {});

      if (mpClientRef.current?.disconnect) {
        await safeCall(() => mpClientRef.current.disconnect());
      }
      mpClientRef.current = null;
      setMc(null);

      if (mm && roomId) {
        await callFirst(mm, ['closeRoom', 'close', 'terminateRoom'], roomId);
        await callFirst(mm, ['closeRoom', 'close', 'terminateRoom']);
        await callFirst(mm, ['leaveRoom', 'leave', 'exitRoom'], roomId);
        await callFirst(mm, ['leaveRoom', 'leave', 'exitRoom']);
      }

      // Best-effort stale room cleanup for rooms created by this client in previous rounds.
      if (mm && ownedRoomIdsRef.current.size > 0) {
        const ids = [...ownedRoomIdsRef.current];
        for (const rid of ids) {
          await callFirst(mm, ['closeRoom', 'close', 'terminateRoom'], rid);
          await callFirst(mm, ['leaveRoom', 'leave', 'exitRoom'], rid);
        }
      }

      setActiveRoom(null);
      setIsHost(false);
      setActors([]);
      setMyActor(null);
      await refreshRooms();
    } finally {
      setIsConnecting(false);
      setJoiningRoomId('');
    }
  }, [activeRoom, callFirst, refreshRooms, safeCall]);

  const cleanup = useCallback(async () => {
    try {
      await safeCall(() => leaveRoom());
      if (mmClientRef.current?.disconnect) {
        await safeCall(() => mmClientRef.current.disconnect());
      }
    } finally {
      mmClientRef.current = null;
      mpClientRef.current = null;
      actorSessionIdRef.current = '';
      ownedRoomIdsRef.current = new Set();
      setRooms([]);
      setActiveRoom(null);
      setMc(null);
      setActors([]);
      setMyActor(null);
      setIsReady(false);
      setIsHost(false);
      setJoiningRoomId('');
    }
  }, [leaveRoom, safeCall]);

  const sendMessage = useCallback((type, data) => {
    const client = mpClientRef.current;
    if (!client) return;
    if (client.general?.sendMessage) {
      client.general.sendMessage(JSON.stringify({ type, data }));
      return;
    }
    if (client.send) {
      client.send(type, data);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !sdk || !profile || !accessToken) {
      cleanup();
      return;
    }

    ensureMatchmaking().catch((e) => {
      setError(e?.message || 'Matchmaking init failed');
      setIsReady(false);
    });

    return () => {};
  }, [accessToken, cleanup, ensureMatchmaking, isAuthenticated, profile, sdk]);

  useEffect(() => {
    activeRoomIdRef.current = roomIdOf(activeRoom || {});
  }, [activeRoom]);

  useEffect(() => {
    if (!activeRoom?.id) {
      if (roomSyncTimerRef.current) {
        clearInterval(roomSyncTimerRef.current);
        roomSyncTimerRef.current = null;
      }
      return;
    }

    const syncNow = async () => {
      await refreshRooms();
      await refreshActors();
    };
    syncNow();

    roomSyncTimerRef.current = setInterval(syncNow, 1500);
    return () => {
      if (roomSyncTimerRef.current) {
        clearInterval(roomSyncTimerRef.current);
        roomSyncTimerRef.current = null;
      }
    };
  }, [activeRoom?.id, refreshActors, refreshRooms]);

  useEffect(() => {
    const hiddenThresholdMs = 10000;

    const handleVisibility = () => {
      if (!activeRoomIdRef.current) return;
      if (document.hidden) {
        hiddenSinceRef.current = Date.now();
        return;
      }
      if (!hiddenSinceRef.current) return;
      const hiddenMs = Date.now() - hiddenSinceRef.current;
      hiddenSinceRef.current = 0;
      if (hiddenMs >= hiddenThresholdMs) {
        // Zombie-session prevention: long background pause triggers best-effort cleanup.
        cleanup().catch(() => {});
      }
    };

    const handlePageHide = () => {
      if (!activeRoomIdRef.current) return;
      // Best-effort cleanup on page lifecycle termination to avoid orphaned rooms.
      cleanup().catch(() => {});
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [cleanup]);

  return {
    profile,
    room: activeRoom,
    rooms,
    roomPlayerCount,
    roomNameOf,
    mc,
    actors,
    myActor,
    isReady,
    isConnecting,
    joiningRoomId,
    isHost,
    isInRoom: Boolean(activeRoom?.id),
    error,
    sendMessage,
    refreshRooms,
    autoMatch,
    createRoom,
    joinRoom,
    leaveRoom,
    startGame,
    cleanup
  };
};

export default useMultiplayer;
