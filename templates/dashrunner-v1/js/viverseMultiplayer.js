import { VIVERSE_CONFIG } from './viverseConfig.js';

/**
 * VIVERSE Multiplayer Controller
 * 
 * Manages Matchmaking (MatchmakingClient) and WebSocket synchronization 
 * (MultiplayerClient). Implements v4.5 Canonical Session ID and robust 
 * Host Binding Verification.
 */
export class ViverseMultiplayerController {
    constructor() {
        this.playClient = null;
        this.mc = null; // MatchmakingClient
        this.mp = null; // MultiplayerClient
        this.roomId = null;
        this.room = null;
        
        this.isHost = false;
        this.isConnected = false;
        this.actorSessionId = null;

        // Callbacks for hooks
        this.onRoomListUpdated = null;
        this.onPlayersUpdated = null;
        this.onGameStart = null;
        this.onMessageReceived = null;
        this.auth = null;
    }

    async initialize(auth) {
        if (!auth.accessToken || !auth.accountId) {
            console.error("Multiplayer requires authenticated profile first!");
            return false;
        }
        this.auth = auth;

        const v = window.viverse || window.VIVERSE_SDK || window.vSdk;
        const PlayClass = v?.Play || v?.play || window.play?.Play || window.Play;
        if (!PlayClass) {
            console.error("Play SDK not detected.");
            return false;
        }

        this.playClient = new PlayClass();
        this.mc = await this.playClient.newMatchmakingClient(VIVERSE_CONFIG.clientId);

        // v4.5 Canonical Session ID Generation
        this.actorSessionId = `${auth.accountId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Explicit Connect with Timeout Validation
        this.isConnected = await new Promise((resolve) => {
            let resolved = false;
            const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
            this.mc.on("onConnect", () => done(true));
            this.mc.on("connect", () => done(true));
            setTimeout(() => done(false), 5000);
            if (typeof this.mc.connect === 'function') this.mc.connect().catch(() => {});
        });

        if (!this.isConnected) {
            console.warn('Matchmaking connect timeout, proceeding contextually...');
        }

        await this.mc.setActor({
            session_id: this.actorSessionId,
            name: auth.profileName || "VIVERSE Player",
            properties: { avatarUrl: auth.avatarUrl || "" }
        });

        this.setupMatchmakingListeners();
        return true;
    }

    setupMatchmakingListeners() {
        this.mc.on("onRoomUpdate", (r) => { this.room = r; this.emitPlayers(); });
        this.mc.on("onRoomDeleted", () => { this.leaveRoom(); });
        this.mc.on("onRoomActorsChange", (r) => { this.room = r; this.emitPlayers(); });
        this.mc.on("onGameStartNotify", () => { 
            if (this.onGameStart) this.onGameStart(); 
        });
    }

    emitPlayers() {
        if (!this.onPlayersUpdated) return;
        const actors = this.room?.actors || [];
        // Extract count for lobby visibility
        this.onPlayersUpdated(actors.length, 2); 
    }

    async getRoomList() {
        if (!this.mc) return [];
        const list = await this.mc.getAvailableRooms?.();
        return Array.isArray(list) ? list : (list?.rooms || []);
    }

    async joinRoom(roomId, auth = this.auth) {
        const res = await this.mc.joinRoom?.(roomId);
        this.room = res?.room || res;
        this.roomId = this.room?.id || this.room?.roomId || this.room?.game_session;
        this.isHost = false;
        await this.initSocket(auth);
        return true;
    }

    async createRoom(auth = this.auth) {
        const created = await this.mc.createRoom?.({
            name: `${VIVERSE_CONFIG.gameName}_${Math.floor(Math.random() * 1000)}`,
            mode: "Room",
            maxPlayers: 2,
            minPlayers: 1
        });
        
        this.room = created?.room || created;
        this.roomId = this.room?.id || this.room?.roomId || this.room?.game_session;
        
        if (!this.roomId) throw new Error("Created room lacked ID");
        
        // Host must explicitly join their own room
        await this.mc.joinRoom?.(this.roomId).catch(() => {});

        // Host Binding Verification Loop (Resilience Gate)
        let attached = false;
        for (let i = 0; i < 6; i++) {
            const actors = (await this.mc.getMyRoomActors?.().catch(() => [])) || this.room?.actors || [];
            if (actors.some((a) => (a.session_id || a.sessionId) === this.actorSessionId)) {
                attached = true;
                break;
            }
            await this.mc.setActor?.({ session_id: this.actorSessionId, name: auth.profileName, properties: {} }).catch(() => {});
            await this.mc.joinRoom?.(this.roomId).catch(() => {});
            await new Promise((r) => setTimeout(r, 250));
        }

        if (!attached) throw new Error("Host failed to bind to room!");

        this.isHost = true;
        await this.initSocket(auth);
        return true;
    }

    async leaveRoom() {
        if (this.mp) {
            if (typeof this.mp.disconnect === 'function') this.mp.disconnect();
            this.mp = null;
        }

        if (this.roomId) {
            if (this.isHost) await this.mc.closeRoom?.().catch(() => {});
            await this.mc.leaveRoom?.().catch(() => {});
        }

        this.roomId = null;
        this.room = null;
        this.isHost = false;
    }

    async startGame() {
        if (this.isHost) await this.mc.startGame?.();
    }

    async initSocket(auth = this.auth) {
        const v = window.viverse || window.VIVERSE_SDK || window.vSdk;
        const MClient = (v?.play || v?.Play)?.MultiplayerClient 
                     || window.play?.MultiplayerClient 
                     || window.Play?.MultiplayerClient;
        
        try {
            this.mp = new MClient(this.roomId, {
                app_id: VIVERSE_CONFIG.clientId,
                token: auth.accessToken,
                session_id: this.actorSessionId
            });
        } catch (_) {
            this.mp = new MClient(this.roomId, VIVERSE_CONFIG.clientId, this.actorSessionId);
        }

        const msgHandler = (raw) => {
            if (!this.onMessageReceived) return;
            try {
                const data = typeof raw === "object" ? raw : JSON.parse(raw);
                this.onMessageReceived(data);
            } catch (e) { console.error("Socket parse error", e); }
        };

        if (this.mp.onMessage) this.mp.onMessage(msgHandler);

        await this.mp.init({ modules: { general: { enabled: true } } });

        if (this.mp.general?.onMessage) this.mp.general.onMessage(msgHandler);
    }

    broadcast(payload) {
        if (this.mp?.general) {
            // Include sender metadata for loopback filtering
            const data = {
                ...payload,
                senderId: this.actorSessionId
            };
            this.mp.general.sendMessage(JSON.stringify(data));
        }
    }
}
