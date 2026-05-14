# Ultimate Zombie Defense — Dev Memo
**Date:** 2026-04-24  
**App ID:** x8apb8tuee  
**Preview:** https://worlds.viverse.com/EqApqqB?preview  
**Leaderboard API:** ultimate-zombie-score  
**Workspace:** ~/.../viverse-ai-agent/.viverse_workspaces/req_1776960613106/  

---

## Current State ✅

What works today:
- WASD movement + Space to shoot (canvas focus via tabIndex + 100ms delay)
- Wave 1 zombies spawn (red cubes) and walk toward player
- Camera follows player
- Player (blue cube) visible and moves correctly
- VIVERSE auth + profile chip (caspertest logged in)
- Leaderboard submit button (API wired, no scores yet)
- Multiplayer lobby UI (Find Match button exists, untested end-to-end)

Key bugs fixed during this session:
- `syncScene()` was missing from host path → no meshes ever rendered
- Camera was fixed → player walked off screen
- Canvas had no tabIndex → WASD captured by outer iframe page
- `getGuestLeaderboard` called 3× → replaced with 1 silent call, then removed entirely (SDK logs 400 internally regardless)

---

## TODO — Priority 1: Game Loop (makes it a complete game)

### 1.1 Player HP + Game Over  
**Effort:** ~1h  
- Add `hp: 100` to player state
- In `hostTick`: if zombie z >= player z (within 1.5 units), subtract damage (10/s)
- Add health bar to HUD (red bar, top of screen)
- When hp <= 0: stop game loop, show "GAME OVER" overlay with final score + wave
- Add restart button that resets state and calls `startGame()` again

### 1.2 Wave Progression  
**Effort:** ~30min  
- In `hostTick`: when `Object.keys(state.zombies).length === 0 && state.wave > 0`, advance wave
- Each wave: `wave * 3` max zombies, zombie speed increases (+0.3/wave), spawn rate increases
- Show "Wave N complete!" flash before next wave starts (2s delay)
- Wave HUD updates automatically (already wired)

### 1.3 Score Persistence + Leaderboard Display  
**Effort:** ~30min  
- Submit Score button already calls `uploadScore` — wire it to current score properly
- After submit, call `fetchRankings` and render results in leaderboard panel
- Show submitted indicator ("Score submitted! ✓")

---

## TODO — Priority 2: Character & Weapon System (the original spec)

### 2.1 Character Select Screen  
**Effort:** ~2h  
Show before game starts. 5 classes with distinct stats:

| Class | Speed | Fire Rate | HP | Special |
|---|---|---|---|---|
| Soldier | 5 | 500ms | 100 | Default |
| Scout | 8 | 800ms | 70 | Fast but fragile |
| Heavy | 3 | 300ms | 200 | Slow, tanky, spread shot |
| Medic | 5 | 600ms | 120 | Slow HP regen |
| Engineer | 5 | 500ms | 100 | Auto-turret every 10 waves |

Store selected class in `gameState.selectedClass`, apply stats in `startGame()`.

### 2.2 Weapon Types  
**Effort:** ~2h  
8 weapons — simplest approach is different bullet spread/speed/damage per class:

| Weapon | Class | Mechanic |
|---|---|---|
| Pistol | Soldier | Single bullet, balanced |
| SMG | Scout | Burst of 3 bullets |
| Minigun | Heavy | Spread shot (3-wide) |
| Shotgun | Heavy (alt) | 5 bullets in cone |
| Sniper | Scout (alt) | 1 bullet, fast, long range |
| Grenade Launcher | Engineer | Explodes in radius |
| Flamethrower | Medic | Short range, AoE cone |
| Rifle | Soldier (alt) | 2-tap burst |

Implementation: change `applyAction` fire handler to produce different bullet patterns based on `gameState.selectedClass`.

### 2.3 Player HP Visual  
**Effort:** ~30min  
- Health bar above player mesh (small green bar that shrinks)
- Could also add a simple damage flash (red screen flash on hit)

---

## TODO — Priority 3: Polish

### 3.1 Better Visuals  
**Effort:** ~1-2h  
Current: colored boxes. Minimum viable improvement:
- Add directional indicator to player (small cone/arrow showing facing direction)
- Add zombie "face" direction (small triangle pointing toward player)
- Ground grid lines for sense of movement
- Muzzle flash effect on shoot (brief yellow sphere)
- Death explosion on zombie kill (scatter particles or brief scale-up/fade)

### 3.2 Level Structure  
**Effort:** ~1h  
Original spec says 100 levels with 4 difficulties. Pragmatic mapping:
- Easy: waves 1-10 (zombie speed 2, spawn 5%)
- Medium: waves 11-30 (speed 3, spawn 8%)
- Hard: waves 31-60 (speed 4, spawn 12%, zombie HP 2)
- Nightmare: waves 61+ (speed 5+, spawn 15%, zombie HP 3, boss every 10 waves)

No need for 100 distinct "levels" — wave-based difficulty curve covers the spec.

### 3.3 Multiplayer Co-op Testing  
**Effort:** ~2h  
MultiplayerManager exists and matchmaking runs. Needs:
- End-to-end test with 2 accounts
- Verify host/guest state sync for zombie positions
- Verify score attribution per player
- Leave/rejoin handling

---

## Technical Debt

- `debug.js` has hardcoded `console.log` — remove all `[UZD]` logs before final publish
- `src/debug.js` should export empty stubs when done:  
  ```js
  export const debugInit = () => {};
  export const debugGameManager = () => {};
  export const debugCanvasFocus = () => {};
  ```
- Zombie deletion while iterating `for...in` — technically safe in JS but worth switching to a delete-queue pattern
- No zombie cleanup when they walk past z=25 (off the far side of map) — add boundary check in hostTick

---

## Files to Know

```
src/
  main.js              — bootstrap, auth, UI, solo/MP buttons, animate loop
  debug.js             — hardcoded debug logs (remove when done)
  game/
    GameManager.js     — game state, WASD keys, hostTick, syncScene
    SceneManager.js    — Three.js renderer, camera follow, mesh management
    MultiplayerManager.js
  utils/
    viverseHelper.js   — fetchViverseProfile (all SDK strategies)
    leaderboardHelper.js — uploadScore, fetchRankings (getGuestLeaderboard removed)
```

---

## Quick Rebuild Command

```bash
cd /Users/casper_wang/Projects/AI/viverse-ai-agent/.viverse_workspaces/req_1776960613106
npm run build && \
viverse-cli auth login -e caspertest@yopmail.com -p Aa0110test && \
viverse-cli app publish dist --app-id x8apb8tuee
```
