# Template Certification Preflight

Use this before starting a template-derived generation or certification run in `viverse-ai-agent`.

## Goal

Fail fast before workspace creation.

## Use For

- onboarding a new template
- first certification run
- early template-run failures such as `Template certification failed ...`

## Inputs

- `templates/registry.json`
- `<template>/template.json`
- `<template>/TEMPLATE.md`
- `<template>/scenario.schema.json`

## Checklist

1. Registry
   - template exists in `templates/registry.json`
   - registry path points to a real template directory
2. Contract
   - `template.json` exists
   - includes `id`, `immutablePaths`, `editablePaths`, `injectionHooks`
3. Scenario/schema
   - `scenario.schema.json` exists
   - schema/template ids match
   - `templateId` and `rulesetId` are present when expected
4. Rulesets
   - `rulesets/` exists
   - at least one ruleset file exists
   - if schema references `default`, `rulesets/default.json` exists
5. Required files
   - any contract `requiredFiles` exist
   - startup/build-critical files exist such as `index.html`, `package.json`, build config
6. Build assumptions
   - template can produce the expected output dir
   - frozen export did not drop required local artifacts
   - `template.json` includes `buildConfig` field — REQUIRED
     Static template: `buildConfig.type = "static"` with explicit `cp` command
     Vite template: `buildConfig.command = "npm run build"`
     WITHOUT buildConfig: agents default to Vite and break static/PlayCanvas templates
   - `enforcement.defaultMode` is `"enforce"` not `"audit"`
     WITHOUT enforce: contract violations are silently ignored and agents go off-script
7. Fast-path readiness (visual/asset modification requests)
   - `editablePaths` explicitly lists all files a user might want to cosmetically change
     (e.g. `src/core/Constants.js`, `src/systems/**`, `src/gameplay/**`, `index.html`)
   - `buildConfig` is complete enough for CONTRACT.json auto-generation:
     `buildConfig.required` (bool), `buildConfig.command`, `buildConfig.publishSource`
   - `appIdPropagation.approvedConfigFiles` lists at least one file for YOUR_APP_ID injection
   - Template does NOT require Architect to produce CONTRACT.json — it is auto-generated
     from `template.json` at seeding time for fast-path runs
8. App ID placeholder hygiene
   - `index.html` must NOT contain any real/hardcoded app ID in runtime config blocks
     (e.g. `window.__APP_CONFIG__ = { clientId: "YOUR_APP_ID" }` — never a real ID like `"abc123"`)
   - Run: `grep -rn "clientId\|appId" <template>/index.html` and confirm value is `YOUR_APP_ID`
   - A stale dev ID in `index.html` survives publish-time sed replacement undetected → auth always fails

## Failure Output Format

When preflight fails, report only:
- failing gate
- exact missing/misaligned file or field
- why it blocks generation
- next action

Example:

- `rulesets.exists`: failed
- missing: `templates/dashrunner-v1/rulesets/default.json`
- blocker: schema requires `rulesetId: "default"` but no default ruleset ships with the template
- next action: add `rulesets/default.json` before starting generation

## Common Early Blockers

- template missing from registry
- `template.json` missing or incomplete
- `scenario.schema.json` missing
- `rulesets/` missing
- `rulesets/default.json` missing while schema references `default`
- required files missing
- `buildConfig` missing from `template.json` (agents default to Vite — breaks static templates)
- `enforcement.defaultMode` is `"audit"` (contract violations silently allowed)
- Static template has no `YOUR_APP_ID` placeholder in appIdPropagation approved config file
- `immutablePaths` uses a glob like `js/**` that accidentally covers engine files that should be immutable
- `editablePaths` too restrictive for fast-path runs — cosmetic files like `src/core/Constants.js` or
  `index.html` not listed, causing TEMPLATE_SCOPE_VIOLATION when user requests visual/asset changes
- `buildConfig.publishSource` missing or wrong — CONTRACT.json auto-gen uses this to determine where
  to publish from; omitting it causes the publish step to default incorrectly
- Hardcoded real app ID in `index.html` runtime config (e.g. `clientId: "abc123"`) — sed only replaces
  `YOUR_APP_ID`; stale IDs survive undetected and cause auth to always initialize in guest mode
- `sed` App ID injection missing `*.js` files — compiled Vite bundles contain inlined `YOUR_APP_ID`;
  injection pattern must be `find dist/ \( -name "*.json" -o -name "*.html" -o -name "*.js" \) | xargs sed`

Do not start a real generation run until preflight passes.

## Immutable vs Editable Path Design Rules

Deciding which files to protect is a per-template authoring responsibility. Apply this framework:

### Mark as `immutablePaths` (READ-ONLY, Coder must never touch)
- Pure engine/renderer modules: e.g. `Vehicle.js`, `Camera.js`, `Physics.js`, `Track.js`, `Particles.js`
- SDK integration shims: e.g. `ViverseAuthController.js`, `LeaderboardPanel.js`
- Config resolvers: e.g. `viverseConfig.js` (reads App ID from hostname/runtime, no user logic)
- Any file whose entire content is infrastructure with zero user-customizable behavior

### Mark as `editablePaths` (Coder may patch in-place)
- Entry/orchestration files that mix engine wiring AND game logic: e.g. `main.js`
  - These are editable but SURGICAL EDIT RULE applies: read first, patch in place, never recreate
- HTML shells: `index.html`, `editor.html`
- Asset directories: `audio/**`, `models/**`, `sprites/**`
- Ruleset configs: `rulesets/**`

### Anti-patterns to avoid
- **Glob too broad**: `js/**` in editablePaths covers engine files. Use explicit per-file immutablePaths entries instead; specific entries override globs.
- **All JS immutable**: if `main.js` is immutable, users can never change scoring/lap logic/UI — breaks legitimate customization.
- **No split**: putting all game logic in one file with no separation means either everything or nothing is protected. For new templates, separate engine modules from the orchestration entry point.
