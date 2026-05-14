# Template Plan: frontline-runner-v1
**Date:** 2026-04-24  
**Status:** Planning  
**Game reference:** Last War: Survival — Frontline Breakthrough mode  
**Template ID:** `frontline-runner-v1`  

---

## What the Template IS

A **lane-runner zombie shooter** for VIVERSE. Based on Last War's Frontline Breakthrough mechanic — the most viral gameplay loop that drove $2B in revenue. Key insight from research: this is the advertised gameplay that made Last War famous in social media ads.

Core loop:
> **Troops = your HP AND your firepower.** Swipe left/right across lanes. Auto-shoot upward. Break barrels to gain troops. Dodge negative gates. Survive elite bosses. Clear 5 levels.

Different from current zombie defense game in every axis: fixed top-down camera, vertical auto-scroll, lane movement only, auto-fire, squad-based HP.

---

## Template Registry Entry

```json
{
  "id": "frontline-runner-v1",
  "name": "Frontline Runner Template",
  "version": "1.0.0",
  "genre": "Lane Runner",
  "description": "Vertical lane-runner shooter inspired by Last War's Frontline Breakthrough. Auto-scrolling levels, squad-based HP system, lane-swapping controls, weapon pickups, positive/negative gates, and hero skills. VIVERSE auth, per-run leaderboard, and co-op multiplayer.",
  "tags": ["game", "runner", "lane", "threejs", "arcade", "auth", "leaderboard", "multiplayer"],
  "capabilities": ["auth", "leaderboard", "matchmaking", "publish"],
  "templatePath": "templates/frontline-runner-v1",
  "recommendedPrompt": "Create a new lane runner game using template 'frontline-runner-v1'. Preserve auth, leaderboard, and multiplayer wiring while customizing the theme, enemies, hero roster, level configs, and weapon set."
}
```

---

## File Structure

```
templates/frontline-runner-v1/
├── template.json               ← metadata, immutable/editable paths, injection hooks
├── TEMPLATE.md                 ← guardrails, customization surface, app wiring docs
├── README.md                   ← user-facing description
├── scenario.schema.json        ← rulesets schema
├── package.json                ← Vite + Three.js (same as tankarena)
├── index.html                  ← runtime config (clientId: YOUR_APP_ID)
├── rulesets/
│   ├── default.json            ← standard: 5 levels, normal speed, mixed gates
│   ├── easy.json               ← fewer negative gates, slower zombies, more troops
│   └── hard.json               ← dense negative gates, elites every level, boss wave
└── src/
    ├── main.js                 ← IMMUTABLE bootstrap (SDK detect → auth → game init)
    ├── viverseAuth.js          ← IMMUTABLE VIVERSE auth + profile fetch
    ├── viverseConfig.js        ← IMMUTABLE App ID resolution
    ├── viverseLeaderboard.js   ← IMMUTABLE score submit/fetch (per-run score)
    ├── viverseMultiplayer.js   ← IMMUTABLE co-op room lifecycle
    ├── game/
    │   ├── RunnerEngine.js     ← EDITABLE core game loop, lane state, squad HP
    │   ├── ScrollEngine.js     ← EDITABLE vertical scroll, ground tiles, parallax
    │   ├── EnemySystem.js      ← EDITABLE zombie types, spawn patterns, boss logic
    │   ├── GateSystem.js       ← EDITABLE positive/negative gate layout per level
    │   ├── WeaponSystem.js     ← EDITABLE weapon types, pickup logic, auto-fire
    │   ├── HeroSystem.js       ← EDITABLE hero roster, active skills, cooldowns
    │   └── LevelConfig.js      ← EDITABLE 5-level definitions (enemy layout, gates)
    ├── ui/
    │   ├── HUD.js              ← EDITABLE troop count bar, wave indicator, skill cooldown
    │   └── HeroSelect.js       ← EDITABLE hero selection screen before game start
    └── style.css               ← EDITABLE UI theme
```

---

## template.json Design

```json
{
  "id": "frontline-runner-v1",
  "version": "1.0.0",
  "upstream": {
    "sourceType": "internal",
    "sourceRoot": "template-sources/frontline-runner/app"
  },
  "capabilities": ["auth", "leaderboard", "matchmaking", "publish"],
  "immutablePaths": [
    "package.json",
    "src/viverseAuth.js",
    "src/viverseConfig.js",
    "src/viverseLeaderboard.js",
    "src/viverseMultiplayer.js",
    "src/main.js"
  ],
  "editablePaths": [
    "index.html",
    "src/game/**",
    "src/ui/**",
    "src/style.css",
    "rulesets/**",
    "README.md",
    "TEMPLATE.md",
    "scenario.schema.json"
  ],
  "appIdPropagation": {
    "strategy": "runtime-config-or-hostname",
    "approvedConfigFiles": ["index.html", "src/viverseConfig.js"]
  },
  "compliancePaths": {
    "authFiles": ["src/viverseAuth.js", "src/viverseConfig.js"],
    "matchmakingHooks": ["src/viverseMultiplayer.js"],
    "startupFiles": ["index.html", "src/main.js"]
  },
  "authPreflightMode": "verify_only",
  "requiredGates": ["build.app_id_propagation"],
  "enforcement": { "defaultMode": "enforce" }
}
```

---

## Game Architecture

### Core State Model

```js
// RunnerEngine.js
state = {
  phase: 'hero-select' | 'level-intro' | 'running' | 'level-complete' | 'game-over',
  level: 1,          // 1-5
  troops: 20,        // HP + firepower
  maxTroops: 20,
  hero: null,        // selected hero object
  weapon: 'pistol',  // current weapon type
  weaponTimer: 0,    // remaining seconds on weapon pickup
  score: 0,          // troops remaining × level multiplier at end
  laneX: 1,          // 0=left, 1=center, 2=right (3-lane)
  scrollY: 0,        // how far through current level
  enemies: [],       // active enemy objects
  gates: [],         // active gate objects
  bullets: [],       // active bullet objects
  pickups: []        // barrels and weapon crates
}
```

### Lane System

```
Lane 0 (left)   Lane 1 (center)   Lane 2 (right)
    |                  |                 |
    |     [zombie]     |                 |
    |                  |    [+20 gate]   |
    | [-80 gate]       |                 |
    |                  |   [barrel]      |
    |    [SQUAD]       |                 |  ← player formation
```

- 3 lanes (configurable to 5 in ruleset)
- Player shifts lanes instantly on A/D or left/right arrow
- Formation width = 1 lane, visually 3-5 soldier boxes

### Troops = HP + Firepower

```js
// troops directly scales bullets per volley
bulletsPerVolley = Math.max(1, Math.floor(troops / 5))  // 20 troops = 4 bullets wide
fireRate = 0.2s  // configurable per weapon

// taking damage
onZombieContact(zombie) {
  troops -= zombie.damage  // 5 for normal, 15 for elite
  if (troops <= 0) → game over
}

// gaining troops
onGateCollect(gate) {
  if (gate.type === 'positive') troops += gate.value
  if (gate.type === 'negative') troops = max(0, troops - gate.value)
}
onBarrelBreak(barrel) {
  troops += barrel.troopCount  // 1-5 per barrel
}
```

### Weapon System (5 types)

| Weapon | Auto-fire pattern | Duration |
|---|---|---|
| Pistol | 1 bullet straight up, default | permanent |
| AK47 | 1 bullet, 2× fire rate | 12s |
| Shotgun | 3 bullets spread, slower rate | 12s |
| Sniper | 1 bullet, pierces all enemies in lane | 10s |
| Minigun | 5 bullets spread across all lanes, rapid | 8s |

### Hero System (3 heroes in default template)

| Hero | Skill | Cooldown | Style |
|---|---|---|---|
| Kira (Soldier) | Airstrike — AoE bomb clears all enemies in view | 20s | Aggressive |
| Nova (Medic) | Rally — +10 troops instantly | 15s | Sustain |
| Rex (Engineer) | Turret — places auto-turret in current lane for 8s | 25s | Strategic |

Coders can add/replace heroes by editing `src/game/HeroSystem.js`.

### Level Config (LevelConfig.js)

```js
// Each level is a scroll-through obstacle course
LEVELS = [
  {
    id: 1,
    name: 'Outbreak',
    scrollLength: 800,     // scroll units until level end
    enemyDensity: 0.3,     // enemies per scroll unit
    eliteCount: 0,
    bossId: null,
    gateRatio: { positive: 0.6, negative: 0.4 }
  },
  { id: 2, name: 'Surge', scrollLength: 1000, enemyDensity: 0.5, eliteCount: 1, bossId: null },
  { id: 3, name: 'Onslaught', scrollLength: 1200, enemyDensity: 0.7, eliteCount: 2, bossId: null },
  { id: 4, name: 'Doom Wave', scrollLength: 1400, enemyDensity: 0.9, eliteCount: 3, bossId: null },
  { id: 5, name: 'Final Stand', scrollLength: 1600, enemyDensity: 1.2, eliteCount: 4, bossId: 'doom-elite' }
]
```

### Multiplayer (co-op)

- 2 players side by side, each in their own 3-lane column
- Shared health bar: if either player reaches 0 troops, run ends
- Shared score: combined troop count × level multiplier
- Elite enemies split aggro: 50% damage to each player's lane
- Implementation: same `viverseMultiplayer.js` room lifecycle as tankarena

---

## Rulesets Design

```json
// rulesets/default.json
{
  "id": "default",
  "name": "Standard",
  "laneCount": 3,
  "startingTroops": 20,
  "scrollSpeed": 120,
  "gateNegativeMax": 80,
  "gatePositiveMax": 20,
  "weaponPickupChance": 0.25,
  "barrelTroopRange": [2, 5],
  "levelCount": 5,
  "scoreMultiplierPerLevel": [1, 1.5, 2, 3, 5]
}

// rulesets/easy.json
{
  "id": "easy",
  "startingTroops": 35,
  "scrollSpeed": 80,
  "gateNegativeMax": 30,
  "weaponPickupChance": 0.4
}

// rulesets/hard.json
{
  "id": "hard",
  "startingTroops": 15,
  "scrollSpeed": 160,
  "gateNegativeMax": 120,
  "weaponPickupChance": 0.15,
  "eliteHpMultiplier": 2.0
}
```

---

## Immutable File Responsibilities

| File | Locks in | Why immutable |
|---|---|---|
| `src/main.js` | SDK detection, 1200ms handshake, auth init, game bootstrap | Compliance: auth timing, bridge ready guard |
| `src/viverseAuth.js` | checkAuth, fetchProfile with all fallback strategies | Compliance: auth-resolved-sdk-profile-fetch rule |
| `src/viverseConfig.js` | App ID resolution (runtime-config → hostname fallback) | Compliance: app-id-propagation-gate |
| `src/viverseLeaderboard.js` | uploadScore, fetchRankings for leaderboard API name | Compliance: leaderboard naming from CONTRACT.json |
| `src/viverseMultiplayer.js` | newMatchmakingClient, room create/join/leave/start lifecycle | Compliance: mp-new-matchmaking-client, mp-room-leave-lifecycle |

Coder only touches `src/game/**`, `src/ui/**`, `src/style.css`.

---

## Editable Surface for Coders

What's safe to change per request:

| Area | File | Typical customizations |
|---|---|---|
| Theme/visuals | `src/style.css`, `ScrollEngine.js` | Background color, ground texture, sky |
| Enemy roster | `EnemySystem.js` | New zombie types, boss designs, damage values |
| Hero roster | `HeroSystem.js` | Add/remove heroes, tweak skill values |
| Weapon set | `WeaponSystem.js` | Bullet patterns, fire rates, pickup duration |
| Level design | `LevelConfig.js` | Gate density, enemy waves, level count, names |
| Rules | `rulesets/*.json` | Difficulty tuning without code changes |
| HUD | `HUD.js`, `HeroSelect.js` | Visual style, color scheme |

---

## Build Plan (Execution Order)

### Step 1 — Template source app (template-sources/frontline-runner/app/)
Build and validate the polished base game:
1. `index.html` — runtime config block with `YOUR_APP_ID`
2. `src/viverseAuth.js` — copy from tankarena, adapt for Vite
3. `src/viverseConfig.js` — copy from tankarena
4. `src/viverseLeaderboard.js` — copy from tankarena
5. `src/viverseMultiplayer.js` — copy from tankarena
6. `src/main.js` — bootstrap, hero select flow, then RunnerEngine
7. `src/game/RunnerEngine.js` — lane state, scroll loop, squad HP
8. `src/game/ScrollEngine.js` — Three.js ground scroll, tile recycling
9. `src/game/EnemySystem.js` — zombie spawn, movement, 3 types
10. `src/game/GateSystem.js` — gate layout, collision, +/- logic
11. `src/game/WeaponSystem.js` — 5 weapon types, auto-fire volley
12. `src/game/HeroSystem.js` — 3 heroes, skill activation
13. `src/game/LevelConfig.js` — 5 level definitions
14. `src/ui/HUD.js` — troop bar, wave, score, skill cooldown
15. `src/ui/HeroSelect.js` — 3-card hero selection screen

### Step 2 — Template registration
1. Copy source app to `templates/frontline-runner-v1/`
2. Write `template.json`
3. Write `TEMPLATE.md` (guardrails, customization surface)
4. Write `scenario.schema.json`
5. Write `rulesets/default.json`, `easy.json`, `hard.json`
6. Add to `templates/registry.json`

### Step 3 — Pipeline integration
1. Build the source app (`npm run build`)
2. Copy to `template-sources/frontline-runner/app/`
3. Run one e2e test via the agent to validate:
   - auth wiring
   - leaderboard API name propagation
   - multiplayer room lifecycle
   - App ID injection
4. Confirm VERIFIER:PASS with 0 c_fixes

### Step 4 — Handoff doc
Write `handoffs/frontline-runner-v1-template.md` covering:
- Template contract and invariants
- Known compliance rules that apply
- What Coders can/cannot change
- Test prompts that should produce PASS

---

## Key Differences from tankarena-3d-v1

| | tankarena-3d-v1 | frontline-runner-v1 |
|---|---|---|
| Camera | Fixed top-down arena view | Fixed overhead, scrolls with level |
| Controls | WASD free movement | ←/→ lane swap only |
| Shooting | Manual fire (space) | Auto-fire always |
| Health | Single HP bar | Troop count = HP |
| Multiplayer | 2-player shared arena | 2-player side-by-side columns |
| Level structure | Round-based (90s timer) | Stage-based (5 levels per run) |
| Score | Win/loss per round | Troops remaining × level multiplier |
| Complexity | Higher (pathfinding, tank physics) | Lower (lane logic, scroll math) |

---

## Estimated Work

| Phase | Time | Output |
|---|---|---|
| Core runner prototype (Steps 1a–1g) | 3h | Playable lane runner, auto-fire, enemies |
| Full feature complete (Steps 1h–1o) | 3h | Gates, weapons, heroes, HUD, hero select |
| Template packaging (Step 2) | 1h | template.json, TEMPLATE.md, rulesets |
| Pipeline integration + e2e test (Step 3) | 1–2h | VERIFIER:PASS confirmed |
| **Total** | **~8–9h** | Working template in registry |
