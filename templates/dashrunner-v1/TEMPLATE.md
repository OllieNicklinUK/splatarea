# dashrunner-v1 Template Contract

Frozen template package exported from `template-sources/viverse-multiplayer-runner/app`.

Use this template when you need a VIVERSE-ready endless runner with auth, leaderboard, matchmaking, and avatar-aware local player runtime already wired.

## Purpose

Provide a reusable VIVERSE-ready endless runner baseline with:
- side-lane runner movement and jump/slide obstacle gameplay
- VIVERSE auth integration
- VIVERSE leaderboard submit/fetch flow
- VIVERSE matchmaking room lifecycle
- avatar-aware local player runtime with VRM/VRMA support

## Guardrails

- Keep App ID resolution and auth/profile recovery integrity intact in `js/viverseAuth.js` and `js/viverseConfig.js`.
- Keep leaderboard integration on `gameDashboard` in `js/viverseLeaderboard.js`.
- Keep matchmaking room lifecycle integrity in `js/viverseMultiplayer.js`.
- Keep startup/bootstrap integrity in `js/main.js` and `js/viverseApp.js`.
- Preserve the current plain Vite + Three.js architecture. This template is not a React/R3F starter.
- Do not replace the runtime with React, ReactDOM, `@react-three/fiber`, `@react-three/drei`, Tailwind, or create-vite scaffolding.
- Keep the entrypoint shape on `js/main.js`; do not migrate to framework-style `main.jsx` or `App.jsx` unless explicitly requested.

## Editable Surface

- `js/game/**`
- `assets/**`
- `public/**`
- `css/**`
- `index.html`
- `game-config.json`

## Immutable Core

- `js/viverseApp.js`
- `js/viverseAuth.js`
- `js/viverseConfig.js`
- `js/viverseLeaderboard.js`
- `js/viverseMultiplayer.js`
- `js/viverseRemotePlayer.js`
- `js/main.js`

## Suggested Customizations

- runner rules, pacing, lane/jump/slide tuning
- obstacle and collectible mix
- environment art, theme styling, and UI language
- game title, branding, and non-platform copy
- asset pack swaps for characters, obstacles, and scenery
