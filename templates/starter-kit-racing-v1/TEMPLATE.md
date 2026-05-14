# starter-kit-racing-v1 Template Contract

Arcade racing template extracted from local `Starter-Kit-Racing-master` and upgraded for VIVERSE auth, leaderboard, and closed-loop random track generation.

## Purpose

Provide a reusable VIVERSE racing baseline with:
- resilient VIVERSE auth bootstrap
- `gameDashboard` leaderboard submission
- static browser-friendly project layout without a required build step
- in-game closed-loop random track switching
- optional editor for authoring and sharing custom loops

## Guardrails

- Keep VIVERSE auth resilience intact in `js/ViverseAuthController.js`.
- Keep leaderboard client usage on `gameDashboard` in `js/LeaderboardPanel.js`.
- Preserve the random closed-loop generator contract in `js/randomLoop.js`.
- Do not ship a real App ID in the template. Leave `window.__STARTER_KIT_RACING_CONFIG__.clientId` empty until project initialization.
- Keep gameplay overlays clickable; do not regress HUD hit-testing on `#race-root`.

## Customization Surface

- visual theme and HUD styling
- race rules, lap counts, and scoring
- random loop generation heuristics
- editor UX and track-sharing flow
- audio/models/track art

## App Wiring

The runtime config lives in `index.html`:

```html
window.__STARTER_KIT_RACING_CONFIG__ = {
  clientId: '',
  leaderboardName: 'starter-kit-racing-time',
  lapsToFinish: 3
};
```

Before publish:
- set `clientId` to the target VIVERSE App ID
- create the Studio leaderboard with API name exactly matching `leaderboardName`
