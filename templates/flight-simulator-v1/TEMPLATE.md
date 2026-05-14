# flight-simulator-v1 Template Contract

Three.js flight simulator template with VIVERSE auth, global leaderboard, and procedural terrain.

## Purpose

Provide a VIVERSE-ready 3D flight simulator baseline with:
- Aircraft pitch/roll/yaw physics in Three.js
- Ring-collection scoring system
- Procedural terrain (mountains, trees, clouds)
- VIVERSE auth integration with resilient profile recovery
- VIVERSE leaderboard score submission and top-10 ranking view
- Profile chip UI (top-right, auth-decoupled)
- Canvas tabindex for VIVERSE iframe keyboard/mouse input capture

## Guardrails

- Keep auth bootstrap and iframe handshake delay (1200ms) intact in `js/viverseAuth.js`.
- Keep leaderboard initialization, idempotent submit guard, and robust extraction in `js/viverseLeaderboard.js`.
- Keep App ID resolution (env var → hostname fallback) intact in `js/viverseConfig.js`.
- Keep game launch in `src/main.js` auth-decoupled — game must start immediately without waiting for auth.
- Keep `src/core/EventBus.js` and `src/core/GameState.js` unchanged.
- Do NOT remove `tabindex="0"` from the canvas — keyboard/mouse events are silently dropped in VIVERSE iframe without it.
- Do NOT use `sdk.leaderboard` constructor; use `gameDashboard`/`GameDashboard` only.
- Preserve plain Vite + Three.js architecture. Do not add React, R3F, or framework scaffolding.

## Editable Surface

- `src/core/Constants.js` — tweak physics, ring count, colors, terrain params
- `src/core/Game.js` — game loop, camera, effects wiring
- `src/gameplay/Player.js` — aircraft mesh, flight physics
- `src/level/LevelBuilder.js` — terrain, mountains, trees, clouds, fog
- `src/systems/**` — rings, exhaust, speed lines, sky, particles, camera effects, input
- `src/audio/**` — BGM and SFX patterns
- `src/ui/**` — HUD instruments, menu overlays
- `index.html` — title, leaderboard name config, styling
- `public/**` — static assets

## Immutable Core

- `js/viverseAuth.js` — full auth controller with profile recovery chain
- `js/viverseConfig.js` — App ID resolution and VIVERSE_CONFIG
- `js/viverseLeaderboard.js` — leaderboard client with idempotent submit
- `src/main.js` — VIVERSE wiring entry point (auth + leaderboard + game bootstrap)
- `src/core/EventBus.js` — pub/sub singleton
- `src/core/GameState.js` — centralized game state

## Suggested Customizations

- aircraft theme, color scheme, and visual style
- terrain biome (arctic, tropical, alien, desert)
- ring layout, count, spread, and point values
- weather effects (clouds, fog density, rain)
- game title, branding, and UI copy
- scoring model changes (time-based, altitude bonus, etc.)

## Studio Setup (Required before publish)

1. Create a World App in VIVERSE Studio → get App ID.
2. Create a leaderboard under that app:
   - API name: must match `leaderboardName` in `index.html` config block (default: `FlightSimLeaderboard`)
   - Data type: `Numerical`, Sort: `Descending`, Update rule: `Best` or `Append`
3. Set `clientId` in the `window.__FLIGHT_SIM_CONFIG__` block in `index.html` to your App ID.
4. `npm run build` then publish `dist/` to VIVERSE.
