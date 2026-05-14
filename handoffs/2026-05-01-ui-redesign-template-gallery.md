# Handoff: UI Redesign + Template Gallery + Demo Deployment
**Date:** 2026-05-01  
**Status:** ✅ COMPLETE (deployed 2026-05-02)  
**Scope:** `viverse-ai-agent` — `public/` UI, `templates/registry.json`, `scripts/`, `src/services/templates/`

---

## Goal

Turn the dashboard from a single chat + collapsing iframe into a **split layout** where the user can play a live Viverse game on the right while chatting with the agent on the left. Changes requested to the AI agent to the game should be immediately visible without leaving the UI.

---

## Final Layout

```
┌──────────────────────────┬──────────────────────────────────────────────────┐
│  SIDEBAR  (resizable)    │  GAME PANEL  (flex: 1)                           │
│  width: CSS var          │                                                  │
│  min 220px / max 480px   │  ┌────────────────────────────────────────────┐  │
│  ──────────────────────  │  │  TEMPLATE GALLERY  (horiz scroll, 160px)   │  │
│  Logo                    │  │  [ Card ]  [ Card ]  [ Card ]  [ Card ]…   │  │
│  Nav                     │  └────────────────────────────────────────────┘  │
│  Account panel           │                                                  │
│  Template <select>       │  ┌────────────────────────────────────────────┐  │
│  (compact, quick-pick)   │  │  Game iframe  OR  Branded placeholder      │  │
│  Status badge            │  │  (VIVERSE logo + "Select a template"       │  │
│  ──── drag resize ────   │  │   to preview text)                         │  │
│                          │  └────────────────────────────────────────────┘  │
│  CHAT SECTION            │                                                  │
│  ──────────────────────  │  Game panel header bar:                          │
│  Agent header (compact)  │  [App title]  [⟳ Reload]  [↗ Open in new tab]   │
│  Chat messages           │                                                  │
│  (scrollable, flex:1)    │                                                  │
│  Run console             │                                                  │
│  (collapsible strip)     │                                                  │
│  Chat input + send btn   │                                                  │
└──────────────────────────┴──────────────────────────────────────────────────┘
```

Key layout decisions confirmed by user:
- Chat moves into the **sidebar bottom section** (not a separate center panel)
- Sidebar is **resizable** via drag handle on its right edge
- Game panel is **always visible** (no collapse) and takes all remaining width
- Template gallery lives at the **top of the game panel** as a horizontal scroll strip
- Run Console stays **inside the sidebar chat section**, collapsible, default collapsed

---

## Phase 0 — Intent Classifier (Foundation for Fast Edits)

### Problem

Every request currently funnels into the full harness: Architect → auth_preflight → app create → logic → publish → reviewer → verifier. For a "change the player speed" edit this costs 5–15 min and 6–7 task hops. The harness is correct for new apps, wrong for iterations.

### Classifier Design

**Input signals (cheap to collect, no extra LLM call required):**

| Signal | Where to read |
|---|---|
| Chat history contains `FINAL_PREVIEW_URL:` | `history` array passed into `processRequest` |
| A workspace was found by `_pickWorkspace` | `best.state` is non-null before planning |
| `best.state.runtimeFlags.appIdAuthority.value` is a valid 10-char App ID | existing auth already completed |
| User message starts with "create / build / make / start a new …" | regex on `message` |
| User message contains change / update / fix / add … to the existing game | regex on `message` |
| User message targets visual-only things: color, theme, font, background, speed, size, image | regex on `message` |

**Classification rules (precedence top → bottom):**

```
1. If NO prior workspace found AND message matches new-game keywords → new_app
2. If prior workspace found AND appIdAuthority is valid AND message is visual-only → asset_iteration
3. If prior workspace found AND appIdAuthority is valid → logic_iteration
4. Default (any ambiguity) → new_app  (safest fallback)
```

**Modes:**

| Mode | What it means | Tasks in plan |
|---|---|---|
| `new_app` | Starting a different/first app | Full harness: Architect → auth → logic → publish → reviewer → verifier |
| `logic_iteration` | Changing game rules / adding features / fixing bugs in existing app | Skip Architect + auth_preflight + app create; reuse `appIdAuthority`; tasks: coder_logic → coder_publish → reviewer → verifier |
| `asset_iteration` | Visual-only tweak (colors, labels, speeds, images) in existing app | Skip Architect + auth + planning; tasks: coder_asset (edit source files) → coder_publish → verifier only |

### Hook Location in `OrchestratorService.js`

Insert the classifier **after the `_pickWorkspace` call (~line 3770) and before the `if (!state)` planning gate (~line 3839)**.

```js
// ── INTENT CLASSIFIER (Phase 0) ──────────────────────────────────────────
const _iterMode = this._classifyRequestIntent(message, { workspaceState: state });
// _iterMode: 'new_app' | 'logic_iteration' | 'asset_iteration'
// Use it below to short-circuit the planning path when appropriate
// ─────────────────────────────────────────────────────────────────────────
```

### `_classifyRequestIntent(message, { workspaceState })` — new private method

```js
_classifyRequestIntent(message = '', { workspaceState = null } = {}) {
    const text = String(message || '').toLowerCase().trim();
    const hasExistingWorkspace = !!workspaceState;
    const hasValidAppId = this._isValidAppId(
        String(workspaceState?.runtimeFlags?.appIdAuthority?.value || '')
    );

    // Explicit new-game qualifiers: "a new game", "a different app", "start fresh", "from scratch"
    const isExplicitlyNewGame = /\b(new|different|another|fresh)\b.*\b(game|app|demo|project)\b/.test(text)
        || /\b(start fresh|from scratch|new project)\b/.test(text);
    // Bare create-verb without explicit newness qualifier ("make the game faster" still matches this)
    const isCreateVerb = /\b(create|build|make|start|generate)\b.*\b(game|app|demo|project)\b/.test(text);
    const isIterationRequest = /\b(change|update|fix|add|remove|tweak|adjust|increase|decrease|improve)\b/.test(text);
    const isVisualOnlyRequest = /\b(color|colour|theme|font|background|speed|size|scale|image|icon|logo|label|text)\b/.test(text)
        && !/\b(logic|rule|score|mechanic|gameplay|ai|opponent|multiplayer)\b/.test(text);

    // No workspace → always new app
    if (!hasExistingWorkspace) return 'new_app';
    // Explicit "new / different / another" signal overrides existing workspace context
    if (isExplicitlyNewGame) return 'new_app';
    // Iteration signals take priority over bare create-verb when workspace + appId exist
    if (hasValidAppId && isVisualOnlyRequest) return 'asset_iteration';
    if (hasValidAppId && isIterationRequest) return 'logic_iteration';
    // Bare create-verb with workspace but no valid appId yet → treat as new app
    if (isCreateVerb && !hasValidAppId) return 'new_app';
    return 'new_app'; // safe default
}
```

### Routing changes per mode

**`logic_iteration`** — in `processRequest`, after classifier runs and `_iterMode === 'logic_iteration'`:
- Skip the full plan LLM call; inject a fixed 4-task plan directly:
  ```js
  plan = {
      isNewProject: false,
      tasks: [
          { id: 'coder_logic', role: 'Coder', prompt: `Logic-only edit. Request: "${message}". Reuse App ID ${appId}. Edit source files in allowed editablePaths only. Do NOT run viverse-cli app create.`, dependsOn: [] },
          { id: 'coder_publish', role: 'Coder', prompt: 'Rebuild and republish with existing App ID. Steps: (1) npm run build, (2) viverse-cli app publish dist --app-id <AppId>.', dependsOn: ['coder_logic'] },
          { id: 'task_reviewer', role: 'Reviewer', prompt: '...standard reviewer prompt...', dependsOn: ['coder_publish'] },
          { id: 'task_verifier', role: 'Verifier', prompt: '...standard verifier prompt...', dependsOn: ['task_reviewer'] }
      ]
  };
  ```
- Set `state.runtimeFlags.requestScope.primary = 'gameplay'`
- Bypass both the LLM planner **and** `_enforceWorkflowTasks` entirely — inject the fixed task array directly into `state.plan.tasks` before `_enforceWorkflowTasks` runs. `_enforceWorkflowTasks` signature: `(tasks, { skipWorkflowExpansion = false })` — if downstream compatibility requires calling it, pass `{ skipWorkflowExpansion: true }` to suppress task injection.

**`asset_iteration`** — same as `logic_iteration` but also skip reviewer; plan is 3 tasks:
  - `coder_asset` (edit files, no build), `coder_publish`, `task_verifier`
  - Set `state.runtimeFlags.requestScope = { primary: 'ui', allowedSubsystems: ['ui', 'assets'] }`

**`new_app`** — no change; existing pipeline runs as today.

### Classification signals cheat-sheet

```
EXPLICIT NEW APP:  "create a new game", "build a different app", "start fresh", "from scratch"
LOGIC ITER:        "change the rules", "add a power-up", "fix the score", "add multiplayer"
ASSET ITER:        "change the color", "make the background blue", "update the image"
BARE CREATE-VERB:  "create a game" with no existing workspace → new_app
                   "make the game faster" with valid workspace + appId → asset_iteration (visual)
AMBIGUOUS:         always new_app (safest)
```

### Files to create/modify for Phase 0

| File | Change |
|---|---|
| `src/services/OrchestratorService.js` | ADD `_classifyRequestIntent()` method; ADD classifier call + routing branch in `processRequest` after `_pickWorkspace` (~line 3770), before planning gate (~line 3839) |

### Testing Phase 0

1. With no existing workspace: any message → `new_app` (full harness, no change in behavior)
2. With existing workspace, valid appId, message = "change the player speed to 8": → `asset_iteration`, verifies 3-task plan
3. With existing workspace, valid appId, message = "add a second lane": → `logic_iteration`, verifies 4-task plan, no auth_preflight
4. With existing workspace, message = "create a different game": → `new_app` (isNewGameRequest=true)

---

## Phase 1 — Template Demo Deployment

### Which templates get demo apps

| Template ID | Deploy? | `demoPlayLink` | `demoAppId` | Notes |
|---|---|---|---|---|
| `dashrunner-v1` | ✅ Yes | `https://worlds.viverse.com/ejxyg8K` | `gpszgk2rug` | Vite build, env-var App ID injection |
| `flow-line-v1` | ✅ Yes | `https://worlds.viverse.com/Wy3mp9J` | `yempr9y8p5` | Static copy + sed `YOUR_APP_ID` |
| `redpointfish-v1` | ✅ Yes | `https://worlds.viverse.com/sykM5Ku` | `7ptjddhecm` | Vite build, env-var App ID injection |
| `starter-kit-racing-v1` | ✅ Yes | `https://worlds.viverse.com/txD5e6K` | `2z3zhuvzr7` | Fully static, sed `clientId: ''` |
| `tankarena-3d-v1` | ✅ Yes | `https://worlds.viverse.com/fCJtBxZ` | `n662tybnvh` | npm build + post-build sed on dist/ |
| `blank-webapp-v1` | ❌ No deploy | `null` — by design | `null` | Utility, `cta: "utility"` |
| `lambda-tool-v1` | ❌ No deploy | `null` — by design | `null` | Utility, `cta: "utility"` |
| `battletanks-v1` | 🚫 Abandoned | — | — | No source; excluded from gallery |
| `viverse-multiplayer-runner` | 🚫 Retired | — | — | Backported to dashrunner-v1 (2026-05-01) |

> **Run status:** ✅ 5 / 5 game templates deployed (2026-05-02). `registry.json` and `/api/ai/templates` both return live `demoPlayLink` + `demoAppId` for all 5 game templates.

### Step 1.1 — `scripts/publish-template-demos.mjs` (NEW FILE)

Standalone Node script, no LLM loop:
1. Reads `templates/registry.json`; skips any template that already has `demoPlayLink` set (idempotent). Pass `--force <templateId>` (e.g. `node scripts/publish-template-demos.mjs --force dashrunner-v1`) to force re-deployment of a specific template regardless of existing `demoPlayLink`.
2. Accepts `--email` / `--password` CLI flags; falls back to `.env` `VIVERSE_EMAIL` / `VIVERSE_PASSWORD`
3. For each game template, copies the template folder to a temp dir, then applies the per-template strategy below
4. For all templates: `viverse-cli auth login -e <email> -p <password>`, then `viverse-cli app create --name "Demo-<template-id>"` — captures the 10-char App ID from stdout
5. Publishes and captures the resulting `worlds.viverse.com/…` URL
6. Writes `demoPlayLink` and `demoAppId` back into `templates/registry.json`
7. Logs per-template progress; on error, logs and continues to the next template

**Per-template build + App ID injection strategy:**

| Template | Build | App ID injection | Publish dir |
|---|---|---|---|
| `dashrunner-v1` | `npm ci && npm run build` with `VITE_VIVERSE_CLIENT_ID=<AppId>` env var set before build | Env var baked in by Vite — no sed needed | `dist/` |
| `flow-line-v1` | Run `buildConfig.command` from `template.json` (static `cp` to `dist/`) | `sed -i "" "s/YOUR_APP_ID/<AppId>/g" dist/index.html` | `dist/` |
| `redpointfish-v1` | `npm ci && npm run build` with `VITE_VIVERSE_CLIENT_ID=<AppId>` env var set before build | Env var baked in by Vite — no sed needed | `dist/` |
| `starter-kit-racing-v1` | **No build** — template is fully static | `sed -i "" "s/clientId: ''/clientId: '<AppId>'/" index.html` in temp dir | publish entire temp dir |
| `tankarena-3d-v1` | `npm ci && npm run build` | `find dist/ \( -name "*.json" -o -name "*.html" \) -exec sed -i "" "s/YOUR_APP_ID/<AppId>/g" {} +` | `dist/` |

**Script logic for App ID injection detection** (auto-detects which strategy to use):
- If `template.json` has `buildConfig` → use `buildConfig.command` (static copy), then sed `YOUR_APP_ID`
- Else if `package.json` exists and `scripts.build` uses Vite → run `VITE_VIVERSE_CLIENT_ID=<AppId> npm run build`
- Else (no package.json, no buildConfig) → no build; sed `clientId: ''` → `clientId: '<AppId>'` in `index.html`

**Prerequisite:** `viverse-cli` must be available. The script auto-detects it via `which viverse-cli` (macOS/Linux) or `where viverse-cli` (Windows); falls back to checking `/opt/homebrew/bin`, `/usr/local/bin`, and `~/.npm-global/bin`. Exits immediately with a descriptive error if not found in any location. `node_modules` for Vite templates will be installed fresh in temp dir via `npm ci`.

### Step 1.2 — `src/services/templates/TemplateRegistryService.js`

In `_normalizeTemplateRecord`, pass through four new optional fields:
- `demoPlayLink` — string URL or `null`
- `demoAppId` — string or `null`
- `cta` — string (`"utility"`) or `undefined`
- `utilityCtaExamples` — `string[]` or `undefined` — example prompt chips shown on utility gallery cards

These surface automatically in the `/api/ai/templates` response once added to the record.

**Add to `templates/registry.json`** for utility templates (keeps prompt chips data-driven, not hardcoded in JS):
- `blank-webapp-v1`: `"utilityCtaExamples": ["Build a countdown timer", "Create a poll widget", "Make a score tracker"]`
- `lambda-tool-v1`: `"utilityCtaExamples": ["Build a live weather widget", "Create an AI chat tool", "Make a news ticker"]`

---

## Phase 2 — UI Layout Redesign

### Step 2.1 — `public/index.html`

**Structural changes:**

1. Remove `<div class="template-sidebar-section">` from sidebar (the full dropdown panel block)
2. Add a compact template quick-pick row in sidebar top: one `<select id="template-select">` + one `<button id="template-generate-btn">Insert</button>` — single-row, compact styling
3. Add `<div class="sidebar-resize-handle"></div>` as the last child of `.sidebar`
4. Move all chat elements out of `<main>` into a new `.chat-section` div inside `.sidebar`:
   - Compact agent header (32px avatar, name, status)
   - `#chat-messages`
   - `#run-console` (collapsible strip)
   - `.chat-input-area` (attachments, input, send)
5. Restructure `<main id="main-content">` to just contain the game panel:
   - `.game-panel-header` (title, reload btn, open-external btn, close btn)
   - `.template-gallery` (horizontal scroll row of cards)
   - `.game-frame-wrap` containing `#world-iframe` and `.game-placeholder` overlay

Remove: `#lower-preview`, `.preview-header`, the collapse/expand preview logic entirely.

### Step 2.2 — `public/styles.css`

**New/changed rules:**

```css
/* Layout */
.app-wrapper         { display: flex; height: 100vh; overflow: hidden; }
.sidebar             { width: var(--sidebar-width, 280px); min-width: 220px; max-width: 480px;
                       display: flex; flex-direction: column; position: relative; }
.sidebar-top         { flex: 0 0 auto; padding: 24px 24px 16px; }
.sidebar-resize-handle { position: absolute; right: 0; top: 0; bottom: 0; width: 5px;
                         cursor: col-resize; z-index: 10;
                         transition: background 0.15s; }
.sidebar-resize-handle:hover { background: rgba(0,132,255,0.4); }
.chat-section        { flex: 1; display: flex; flex-direction: column; min-height: 0;
                       border-top: 1px solid var(--glass-border); }

/* Chat (compact for sidebar) */
.chat-header-compact { padding: 12px 16px; border-bottom: 1px solid var(--glass-border); }
.agent-avatar        { width: 32px; height: 32px; } /* reduced from 44px */
.chat-messages       { flex: 1; overflow-y: auto; padding: 16px; gap: 16px; } /* reduced from 40px */
.message-bubble      { max-width: 100%; } /* was 80% */
.chat-input-area     { padding: 10px 12px 14px; }
#user-input          { max-height: 120px; } /* reduced from 200px */

/* Game panel */
.game-panel          { flex: 1; display: flex; flex-direction: column; min-width: 0;
                       background: var(--bg-dark); }
.game-panel-header   { flex: 0 0 auto; display: flex; align-items: center;
                       padding: 10px 20px; border-bottom: 1px solid var(--glass-border);
                       background: rgba(13,17,23,0.95); backdrop-filter: blur(10px); }

/* Template gallery */
.template-gallery    { flex: 0 0 auto; height: 160px; display: flex; align-items: center;
                       gap: 12px; padding: 12px 16px; overflow-x: auto;
                       border-bottom: 1px solid var(--glass-border); }
.template-gallery::-webkit-scrollbar { height: 4px; }
.template-card       { width: 180px; flex-shrink: 0; border-radius: 16px;
                       background: var(--glass-bg); border: 1px solid var(--glass-border);
                       padding: 14px; display: flex; flex-direction: column; gap: 8px;
                       transition: border-color 0.2s; }
.template-card:hover { border-color: rgba(0,132,255,0.4); }
.template-card-name  { font-size: 13px; font-weight: 600; }
.genre-badge         { font-size: 10px; padding: 3px 8px; border-radius: 999px;
                       text-transform: uppercase; letter-spacing: 0.8px; }
/* genre colors (case-insensitive, full registry genre name as key):
   'puzzle'=#7c3aed  'endless runner'=#0084ff  'arcade racing'=#f59e0b
   'card strategy'=#10b981  'arcade action'=#ef4444  'utility'=#64748b */
/* JS lookup: const GENRE_COLORS = { 'puzzle':'#7c3aed', 'endless runner':'#0084ff',
   'arcade racing':'#f59e0b', 'card strategy':'#10b981', 'arcade action':'#ef4444',
   'utility':'#64748b' }; use genre.toLowerCase() as key */
.template-card-desc  { font-size: 11px; color: var(--text-secondary); 
                       overflow: hidden; display: -webkit-box;
                       -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.card-actions        { display: flex; gap: 6px; margin-top: auto; }
.card-play-btn       { flex: 1; background: var(--accent); border: none; border-radius: 8px;
                       color: #fff; font-size: 11px; padding: 6px 0; cursor: pointer; }
.card-use-btn        { flex: 1; background: transparent; border: 1px solid var(--glass-border);
                       border-radius: 8px; color: var(--text-secondary); font-size: 11px;
                       padding: 6px 0; cursor: pointer; }
.card-play-btn:disabled { opacity: 0.35; cursor: default; }

/* Utility card CTA */
.utility-prompt-chip { font-size: 10px; padding: 4px 8px; border-radius: 8px;
                       background: rgba(255,255,255,0.05); border: 1px solid var(--glass-border);
                       color: var(--text-secondary); cursor: pointer; }
.utility-prompt-chip:hover { background: rgba(0,132,255,0.1); border-color: rgba(0,132,255,0.4); color: #fff; }

/* Game frame */
.game-frame-wrap     { flex: 1; position: relative; }
#world-iframe        { width: 100%; height: 100%; border: none; }

/* Branded placeholder */
.game-placeholder    { position: absolute; inset: 0; display: flex; flex-direction: column;
                       align-items: center; justify-content: center; gap: 20px;
                       background: var(--bg-dark); }
.game-placeholder-logo { width: 64px; height: 64px; background: var(--accent);
                          border-radius: 16px; box-shadow: 0 0 40px var(--accent-glow); }
.game-placeholder h3 { font-size: 18px; font-weight: 600; }
.game-placeholder p  { font-size: 14px; color: var(--text-secondary); text-align: center;
                       max-width: 280px; line-height: 1.5; }

/* Game loading overlay */
.game-loading-overlay { position: absolute; inset: 0; background: rgba(10,12,16,0.7);
                        display: flex; align-items: center; justify-content: center;
                        backdrop-filter: blur(4px); z-index: 5; }
```

Remove all: `.lower-preview`, `.lower-preview.collapsed`, `.preview-header`, `.preview-content` — these are fully replaced.

### Step 2.3 — `public/app.js` — Template gallery

New `renderTemplateGallery(templates)` function:
- Called once after `loadTemplates()` resolves; renders into `.template-gallery`
- Game templates: **▶ Play** button (calls `openGamePanel(demoPlayLink)`) + **Use** button (inserts `recommendedPrompt` into `#user-input`, focuses input)
- If `demoPlayLink` is null: Play button rendered as disabled with `title="Demo not yet deployed"`
- Utility templates (`cta === 'utility'`): genre badge "Utility", description, 2–3 example prompt chips, **Use** button only (no Play)
  - Chips are **data-driven**: read `(t.utilityCtaExamples || [])` from the template record — defined in `registry.json`, not hardcoded in JS
- Clicking a prompt chip inserts it into `#user-input` (with template context prepended) and focuses input
- Gallery is drag-scrollable on desktop (mousedown → mousemove scroll logic)

### Step 2.4 — `public/app.js` — Game panel logic

Replace `openWorldPreview` / `closeWorldPreview`:

```js
function openGamePanel(url) {
    activeWorldUrl = url;
    const finalUrl = url.includes('?') ? (url.includes('full3d=') ? url : url + '&full3d=') : url + '?full3d=';
    worldIframe.src = finalUrl;
    gamePlaceholder.classList.add('hidden');
    gameLoadingOverlay.classList.remove('hidden');
    gamePanel.querySelector('.game-panel-title').textContent = 'Loading…';
}
worldIframe.addEventListener('load', () => {
    gameLoadingOverlay.classList.add('hidden');
    gamePanel.querySelector('.game-panel-title').textContent = activeWorldUrl ? 'Game Preview' : '';
});

function closeGamePanel() {
    worldIframe.src = 'about:blank';
    activeWorldUrl = '';
    gamePlaceholder.classList.remove('hidden');
    gameLoadingOverlay.classList.add('hidden');
    gamePanel.querySelector('.game-panel-title').textContent = '';
}
```

Reload button: `worldIframe.src = worldIframe.src`  
Open external: `window.open(activeWorldUrl, '_blank')`  
**Close button** — add `<button id="game-panel-close-btn" title="Close">&#x2715;</button>` right-aligned in `.game-panel-header`. Calls `closeGamePanel()`. On mobile (`window.innerWidth < 768`), also adds class `game-panel--collapsed` to `.game-panel` (hides the panel entirely); add `<button id="game-panel-reopen-btn">▶ Game</button>` in the sidebar footer as a toggle to restore it.`

Stream `FINAL_PREVIEW_URL:` detection — the existing implementation intercepts rendered link clicks (app.js ~line 596-603) and is **not** an active stream scan. **Fix required** in Step 2.4: in the text accumulation block (~line 467, after `accumulatedText +=`), add an active scan:

```js
if (!_previewAutoLoaded) {
    const m = accumulatedText.match(/FINAL_PREVIEW_URL:\s*(https?:\/\/\S+)/);
    if (m) { _previewAutoLoaded = true; openGamePanel(m[1]); }
}
```

Declare `let _previewAutoLoaded = false` at the top of the stream handler; reset to `false` at the start of each new request.

Post-run action card in chat (after completed run with a previewUrl):
```html
<div class="run-result-card">
  ✅ Build published
  <a href="..." class="result-url">worlds.viverse.com/xxxxx</a>
  <button class="view-in-panel-btn">View in Panel →</button>
</div>
```
`View in Panel →` calls `openGamePanel(url)`.

### Step 2.5 — `public/app.js` — Sidebar resize

```js
const sidebarResizeHandle = document.querySelector('.sidebar-resize-handle');
const sidebar = document.querySelector('.sidebar');
const SIDEBAR_MIN = 220, SIDEBAR_MAX = 480;
let isResizing = false;

sidebarResizeHandle.addEventListener('pointerdown', (e) => {
    isResizing = true;
    sidebarResizeHandle.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
    if (!isResizing) return;
    const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX));
    document.documentElement.style.setProperty('--sidebar-width', w + 'px');
});
document.addEventListener('pointerup', () => {
    if (!isResizing) return;
    isResizing = false;
    const w = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width');
    localStorage.setItem('viverse_sidebar_width', w.trim());
});

// Restore on load
const saved = localStorage.getItem('viverse_sidebar_width');
if (saved) document.documentElement.style.setProperty('--sidebar-width', saved);
```

### Step 2.6 — Sidebar template quick-pick

The removed `.template-sidebar-section` is replaced with a minimal single-row in `.sidebar-top`:
```html
<div class="template-quick-pick">
  <select id="template-select" class="template-select"></select>
  <button id="template-generate-btn" class="template-generate-btn" type="button">Insert</button>
</div>
```
All `getElementById` references in `app.js` remain the same — element IDs are unchanged, just relocated.

---

## Phase 3 — Live Edit Loop Polish (step 3.1 + 3.2 above in 2.4)

Already covered in Step 2.4:
- `FINAL_PREVIEW_URL` stream event → auto-load in game panel
- Post-run card with "View in Panel →" button
- Loading overlay on game panel during iframe navigation

---

## Template Gap: `viverse-multiplayer-runner` vs `dashrunner-v1`

**`dashrunner-v1` has these files missing from `viverse-multiplayer-runner/app`:**

| File | Lines | What it adds |
|---|---|---|
| `js/game/Game.js` | 655 | Full game loop, post-processing (bloom, curved-world shader, vignette), collectibles, Chaser, BoostSystem, ThemeManager |
| `js/game/Player.js` | 672 | VRM/VRMA avatar state machine, collision box, model load flow |
| `js/game/Opponent.js` | 344 | Remote opponent rendering |
| `js/viverse/ViverseService.js` | 184 | Abstraction over VIVERSE SDK (client, leaderboard) |
| `js/viverse/MultiplayerService.js` | 196 | Room lifecycle abstraction |
| `js/viverseAuth.js` | +130 lines | Timeout helpers, retry, `normalizeProfile`, robust fallback chain |
| `TEMPLATE.md` | — | Agent guardrails |
| `Gameplay.js` | 3 lives system, ThemeManager | — |

**`viverse-multiplayer-runner/app` has these improvements not in `dashrunner-v1`:**

| Feature | Location | Detail |
|---|---|---|
| Sender loopback filtering | `viverseMultiplayer.js` + `Gameplay.js` | Injects `senderId` on `sendMessage`; Gameplay discards own broadcasts |
| Opponent profile sync | `Gameplay.js` | `onPlayersUpdated` hook loads opponent's avatar from `actor.properties.avatarUrl` |
| Lane targeting state | `Gameplay.js` | `this.targetLane` for smoother lane transitions |

**Decision: Option A — DONE (2026-05-01).** All 3 features backported into `dashrunner-v1`. `viverse-multiplayer-runner` is retired and must NOT be added to the registry or gallery.

Backport applied:
- `js/viverseMultiplayer.js` → `broadcast()` now spreads `senderId: this.actorSessionId` into every outbound payload
- `js/game/Gameplay.js` → `onMessageReceived` now guards with `if (data.senderId === this.app.multiplayer.actorSessionId) return;`
- `js/game/Gameplay.js` → new `onPlayersUpdated` callback in `onInject()` — loads opponent avatar from `actor.properties.avatarUrl` when a second player joins
- `js/game/Gameplay.js` → constructor now initialises `this.targetLane = 1`; `onUpdate` syncs `this.targetLane = player.laneIndex` before passing it to `obstacles.update()`

---

## Files to Create / Modify

| File | Change |
|---|---|
| `src/services/OrchestratorService.js` | ADD `_classifyRequestIntent()`; wire in `processRequest` |
| `scripts/publish-template-demos.mjs` | CREATE — demo deploy script |
| `templates/registry.json` | ADD `demoPlayLink`, `demoAppId`, `cta` fields per template; ADD `utilityCtaExamples` for utility templates |
| `src/services/templates/TemplateRegistryService.js` | EDIT — pass through 3 new fields in normalizer |
| `public/index.html` | REWRITE — new 3-section layout |
| `public/styles.css` | EDIT — new layout rules, card styles, remove collapse styles |
| `public/app.js` | EDIT — gallery render, game panel, resize drag, post-run card |

---

## Implementation Order

**Phase 0 — Intent Classifier**
1. Add `_classifyRequestIntent()` to `OrchestratorService.js`
2. Wire classifier call + routing branch in `processRequest` (after `_pickWorkspace` ~line 3770, before planning gate ~line 3839)
3. Unit-test with 4 scenarios above

**Phase 1 — Demo Deployment**
4. `TemplateRegistryService.js` — add field passthrough (2 min, 3 lines)
5. `scripts/publish-template-demos.mjs` — write and test against one template first
6. Run script to populate `registry.json` with `demoPlayLink` values

**Phase 2 — UI**
7. `public/index.html` — restructure layout
8. `public/styles.css` — new layout + card styles
9. `public/app.js` — gallery, resize, game panel, post-run card
10. Smoke test: open dashboard, confirm gallery renders, resize works, clicking Play loads iframe

---

## Notes / Constraints

- `battletanks-v1` has no source — **do not add to registry or gallery**
- `viverse-multiplayer-runner` is **retired** (backport done 2026-05-01) — do not add to registry or gallery
- Demo app IDs and URLs must be written to `registry.json` by the script — do not hardcode in JS
- All existing `getElementById` calls in `app.js` use the same IDs — no rename needed, only relocation in HTML
- The `account-panel` is currently hidden by default (opacity:0) and revealed programmatically — this behavior stays the same
- `#run-console` stays inside the chat section (sidebar bottom), collapsible, default collapsed
- The chat section must `min-height: 0` and `flex: 1` with `overflow: hidden` on the parent so it doesn't overflow the sidebar

---

## Verification

### Phase 0 — Intent Classifier

Test `_classifyRequestIntent(message, { workspaceState })` directly (no server needed):

| # | Message | `workspaceState` | Expected mode | Reason |
|---|---|---|---|---|
| 1 | "create a game" | `null` | `new_app` | No workspace |
| 2 | "change the player speed to 8" | valid state + appId | `asset_iteration` | Visual-only; workspace + appId present |
| 3 | "add a second lane to the track" | valid state + appId | `logic_iteration` | Iteration verb; workspace + appId present |
| 4 | "create a different game" | valid state + appId | `new_app` | `isExplicitlyNewGame` override |
| 5 | "make the game background blue" | valid state + appId | `asset_iteration` | Visual-only keyword (`background`) |
| 6 | "build a new poker game" | valid state + appId | `new_app` | "new" keyword triggers `isExplicitlyNewGame` |

### Phase 1 — Demo Deployment Script

**Pre-condition:** All 5 game templates currently have `demoPlayLink: null` in `registry.json` (run status: 0 / 5).

Run against a single template first:

```sh
node scripts/publish-template-demos.mjs --only flow-line-v1
```

**Pass criteria:**
- Script prints per-template progress with App ID captured from stdout
- `templates/registry.json` updated with `demoPlayLink` and `demoAppId` for `flow-line-v1`
- Re-running the same command (no `--force`) skips the template — idempotent
- `node scripts/publish-template-demos.mjs --force flow-line-v1` re-deploys
- Running on a machine without `viverse-cli` exits with clear error message (not a stack trace)

### Phase 2 — UI Smoke Tests

| Check | Steps | Pass criteria |
|---|---|---|
| Gallery renders | Open dashboard; inspect `.template-gallery` | ≥ 5 game cards + 2 utility cards |
| Genre badges | Inspect badge colours on cards | Each badge colour matches the `GENRE_COLORS` lookup for that genre |
| Utility chips | Inspect chip text on a utility card | Chips match `utilityCtaExamples` values in `registry.json` |
| Chip click | Click a prompt chip | Text inserted into `#user-input`; input focused |
| Sidebar resize | Drag resize handle; reload page | Width persists across page reload (localStorage key present) |
| FINAL_PREVIEW_URL auto-load | Trigger a build run; monitor stream | Game panel auto-loads without requiring a click |
| Manual open | Click "▶ Play" on a gallery card | iframe loads the `demoPlayLink` URL with loading overlay, then hides |
| Close button | Click ✕ in game panel header | iframe clears; branded placeholder shown; `activeWorldUrl` is empty |
| Post-run card | Inspect chat after a completed run with preview URL | "View in Panel →" button visible; clicking it loads iframe |
