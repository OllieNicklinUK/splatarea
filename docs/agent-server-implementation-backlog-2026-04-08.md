# Agent Server Implementation Backlog

Date: 2026-04-08
Scope: convert the refactor and `claw-code` research plans into an execution backlog for the Viverse agent server.

Source docs:
- [agent-defect-summary-2026-04-08.md](/Users/casper_wang/Projects/AI/viverse-ai-agent/docs/agent-defect-summary-2026-04-08.md)
- [agent-server-refactor-plan-2026-04-08.md](/Users/casper_wang/Projects/AI/viverse-ai-agent/docs/agent-server-refactor-plan-2026-04-08.md)
- [claw-code-derived-implementation-plan-2026-04-08.md](/Users/casper_wang/Projects/AI/viverse-ai-agent/docs/claw-code-derived-implementation-plan-2026-04-08.md)

Current repo constraint:
- [`package.json`](/Users/casper_wang/Projects/AI/viverse-ai-agent/package.json) has no usable automated test suite yet. The current `test` script exits with error by design.

## 1. Delivery Strategy

Execution order should optimize for:
- establishing machine-readable truth first
- reducing regression risk early
- avoiding a giant `OrchestratorService.js` rewrite before replacement abstractions exist

Recommended milestone order:
1. baseline contracts and harness setup
2. workflow truth and status separation
3. context extraction and prompt budget control
4. planner and task packet hardening
5. skill and verification ledgers
6. recovery policy and stage machine
7. template preflight enforcement
8. final cleanup and observability tightening

## 2. Workstreams

### Workstream A. Test Harness and Baseline Contracts

Goal:
- create enough regression coverage to refactor safely

Priority:
- `P0`

Tasks:
- `A1` Add a real Node test runner and wire `npm test`.
- `A2` Create service-level tests for `Phase0RoutingService`.
- `A3` Create orchestration fixture tests for:
  - status query remains read-only
  - planner schema rejection
  - resume from latest incomplete stage
  - skill-load artifact recording
- `A4` Add deterministic fixtures for current known defect cases from the defect summary.
- `A5` Add a small fake provider / fake tool harness for orchestrator unit-style tests.

Likely files:
- [`package.json`](/Users/casper_wang/Projects/AI/viverse-ai-agent/package.json)
- new `tests/` directory
- new `tests/fixtures/`
- new `tests/helpers/`

Dependencies:
- none

Exit criteria:
- `npm test` runs
- at least 5 defect-summary regressions have executable coverage

Risk:
- medium

### Workstream B. Workflow Truth and Status Path

Goal:
- make workflow state authoritative and status queries read-only

Priority:
- `P0`

Tasks:
- `B1` Add `WorkflowStateService` with a normalized workflow summary schema.
- `B2` Move status formatting and read-only state lookup out of `OrchestratorService`.
- `B3` Update `aiController` to use `WorkflowStateService` exclusively for `STATUS_QUERY`.
- `B4` Add typed workflow status payloads for both streaming and JSON responses.
- `B5` Add provisional vs final response markers in stream events.

Likely files:
- [`src/controllers/aiController.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/controllers/aiController.js)
- [`src/services/OrchestratorService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- new [`src/services/WorkflowStateService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/WorkflowStateService.js)

Dependencies:
- `A1-A3`

Exit criteria:
- status queries never schedule execution work
- workflow status can always show stage, counts, blocker, latest verifier, workspace/request id

Risk:
- medium

### Workstream C. Workflow Events and Context Packets

Goal:
- replace history replay with compact extracted execution context

Priority:
- `P0`

Tasks:
- `C1` Add `WorkflowEventService` with typed event emission helpers.
- `C2` Define `WorkflowContextPacket` schema.
- `C3` Add `WorkflowContextService.extract()` from:
  - chat history
  - planner output
  - task results
  - verification artifacts
  - skill artifacts
- `C4` Add `WorkflowContextService.compact()` for stage-scoped prompt assembly.
- `C5` Add `WorkflowContextService.rehydrate()` for resume.
- `C6` Add prompt-budget checks before model calls.
- `C7` Store compact packets on stage transitions and after failures.

Likely files:
- [`src/services/GeminiService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/GeminiService.js)
- [`src/services/OrchestratorService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- new [`src/services/WorkflowEventService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/WorkflowEventService.js)
- new [`src/services/WorkflowContextService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/WorkflowContextService.js)

Dependencies:
- `B1-B4`

Exit criteria:
- resumed tasks use compact stage context instead of raw history replay
- oversized prompt assemblies are compacted or rejected deterministically

Risk:
- high

### Workstream D. Planner Validation and Typed Task Packets

Goal:
- harden the boundary between planning and execution

Priority:
- `P0`

Tasks:
- `D1` Add `PlannerSchemaValidator`.
- `D2` Define `TaskPacket` schema with:
  - objective
  - role
  - scope
  - workspace
  - acceptance checks
  - retry policy
  - escalation policy
  - reporting contract
- `D3` Validate planner output before task creation.
- `D4` Retry planner once or twice with targeted schema feedback on invalid output.
- `D5` Convert internal dispatch from loose prompt text to structured task packets.
- `D6` Update role prompt assembly to consume task packets.

Likely files:
- [`src/services/OrchestratorService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- [`src/services/AgentRegistry.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/AgentRegistry.js)
- new [`src/services/PlannerSchemaValidator.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/PlannerSchemaValidator.js)

Dependencies:
- `A3`
- `C2-C4`

Exit criteria:
- `isNewProject` cannot become `undefined`
- task dispatch always contains explicit acceptance checks and retry policy

Risk:
- high

### Workstream E. Skill Ledger and Canonical Skill Identity

Goal:
- remove prose-based skill enforcement and filesystem guessing

Priority:
- `P1`

Tasks:
- `E1` Add canonical skill ref format:
  - `skill:<name>/SKILL.md`
  - `file:<name>.md`
- `E2` Extend `SkillProvider` to normalize and resolve canonical refs.
- `E3` Add `SkillLedgerService`.
- `E4` Emit structured `loadSkill` artifacts from tool execution.
- `E5` Replace report-text parsing with artifact-based validation.
- `E6` Add optional `listSkillRefs()` surface for safe skill inspection.
- `E7` Remove assumptions that skills live in guessed workspace cache paths.

Likely files:
- [`src/services/SkillProvider.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/SkillProvider.js)
- [`src/services/GeminiService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/GeminiService.js)
- [`src/services/OrchestratorService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- new [`src/services/SkillLedgerService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/SkillLedgerService.js)

Dependencies:
- `C1-C3`

Exit criteria:
- skill failures come from ledger truth, not final message formatting
- root-file skills resolve deterministically

Risk:
- medium

### Workstream F. Verification Ledger and Final Gate Truth

Goal:
- make test/build/probe outcomes machine-readable and resumable

Priority:
- `P1`

Tasks:
- `F1` Add `VerificationLedgerService`.
- `F2` Normalize artifact records for:
  - build results
  - preview probe results
  - reviewer/verifier outcomes
  - compliance checks
- `F3` Add final gate computation from verification ledger.
- `F4` Feed final gate truth into workflow status and final user messaging.
- `F5` Store latest verifier state and latest passing checkpoint in workflow state.

Likely files:
- [`src/services/OrchestratorService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- [`src/services/PreviewAutoTestService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/PreviewAutoTestService.js)
- [`src/services/BrowserRuntimeTestService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/BrowserRuntimeTestService.js)
- [`src/services/ComplianceService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/ComplianceService.js)
- new [`src/services/VerificationLedgerService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/VerificationLedgerService.js)

Dependencies:
- `B1-B5`
- `C1-C3`

Exit criteria:
- final success wording is impossible before verification ledger says pass
- latest verifier/build/probe state is visible in workflow status

Risk:
- medium

### Workstream G. Recovery Policy and Failure Taxonomy

Goal:
- stop random loops and turn repair into bounded policy

Priority:
- `P1`

Tasks:
- `G1` Define normalized failure taxonomy.
- `G2` Add `WorkflowPolicyService` with recovery recipes and retry budgets.
- `G3` Map known errors into taxonomy:
  - `MAX_TOOL_ITERATIONS_REACHED`
  - `CONVERGENCE_GUARD`
  - planner schema errors
  - template preflight failures
  - provider/network failures
  - runtime probe failures
- `G4` Emit recovery-attempt events and retry counters.
- `G5` Stop repeated recovery when no code-state change or no new evidence exists.

Likely files:
- [`src/services/OrchestratorService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- [`src/services/GeminiService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/GeminiService.js)
- new [`src/services/WorkflowPolicyService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/WorkflowPolicyService.js)

Dependencies:
- `C1`
- `F1-F3`

Exit criteria:
- repairable failures retry automatically within explicit budgets
- non-repairable failures surface as blockers with machine-readable reasons

Risk:
- high

### Workstream H. Stage Machine Refactor

Goal:
- move completion semantics into orchestrator-owned stages

Priority:
- `P1`

Tasks:
- `H1` Define stage enum:
  - `plan`
  - `scaffold_preflight`
  - `implement`
  - `build_verify`
  - `runtime_verify`
  - `publish`
  - `finalize`
- `H2` Add stage transition rules and checkpoints.
- `H3` Move current ad hoc task-type inference into stage handlers.
- `H4` Attach per-stage allowed tools, acceptance checks, and retry budgets.
- `H5` Persist `currentStage`, `nextAction`, `lastFailure`, `retryCounts`.
- `H6` Resume from latest incomplete or repairable stage.

Likely files:
- [`src/services/OrchestratorService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- optional new [`src/services/WorkflowStageService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/WorkflowStageService.js)

Dependencies:
- `D1-D5`
- `F1-F4`
- `G1-G4`

Exit criteria:
- broad coder tasks no longer own global workflow progression
- `continue` resumes exact unfinished stage

Risk:
- very high

### Workstream I. Template Front Door and Scaffold Preflight

Goal:
- prevent bad starter states from reaching implementation

Priority:
- `P2`

Tasks:
- `I1` Add mandatory template certification check before implementation.
- `I2` Add scaffold preflight validator for dependency/config coherence.
- `I3` Standardize module system checks for Vite/PostCSS/Tailwind configs.
- `I4` Reject or repair starter-state defects before coder stage begins.
- `I5` Add template certification metadata to workflow and status surfaces.

Likely files:
- [`src/services/templates/TemplateRegistryService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/templates/TemplateRegistryService.js)
- [`src/services/templates/TemplateCertificationService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/templates/TemplateCertificationService.js)
- [`src/services/templates/TemplateContractService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/templates/TemplateContractService.js)
- [`src/services/OrchestratorService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)

Dependencies:
- `H1-H4`

Exit criteria:
- template/config mismatch is detected before implementation starts

Risk:
- medium

### Workstream J. Observability and Cleanup

Goal:
- make the new control model debuggable

Priority:
- `P2`

Tasks:
- `J1` Add structured logs for route decision, stage transition, verification result, recovery attempt, final outcome.
- `J2` Remove obsolete prose-based enforcement helpers.
- `J3` Add developer docs for new workflow state, ledgers, and recovery policy.
- `J4` Add a machine-readable diagnostics endpoint or debug dump for workflow state.

Likely files:
- [`src/utils/logger.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/utils/logger.js)
- [`src/services/OrchestratorService.js`](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- `docs/`

Dependencies:
- `B` through `I`

Exit criteria:
- a stalled or failed run can be diagnosed from structured state and logs alone

Risk:
- low

## 3. Suggested Milestone Cuts

### Milestone 1. Safe Control Plane

Includes:
- `A1-A4`
- `B1-B5`
- `D1-D4`

Outcome:
- read-only status
- planner hardening
- basic regression safety net

### Milestone 2. Resume Reliability

Includes:
- `C1-C7`
- `D5-D6`

Outcome:
- compact context packets
- better continuation and prompt-budget safety

### Milestone 3. Artifact Truth

Includes:
- `E1-E7`
- `F1-F5`

Outcome:
- skills and verification become machine-readable source of truth

### Milestone 4. Bounded Recovery

Includes:
- `G1-G5`
- `H1-H6`

Outcome:
- real verify-fix-retry loops
- stage-owned completion semantics

### Milestone 5. Deterministic Generation Front Door

Includes:
- `I1-I5`
- `J1-J4`

Outcome:
- invalid templates fail early
- new system is diagnosable and reviewable

## 4. Dependency Map

Critical path:
- `A -> B -> C -> D -> F -> G -> H -> I`

Parallelizable slices:
- `E` can start after `C`
- `J` can start incrementally after `B`

## 5. Review Checklist

Use this for PR review across the backlog:

1. Does this change move truth from prose into structured state?
2. Does this change reduce `OrchestratorService` ambiguity instead of adding more ad hoc branching?
3. Can the resulting state survive interruption and support resume?
4. Is there a deterministic acceptance criterion for the new behavior?
5. Is there a regression test or fixture for the defect class being fixed?
6. Does the change avoid expanding the model prompt with raw logs/history unnecessarily?
7. Does it distinguish `blocked`, `failed`, and `still running` correctly?

## 6. First PR Recommendation

Recommended first PR:
- add a real test runner
- add `WorkflowStateService`
- route `STATUS_QUERY` through it
- add typed workflow summary schema
- add tests for status-query non-execution behavior

Reason:
- smallest high-value slice
- immediately addresses one confirmed defect
- creates the foundation for later context/resume and stage-machine work
