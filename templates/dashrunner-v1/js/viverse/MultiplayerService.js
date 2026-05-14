export class MultiplayerService {
    constructor(viverseService) {
        this.viverse = viverseService;
        this.appId = viverseService.appId;
        this.playClient = null;
        this.mc = null; // MatchmakingClient
        this.mp = null; // MultiplayerClient
        this.roomId = null;
        this.room = null;
        
        this.isHost = false;
        this.isConnected = false;
        this.actorSessionId = null;

        // Callbacks
        this.onRoomListUpdated = null;
        this.onPlayersUpdated = null;
        this.onGameStart = null;
        this.onMessageReceived = null;
    }

    async init() {
        if (!this.viverse.accessToken || !this.viverse.accountId) {
            console.error("Multiplayer requires auth first!");
            return false;
        }

        const v = window.viverse || window.VIVERSE_SDK || window.vSdk;
        const PlayClass = v?.Play || v?.play || window.play?.Play || window.Play;
        if (!PlayClass) {
            console.error("Play SDK not loaded on window.");
            return false;
        }

        this.playClient = new PlayClass();
        this.mc = await this.playClient.newMatchmakingClient(this.appId);

        // v4.5 Canonical Session ID Generation
        this.actorSessionId = `${this.viverse.accountId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

        if (typeof this.mc.setActor !== "function") throw new Error("mc.setActor API unavailable!");

        await this.mc.setActor({
            session_id: this.actorSessionId,
            name: this.viverse.profileName || "DashRunner",
            properties: { avatarUrl: "" }
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
        this.onPlayersUpdated(actors.length, 2);
    }

    async getRoomList() {
        const list = await this.mc.getAvailableRooms?.();
        return Array.isArray(list) ? list : (list?.rooms || []);
    }

    async joinRoom(roomId) {
        const res = await this.mc.joinRoom?.(roomId);
        this.room = res?.room || res;
        this.roomId = this.room?.id || this.room?.roomId || this.room?.game_session;
        this.isHost = false;
        await this.initMultiplayer();
        return true;
    }

    async createRoom() {
        const created = await this.mc.createRoom?.({
            name: `DashRunner_${Math.floor(Math.random() * 1000)}`,
            mode: "Room",
            maxPlayers: 2,
            minPlayers: 1
        });
        
        this.room = created?.room || created;
        this.roomId = this.room?.id || this.room?.roomId || this.room?.game_session;
        
        if (!this.roomId) throw new Error("Created room lacked ID");
        
        // Host must explicitly join their own room
        await this.mc.joinRoom?.(this.roomId).catch(() => {});

        // Host Binding Verification Loop
        let attached = false;
        for (let i = 0; i < 6; i++) {
            const actors = (await this.mc.getMyRoomActors?.().catch(() => [])) || this.room?.actors || [];
            if (actors.some((a) => (a.session_id || a.sessionId) === this.actorSessionId)) {
                attached = true;
                break;
            }
            await this.mc.setActor?.({ session_id: this.actorSessionId, name: this.viverse.profileName, properties: {} }).catch(() => {});
            await this.mc.joinRoom?.(this.roomId).catch(() => {});
            await new Promise((r) => setTimeout(r, 250));
        }

        if (!attached) throw new Error("Host session failed to bind to room!");

        this.isHost = true;
        await this.initMultiplayer();
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
        if (!this.isHost) return;
        await this.mc.startGame?.();
    }

    async initMultiplayer() {
        const v = window.viverse || window.VIVERSE_SDK || window.vSdk;
        const MClient = (v?.play || v?.Play)?.MultiplayerClient || window.play?.MultiplayerClient || window.Play?.MultiplayerClient;
        
        try {
            this.mp = new MClient(this.roomId, {
                app_id: this.appId,
                token: this.viverse.accessToken,
                authorization: this.viverse.accessToken,
                accessToken: this.viverse.accessToken,
                session_id: this.actorSessionId
            });
        } catch (_) {
            this.mp = new MClient(this.roomId, this.appId, this.actorSessionId);
        }

        // Bridge both interfaces exactly as described in strict SKILL.md
        if (this.mp.onMessage) {
            this.mp.onMessage((raw) => this.handleMessage(raw));
        }

        await this.mp.init({ modules: { general: { enabled: true } } });

        if (this.mp.general?.onMessage) {
            this.mp.general.onMessage((raw) => this.handleMessage(raw));
        }
    }

    handleMessage(raw) {
        if (!this.onMessageReceived) return;
        try {
            const data = typeof raw === "object" ? raw : JSON.parse(raw);
            this.onMessageReceived(data);
        } catch (e) {
            console.error("Message parse error", e);
        }
    }

    sendMessage(payload) {
        if (!this.mp || !this.mp.general) return;
        // Avoid detached 'this' errors by calling bound
        this.mp.general.sendMessage(JSON.stringify(payload));
    }
}
