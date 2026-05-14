# TankArena 3D VIVERSE Integration Plan

Date: 2026-04-15  
Prototype root: `/Users/casper_wang/Projects/AI/viverse-ai-agent/template-sources/tankarena-3d/app`  
Current test app:
- App ID: `rh2vu2k3yu`
- Preview: `https://worlds.viverse.com/9G2QHUb?preview`

## Purpose

Turn the current isolated 3D tank prototype into a VIVERSE-ready game by integrating:

1. VIVERSE auth
2. leaderboard
3. multiplayer
4. publish/release validation

Only after those pass in a real published prototype should this be extracted into a new reusable template.

This plan is based on the current skill guidance in:
- `viverse-auth`
- `viverse-leaderboard`
- `viverse-multiplayer`
- `viverse-template-generation`
- `viverse-world-publishing`

## Non-Negotiable Rules From Skills

### Auth

1. Wait 1200ms after SDK detection before first `checkAuth()`.
2. Use auth domain `account.htcvive.com`.
3. Use a single auth service as the source of truth.
4. Resolve App ID robustly:
   - valid configured App ID first
   - preview-hostname fallback second
5. Do not render raw `account_id` as display name.
6. Run profile fallback order correctly:
   - Avatar SDK
   - `getUserInfo()`
   - `getUser()`
   - `getProfileByToken()`
   - direct API fallback if still needed
7. Keep auth bootstrap one-shot; do not re-run it due to UI churn.

### Leaderboard

1. Use `gameDashboard` / `GameDashboard`, not `sdk.leaderboard`.
2. Use the same App ID authority as auth and publish.
3. Treat Studio leaderboard setup as mandatory operator work.
4. Make score submit idempotent per match result.
5. Keep leaderboard UI collapsible so it does not cover gameplay.

### Multiplayer

1. Use `playClient.newMatchmakingClient(appId)`.
2. Connect matchmaking explicitly and wait with timeout.
3. Call `setActor()` after connect with unique per-session `session_id`.
4. Discover rooms first, then join by real room ID.
5. Keep room lifecycle actions explicit:
   - create
   - join
   - leave
6. Make the host authoritative for gameplay-critical state.
7. Do not let non-host clients directly publish canonical gameplay state.
8. Add late-join recovery up front.

### Template / Publishing

1. Prototype first, template second.
2. Maintain one App ID authority for the run.
3. Rebuild before publish when App ID-related code changes.
4. Do not treat shell load as runtime pass.
5. Preserve startup/bootstrap integrity when template extraction begins.

## Current Prototype State

Implemented:
- local 3D arena
- fixed camera
- visible walls and basic combat
- classic tank-drive controls
- independent turret control
- thin VIVERSE auth bootstrap shell
- repeated publish loop using one App ID

Not yet production-ready:
- auth profile fallback chain is incomplete compared with skill requirements
- leaderboard not implemented
- multiplayer not implemented
- score/result idempotency not implemented
- room lifecycle UI not implemented
- release verification gates not yet formalized for this prototype

## Architecture Target

Keep gameplay core isolated from VIVERSE adapters.

### Core gameplay modules

- `src/game/Arena.js`
- `src/game/Tank.js`
- `src/game/ProjectileSystem.js`
- `src/game/GameState.js`

### Adapter / service modules

- `src/viverseConfig.js`
- `src/viverseAuth.js`
- `src/viverseLeaderboard.js` (new)
- `src/viverseMultiplayer.js` (new)
- `src/game/SyncManager.js` or `src/net/SyncManager.js` (new)

### UI / operator surface

- `src/ui/createHud.js`
- optional `src/ui/LeaderboardPanel.js` (new)
- optional `src/ui/RoomPanel.js` (new)

Rule:
- gameplay modules must not directly depend on raw VIVERSE SDK globals
- adapters may call into gameplay through explicit methods/events only

## Phase Plan

## Phase 0: Freeze Gameplay Baseline

Goal:
- stop changing core controls/camera every time VIVERSE integration is added

Tasks:
1. Keep the current control model:
   - `W/S`: drive
   - `A/D`: hull rotate
   - arrow keys or `J/L`: turret rotate
   - mouse/touch: explicit pointer aiming
   - `Space` / click: fire
2. Add a small internal gameplay checklist:
   - player can move
   - turret heading persists
   - bullets leave the barrel direction
   - bot can hit player
   - round ends and restarts
3. Add one build tag/version marker in HUD or console.

Exit criteria:
- prototype loop is stable enough that new bugs are integration bugs, not baseline gameplay drift

## Phase 1: Auth Hardening

Goal:
- make auth production-safe and skill-compliant without entangling gameplay

Primary files:
- `src/viverseConfig.js`
- `src/viverseAuth.js`
- `src/main.js`
- `src/ui/createHud.js`

Implementation:
1. Add SDK detection fallback for:
   - `window.viverse`
   - `window.VIVERSE_SDK`
   - `window.vSdk`
2. Keep 1200ms post-detection handshake delay.
3. Keep one-shot bootstrap guard.
4. Upgrade profile fetch path to skill-compliant order:
   - Avatar SDK
   - `client.getUserInfo()`
   - `client.getUser()`
   - `client.getProfileByToken(token)`
   - direct API fallback when allowed
5. Prevent downgrade to generic placeholder names.
6. Keep local play available even when auth fails or App ID is absent.
7. Add explicit login button in HUD when guest.

Exit criteria:
- published preview shows correct identity when authenticated
- guest fallback is clean
- auth failure does not block local play

## Phase 2: Leaderboard Integration

Goal:
- persist and display match outcomes before touching multiplayer

Primary files:
- `src/viverseLeaderboard.js` (new)
- `src/ui/createHud.js`
- `src/main.js`
- `src/viverseConfig.js`

Environment/config:
- add `leaderboardName` to runtime config
- optionally move toward `window.__TANKARENA_CONFIG__.leaderboardName`

Implementation:
1. Initialize dashboard client only after auth token is present.
2. Use:
   - `gameDashboard` / `GameDashboard`
   - `uploadLeaderboardScore()`
   - `getLeaderboard()`
3. Start with one metric:
   - `tankarena-wins`
4. Add result-key idempotency:
   - one upload per finished round result
5. Add collapsible leaderboard launcher in HUD.
6. Fetch top scores on demand and after successful submit.
7. Show:
   - loading
   - empty
   - error
   - top 10

Operator reminder required:
1. Create leaderboard in VIVERSE Studio under App ID `rh2vu2k3yu`
2. API name must exactly match configured leaderboard name
3. Type must be `Numerical`
4. Sort direction should be `Descending`
5. Update rule should match scoring model, likely `Append` or `Best`

Exit criteria:
- authenticated player can finish a round and upload one score
- leaderboard fetch returns rows
- leaderboard panel does not block active gameplay

## Phase 3: Multiplayer Bootstrap

Goal:
- establish room lifecycle first, before synchronizing full combat

Primary files:
- `src/viverseMultiplayer.js` (new)
- `src/main.js`
- `src/ui/createHud.js`

Implementation:
1. Load Play SDK in the app shell if not already present.
2. Create matchmaking client with the active App ID.
3. Connect explicitly with timeout.
4. Generate unique per-connect `session_id`.
5. Run `setActor()` after connect.
6. Implement manual controls:
   - create room
   - list rooms
   - join room
   - leave room
7. Gate start match by player count.
8. Keep local single-player fallback usable when no room exists.

UI requirements:
- room panel must be explicit
- auto-match may be added later, but manual controls stay

Exit criteria:
- two users can create/join/leave a room repeatedly
- no stale-room trapping between tests

## Phase 4: Multiplayer Sync Foundation

Goal:
- synchronize transforms and match state safely

Primary files:
- `src/viverseMultiplayer.js`
- `src/game/SyncManager.js` or `src/net/SyncManager.js`
- `src/main.js`

Authority model:
- host authoritative for:
  - HP
  - hits
  - round timer
  - winner/result
- clients own:
  - local input
  - local requested actions
- non-host sends intent; host resolves and broadcasts canonical state

Implementation:
1. Initialize `MultiplayerClient` with validated `roomId`.
2. Enable `general` module.
3. Add protocol message types:
   - `INPUT`
   - `STATE_SYNC`
   - `FIRE`
   - `REQUEST_STATE`
   - `ROUND_END`
4. Implement late-join recovery:
   - host sends canonical state on request
5. Keep first sync step narrow:
   - remote transform
   - turret angle
   - active round state

Exit criteria:
- remote tank motion is visible
- remote turret rotation is visible
- room start and end state are shared reliably

## Phase 5: Host-Authoritative Combat

Goal:
- make combat fair and deterministic enough for two-player testing

Primary files:
- `src/game/ProjectileSystem.js`
- `src/game/GameState.js`
- `src/viverseMultiplayer.js`
- `src/game/SyncManager.js` or `src/net/SyncManager.js`

Implementation:
1. Host resolves shot validity and hit results.
2. Non-host sends fire intent, not direct damage.
3. Host publishes canonical damage/state updates.
4. Keep one complete result write per round end.
5. Ensure rematch resets local and network state cleanly.

Exit criteria:
- bot mode can be disabled in multiplayer
- two users can hit each other and see consistent HP
- end-of-round result agrees on both clients

## Phase 6: Publish and Runtime Verification

Goal:
- convert the prototype into a reliable published app, not just a working local build

Primary files:
- `src/viverseConfig.js`
- `index.html`
- build output in `dist/`

Implementation:
1. Keep one App ID authority:
   - `rh2vu2k3yu` for this prototype track
2. Rebuild before each publish if runtime config changes.
3. Verify App ID appears in `dist/` after build.
4. Publish to the same app while prototype stabilizes.
5. Keep a runtime test log after every publish:
   - auth pass/fail
   - leaderboard pass/fail
   - room join/create pass/fail
   - combat sync pass/fail
   - mobile UI pass/fail

Exit criteria:
- published preview is the primary truth source for runtime validation
- no release decision is made from local-only testing

## Phase 7: Template Extraction

Goal:
- turn the stabilized prototype into a reusable template only after runtime proof

Target:
- new template candidate, likely `tankarena-3d-v1`

Template structure target:
- immutable:
  - engine/camera/input bootstrap
  - auth bootstrap
  - multiplayer lifecycle
  - publish wiring
- editable:
  - arena layout
  - tank stats
  - weapons
  - bot tuning
  - HUD theme
  - leaderboard labels

Required template artifacts:
1. `template.json`
2. `TEMPLATE.md`
3. scenario schema
4. default ruleset
5. certification rules
6. template-specific compliance paths for:
   - auth
   - leaderboard
   - multiplayer
   - startup

Exit criteria:
- prototype runtime behavior is already proven before templating
- template extraction is mostly packaging and enforcement, not game rescue

## File-Level Work Breakdown

### Existing files to evolve

- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/index.html`
- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/main.js`
- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/viverseConfig.js`
- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/viverseAuth.js`
- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/game/Arena.js`
- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/game/Tank.js`
- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/game/ProjectileSystem.js`
- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/game/GameState.js`
- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/ui/createHud.js`

### New files expected

- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/viverseLeaderboard.js`
- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/viverseMultiplayer.js`
- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/game/SyncManager.js` or `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/net/SyncManager.js`
- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/ui/LeaderboardPanel.js`
- `/Users/casper_wang/Projects/AI/viverse-ai-agent/game-source/tankarena-3d-prototype/src/ui/RoomPanel.js`

## Risks

1. Mixing gameplay tuning and VIVERSE integration in the same changeset.
2. Letting multiplayer logic leak into gameplay classes.
3. Failing to keep App ID, leaderboard name, and Studio config aligned.
4. Treating local success as publish success.
5. Adding auto-match too early and losing room lifecycle visibility during debugging.
6. Letting non-host clients mutate canonical round state.

## Recommended Order of Execution

1. finish auth hardening
2. add leaderboard
3. add manual room lifecycle
4. add remote transform sync
5. add host-authoritative combat sync
6. add publish/runtime checklist
7. extract template

## Definition of Ready for Template Extraction

The prototype is ready to become a template only when all of the following are true:

- local single-player works in published preview
- auth identity works in published preview
- leaderboard submit/fetch works in published preview
- room create/join/leave works for repeated tests
- multiplayer combat reaches clean round completion
- mobile viewport remains readable
- no known App ID propagation drift
- all required operator Studio steps are documented and reproducible

## Immediate Next Slice

Start with:
- Phase 1 auth hardening
- Phase 2 leaderboard integration

Reason:
- both are skill-defined
- both are cheaper than multiplayer
- both reduce later debugging ambiguity
