# blank-webapp-v1 Template Contract

Minimal VIVERSE-wired web app baseline for mobile-first utility tools and widgets.
Designed for iframe embedding, panel widgets, and standalone mobile pages.
No Lambda dependency — auth is optional and gracefully degraded.

## Purpose

Provide the smallest possible VIVERSE-ready app baseline with:
- VIVERSE auth integration (optional — app works without login)
- Mobile-first touch UI
- iframe/widget-safe layout (no overflow-hidden traps, no fixed fullscreen)
- Runtime App ID propagation via `window.__APP_CONFIG__`
- Vite build with clean `dist/` output ready for VIVERSE publish

## Guardrails

- Keep auth bootstrap integrity intact in `src/viverseAuth.js` — do not modify the profile fallback chain or SDK detection logic.
- Keep App ID resolution logic intact in `src/viverseConfig.js` — runtime-config-or-hostname strategy must be preserved.
- Keep the app mount entrypoint shape in `src/main.js` — it must call `auth.initialize()` then mount the UI regardless of auth outcome. Never gate app mount on auth success.
- Do not lock the root layout with `overflow: hidden` or `height: 100vh` — use `min-height: 100dvh` so embedded panels remain scrollable.
- Do not ship a real App ID in the template. Leave `clientId` as `YOUR_APP_ID` in `index.html` until publish time.
- Auth is **optional** in this template. The app must degrade gracefully when unauthenticated — show a login prompt but keep core functionality accessible.
- Do not introduce Lambda or Play SDK dependencies in this template. If the feature requires external API keys, use the `lambda-tool-v1` template instead.
- Preserve the plain Vite + vanilla JS architecture. Do not introduce React, Vue, Tailwind, or framework scaffolding unless the user explicitly requests a framework migration.

## Customization Surface

- All app UI and logic in `src/` (except `viverseAuth.js`, `viverseConfig.js`, `main.js`)
- `index.html` — page title, meta, runtime config block, global styles
- `public/` — static assets, icons, fonts
- `rulesets/` — app behavior parameters
- `package.json` — dependencies (keep Vite + no-framework baseline unless migrating)

## App Wiring

Runtime config lives in `index.html`:

```html
window.__APP_CONFIG__ = {
  clientId: "YOUR_APP_ID",
  appName: "My App",
  versionName: "1.0.0"
};
```

Before publish:
- Set `clientId` to the target VIVERSE App ID
- Validate auth flow (login button, profile display) in VIVERSE preview
- Confirm app renders correctly inside an iframe at 375px width (mobile baseline)

## Mobile / iframe Checklist

- [ ] Root element uses `min-height: 100dvh` not `height: 100vh`
- [ ] Touch targets are at least 44×44px
- [ ] No hover-only interactions
- [ ] Content is readable at 375px viewport width
- [ ] App does not break when `window.viverse` is absent
- [ ] Login prompt shown but app still functional when unauthenticated
