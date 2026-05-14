# blank-webapp-v1 Template Contract

Minimal VIVERSE-wired web app baseline for mobile-first utility tools and widgets.
Designed for iframe embedding, panel widgets, and standalone mobile pages.
No Lambda dependency — auth is optional and gracefully degraded.

## Purpose

Provide the smallest possible VIVERSE-ready app baseline with:
- VIVERSE auth integration (optional — app works without login)
- VIVERSE Storage SDK for per-user cloud persistence (vote choice, preferences)
- VIVERSE Leaderboard SDK for shared cross-user aggregation (vote counts)
- Admin panel gated by `adminAccountId` for live result monitoring
- Mobile-first touch UI
- iframe/widget-safe layout (no overflow-hidden traps, no fixed fullscreen)
- Runtime App ID propagation via `window.__APP_CONFIG__`
- Vite build with clean `dist/` output ready for VIVERSE publish

## Guardrails

- Keep auth bootstrap integrity intact in `src/viverseAuth.js` — do not modify the profile fallback chain or SDK detection logic.
- Keep App ID resolution logic intact in `src/viverseConfig.js` — runtime-config-or-hostname strategy must be preserved.
- Keep the app mount entrypoint shape in `src/main.js` — it must call `auth.initialize()` then mount the UI regardless of auth outcome. Never gate app mount on auth success.
- Do not lock the root layout with `overflow: hidden` or `height: 100vh` — use `min-height: 100dvh` so embedded panels remain scrollable.
- Do not ship a real App ID in the template source. Leave `clientId` as `YOUR_APP_ID` in `index.html` until publish time.
- Auth is **optional** in this template. The app must degrade gracefully when unauthenticated — show a login prompt but keep core functionality accessible.
- Do not introduce Lambda or Play SDK dependencies. If the feature requires external API keys, use the `lambda-tool-v1` template instead.
- Preserve the plain Vite + vanilla JS architecture. Do not introduce React, Vue, Tailwind, or framework scaffolding unless the user explicitly requests a framework migration.

## Customization Surface

- All app UI and logic in `src/app.js` (except `viverseAuth.js`, `viverseConfig.js`, `main.js`)
- `index.html` — page title, meta, runtime config block, global styles
- `public/` — static assets, icons, fonts
- `rulesets/` — app behavior parameters
- `package.json` — dependencies (keep Vite + no-framework baseline unless migrating)

## Runtime Config (`index.html`)

```html
window.__APP_CONFIG__ = {
  clientId: "YOUR_APP_ID",       // 10-char App ID — set at publish time
  appName: "My App",
  versionName: "1.0.0",
  adminAccountId: "",            // accountId of admin user — sees admin panel

  poll: {
    question: "What feature would you like to see next?",
    options: ["Option A", "Option B", "Option C", "Option D"],
    leaderboardNames: ["poll-opt-0", "poll-opt-1", "poll-opt-2", "poll-opt-3"]
  }
};
```

- Set `clientId` to the target VIVERSE App ID before publish.
- Set `adminAccountId` to your VIVERSE `account_id` to enable the admin panel.
- `leaderboardNames` must exactly match the API names configured in VIVERSE Studio (see Studio Setup below).

## Studio Setup (Required for Leaderboard Vote Counts)

For each poll option, create one leaderboard in VIVERSE Studio under the target App ID:

| Leaderboard API name | Data type  | Sort direction | Update rule |
|----------------------|------------|----------------|-------------|
| `poll-opt-0`         | Numerical  | Descending     | **Best**    |
| `poll-opt-1`         | Numerical  | Descending     | **Best**    |
| `poll-opt-2`         | Numerical  | Descending     | **Best**    |
| `poll-opt-3`         | Numerical  | Descending     | **Best**    |

**Update rule must be `Best`** — this ensures each authenticated user is counted once per option regardless of repeat votes. Vote count = number of leaderboard entries (each user has score=1).

Steps:
1. Go to https://studio.viverse.com → your app → Upload Content → SDK Settings
2. Click "Add New Leaderboard" for each option
3. Set API name exactly as shown above (case-sensitive)
4. Set Data type = Numerical, Sort direction = Descending, Update rule = Best
5. Save and rebuild + republish the app

> If `poll-opt-0` through `poll-opt-3` are not configured in Studio, vote counts will show 0. Auth and voting still work — only the count display is affected.

## Storage SDK — User Vote Persistence

The poll uses `viverse.storage` → `cloudSaveClient` to save each user's voted option to the cloud under the key `poll-vote`. This persists across devices and sessions.

- Falls back to `localStorage` silently if the Storage SDK is unavailable.
- Only available to authenticated users.
- No Studio configuration required for Storage SDK.

## Admin Panel

The admin panel is visible only to the user whose `accountId` matches `adminAccountId` in `__APP_CONFIG__`. It shows:

- Live vote counts per option (fetched from leaderboard)
- Percentage bars
- Total vote count
- Refresh button

To enable: set `adminAccountId` to your VIVERSE account ID. Find your `account_id` from the auth profile after login (`authState.profile.accountId`).

To reset votes: leaderboard entries cannot be deleted via the SDK. Use VIVERSE Studio to manage leaderboard data directly.

## Mobile / iframe Checklist

- [ ] Root element uses `min-height: 100dvh` not `height: 100vh`
- [ ] Touch targets are at least 44×44px
- [ ] No hover-only interactions
- [ ] Content is readable at 375px viewport width
- [ ] App does not break when `window.viverse` is absent
- [ ] Login prompt shown but app still functional when unauthenticated

## Publish Checklist

- [ ] `clientId` in `index.html` set to real App ID
- [ ] `adminAccountId` set (optional)
- [ ] Leaderboards created in Studio with exact API names and `Best` update rule
- [ ] `npm run build` passes clean
- [ ] `viverse-cli app publish dist --app-id <id>` succeeds
- [ ] Auth flow and vote submission verified in preview
