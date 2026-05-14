# Template Plan: kingshot-archer-v1
**Date:** 2026-04-24  
**Status:** Planning (updated — standalone template)  
**Game reference:** Kingshot (Century Games) — Tower Defense shooting mode  
**Template ID:** `kingshot-archer-v1`  

---

## What This Template IS

A **3D medieval archery tower defense** game for VIVERSE.  
Inspired by Kingshot's viral Tower Defense mode — the mechanic that drives all the "IMPOSSIBLE SHOT" ads.

Core loop:
> **Draw your bow. Aim with trajectory physics. One perfect shot chains through an entire enemy formation. Place crossbow/cannon towers between shots. Survive 10 waves to win.**

This is fundamentally different from both the zombie defense game and the frontline runner:
- **Zombie defense** = free WASD movement, top-down
- **Frontline runner** = lane-based auto-scroll
- **Kingshot archer** = fixed castle + precision aiming + tower placement + physics

The satisfaction comes from a single well-aimed arrow piercing through 8 enemies in a row.

---

## Core Gameplay Mechanics

### 1. The Shot
- Player sits at a fixed position at the castle gate (doesn't move)
- **Aim**: click/drag to draw bow — a dotted arc preview shows trajectory
- **Release**: let go to fire — arrow follows parabolic arc
- **Pierce**: arrow travels through enemies until it loses momentum (pierce count scales with upgrades)
- **Wind**: subtle horizontal drift shown by wind indicator (adds skill ceiling)
- **Power bar**: optional — hold longer = farther/faster shot

### 2. Enemy Formations
Enemies march toward the castle in **formation rows**, not single file. This is what makes chain kills so satisfying:
```
[🧟][🧟][🧟][🧟][🧟]  ← row of 5 = potential 5-chain
         ↓
[🧟][🧟]   [🧟][🧟]  ← spreads as they advance
         ↓
[🛡️ TANK]              ← heavy armor, blocks arrow
```
Hit the row at the right angle → chain through all 5. Miss the angle → hit 2. **Skill expression through angle choice.**

### 3. Tower Placement
Between waves (10s breather), player can place/upgrade:

| Tower | Auto-fires | Damage | Upgrade effect |
|---|---|---|---|
| Crossbow | Single shot, fast rate | Low | +pierce, +range |
| Cannon | Area splash, slow rate | High | +blast radius |
| Watchtower | Slows enemies | — | +slow strength |
| Ballista | Piercing shot, very fast | Medium | +projectile speed |

Towers placed on **fixed slots** on the castle walls (3-5 slots, unlocked as waves progress). Player decides which tower type fills each slot.

### 4. Hero Ability (Active Skill)
One hero ability on cooldown (Space key):
- **Fire Arrow** — next manual shot ignites, spreads fire to nearby enemies (+AoE)
- **Stone Wall** — spawns a temporary wall that slows and damages enemies crossing it  
- **Eagle Eye** — slows time by 50% for 4 seconds (aim assist)
- **Rain of Arrows** — 20 arrows drop in a spread pattern on the cursor position

### 5. Wave Structure (10 waves per run)
```
Wave 1-3:  Standard zombies, single rows, easy angles
Wave 4-5:  Shield bearers mixed in (need side-angle shots to pierce)
Wave 6-7:  Double rows approach simultaneously
Wave 8-9:  Tank units + fast runners mixed
Wave 10:   Boss wave — one giant boss + formation escort
```

### 6. Scoring
- Base: 10pts per kill
- Chain bonus: ×2 at 3-chain, ×3 at 5-chain, ×5 at 8+chain
- No-damage wave bonus: +200pts if castle takes no damage this wave
- Speed bonus: kills in first 10s of wave = 1.5×
- Final score → leaderboard

---

## Multiplayer (Co-op + PvP)

**Co-op (2 players):**
- Side-by-side view: each player defends their own half of the castle
- Shared tower slots: one player places, both benefit
- Shared health bar: if either side's castle HP drops to 0, run ends
- Chain kills across the center line count for both players
- VIVERSE matchmaking room lifecycle (same as tankarena)

**Async PvP (leaderboard-based):**
- Single-player run → submit score
- Leaderboard shows wave reached + final score
- No real-time PvP needed for v1

---

## Template File Structure

```
templates/kingshot-archer-v1/
├── template.json
├── TEMPLATE.md
├── README.md
├── scenario.schema.json
├── package.json
├── index.html                  ← runtime config (clientId: YOUR_APP_ID)
├── rulesets/
│   ├── default.json            ← 10 waves, balanced towers, normal wind
│   ├── easy.json               ← 7 waves, slow enemies, no wind
│   └── hard.json               ← 15 waves, fast enemies, strong wind, reduced tower slots
└── src/
    ├── main.js                 ← IMMUTABLE bootstrap + auth + game init
    ├── viverseAuth.js          ← IMMUTABLE
    ├── viverseConfig.js        ← IMMUTABLE
    ├── viverseLeaderboard.js   ← IMMUTABLE
    ├── viverseMultiplayer.js   ← IMMUTABLE
    ├── game/
    │   ├── AimSystem.js        ← EDITABLE arc preview, wind, power, fire logic
    │   ├── ArrowPhysics.js     ← EDITABLE projectile trajectory, pierce, chain kill
    │   ├── EnemySystem.js      ← EDITABLE wave configs, enemy types, formation patterns
    │   ├── TowerSystem.js      ← EDITABLE tower types, placement, auto-fire, upgrades
    │   ├── HeroSystem.js       ← EDITABLE hero abilities, cooldowns, effects
    │   ├── CastleHealth.js     ← EDITABLE castle HP, damage on reach, game-over trigger
    │   └── WaveController.js   ← EDITABLE wave sequencing, between-wave timer, boss logic
    ├── scene/
    │   ├── SceneBuilder.js     ← EDITABLE Three.js scene, castle mesh, battlefield layout
    │   ├── CameraRig.js        ← EDITABLE camera angle, zoom, multiplayer split-view
    │   └── VFX.js              ← EDITABLE hit sparks, chain kill effect, fire spread
    └── ui/
        ├── HUD.js              ← EDITABLE wave counter, castle HP bar, score, wind gauge
        ├── TowerPanel.js       ← EDITABLE tower selection drawer, placement mode UI
        └── HeroSelect.js       ← EDITABLE pre-game hero choice (3 heroes with different skills)
```

---

## template.json Design

```json
{
  "id": "kingshot-archer-v1",
  "version": "1.0.0",
  "upstream": {
    "sourceType": "internal",
    "sourceRoot": "template-sources/kingshot-archer/app"
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
    "src/scene/**",
    "src/ui/**",
    "src/style.css",
    "rulesets/**",
    "README.md",
    "TEMPLATE.md"
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

## Rulesets Design

```json
// rulesets/default.json
{
  "id": "default",
  "name": "Standard",
  "waveCount": 10,
  "startCastleHp": 500,
  "arrowPierceBase": 3,
  "windStrength": 0.3,
  "towerSlots": 4,
  "enemySpeedMultiplier": 1.0,
  "chainKillBonusMultiplier": 1.0,
  "bossWaveInterval": 10
}

// rulesets/easy.json
{
  "id": "easy",
  "waveCount": 7,
  "startCastleHp": 800,
  "arrowPierceBase": 5,
  "windStrength": 0.0,
  "towerSlots": 5,
  "enemySpeedMultiplier": 0.7
}

// rulesets/hard.json
{
  "id": "hard",
  "waveCount": 15,
  "startCastleHp": 300,
  "arrowPierceBase": 2,
  "windStrength": 0.8,
  "towerSlots": 3,
  "enemySpeedMultiplier": 1.5
}
```

---

## 3D Scene Design (Three.js)

```
Camera angle: 45° isometric, slightly behind and above player archer
              Fixed — does NOT move during combat

                     [sky / fog]
    ┌──────────────────────────────────────────────────────┐
    │         🌫️ distant hills (background plane)          │
    │                                                      │
    │  [👹][👹][👹][👹][👹]  ← wave 3 formation           │
    │                                                      │
    │      [🗼 crossbow]        [🗼 cannon]                │
    │                                                      │
    │  ══════════════════════════════  ← castle wall       │
    │  [🏰 gate] [🏰]  [🏹 PLAYER]  [🏰] [🏰 gate]      │
    └──────────────────────────────────────────────────────┘
              ↑ player at fixed position, aiming up
```

**Visual elements:**
- Castle wall mesh across the bottom (stone texture via MeshStandardMaterial)
- Tower slots as glowing pedestals on the wall
- Enemies as colored cubes/capsules with health bars, organized in formation
- Arrow: thin cylinder traveling along parabolic path, yellow trail
- Chain kill: burst of red particle sparks per enemy hit
- Wind indicator: top-right corner, animated feather/leaf

---

## Key Technical Decisions

### Aiming System
```js
// AimSystem.js — trajectory arc preview
onMouseDrag(x, y) {
  const angle = Math.atan2(y - origin.y, x - origin.x);
  const power = Math.min(distance / 100, 1.0); // 0-1
  const windOffset = ruleset.windStrength * windDirection * 0.1;
  
  // Compute parabolic preview points
  this.arcPoints = [];
  for (let t = 0; t < 50; t++) {
    arcPoints.push({
      x: origin.x + Math.cos(angle) * power * t + windOffset * t,
      y: origin.y + Math.sin(angle) * power * t - 0.5 * gravity * t * t
    });
  }
  this.drawArc(arcPoints); // render dotted line preview
}

onRelease() {
  this.fireArrow({ angle, power, wind: windOffset });
}
```

### Pierce Chain Kill
```js
// ArrowPhysics.js
update(dt) {
  this.pos.x += this.vel.x * dt + this.wind * dt;
  this.pos.y += this.vel.y * dt - gravity * dt;
  this.vel.y -= gravity * dt; // gravity pulls arrow down
  
  // Check intersection with all enemy bounding boxes
  for (const enemy of enemies) {
    if (intersects(this.pos, enemy.bounds)) {
      enemy.hp -= this.damage;
      this.pierceCount--;
      this.chainMultiplier++;    // score multiplier increases per chain
      if (this.pierceCount <= 0) this.destroy();
    }
  }
}
```

### Tower Auto-fire (runs independent of player shots)
```js
// TowerSystem.js — each tower has its own timer
class CrossbowTower {
  update(dt) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.fireRate;
      const target = this.findNearestEnemy(this.range);
      if (target) this.fireStraightAt(target);
    }
  }
}
```

---

## What Coders Can Customize per Request

| Customization | File | Example |
|---|---|---|
| Theme | `SceneBuilder.js`, `style.css` | Fantasy → Sci-fi laser defense |
| Enemy types | `EnemySystem.js` | Zombies → Space invaders → Orcs |
| Formation patterns | `EnemySystem.js` | V-shape, diamond, spiral approach |
| Tower set | `TowerSystem.js` | Medieval → Laser turrets, ice towers |
| Hero abilities | `HeroSystem.js` | Fire arrow → Lightning strike |
| Difficulty curve | `WaveController.js` | Steeper ramp, boss every 5 waves |
| Physics tuning | `ArrowPhysics.js` | Heavier gravity, faster arrows |
| Rules | `rulesets/*.json` | No-code difficulty tuning |

---

## Comparison: All Three Game Plans

| | zombie-defense | frontline-runner-v1 | **kingshot-archer-v1** |
|---|---|---|---|
| Camera | Follow-cam | Fixed overhead scroll | Fixed isometric (castle view) |
| Controls | WASD free movement | ←/→ lane swap | Drag to aim + click to place tower |
| Shooting | Space = manual | Auto-fire always | Draw-and-release with arc preview |
| Health | HP bar | Troop count | Castle HP bar |
| Strategy | Positioning + aim | Lane + gate timing | Shot angle + tower placement |
| Input device | Keyboard required | Keyboard/touch | Mouse/touch (better on mobile!) |
| Mobile fit | Poor | Good | **Excellent** (drag to aim = natural touch) |
| Multiplayer | Co-op (shared arena) | Co-op (side-by-side) | Co-op (split castle) or async leaderboard |
| Uniqueness | Common genre | Last War clone | **Most distinctive on VIVERSE** |

---

## Why Kingshot Archer > Frontline Runner for VIVERSE

1. **Touch-first** — drag to aim is natural on mobile, no keyboard required
2. **Shorter sessions** — 10 waves ≈ 5 minutes, perfect for VIVERSE preview format
3. **Visual satisfaction** — chain kills through formations are instantly shareable
4. **Higher skill ceiling** — wind + angle + timing creates genuine mastery curve
5. **Multiplayer differentiation** — split-castle co-op is genuinely novel
6. **No competitor on VIVERSE** — no existing archery/tower defense game in registry

---

## Build Plan (Execution Order)

### Phase 1 — Core prototype (~3h)
1. `SceneBuilder.js` — castle wall, battlefield plane, isometric camera
2. `AimSystem.js` — drag arc preview (dotted line in Three.js)
3. `ArrowPhysics.js` — parabolic trajectory, gravity, pierce
4. `EnemySystem.js` — basic zombie formation, march toward castle
5. `CastleHealth.js` — HP bar, damage on enemy reach, game over

### Phase 2 — Full feature set (~3h)
6. `TowerSystem.js` — crossbow + cannon placement + auto-fire
7. `HeroSystem.js` — 3 hero skills with cooldown
8. `WaveController.js` — 10 waves, formation configs, boss wave
9. `VFX.js` — chain kill sparks, fire spread, arrow trail
10. `HUD.js` — wave counter, castle HP, score, wind gauge, chain display

### Phase 3 — VIVERSE + hero select (~1h)
11. `HeroSelect.js` — 3-card hero selection screen
12. VIVERSE auth wiring (copy tankarena pattern)
13. Leaderboard submit on run end
14. Multiplayer split-castle co-op

### Phase 4 — Template packaging (~1h)
15. Write `template.json`, `TEMPLATE.md`, `scenario.schema.json`
16. Write 3 rulesets (`default`, `easy`, `hard`)
17. Add to `templates/registry.json`
18. Copy source to `template-sources/kingshot-archer/app/`

### Phase 5 — Pipeline validation (~1-2h)
19. Run agent e2e against the template
20. Confirm VERIFIER:PASS, 0 c_fixes
21. Write handoff doc

**Total estimated: ~9-10h**  
Phase 1 alone (~3h) gives a fully playable standalone game before template packaging.

---

## Scope Cut for v1 (Can Add Later)
- Wind simulation: ship in v1 as static wind indicator, no actual physics drift
- Boss mechanics: simplified in v1 (just high-HP enemy, no special attack pattern)
- Tower upgrades: v1 has placement only, no upgrade path
- PvP mode: v1 is co-op only, async leaderboard for solo
- Hero gacha: v1 has 3 fixed heroes, no unlock system
