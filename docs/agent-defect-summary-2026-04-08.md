# Viverse AI Agent Defect Summary

Date: 2026-04-08
Scope: defects found during routing, orchestration, skill enforcement, and end-to-end project execution for the external `viverse-sdk-skills` setup.

## Goal

This document captures the issues found so far and the proper solution for each one. The focus is on durable fixes, not prompt tweaks, retries, or temporary mitigations.

## Defects

### 1. Status questions were routed into execution instead of state lookup

Observed behavior:
- A question like `is verifier completed` triggered a new Architect task instead of returning workflow status.

Root cause:
- Routing classified the message as a generic project continuation.
- The execution layer had no dedicated `STATUS_QUERY` path, so all project-like intents fell into orchestrator planning/execution.

Proper solution:
- Keep a dedicated intent type for `STATUS_QUERY`.
- Resolve status queries through a read-only workflow state service.
- Do not call orchestrator planning or task dispatch for status intents.
- The state service should return:
  - current workflow status
  - pending/completed/failed/blocked counts
  - latest verifier status
  - current pending task
  - selected workspace / `req_*`

Target architecture:
- `Phase0Router` decides `STATUS_QUERY | EXECUTION | GENERAL_QA`
- `WorkflowStateService` handles status reads
- `OrchestratorService` handles only planning/execution

### 2. Routing originally depended too much on heuristics

Observed behavior:
- Natural follow-up questions were not reliably understood.
- The user had to worry about wording instead of relying on intent understanding.

Root cause:
- The first phase router was deterministic and phrase-based.
- Heuristics are acceptable for obvious resume/continue cases, but not for ambiguous natural language.

Proper solution:
- Use hybrid routing:
  - heuristics only for high-confidence trivial cases
  - LLM router for ambiguous cases
- Require strict structured output from the router:
  - `route`
  - `phase0Mode`
  - `targetAgent`
  - `intentType`
  - `confidence`
  - `reason`
- Track decision source and confidence for observability.

### 3. Skill enforcement design was coupled to natural-language response formatting

Observed behavior:
- Tasks failed with errors such as:
  - `Missing [SKILL_LOAD_REPORT] section in agent response`
  - `Missing skill load entry for 'viverse-resilience-guide.md'`
- Implementation could be correct while the task still failed on report formatting.

Root cause:
- Enforcement depended on parsing the model's final natural-language response.
- The model could implement correctly but format the report incorrectly, incompletely, or inconsistently.

Proper solution:
- Remove skill compliance as a natural-language postcondition.
- Record skill loading/compliance as structured runtime artifacts produced by the tool/execution layer.
- Every `loadSkill` call should emit a machine-readable event with:
  - requested ref
  - resolved path
  - success/failure
  - error text
- Enforcement should validate against those structured artifacts, not the model summary text.

Required implementation direction:
- Add a skill-execution ledger to the workspace state or task artifacts.
- Let coder/reviewer/verifier optionally summarize results in prose, but never use that prose as the source of truth.

### 4. Skill enforcement policy conflicted with role capabilities

Observed behavior:
- Architect and other non-coder roles were forced to satisfy the same strict skill-report gate as coder tasks.

Root cause:
- The enforcement block required all technical roles to load/report skills.
- Some roles had conflicting output contracts, especially strict JSON roles.
- Some roles also lacked the necessary tools at the time of enforcement.

Proper solution:
- Separate two concerns:
  - skill grounding requirement
  - hard release gate
- Only apply hard skill enforcement to roles where it is operationally meaningful, or preferably enforce it centrally via the runtime ledger.
- Ensure any role that is expected to load skills actually has `loadSkill`.

Long-term fix:
- Replace role-specific report parsing with a central enforcement service that reads execution artifacts.

### 5. Root-level skill loading is ambiguous for `viverse-resilience-guide.md`

Observed behavior:
- The coder reported `viverse-resilience-guide.md: BLOCKED - File not found`
- The file actually exists at:
  - `/Users/casper_wang/Projects/AI/viverse-sdk-skills/skills/viverse-resilience-guide.md`

Root cause:
- Root-level skill files are represented differently from folder-based skills.
- The required ref is `. / viverse-resilience-guide.md` logically, but model/tool usage can drift into treating it like a folder skill.
- This creates ambiguity in reporting and possibly in tool invocation.

Proper solution:
- Normalize skill identities before they reach the model and tool layer.
- Introduce a canonical skill reference schema:
  - folder skill: `skill:<name>/SKILL.md`
  - root file skill: `file:viverse-resilience-guide.md`
- `loadSkill` should accept only canonical refs and return canonical refs.
- The orchestrator should never expose ambiguous raw path semantics to the model.

Required implementation direction:
- Add canonical ref encoding/decoding in `SkillProvider`
- Update enforcement and routing to use canonical refs end-to-end

### 6. Skill load validation was too brittle

Observed behavior:
- A task could fail even when the report clearly referred to the right skill, because the exact string did not match.

Root cause:
- Validation required exact textual matches on refs and statuses.
- Differences such as `.md`, markdown formatting, or shorthand refs caused false negatives.

Proper solution:
- Use canonical refs internally.
- Validate only canonical refs from structured artifacts.
- Eliminate regex-based interpretation of human-formatted bullets as the authoritative source.

Note:
- Alias matching can reduce false negatives, but it is still not the final design. Canonical structured reporting is the correct fix.

### 7. Planner schema quality is inconsistent (`isNewProject` became `undefined`)

Observed behavior:
- Log showed `Orchestrator: Plan generated. isNewProject: undefined`

Root cause:
- Planner output schema is not enforced strongly enough before it enters orchestration.
- The plan parser accepts incomplete planner output.

Proper solution:
- Add strict planner schema validation before task creation.
- Reject or auto-repair planner output missing required fields.
- Required planner fields should include:
  - `isNewProject: boolean`
  - `tasks: array`
  - task `id`, `role`, `prompt`, `dependsOn`

Required implementation direction:
- Use a schema validator for planner output.
- If the planner output is invalid, trigger a planner retry with explicit schema error feedback.

### 8. Coder explored non-existent skill cache paths inside the workspace

Observed behavior:
- The coder ran commands like:
  - `ls -R .viverse_workspaces/skill_cache/viverse-template-generation`
  - `grep -r "redpointfish-v1" .viverse_workspaces/skill_cache/`
- Those paths do not exist in the project workspace.

Root cause:
- The model inferred a local skill cache layout that is not part of the actual runtime contract.
- There is no explicit “where skills live / how to inspect them” contract exposed to the agent.

Proper solution:
- Do not let the model infer skill storage paths.
- Expose a dedicated read-only tool for skill inspection:
  - `loadSkill(ref)`
  - optional `listSkillRefs()`
- Remove any need for shell-based discovery of skill storage.
- Agent instructions should explicitly forbid filesystem guessing for skill sources.

### 9. Template/project scaffolding is not deterministic

Observed behavior:
- The coder scaffolded with `create-vite` and then had to repair the workspace repeatedly.
- The generated project had dependency/config mismatches:
  - missing `@vitejs/plugin-react-swc`
  - `postcss.config.cjs` containing ESM `export default`

Root cause:
- The agent is freehand assembling the scaffold instead of consuming a locked template contract.
- The template does not provide a deterministic, validated starter with dependency/config integrity.

Proper solution:
- Move project generation to a versioned template artifact, not ad hoc shell scaffolding.
- Each template must provide:
  - locked `package.json`
  - locked `vite.config.*`
  - locked PostCSS/Tailwind config
  - contract for required environment variables
  - smoke-tested build output
- The coder should clone/copy the template and then modify only application-specific files.

Required implementation direction:
- Treat `redpointfish-v1` as a true generation template with validated starter files
- Add template certification checks before a template is made available

### 10. Build pipeline config compatibility is broken

Observed behavior:
- Build failed because `vite.config.js` referenced `@vitejs/plugin-react-swc` before the dependency was installed.
- Build failed because `postcss.config.cjs` used ESM syntax.

Root cause:
- The scaffold/config stack is internally inconsistent.
- The template/build setup is not validated as a coherent unit.

Proper solution:
- Validate template build stack as an atomic package.
- Standardize on one module system per config file.
- Add a preflight validator that checks:
  - referenced plugins exist in dependencies
  - config file extension matches syntax
  - Tailwind/PostCSS/Vite versions are compatible

Required implementation direction:
- Add a deterministic scaffold validation step before coding begins.
- Fail early with actionable template validation errors instead of allowing the coder to discover them by trial and error.

### 11. Tool-loop recovery is working, but the system still enters unnecessary loops

Observed behavior:
- The coder hit `MAX_TOOL_ITERATIONS_REACHED`
- Recovery task was scheduled and work continued

Root cause:
- The task flow allowed repeated probing and repair attempts inside one broad coder task.
- The model continued exploring verification paths instead of operating inside a bounded state machine.

Proper solution:
- Break broad coder tasks into deterministic sub-stages with explicit exit criteria:
  1. app creation / app id capture
  2. scaffold integrity
  3. source implementation
  4. build
  5. app-id propagation verification
  6. publish
- Each stage should have bounded allowed commands and bounded retries.
- The orchestrator should own stage transitions; the coder should not improvise global workflow progression.

### 12. Compliance success and task status can contradict each other in user-facing output

Observed behavior:
- The chat showed implementation success, build success, and `PASS` items, followed by:
  - `Coder task failed`

Root cause:
- The system streams model summary text before final deterministic gates complete.
- User-visible “success” content is emitted before task status is finalized.

Proper solution:
- Separate provisional execution summaries from final task outcome.
- Do not emit success-framed completion summaries until deterministic gates have passed.
- Mark in-progress summaries explicitly as provisional.

Required implementation direction:
- Add a two-phase output model:
  - phase A: work summary / provisional findings
  - phase B: final gate result / task status
- Only phase B should decide user-visible success/failure wording.

## Cross-Cutting Fix Program

These problems should be solved as one coherent redesign, not isolated patches.

### A. Introduce canonical skill identity and a runtime skill ledger

Build:
- canonical skill refs
- structured `loadSkill` artifacts
- centralized enforcement against the ledger

This eliminates:
- false missing-skill failures
- report-format brittleness
- root-level file ambiguity
- contradictory BLOCKED/PASS outputs

### B. Separate intent routing, workflow state reading, and execution

Build:
- `Phase0Router`
- `WorkflowStateService`
- `OrchestratorService`

This eliminates:
- status queries launching new tasks
- overloading orchestrator with both state reads and execution logic
- heuristic-only misrouting

### C. Replace freehand project scaffolding with certified templates

Build:
- locked template artifacts
- template certification checks
- scaffold preflight validation

This eliminates:
- dependency/config drift
- repeated scaffold repair loops
- build failures caused by invalid starter state

### D. Convert the coder workflow into bounded orchestrator-owned stages

Build:
- explicit stage machine
- per-stage acceptance criteria
- bounded retries

This eliminates:
- tool-call loops
- over-broad coder tasks
- late discovery of configuration/build defects

## Recommended Research Task Topics

1. Canonical skill reference model and structured skill-ledger enforcement.
2. Workflow state service and read-only status query architecture.
3. Planner schema validation and repair policy.
4. Certified template pipeline for `redpointfish-v1` and future templates.
5. Staged orchestration model for coder/verifier execution.

