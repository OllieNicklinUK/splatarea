# Flow Line Template (v1)

A PlayCanvas-based puzzle game — connect matching colored dots to fill the grid.

## ⚠️ CRITICAL: This is a static PlayCanvas project

**This template does NOT use Vite, npm, or any build system.**
- Do NOT create `vite.config.js`, `package.json`, or `src/` files
- Do NOT run `npm run build`
- Do NOT publish `dist/` from a Vite build
- The publish step copies PlayCanvas source files directly to `dist/`

## App ID injection

The App ID must be set in:
1. `2453710.json` → `entities["e951e842..."].components.script.scripts.viverseLeaderboard.attributes.clientId`
2. `__settings__.js` is auto-loaded by PlayCanvas and does not need App ID injection

## Build step (no npm)

```bash
mkdir -p dist
cp index.html manifest.json styles.css config.json viverse-auth-overlay.js \
   __game-scripts.js __loading__.js __modules__.js __settings__.js __start__.js \
   2453710.json playcanvas-stable.min.js dist/
cp -r files dist/
# Inject App ID (YOUR_APP_ID is a placeholder in 2453710.json)
sed -i '' 's/YOUR_APP_ID/<APP_ID>/g' dist/2453710.json
viverse-cli app publish dist --app-id <APP_ID>
```

## Editable files

- `styles.css` — visual styling
- `config.json` — game configuration
- `2453710.json` — PlayCanvas scene (App ID injected here)
- `__start__.js` / `__settings__.js` — PlayCanvas startup

## Immutable files (do NOT modify)

- `__game-scripts.js` — compiled game logic
- `viverse-auth-overlay.js` — VIVERSE auth overlay
