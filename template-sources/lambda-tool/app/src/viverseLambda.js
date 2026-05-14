// viverseLambda.js — IMMUTABLE
// Play SDK Lambda invoke wrapper.
// Handles synthetic roomId, multiplayerClient lifecycle, Key/Value decode, and timeouts.
// Ported from voxel-landmark production implementation.
// Do not modify this file.

class ViverseLambdaService {
  constructor() {
    this.playClient = null;
    this.multiplayerClient = null;
    this.session = { appId: '', userSessionId: '', roomId: '' };
    this._initPromise = null;
  }

  _withTimeout(promise, ms, label) {
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms
      );
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  _resolveSdk() {
    return window.viverse || window.VIVERSE_SDK || null;
  }

  _resolvePlayCtor(vSdk) {
    if (!vSdk) return null;
    if (typeof vSdk.play === 'function') return vSdk.play;
    if (typeof vSdk.Play === 'function') return vSdk.Play;
    return null;
  }

  // Decode Play SDK Key/Value array format into plain objects recursively
  _decodePlayLambdaValue(value) {
    if (Array.isArray(value)) {
      const isKeyValueArray = value.every(
        (entry) =>
          entry &&
          typeof entry === 'object' &&
          Object.prototype.hasOwnProperty.call(entry, 'Key') &&
          Object.prototype.hasOwnProperty.call(entry, 'Value')
      );
      if (isKeyValueArray) {
        const obj = {};
        for (const entry of value) {
          obj[String(entry.Key)] = this._decodePlayLambdaValue(entry.Value);
        }
        return obj;
      }
      return value.map((entry) => this._decodePlayLambdaValue(entry));
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this._decodePlayLambdaValue(v);
      }
      return out;
    }
    return value;
  }

  async init({ appId, userId }) {
    if (this._initPromise) return this._initPromise;

    const resolvedAppId = String(appId || '').trim();
    const resolvedUserId = String(userId || '').trim();
    if (!resolvedAppId) throw new Error('ViverseLambda: missing appId');
    if (!resolvedUserId) throw new Error('ViverseLambda: missing userId');

    const vSdk = this._resolveSdk();
    const PlayCtor = this._resolvePlayCtor(vSdk);
    if (!PlayCtor) throw new Error('ViverseLambda: Play SDK unavailable');

    // Synthetic room — no matchmaking needed for Lambda invoke
    const roomId = `lambda-${resolvedAppId}`;
    const userSessionId = `${resolvedUserId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this._initPromise = (async () => {
      console.log('[ViverseLambda] init:start', { appId: resolvedAppId });

      this.playClient = new PlayCtor();
      this.multiplayerClient = await this._withTimeout(
        this.playClient.newMultiplayerClient(roomId, resolvedAppId, userSessionId),
        15000,
        'newMultiplayerClient'
      );
      if (!this.multiplayerClient) {
        throw new Error('ViverseLambda: failed to create multiplayerClient');
      }

      await this._withTimeout(this.multiplayerClient.init(), 20000, 'multiplayerClient.init');
      this.session = { appId: resolvedAppId, userSessionId, roomId };
      console.log('[ViverseLambda] init:ready', { roomId });
      return true;
    })()
      .catch((err) => {
        this.playClient = null;
        this.multiplayerClient = null;
        this.session = { appId: '', userSessionId: '', roomId: '' };
        throw err;
      })
      .finally(() => {
        this._initPromise = null;
      });

    return this._initPromise;
  }

  async ensure({ appId, userId }) {
    if (this.multiplayerClient && this.session.appId === appId) {
      return this.multiplayerClient;
    }
    await this.init({ appId, userId });
    return this.multiplayerClient;
  }

  async invoke(eventName, eventData, accessToken, context = {}) {
    const token = String(accessToken || '').trim();
    const name = String(eventName || '').trim();
    if (!token) throw new Error('ViverseLambda: missing accessToken');
    if (!name) throw new Error('ViverseLambda: missing eventName');

    const appId = String(context.appId || '').trim();
    const userId = String(context.userId || '').trim();
    if (!appId || !userId) throw new Error('ViverseLambda: missing appId/userId context');

    const client = await this.ensure({ appId, userId });
    if (!client.lambda || typeof client.lambda.invoke !== 'function') {
      throw new Error('ViverseLambda: lambda module unavailable on multiplayerClient');
    }

    console.log('[ViverseLambda] invoke:start', { eventName: name, appId });
    const response = await this._withTimeout(
      client.lambda.invoke(name, eventData || {}, token),
      30000,
      `lambda.invoke(${name})`
    );

    if (!response) throw new Error('ViverseLambda: empty response');
    if (response.status && response.status !== 'succeeded') {
      throw new Error(response.error || response.status);
    }

    console.log('[ViverseLambda] invoke:done', { eventName: name, status: response.status });
    return this._decodePlayLambdaValue(response.result ?? response);
  }
}

export default new ViverseLambdaService();
