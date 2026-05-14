# Template Sources

This directory holds source-of-truth template projects before they are frozen into
agent-consumable packages under `templates/`.

## Rules

- Build and polish source apps here.
- Publish and validate from here with a real App ID.
- Export certified snapshots into `templates/<template-id>/` using:
  `node scripts/build-template.mjs --source <path> --template <id>`
- Do not treat `.viverse_workspaces/` as template source.
- Do not point the agent at source trees directly — only frozen `templates/` are agent-consumable.

## Export Pipeline

```
template-sources/<name>/app/   ← source of truth (build & polish here)
        ↓
node scripts/build-template.mjs --source template-sources/<name>/app --template <id>
        ↓
templates/<id>/                ← frozen, agent-consumable
```

The script runs pre-flight gates (registry entry, immutable file presence, injection hook paths),
diffs source vs frozen by SHA-256, blocks if immutable files diverge, and writes an export manifest
to `template-sources/<name>/export/last-export.json`.

## Current Sources

| Directory | Template ID | Status | Notes |
|---|---|---|---|
| `tankarena-3d/` | `tankarena-3d-v1` | ✅ Active | Fully sourced, verified clean, export pipeline validated |
| `blank-webapp/` | `blank-webapp-v1` | 🔧 Ready to freeze | Source app complete — run build-template.mjs to freeze |
| `lambda-tool/` | `lambda-tool-v1` | 🔧 Ready to freeze | Source app complete — run build-template.mjs to freeze |
| `viverse-multiplayer-runner/` | _(future: dashrunner-v1)_ | 🚧 In progress | DashRunner-based, not yet registered |
| `_archive/battletanks-v1-broken/` | — | ❌ Archived | Broken prototype, kept for reference only |

## Freeze Commands

```bash
# First-time freeze (no existing frozen template to diff against)
node scripts/build-template.mjs --source template-sources/blank-webapp/app --template blank-webapp-v1 --skip-diff
node scripts/build-template.mjs --source template-sources/lambda-tool/app --template lambda-tool-v1 --skip-diff

# Subsequent updates (diff source vs frozen, block on immutable violations)
node scripts/build-template.mjs --source template-sources/blank-webapp/app --template blank-webapp-v1
node scripts/build-template.mjs --source template-sources/lambda-tool/app --template lambda-tool-v1

# Dry run (see what would change without writing)
node scripts/build-template.mjs --source template-sources/tankarena-3d/app --template tankarena-3d-v1 --dry-run
```

## Adding a New Template

1. Create `template-sources/<name>/app/` with the polished source app.
2. Create `templates/<new-id>/template.json` and `TEMPLATE.md` with the contract.
3. Add entry to `templates/registry.json`.
4. Run `build-template.mjs --skip-diff` to do the first freeze.
5. Run `build-template.mjs --dry-run` to verify sync.
6. Add/update the corresponding skill in `viverse-sdk-skills/skills/`.
