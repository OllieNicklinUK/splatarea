# Template Verifier Recovery

Use this when a template-derived workspace has already run through generation/build/publish, but the workflow is blocked on deterministic verification.

## Goal

Fix verifier-only blockers without restarting the workflow.

## Use For

- verifier blocked after publish
- App ID propagation failure
- `dist` still contains placeholder literals
- source contains invalid hardcoded config workaround

## Inputs

- workspace path
- `<workspace>/.agent_state.json`
- `<workspace>/run_report.json`
- exact verifier reason

## Workflow

1. Confirm it is verifier-only
   - publish/build already completed or preview probe passed
   - no missing credentials or runtime crash
2. Extract exact failing lines
   - example: `source contains hardcoded app id literal (js/game/Gameplay.js)`
   - example: `dist still contains placeholder YOUR_APP_ID (dist/assets/index-CP2FkcK3.js)`
3. Patch only the concrete defect
   - keep existing App ID authority
   - stay inside editable surface unless contract change is intentional
4. Rebuild once after a real state change
5. Rerun deterministic verification only
6. Republish only if the shipped bundle actually needs updating

## Decision Rules

- publish succeeded + verifier failed: treat as recovery, not a new run
- hardcoded App ID in source: remove literal, restore env/runtime resolution, rebuild, reverify
- `dist` contains `YOUR_APP_ID`: fix source/env authority, rebuild, reverify
- immutable-path conflict: move fix into allowed adapter/shim or report contract conflict

## Output Format

Report only:
- state change
- exact failing lines
- exact fix applied
- next action

Example:

- state change: verifier moved from `blocked` to `pass`
- exact failing lines:
  - `source contains hardcoded app id literal (js/game/Gameplay.js)`
  - `dist still contains placeholder YOUR_APP_ID (dist/assets/index-CP2FkcK3.js)`
- exact fix applied:
  - removed hardcoded App ID from `js/game/Gameplay.js`
  - rebuilt `dist`
- next action:
  - rerun deterministic verifier only

## Do Not

- rerun the full workflow when verifier is the only blocker
- republish before fixing the local deterministic defect
- rerun identical grep/build commands without state change
- introduce a second App ID authority
- “fix” a verifier blocker by hardcoding the same App ID somewhere else

Success means the verifier blocker is cleared or reduced to one new concrete blocker with an unambiguous next action.
