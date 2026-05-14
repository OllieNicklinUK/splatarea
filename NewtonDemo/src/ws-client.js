const WS_URL = 'ws://localhost:8765';

export class PhysicsClient {
  constructor({ onState, onConnect, onDisconnect }) {
    this.onState = onState;
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.ws = null;
    this.connected = false;
    this._connect();
  }

  _connect() {
    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        this.connected = true;
        this.onConnect?.('newton');
      };

      this.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'state') this.onState(msg);
        } catch { /* skip malformed */ }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.onDisconnect?.();
        // Reconnect after 2s
        setTimeout(() => this._connect(), 2000);
      };

      this.ws.onerror = () => {
        this.ws.close();
      };
    } catch {
      setTimeout(() => this._connect(), 2000);
    }
  }

  smash(pos, radius = 3.0, force = 60.0) {
    if (!this.connected) return;
    this.ws.send(JSON.stringify({ type: 'smash', pos, radius, force }));
  }

  reset() {
    if (!this.connected) return;
    this.ws.send(JSON.stringify({ type: 'reset' }));
  }
}
