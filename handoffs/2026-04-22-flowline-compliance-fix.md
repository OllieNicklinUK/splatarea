# Handoff: flow-line-v1 compliance gate false positive on immutable file

**Date:** 2026-04-22  
**Repo:** `/Users/casper_wang/Projects/AI/viverse-ai-agent`  
**Server:** `localhost:3000` — run `node src/index.js` from repo root  
**Test account:** `caspertest@yopmail.com` / `Aa0110test`

---

## Context

Long multi-session improvement project on `viverse-ai-agent`. The current
blocking issue is a false-positive compliance gate failure when building
flow-line-v1 (a static PlayCanvas template).

---

## What is failing right now

**Run:** `req_1776903195691` — `paused_or_failed`

**Timing (last run — showing our improvements are working):**
```
  32s  Architect   completed  (was 236s — readFile guard fixed this)
 109s  Auth task   completed  (was 420s timeout — STATIC_TEMPLATE_SCOPE fixed this)
  32s  c_fix       FAILED     Skill enforcement failed: Missing skill load entry for
                              'skill:viverse-auth/SKILL.md'
```

**Root cause chain:**
1. After `task_template_auth` completes, the fast compliance gate runs
2. It scans `viverse-auth-overlay.js` — which is listed in `immutablePaths`
3. Rules `auth-single-bootstrap-guard` and `auth-resolved-sdk-profile-fetch`
   from `viverse-sdk-skills/skills/viverse-auth/rules.json` fail against it
4. A `c_fix` task is spawned to fix those violations
5. `c_fix` can't fix them because the file is immutable — it times out or fails
   skill enforcement (loaded the skill in response text but not via tool call)

**The fix needed:** Exclude files listed in `contract.immutablePaths` from
compliance rule scanning in `ComplianceService.js`.

---

## The fix to implement

**File:** `src/services/ComplianceService.js`  
**Function:** `verifyAppIdPropagation` — around line 715 where
`sourceFilesWithText` is built.

Current code:
```js
for (const file of allSourceFiles) {
  const rel = path.relative(workspacePath, file).replace(/\\/g, '/');
  if (
    rel.startsWith('node_modules/') ||
    rel.startsWith('dist/') ||
    ...
  ) continue;
  const txt = await fs.readFile(file, 'utf8');
  sourceFilesWithText.push({ rel, txt });
}
```

**Add immutable path exclusion:**
```js
// Exclude immutable template files from compliance rule scanning —
// violations in immutable files can't be fixed by the Coder
const immutablePaths = new Set(
  Array.isArray(templateContext?.contract?.immutablePaths)
    ? templateContext.contract.immutablePaths.map(p => String(p).replace(/\\/g, '/'))
    : []
);

for (const file of allSourceFiles) {
  const rel = path.relative(workspacePath, file).replace(/\\/g, '/');
  if (
    rel.startsWith('node_modules/') ||
    rel.startsWith('dist/') ||
    rel.startsWith('publish_dist/') ||
    rel.startsWith('build_final/') ||
    rel.startsWith('.git/')
  ) continue;
  // Skip immutable files — Coder cannot fix violations in them
  if (immutablePaths.has(rel) || immutablePaths.has(path.basename(rel))) continue;
  ...
}
```

Also check `runFastGate` (around line 498) — it calls `_runTemplateStaticChecks`
with a `files` list. The same immutable exclusion needs to be applied there too.

Find where `_runTemplateStaticChecks` builds its file list and add the same filter.

---

## What was fixed in this session (all committed)

### viverse-ai-agent commits (unpushed: 2)
```
44beb72 fix(compliance): add .json to DIST_SCAN_EXT so static template App IDs are verified
8116117 fix: static template auth — STATIC_TEMPLATE_SCOPE block + explicit auth prompts
168ee59 docs: template skills — buildConfig, enforcement, large-file lessons
1f00581 fix: readFile guard for large/binary files + flow-line auth speed + 5min timeout
```

Key fixes that unblocked flow-line timing:
- `FileService.readFile`: blocks `.min.js`, `.wasm`, binary files → returns `[FILE BLOCKED]`
- `FileService.readFile`: truncates files >80KB with `[TRUNCATED]` notice
- `OrchestratorService`: `STATIC_TEMPLATE_SCOPE` block injected into every Coder task
  when `buildConfig.type === 'static'` — tells Coder to use `sed` for App ID, never
  read `__game-scripts.js`, never create `vite.config.js`
- All 3 auth task prompt sites updated to remove "vite.config.js fallback" for static templates
- `templates/flow-line-v1/template.json`: `buildConfig` added, enforcement → `"enforce"`,
  `appIdPropagation.authNote` with exact JSON path to `clientId`
- `template-sources/flow-line/app/2453710.json`: `YOUR_APP_ID` pre-injected as placeholder
- Duration timeout: reduced to 5min for both Pro and Flash

### viverse-sdk-skills commits (unpushed: 2)
```
d83bd55 feat: add lessons 9-11 + checklist items for template authoring
558cca5 feat: add lesson 0 — rulesets/default.json is mandatory for all templates
```

---

## Key architecture notes

**Model tiering:**
- Pro (gemini-3.1-pro-preview): ORCHESTRATOR, ARCHITECT, CODER, SUMMARIZER
- Flash (gemini-3-flash-preview): REVIEWER, VERIFIER, GENERAL, PHASE0_ROUTER
- Auth tasks (id matches `task_.*auth` or `.*_auth$`) → Flash via `_taskTierOverride`
- Controlled via `GEMINI_MODEL_PRO` / `GEMINI_MODEL_FLASH` in `.env`

**Workspace registry:** `.viverse_workspaces/.registry.json`
- Auto-registered on workflow completion
- API: `GET/POST/DELETE /api/ai/workspaces/:reqId`

**Agent memory:** `.viverse_agent_memory.json` (gitignored)
- Cross-session notes + user profile
- API: `GET/POST/DELETE /api/ai/memory`
- Injected as frozen `[AGENT_MEMORY]` block into all agent system prompts

**Scope blocks injected per task** (OrchestratorService ~line 4240):
- `AUTH_PREFLIGHT_SCOPE` — for auth preflight tasks
- `APP_SETUP_SCOPE` — for tasks containing `viverse-cli app create`
- `STATIC_TEMPLATE_SCOPE` — NEW: for any Coder task when `buildConfig.type === 'static'`
- `BATTLETANKS_TEMPLATE_SCOPE` — for tank arena tasks

**File protection:**
- `FileService.readFile` blocks: `.min.js`, `.wasm`, `.map`, binary media → `[FILE BLOCKED]`
- `FileService.readFile` truncates: files >80KB → first 80KB + `[TRUNCATED]`
- `ComplianceService.IGNORE_FILES`: `.agent_state.json`, `.compliance_cache.json`, `CONTRACT.json`

---

## Files to know

```
src/services/
  OrchestratorService.js     main orchestration, scope blocks, task dispatch
  ComplianceService.js       compliance gate — WHERE THE FIX IS NEEDED
  FileService.js             readFile guard lives here
  AgentRegistry.js           model tier per role
  GeminiService.js           tierOverride, memoryBlock injection
  AgentMemoryService.js      cross-session memory
  WorkspaceRegistryService.js workspace registry
  FixOrchestrationService.js fix loop hardening

templates/
  flow-line-v1/template.json   static PlayCanvas template (recently fixed)
  blank-webapp-v1/template.json Vite webapp template
  REQUIRED_STRUCTURE.md        what every template directory must contain

template-sources/flow-line/app/2453710.json  → clientId: "YOUR_APP_ID" (pre-injected)

viverse-sdk-skills/skills/viverse-template-generation/SKILL.md
  → Lessons 0-11, checklist, buildConfig guidance
```

---

## After fixing ComplianceService

1. Restart server: `lsof -ti:3000 | xargs kill -9; node src/index.js &`
2. Retry: send message in browser at `localhost:3000`:
   ```
   Create a new puzzle game using template flow-line-v1. Keep gameplay intact.
   Customize the visual theme with a dark neon aesthetic.
   ```
3. Expected timing with all fixes in place:
   - Architect: ~30s
   - Auth task: ~60-90s (sed injection, no grep loops)
   - Logic task: ~120-180s
   - Publish + Reviewer + Verifier: ~120s
   - Total: ~7-8min clean

4. Commit fix to `viverse-ai-agent` and push both repos:
   ```bash
   cd ~/Projects/AI/viverse-ai-agent && git push
   cd ~/Projects/AI/viverse-sdk-skills && git push
   ```

5. Verify `viverse-resilience-guide.md` grows after first completed run
   (SUMMARIZER on Pro should write lessons — check file size vs 4454 bytes baseline)
