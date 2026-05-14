import { VIVERSE_CONFIG } from "./viverseConfig.js";

function normalizeRoom(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: raw.id || raw.roomId || "",
    name: raw.name || raw.room_name || "Room",
    maxPlayers: raw.maxPlayers || raw.max_players || 2,
    minPlayers: raw.minPlayers || raw.min_players || 1,
    actors: Array.isArray(raw.actors) ? raw.actors.filter(Boolean) : [],
    raw
  };
}

function normalizeActor(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    id: raw.id || raw.actor_id || raw.actorId || "",
    sessionId: raw.session_id || raw.sessionId || "",
    name: raw.name || raw.user_name || raw.displayName || "Player",
    raw
  };
}

function getPlayClass(sdk) {
  return sdk?.Play || sdk?.play || window.play?.Play || window.Play || null;
}

export class ViverseMultiplayerController {
  constructor(onStateChange = () => {}) {
    this.onStateChange = onStateChange;
    this.playClient = null;
    this.matchmakingClient = null;
    this.actorSessionId = "";
    this.refreshTimer = null;
    this.state = {
      status: "idle",
      error: "",
      isConnected: false,
      rooms: [],
      currentRoom: null,
      actors: [],
      isHost: false,
      canStart: false
    };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.onStateChange({ ...this.state });
  }

  async initialize({ sdk, profile }) {
    const PlayClass = getPlayClass(sdk);
    if (typeof PlayClass !== "function") {
      this.setState({ status: "unavailable", error: "Play SDK unavailable" });
      throw new Error("Play SDK unavailable");
    }
    if (!profile?.accountId) {
      this.setState({ status: "guest", error: "Login required for multiplayer" });
      throw new Error("Login required for multiplayer");
    }
    if (!VIVERSE_CONFIG.appId) {
      this.setState({ status: "error", error: "Missing App ID for multiplayer" });
      throw new Error("Missing App ID for multiplayer");
    }

    this.playClient = new PlayClass();
    this.matchmakingClient = await this.playClient.newMatchmakingClient(VIVERSE_CONFIG.appId);
    this.actorSessionId = `${profile.accountId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.setState({ status: "connecting", error: "" });

    const isConnected = await this.connect();
    if (!isConnected) {
      this.setState({ status: "error", error: "Matchmaking connection timed out" });
      throw new Error("Matchmaking connection timed out");
    }

    await this.setActor(profile);
    await this.refreshRooms();
    this.startAutoRefresh();
    this.setState({ status: "ready", isConnected: true, error: "" });
  }

  async connect() {
    const mc = this.matchmakingClient;
    if (!mc) return false;

    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      try {
        mc.on?.("onConnect", () => done(true));
        mc.on?.("connect", () => done(true));
      } catch {}

      setTimeout(() => done(false), 5000);

      if (typeof mc.connect === "function") {
        mc.connect().then(() => done(true)).catch(() => done(false));
      }
    });
  }

  async setActor(profile) {
    const mc = this.matchmakingClient;
    if (!mc || typeof mc.setActor !== "function") {
      throw new Error("Matchmaking client setActor unavailable");
    }
    await mc.setActor({
      session_id: this.actorSessionId,
      name: profile.displayName || "Player",
      properties: { avatarUrl: profile.avatarUrl || "" }
    });
  }

  async refreshRooms() {
    const mc = this.matchmakingClient;
    if (!mc) return [];
    let rooms = [];
    try {
      const response =
        (typeof mc.getAvailableRooms === "function" && (await mc.getAvailableRooms().catch(() => null))) ||
        (typeof mc.getRoomList === "function" && (await mc.getRoomList().catch(() => null))) ||
        [];
      const list = response?.rooms || response?.data?.rooms || response || [];
      rooms = list.map(normalizeRoom).filter(Boolean);
    } catch (error) {
      this.setState({ error: error?.message || "Unable to refresh room list" });
    }
    this.setState({ rooms });
    return rooms;
  }

  startAutoRefresh() {
    this.stopAutoRefresh();
    this.refreshTimer = window.setInterval(() => {
      if (!this.state.currentRoom) {
        this.refreshRooms().catch(() => {});
      }
    }, 5000);
  }

  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async createRoom() {
    const mc = this.matchmakingClient;
    if (!mc) throw new Error("Matchmaking unavailable");
    const response = await mc.createRoom({
      name: `TankArena-${this.actorSessionId.slice(-4)}`,
      mode: "Room",
      maxPlayers: 2,
      minPlayers: 1
    });
    const room = normalizeRoom(response?.room || response);
    if (!room?.id) throw new Error("Room create returned no room ID");
    await this.joinRoom(room.id);
    return room;
  }

  async joinRoom(roomId) {
    const mc = this.matchmakingClient;
    if (!mc || !roomId) throw new Error("roomId is required");
    const response = await mc.joinRoom(roomId);
    const room = normalizeRoom(response?.room || response);
    await this.refreshActors(room);
    return room;
  }

  async refreshActors(room = null) {
    const mc = this.matchmakingClient;
    let actors = [];
    try {
      const actorResponse =
        (typeof mc?.getMyRoomActors === "function" && (await mc.getMyRoomActors().catch(() => null))) ||
        room?.actors ||
        [];
      actors = (Array.isArray(actorResponse) ? actorResponse : actorResponse?.actors || [])
        .map(normalizeActor)
        .filter(Boolean);
    } catch {}

    const resolvedRoom = room || this.state.currentRoom;
    const roomActors = actors.length > 0 ? actors : (resolvedRoom?.actors || []).map(normalizeActor).filter(Boolean);
    const currentRoom = resolvedRoom ? { ...resolvedRoom, actors: roomActors } : null;
    const isHost = currentRoom?.actors?.[0]?.sessionId === this.actorSessionId;
    this.setState({
      currentRoom,
      actors: roomActors,
      isHost,
      canStart: Boolean(isHost && roomActors.length >= 2)
    });
    return roomActors;
  }

  async leaveRoom() {
    const mc = this.matchmakingClient;
    if (!mc) return;
    try {
      if (this.state.isHost && typeof mc.closeRoom === "function" && this.state.currentRoom?.id) {
        await mc.closeRoom(this.state.currentRoom.id).catch(() => {});
      }
      if (typeof mc.leaveRoom === "function") {
        await mc.leaveRoom().catch(() => {});
      }
    } finally {
      this.setState({
        currentRoom: null,
        actors: [],
        isHost: false,
        canStart: false
      });
      await this.refreshRooms();
    }
  }

  async startMatch() {
    const mc = this.matchmakingClient;
    if (!mc) throw new Error("Matchmaking unavailable");
    if (!this.state.canStart) throw new Error("Two players required to start");
    if (typeof mc.startGame === "function") {
      await mc.startGame();
    }
  }
}
