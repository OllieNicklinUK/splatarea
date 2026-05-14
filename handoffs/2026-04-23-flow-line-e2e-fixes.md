# Handoff: flow-line-v1 End-to-End Pipeline Fixes
**Date:** 2026-04-23  
**Status:** 3 consecutive PASS runs confirmed  
**Last clean run:** `req_1776957782568` — 500s total, 0 c_fixes, 0 compliance failures  
**Repos pushed:** viverse-ai-agent `fe3ee9e`, viverse-sdk-skills `1ecb9a0`

---

## What Works Now

The full flow-line-v1 pipeline runs end-to-end without manual intervention:

```
task_1 (Architect)         ~50s
task_template_auth         ~90s   ← login + app create + build + sed + verify
task_template_logic        ~65s   ← write neon CSS to styles.css + index.html only
task_template_publish      ~200s  ← rebuild + login + viverse-cli app publish
task_reviewer              ~45s
task_verifier              ~55s   PASS
─────────────────────────────────
Total:                     ~8 min  (0 c_fix loops)
```

---

## All Root Causes Fixed (This Session)

### 1. Task dependency chain broken (`a6ec60f`)
**Symptom:** `task_5` (publish) ran before `task_2` (auth) because Architect LLM generated `dependsOn:[]`.  
**Fix:** `_canonicalizeTemplateWorkflowTasks` — remove `hasCombinedCoderTask` bail-out so template-bound requests always get the canonical `auth→logic→publish` chain regardless of how the Architect planned.

### 2. `YOUR_APP_ID` not injected into workspace (`a973943`)
**Symptom:** `workspace/2453710.json` had `clientId: ""` instead of `"YOUR_APP_ID"`.  
**Root cause:** `_seedWorkspaceFromTemplate` was called with `state?.templateContext?.contract` which is always `null` at seeding time (contract isn't assigned to state until *after* seeding). So `approvedConfigFiles = []` and the injection loop never ran.  
**Fix:** Pass the freshly loaded `contract` variable (already in scope) instead.

### 3. `dist/` doesn't exist when auth runs sed (`2dcd1fc`)
**Symptom:** Auth Coder ran `sed ... dist/` before `dist/` was created → sed found nothing.  
**Fix:** Auth prompt updated from 4-step to 5-step: step 3 is now "run buildConfig.command from CONTRACT.json to create dist/", step 4 is sed injection, step 5 is verify.

### 4. Publish blocked by App ID integrity check (`9c3f6ba`)
**Symptom:** `_checkAppIdIntegrity` blocked publish with "no valid VITE_VIVERSE_CLIENT_ID" even though `dist/2453710.json` had the correct App ID.  
**Root cause:** The check reads workspace-root `2453710.json` which still has `YOUR_APP_ID` placeholder (only dist gets the real ID). `_isValidAppId("YOUR_APP_ID") = false` → blocked.  
**Fix:** When `appIdAuthority.locked = true` (set by auth task), the App ID is already verified and in dist. Return `ok: true` immediately.

### 5. Verifier failed on immutable files (`ea7f480`)
**Symptom:** HANDSHAKE GATE and TRACEABILITY GATE failed on `viverse-auth-overlay.js` (immutable).  
**Fix:** Added IMMUTABLE FILE RULE to Verifier system prompt: check CONTRACT.json `immutablePaths` and skip any gate that only fails on those files.

### 6. `dist/` stale after logic changes (`ea7f480`)
**Symptom:** Publish uploaded the pre-logic dist, which had old leaderboard API names.  
**Fix:** Publish prompt updated to 4-step: step 2 is now "re-run buildConfig.command to rebuild dist with latest changes before publishing".

### 7. Logic task exploring json game files (`d26c8fa`)
**Symptom:** Logic Coder spent 300s grepping `2453710.json`, `config.json` for game color properties instead of writing CSS.  
**Fix:** Logic prompt explicitly names `styles.css` and `index.html` as the only targets. Explicit ban: `2453710.json`, `__game-scripts.js`, `config.json`, `viverse-cli` commands, grep exploration.

### 8. Multiplayer compliance rules on non-multiplayer template (`fe3ee9e`)
**Symptom:** 12 `mp-*` compliance rules fired on flow-line-v1 even though capabilities don't include multiplayer.  
**Root cause:** Reviewer labeled a missing SDK script tag issue as `platform-core.matchmaking`. `_deriveComplianceProfiles` returned `['multiplayer']` for that subsystem without checking if the template supports it.  
**Fix:** In `_deriveComplianceProfiles`, when `inferredSubsystem === 'platform-core.matchmaking'`, return `[]` if `supportedProfiles` is non-empty and doesn't include `'multiplayer'`.

---

## Earlier Fixes (Same Branch, From Previous Session)

| Commit | Fix |
|---|---|
| `8b7cc83` | Skill inference scoped to taskPrompt only (not full projectContextSummary) |
| `10beb58` | Auth task prompt — strict 4-step script, no extra file reads |
| `1b3b78d` | Publish task prompt — strict 3-step script, no file reads |
| `115e46f` | Publish task split guard — prevent re-split into auth+logic+publish |
| `8020ba8` | App ID deep JSON scan for `clientId` in PlayCanvas scene files |
| `bc0f872` | `required_sequence_anyfile` uses full file list (immutable files satisfy required rules) |
| `582ed6e` | Preserve `buildConfig.type` through `TemplateContractService` normalization |
| `b1c2a30` | `skipIfBuildType=static` filter in ComplianceService |
| `91db781` | Seed supported compliance profiles from `contract.capabilities` |
| `3585276` | Phase 1.7: repair publish task deps in `_enforceWorkflowTasks` |
| `50c6794` | Wire split auth subtask to preceding coder when parent has no deps |

---

## Remaining Items for Next Session

### HIGH — affects pass rate

**1. Auth time variance (90–250s)**  
`viverse-cli app create` is a network call that takes 60–90s minimum. On slow runs auth spends the rest of the budget reading files before or after. The strict 5-step prompt helps but doesn't eliminate variance.  
*Next fix:* App ID memory reuse — skip `app create` when the same template+user has a recent valid App ID in `agentMemory`. Could cut auth to ~30s for repeat builds.

**2. Publish time (150–300s)**  
The rebuild step (step 2 of publish) re-runs `buildConfig.command` which does a full `cp` of all source files. On slow runs the Coder does extra verification commands before/after publish.  
*Next fix:* Publish prompt could be tighter — the rebuild command is known from CONTRACT.json, so pre-inject it into the prompt directly rather than telling the Coder to "cat CONTRACT.json to get it".

### MEDIUM — occasional failures

**3. Reviewer mislabels SDK issues as `platform-core.matchmaking`**  
The Reviewer prompt says "runtime_checks MUST include auth_profile and matchmaking when applicable". For flow-line-v1 the Reviewer outputs `matchmaking: pass` in its check, and this word leaks into fix task prompts.  
*Next fix:* Update Reviewer prompt for static/non-multiplayer templates to omit `matchmaking` from runtime_checks entirely. OR add `template-matchmaking-hook-missing` to the immutable-exclusion logic.

**4. `fix_` tasks sometimes triggered by Reviewer**  
In the 500s run there were no fix tasks. But in earlier runs a reviewer fix fired (166s, 234s). These add 2-4 min when they occur. The Reviewer is checking for patterns in immutable files (`viverse-auth-overlay.js`) that the Coder can't fix.  
*Next fix:* Update Reviewer prompt to skip checks on immutable paths listed in CONTRACT.json.

### LOW — architecture / polish

**5. `OrchestratorService.js` is 5,700+ lines**  
All prompt strings, task planning, compliance coordination, and task dispatch live in one file. The largest extraction target is `PromptBuilderService` (~800 lines of scope block strings).

**6. `handoffs/runtime-monitor/` stale directories**  
Many old monitoring session files from earlier debugging. Low priority, but could be cleaned up.

---

## Key File Map

```
src/services/
  OrchestratorService.js        Main orchestration — task planning, dispatch, prompt building
  ComplianceService.js          Per-rule immutable filtering, skipIfBuildType, profile seeding
  AgentRegistry.js              Verifier system prompt (IMMUTABLE FILE RULE added here)
  TemplateContractService.js    buildConfig.type preserved through normalization

templates/flow-line-v1/
  template.json                 buildConfig.type='static', immutablePaths, approvedConfigFiles
  2453710.json                  clientId: "" (template source — YOUR_APP_ID injected at seeding)

template-sources/flow-line/app/
  2453710.json                  clientId: "YOUR_APP_ID" (already injected — reference copy)

viverse-sdk-skills/skills/viverse-auth/rules.json
  auth-single-bootstrap-guard       skipIfBuildType: 'static'
  auth-resolved-sdk-profile-fetch   skipIfBuildType: 'static'
```

---

## Monitoring Pattern

```bash
# Fire a test run (server must be running on :3000)
curl -s -N -X POST http://localhost:3000/api/ai/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Create a new puzzle game using template flow-line-v1. Keep the VIVERSE auth, profile chip, leaderboard wiring, and PlayCanvas runtime intact. Customize visuals into a neon circuit theme.",
    "templateId": "flow-line-v1",
    "rulesetId": "default",
    "credentials": {"email": "caspertest@yopmail.com", "password": "Aa0110test"}
  }' >> /tmp/e2e_stream.log 2>&1 &

# Find the new run
REQ=$(python3 -c "
import json,os,time
ws='/Users/casper_wang/Projects/AI/viverse-ai-agent/.viverse_workspaces'
now=time.time()*1000
for d in sorted(os.listdir(ws),reverse=True):
    if not d.startswith('req_'): continue
    if (now-int(d.replace('req_','')))/1000>120: break
    try:
        s=json.load(open(f'{ws}/{d}/.agent_state.json'))
        if s.get('status')=='running': print(d); break
    except: pass
")

# Watch it (writes to /tmp/e2e_result.log every 20s, prints ===DONE=== at end)
python3 scripts/test_e2e.py --template flow-line-v1 --timeout 900

# Quick state check
cat /tmp/e2e_result.log | tail -15
```

---

## Invariants to Preserve

1. **`YOUR_APP_ID` must be in `templates/flow-line-v1/2453710.json` at `clientId: ""`** — `_seedWorkspaceFromTemplate` injects it to `YOUR_APP_ID` via `_injectPlaceholder` only when the field is empty/null. Don't pre-fill it in the template dir.

2. **`template-sources/flow-line/app/2453710.json` has `clientId: "YOUR_APP_ID"`** — this is the reference copy that shows the expected post-seeding state.

3. **Auth prompt must include build step before sed** — `dist/` doesn't exist until the build runs; sed on a non-existent `dist/` silently succeeds but injects nothing.

4. **`_canonicalizeTemplateWorkflowTasks` must always run for template-bound requests** — don't add early-return conditions based on what the Architect LLM planned.

5. **`supportedProfiles` must be seeded from `contract.capabilities`** — if requiredGates is empty (as on flow-line-v1), the old code set `supportedProfiles={}` and `unrestrictedProfiles=true`, allowing all profiles including multiplayer.
