# tankarena-3d-v1 Template Contract

3D arcade tank arena template extracted from the polished `template-sources/tankarena-3d/app` prototype.

## Purpose

Provide a reusable VIVERSE-ready tank game baseline with:
- fixed-camera 3D arena combat
- random battlefield generation per round
- VIVERSE auth integration
- collapsible leaderboard and room panels
- heavy-weapon progression through battlefield material collection

## Guardrails

- Keep App ID resolution and auth fallback integrity intact in `src/viverseAuth.js` and `src/viverseConfig.js`.
- Keep leaderboard integration on `gameDashboard` in `src/viverseLeaderboard.js`.
- Keep matchmaking room lifecycle integrity in `src/viverseMultiplayer.js`.
- Preserve random map generation and spawn-lane safety in `src/game/Arena.js`.
- Preserve independent tank hull and turret control in `src/game/Tank.js`.
- Preserve the existing plain Vite + Three.js architecture. This template is not a React/R3F starter.
- Do not replace the runtime with React, ReactDOM, `@react-three/fiber`, `@react-three/drei`, Tailwind, or create-vite scaffolding.
- Keep the existing entrypoint shape on `src/main.js`; do not migrate to `src/main.jsx`/`App.jsx` unless the user explicitly asks for a framework migration.
- Do not ship a real App ID in the template. Leave `window.__TANKARENA_CONFIG__.clientId` as `YOUR_APP_ID` until initialization.
- Keep HUD panels collapsible so gameplay view stays readable on smaller screens.

## Customization Surface

- tank visuals, arena art, and HUD styling
- damage, cooldowns, timer, and weapon balance
- bot behavior tuning
- map generation heuristics and obstacle mix
- leaderboard naming and presentation
- room-panel UX and multiplayer polish

## App Wiring

Runtime config lives in `index.html`:

```html
window.__TANKARENA_CONFIG__ = {
  clientId: "YOUR_APP_ID",
  leaderboardName: "tankarena-wins",
  versionName: "0.2.0-auth-leaderboard"
};
```

Before publish:
- set `clientId` to the target VIVERSE App ID
- create the Studio leaderboard with API name exactly matching `leaderboardName`
- validate auth, leaderboard, and room lifecycle in preview before submitting review
