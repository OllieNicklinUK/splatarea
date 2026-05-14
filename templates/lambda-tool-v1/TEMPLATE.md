# lambda-tool-v1 Template Contract

VIVERSE-wired utility app template with Play Lambda backend for secure external API access.
Mobile-first, iframe/widget embeddable. Auth is required — Lambda invoke depends on the VIVERSE access token.

## Purpose

Provide a VIVERSE-ready tool app baseline with:
- VIVERSE auth (required — provides accessToken + userId for Lambda)
- Play Lambda invoke for secure external API calls (no keys in frontend)
- Synthetic room session (`lambda-{appId}`) — no matchmaking needed
- Key/Value response decoder for Play SDK result format
- Mobile-first touch UI, iframe/widget-safe layout
- `.env.lambda.example` + `lambda/` script directory for event contracts
- Vite build with clean `dist/` output ready for VIVERSE publish

## Architecture

```
Browser (auth) → accessToken + userId
    ↓
ViverseLambdaService.invoke(eventName, data, accessToken)
    ↓
Play SDK: newMultiplayerClient("lambda-{appId}", appId, userSessionId)
    ↓
multiplayerClient.lambda.invoke(eventName, data, accessToken)
    ↓
Lambda Script (lambda/*.js): getEnv(secret) → fetch(externalAPI) → reply(sanitized)
```

## Guardrails

- **Never modify `src/viverseLambda.js`**. The `_decodePlayLambdaValue` decoder, timeout wrapper, `roomId` synthesis (`lambda-{appId}`), and `ensure()` session reuse must be preserved exactly. Breakage here silently fails all Lambda calls.
- **Never modify `src/viverseAuth.js`**. The profile fallback chain and SDK detection must stay intact.
- **Never modify `src/viverseConfig.js`**. The runtime-config-or-hostname App ID resolution is the publish gate.
- **Never modify `src/main.js`**. App mount must call `auth.initialize()` → extract auth context → pass to lambda. Auth failure must render a login gate, not a blank screen.
- **Never put secrets in `VITE_*` env variables** in production. All secret-bearing external API calls must go through Lambda scripts.
- **Never return raw API keys or tokens** from Lambda scripts. `reply()` must contain only sanitized application data.
- **Never invoke Lambda in unauthenticated state**. Check `accessToken` and `userId` before calling `ViverseLambdaService.invoke()`.
- **Lambda scripts are editable** — agents may add new `lambda/*.js` event scripts for new API capabilities. Each event gets its own file.
- Do not lock layout with `overflow: hidden` or `height: 100vh`. Use `min-height: 100dvh` for iframe safety.
- Do not ship a real App ID. Leave `clientId` as `YOUR_APP_ID` until publish.

## Lambda Event Script Rules

Each file in `lambda/` maps to one `event_name`. Required shape:

```js
// lambda/my_api_event.js
var apiKey = getEnv('MY_API_KEY');
if (!apiKey) { reply({ success: false, error: 'missing MY_API_KEY' }); }
else {
  var input = context.data || {};
  // validate input, call fetch(), sanitize, reply()
  var resp = fetch(endpoint, { ... });
  reply({ success: true, data: sanitizedData });
}
```

Rules:
- `getEnv()` for all secrets — never hardcode
- Validate `context.data` before use
- `reply()` with only sanitized fields — never raw upstream responses
- Include `console.log` for job traceability
- Name files as `{capability}_event.js` (e.g. `weather_event.js`, `prices_event.js`)

## Lambda Env Setup

Secrets are stored in Play Lambda `/env` scoped by `game_id`, not in the repo.
See `.env.lambda.example` for required keys per event.
Use `scripts/sync-lambda-config.sh` (from `viverse-key-protection-lambda` skill) to push env/scripts.

## Customization Surface

- `src/` — all app UI and data logic (except the 4 immutable files)
- `lambda/*.js` — one file per external API event
- `index.html` — page title, runtime config block, global styles
- `public/` — static assets
- `.env.lambda.example` — document required Lambda env keys for each event
- `rulesets/` — app behavior parameters

## App Wiring

Runtime config in `index.html`:

```html
window.__APP_CONFIG__ = {
  clientId: "YOUR_APP_ID",
  appName: "My Tool",
  versionName: "1.0.0"
};
```

Before publish:
- Set `clientId` to real VIVERSE App ID
- Push Lambda env keys (`LAMBDA_AUTHKEY` + `LAMBDA_GAME_ID` = clientId)
- Push Lambda scripts via sync script
- Validate auth → Lambda invoke chain in VIVERSE preview
- Confirm graceful login gate when unauthenticated
- Confirm iframe render at 375px width

## Mobile / iframe Checklist

- [ ] Root element uses `min-height: 100dvh` not `height: 100vh`
- [ ] Touch targets at least 44×44px
- [ ] No hover-only interactions
- [ ] Readable at 375px viewport width
- [ ] Login gate shown (not blank) when unauthenticated
- [ ] Lambda errors handled gracefully — user sees message, not crash
- [ ] `invoke()` not called at high frequency — it is job-style, not streaming
