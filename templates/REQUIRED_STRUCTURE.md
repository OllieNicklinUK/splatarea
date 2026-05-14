# Template Required Structure

Every template directory under `templates/` MUST contain the following
or `TemplateCertificationService.runStaticGates()` will block all runs
with "Template certification failed".

## Mandatory files

```
templates/<template-id>/
├── template.json          # Contract: id, immutablePaths, editablePaths,
│                          # injectionHooks, requiredGates, appIdPropagation
├── TEMPLATE.md            # Human-readable description shown in workspace
├── scenario.schema.json   # Ruleset/scenario validation schema
└── rulesets/
    └── default.json       # At minimum one ruleset file MUST exist
                           # Schema: { id, name, description, authRequired,
                           #           mobileFirst, iframeEmbeddable }
```

## Minimum `rulesets/default.json`

```json
{
  "id": "default",
  "name": "Default",
  "description": "Standard profile description.",
  "authRequired": true,
  "mobileFirst": true,
  "iframeEmbeddable": true
}
```

## Certification gates (`TemplateCertificationService.runStaticGates`)

| Gate                      | Checks                                              |
|---------------------------|-----------------------------------------------------|
| `contract.id`             | `template.json` has `id` field                      |
| `contract.immutablePaths` | at least one immutable path declared                |
| `contract.editablePaths`  | at least one editable path declared                 |
| `rulesets.exists`         | `rulesets/` dir exists with ≥1 file                 |
| `certification.required_files` | any files listed in `contract.certification.requiredFiles` exist |

Any failing gate blocks the workflow before agents run.

## Immutable vs Editable Path Design Rules

Deciding which files to protect is a per-template authoring responsibility:

### `immutablePaths` — Coder must NEVER write these
- Pure engine/renderer modules with no user-configurable behavior (e.g. `Vehicle.js`, `Camera.js`, `Physics.js`)
- SDK integration shims (e.g. `ViverseAuthController.js`, `LeaderboardPanel.js`)
- Config resolvers that read App ID from hostname/runtime (e.g. `viverseConfig.js`)

### `editablePaths` — Coder may patch in-place only
- Entry/orchestration files that mix engine wiring AND game logic (e.g. `main.js`)
  - **SURGICAL EDIT RULE**: Coder must read the full file first, then make targeted edits. Never recreate from scratch.
- HTML shells, asset directories, ruleset configs

### Key anti-patterns
- **Glob too broad**: `js/**` in editablePaths covers engine files → use explicit `immutablePaths` entries (specific paths override globs)
- **All engine JS immutable**: blocks legitimate game customization in entry file
- **No module separation**: mixing engine setup and game logic in one file forces an all-or-nothing protection decision → for new templates, separate concerns into distinct modules

## Critical `template.json` fields

Beyond certification gates, missing these fields causes silent failures during generation:

### `buildConfig` (REQUIRED — no default)

Without this, agents assume Vite and break static/PlayCanvas templates:

```json
// Static template (PlayCanvas, raw HTML)
"buildConfig": {
  "type": "static",
  "command": "mkdir -p dist && cp index.html styles.css ... dist/ && cp -r files dist/",
  "outputDir": "dist",
  "entryHtml": "index.html"
}

// Vite template
"buildConfig": {
  "command": "npm run build",
  "outputDir": "dist",
  "entryHtml": "index.html"
}
```

### `enforcement.defaultMode` (should be `"enforce"`)

`"audit"` silently allows contract violations — agents write `vite.config.js`, `src.js`
into static templates and the published app is blank at runtime.

### App ID placeholder for static templates

If `appIdPropagation.approvedConfigFiles` points to a JSON config file,
pre-inject `YOUR_APP_ID` as the placeholder value so the auth Coder can use:
```bash
sed -i '' 's/YOUR_APP_ID/<actual-app-id>/g' dist/<config-file>.json
```

**This placeholder is now auto-injected at seed time** for JSON files: if a JSON
`approvedConfigFile` has an empty `clientId`/`appId` field, `_seedWorkspaceFromTemplate`
sets it to `YOUR_APP_ID` automatically. For HTML files, pre-inject the placeholder
in the template source manually. Run `TemplateCertificationService.runStaticTemplateAppIdGate`
to verify.
instead of parsing the full file structure.

## Reference skill

Load `viverse-template-generation` skill for full onboarding checklist.
See also: `skills/template-certification-preflight.md`
