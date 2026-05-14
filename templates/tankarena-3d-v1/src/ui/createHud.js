export function createHud(root) {
  const hud = document.createElement("div");
  hud.className = "hud";
  hud.innerHTML = `
    <div class="hud__top">
      <div class="hud__card hud__card--player">
        <div class="hud__label" data-role="p1-name">Player 1</div>
        <div class="hud__bar"><span data-role="p1-bar"></span></div>
        <div class="hud__value" data-role="p1-hp">100</div>
        <div class="hud__subvalue" data-role="p1-weapon">Materials: 0 • Heavy: No</div>
      </div>
      <div class="hud__center">
        <div class="hud__timer" data-role="timer">75</div>
        <button class="hud__button" data-role="start">Start Round</button>
      </div>
      <div class="hud__card hud__card--enemy">
        <div class="hud__label" data-role="p2-name">Bot</div>
        <div class="hud__bar hud__bar--enemy"><span data-role="p2-bar"></span></div>
        <div class="hud__value" data-role="p2-hp">100</div>
        <div class="hud__subvalue" data-role="p2-weapon">Materials: 0 • Heavy: No</div>
      </div>
    </div>
    <div class="hud__bottom">
      <div class="hud__status" data-role="status">Ready for a local duel.</div>
      <div class="hud__meta">
        <span data-role="identity">Guest</span>
        <span data-role="app-id">No App ID</span>
        <button class="hud__chip" data-role="auth-action">Login</button>
        <button class="hud__chip" data-role="leaderboard-toggle">Leaderboard</button>
        <button class="hud__chip" data-role="room-toggle">Rooms</button>
      </div>
    </div>
    <div class="hud__controls">
      <div>Drive: W/S forward-back, A/D rotate</div>
      <div>Aim turret: Arrow keys or J/L</div>
      <div>Fire: Click / Space</div>
      <div>Heavy shot: E after collecting 3 materials</div>
    </div>
    <div class="hud__leaderboard hud__leaderboard--hidden" data-role="leaderboard-panel">
      <div class="hud__leaderboard-head">
        <strong>Leaderboard</strong>
        <button class="hud__chip" data-role="leaderboard-close">Close</button>
      </div>
      <div class="hud__leaderboard-body" data-role="leaderboard-body">Login to load rankings.</div>
    </div>
    <div class="hud__leaderboard hud__leaderboard--hidden" data-role="room-panel">
      <div class="hud__leaderboard-head">
        <strong>Matchmaking</strong>
        <button class="hud__chip" data-role="room-close">Close</button>
      </div>
      <div class="hud__leaderboard-body">
        <div class="hud__room-actions">
          <button class="hud__chip" data-role="room-create">Create Room</button>
          <button class="hud__chip" data-role="room-refresh">Refresh</button>
          <button class="hud__chip" data-role="room-leave">Leave Room</button>
          <button class="hud__chip" data-role="room-start">Start Match</button>
        </div>
        <div class="hud__leaderboard-muted" data-role="room-status">Login to enable multiplayer.</div>
        <div data-role="room-body"></div>
      </div>
    </div>
  `;
  root.appendChild(hud);

  const style = document.createElement("style");
  style.textContent = `
    .hud {
      position: fixed;
      inset: 0;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 18px;
    }
    .hud__top,
    .hud__bottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .hud__card,
    .hud__center,
    .hud__status,
    .hud__meta,
    .hud__controls {
      background: rgba(9, 14, 26, 0.72);
      border: 1px solid rgba(191, 219, 254, 0.18);
      backdrop-filter: blur(12px);
      border-radius: 18px;
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
    }
    .hud__card {
      min-width: 220px;
      padding: 14px 16px;
    }
    .hud__label {
      font-weight: 800;
      letter-spacing: 0.04em;
      margin-bottom: 10px;
      text-transform: uppercase;
    }
    .hud__bar {
      height: 12px;
      background: rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      overflow: hidden;
      margin-bottom: 10px;
    }
    .hud__bar span {
      display: block;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, #67e8f9, #3b82f6);
    }
    .hud__bar--enemy span {
      background: linear-gradient(90deg, #fb7185, #ef4444);
    }
    .hud__value {
      font-size: 1.15rem;
      font-weight: 700;
    }
    .hud__subvalue {
      margin-top: 8px;
      color: #cbd5e1;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .hud__center {
      padding: 14px;
      text-align: center;
      min-width: 180px;
      pointer-events: auto;
    }
    .hud__timer {
      font-size: 2rem;
      font-weight: 900;
      margin-bottom: 10px;
    }
    .hud__button {
      appearance: none;
      border: 0;
      border-radius: 999px;
      padding: 11px 16px;
      font-weight: 800;
      background: linear-gradient(135deg, #22d3ee, #2f6bff);
      color: #f8fafc;
      cursor: pointer;
    }
    .hud__chip {
      appearance: none;
      pointer-events: auto;
      border: 1px solid rgba(191, 219, 254, 0.22);
      border-radius: 999px;
      padding: 8px 12px;
      background: rgba(15, 23, 42, 0.9);
      color: #e2e8f0;
      font-size: 0.86rem;
      font-weight: 700;
      cursor: pointer;
    }
    .hud__bottom {
      align-items: flex-end;
    }
    .hud__status,
    .hud__meta,
    .hud__controls {
      padding: 12px 14px;
      font-size: 0.95rem;
      line-height: 1.4;
    }
    .hud__meta {
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-items: flex-end;
    }
    .hud__controls {
      max-width: 280px;
      align-self: flex-end;
    }
    .hud__leaderboard {
      position: fixed;
      left: 18px;
      bottom: 18px;
      width: min(320px, calc(100vw - 36px));
      max-height: min(360px, 52vh);
      overflow: hidden;
      pointer-events: auto;
      background: rgba(9, 14, 26, 0.86);
      border: 1px solid rgba(191, 219, 254, 0.2);
      border-radius: 18px;
      backdrop-filter: blur(12px);
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.32);
    }
    .hud__leaderboard--hidden {
      display: none;
    }
    .hud__leaderboard-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(191, 219, 254, 0.14);
    }
    .hud__leaderboard-body {
      padding: 12px 14px;
      max-height: 280px;
      overflow-y: auto;
      font-size: 0.95rem;
      line-height: 1.5;
    }
    .hud__leaderboard-row {
      display: grid;
      grid-template-columns: 28px 1fr auto;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .hud__leaderboard-row:last-child {
      border-bottom: 0;
    }
    .hud__leaderboard-muted {
      color: #94a3b8;
    }
    .hud__room-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
    }
    .hud__room-card {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px;
      padding: 10px;
      margin-bottom: 10px;
      background: rgba(15, 23, 42, 0.45);
    }
    .hud__room-card strong {
      display: block;
      margin-bottom: 4px;
    }
    .hud__room-card button {
      margin-top: 8px;
    }
    @media (max-width: 900px) {
      .hud__top,
      .hud__bottom {
        flex-direction: column;
        align-items: stretch;
      }
      .hud__controls {
        align-self: stretch;
      }
      .hud__meta {
        align-items: stretch;
      }
      .hud__leaderboard {
        left: 12px;
        right: 12px;
        width: auto;
        bottom: 12px;
      }
    }
  `;
  document.head.appendChild(style);

  return {
    root: hud,
    refs: {
      p1Name: hud.querySelector('[data-role="p1-name"]'),
      p1Bar: hud.querySelector('[data-role="p1-bar"]'),
      p1Hp: hud.querySelector('[data-role="p1-hp"]'),
      p1Weapon: hud.querySelector('[data-role="p1-weapon"]'),
      p2Name: hud.querySelector('[data-role="p2-name"]'),
      p2Bar: hud.querySelector('[data-role="p2-bar"]'),
      p2Hp: hud.querySelector('[data-role="p2-hp"]'),
      p2Weapon: hud.querySelector('[data-role="p2-weapon"]'),
      timer: hud.querySelector('[data-role="timer"]'),
      status: hud.querySelector('[data-role="status"]'),
      identity: hud.querySelector('[data-role="identity"]'),
      appId: hud.querySelector('[data-role="app-id"]'),
      start: hud.querySelector('[data-role="start"]'),
      authAction: hud.querySelector('[data-role="auth-action"]'),
      leaderboardToggle: hud.querySelector('[data-role="leaderboard-toggle"]'),
      leaderboardPanel: hud.querySelector('[data-role="leaderboard-panel"]'),
      leaderboardBody: hud.querySelector('[data-role="leaderboard-body"]'),
      leaderboardClose: hud.querySelector('[data-role="leaderboard-close"]'),
      roomToggle: hud.querySelector('[data-role="room-toggle"]'),
      roomPanel: hud.querySelector('[data-role="room-panel"]'),
      roomClose: hud.querySelector('[data-role="room-close"]'),
      roomBody: hud.querySelector('[data-role="room-body"]'),
      roomStatus: hud.querySelector('[data-role="room-status"]'),
      roomCreate: hud.querySelector('[data-role="room-create"]'),
      roomRefresh: hud.querySelector('[data-role="room-refresh"]'),
      roomLeave: hud.querySelector('[data-role="room-leave"]'),
      roomStart: hud.querySelector('[data-role="room-start"]')
    }
  };
}
