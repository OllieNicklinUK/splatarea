# Viverse AI Agent Server Refactor Plan

Date: 2026-04-08
Inputs:
- `docs/agent-defect-summary-2026-04-08.md`
- Research theme: persistent auto-verify, auto-fix, and resume-until-complete behavior
- Current implementation surfaces:
  - `src/controllers/aiController.js`
  - `src/services/Phase0RoutingService.js`
  - `src/services/OrchestratorService.js`
  - `src/services/SkillProvider.js`
  - `src/services/GeminiService.js`
  - `src/services/templates/*`

## 1. Executive Summary

The current server already contains pieces of the right architecture:
- a phase-0 router
- a status-query path
- an orchestrator
- template services
- tool-loop recovery hooks

But the system still stops too easily because completion semantics are not owned by a deterministic runtime state machine. Too much responsibility still sits in:
- model prose
- broad coder tasks
- heuristic recovery
- late-stage gates

The core refactor is not "make prompts stronger." The core refactor is:
- move source-of-truth state out of natural-language outputs
- convert execution into bounded orchestrator-owned stages
- add a persistent verification/fix loop with resume checkpoints
- add a context extraction and compaction layer so resume does not depend on replaying long chat history
- make status reads and execution use different services
- make skills and template validity machine-verifiable

## 2. Consolidated Problem Statement

The defect summary and the new research point to one root issue:

The agent server lacks a single durable execution contract that says:
- what step is active
- what counts as done
- what must be verified next
- what failed last
- whether the system should retry, repair, resume, or stop

That missing contract causes several symptoms that look separate but are actually coupled:
- status queries can drift into execution logic
- routing confidence is inconsistent
- skill compliance depends on prose formatting
- planner output can enter orchestration partially invalid
- coder tasks sprawl across too many subgoals
- scaffold defects are discovered too late
- verification loops are reactive instead of designed
- long histories and tool traces bloat prompt context and make continuation less reliable
- resumed runs rely too much on replayed chat text instead of compact durable state
- user-visible success text can contradict final task state
- interrupted workflows do not reliably resume from the last incomplete stage

## 3. Target Architecture

### A. Request Control Plane

Separate request interpretation from workflow state and execution.

Target responsibilities:
- `Phase0RoutingService`
  - classify `GENERAL_QA | STATUS_QUERY | EXECUTION`
  - use heuristics for high-confidence trivial cases only
  - use LLM routing for ambiguous requests
  - emit structured routing metadata with confidence and decision source
- `WorkflowStateService`
  - read-only workflow lookup
  - return current stage, task counts, last verifier result, blockers, active workspace, latest run status
  - never schedule work
- `OrchestratorService`
  - plan and execute only
  - own stage transitions, retries, checkpoint persistence, and final outcome

Why this matters:
- fixes defects 1 and 2
- prevents execution logic from absorbing status and continuation semantics

### B. Durable Workflow State Model

The current system persists workflow state, but not at the right granularity for completion loops.

Add explicit runtime state:
- `workflow.status`
  - `pending | running | blocked | failed | completed`
- `workflow.currentStage`
  - `plan | scaffold | implement | build | verify | publish | finalize`
- `workflow.stageStatus`
  - map of per-stage state and timestamps
- `workflow.lastFailure`
  - stage
  - taskId
  - category
  - reason
  - retryCount
- `workflow.nextAction`
  - deterministic next orchestrator step
- `workflow.checkpoints[]`
  - ordered snapshots of state transitions
- `workflow.contextPackets[]`
  - compact stage-scoped context snapshots derived from history, artifacts, and ledgers
- `workflow.verificationLedger[]`
  - structured results from build/test/probe/reviewer/verifier gates
- `workflow.skillLedger[]`
  - structured skill load and enforcement artifacts

Design rule:
- the model may summarize state
- only the runtime ledger decides state

Why this matters:
- fixes the root cause behind stop-without-resume behavior
- enables true resume from last failed or incomplete gate

### C. Workflow Context Extraction and Compaction

The runtime needs a dedicated mechanism for cutting context, extracting durable state, and rebuilding the minimum useful prompt for the next step.

This is the part of the research that is adjacent to the `claw-code` workflow philosophy and should be represented explicitly in the server design.

Build a `WorkflowContextService` with three responsibilities:
- `extract`
  - convert chat history, tool traces, planner output, stage artifacts, and verifier results into structured durable facts
- `compact`
  - produce a minimal execution packet for the next model call instead of replaying the full conversational transcript
- `rehydrate`
  - on resume, rebuild the stage-specific working context from checkpoints and ledgers rather than from raw history alone

Recommended extracted context fields:
- request id / workspace id
- current stage
- accepted plan summary
- active task id and role
- files touched
- required skills loaded
- latest verification results
- last failure classification
- retry counts and remaining budget
- blockers
- authoritative next action

Design rules:
- long tool output should become artifacts plus summaries, not repeated prompt payload
- prior chat turns are secondary evidence once durable state has been extracted
- stage transitions should write a fresh compact context packet
- resume should prefer the latest valid packet for the current stage

Why this matters:
- reduces prompt bloat and context-window drift
- makes continuation less dependent on fragile chat replay
- improves reliability of auto-resume and verify-fix loops
- gives the system a durable replacement for "remember what happened"

### D. Orchestrator-Owned Stage Machine

Replace broad coder tasks with bounded stages and explicit exit criteria.

Recommended first stage machine for app-generation / app-fix flows:
1. `plan`
2. `scaffold_preflight`
3. `implement`
4. `build_verify`
5. `runtime_verify`
6. `publish`
7. `finalize`

For each stage, define:
- allowed tools
- required inputs
- required artifacts
- acceptance checks
- max retries
- fallback or escalation path

Example:
- `scaffold_preflight`
  - inputs: template id, workspace path, baseline config
  - checks:
    - dependency/config consistency
    - required plugins exist
    - config syntax matches extension
  - exit:
    - `pass` -> `implement`
    - `fail_repairable` -> repair within stage budget
    - `fail_blocking` -> stop as blocked

Why this matters:
- fixes defects 9, 10, 11
- gives the server a deterministic place to continue after interruption

### E. Persistent Verify-Fix-Resume Loop

This is the missing architectural concept you were asking about.

Add an explicit completion loop contract:
- after every meaningful code-modifying stage, run the narrowest relevant verification
- if verification fails, classify the failure
- if repairable, create a bounded fix iteration tied to the same stage
- rerun verification
- continue until:
  - stage acceptance passes
  - retry budget is exhausted
  - or a true blocker is reached

Important rule:
- retries belong to the orchestrator stage machine, not to open-ended model improvisation

Failure classification:
- `schema_error`
- `template_error`
- `tool_loop`
- `build_error`
- `runtime_error`
- `compliance_error`
- `external_infra_error`
- `permission_block`
- `requirements_block`

Resume rule:
- on restart or user "continue", resume from the latest incomplete stage
- if a stage failed and retry budget remains, continue from that stage's repair path
- do not restart planning unless the request changed materially

Why this matters:
- addresses the exact symptom that the agent stops and does not carry itself to completion
- converts "be persistent" from a prompt wish into runtime behavior

### F. Canonical Skill Identity and Structured Skill Ledger

The defect summary is correct: skill enforcement cannot depend on prose.

Build:
- canonical skill refs
  - folder skill: `skill:<name>/SKILL.md`
  - root file skill: `file:<name>.md`
- `SkillProvider` ref normalization and resolution
- `loadSkill` event emission into a runtime ledger
- centralized enforcement using ledger artifacts only

Each skill artifact should capture:
- requested ref
- canonical ref
- resolved path
- role
- taskId
- timestamp
- success/failure
- error text if any

Design rule:
- agent text is informational only
- skill compliance is evaluated from runtime artifacts

Why this matters:
- fixes defects 3, 4, 5, 6, 8

### G. Planner Schema Enforcement and Repair

The planner must not be allowed to emit partial state into orchestration.

Add:
- strict planner schema validator
- normalization layer
- planner retry on schema failure with targeted feedback
- hard rejection of missing required fields

Required minimum fields:
- `isNewProject: boolean`
- `tasks: []`
- task `id`
- task `role`
- task `prompt`
- task `dependsOn`

Design rule:
- invalid plan output is a planner failure, not an orchestrator inference opportunity

Why this matters:
- fixes defect 7
- prevents undefined state from contaminating the rest of the workflow

### H. Certified Templates and Scaffold Preflight

You already have template services. Use them as a hard front door.

Before coding begins:
- resolve template
- validate certification
- validate scaffold stack as an atomic unit
- fail early on inconsistent template state

Template certification should verify:
- locked dependency graph
- buildable starter
- config syntax/extensions align
- required environment contract exists
- baseline smoke checks pass

Design rule:
- no freehand `create-vite` scaffolding when a certified template exists

Why this matters:
- fixes defects 9 and 10
- reduces wasted tool iterations downstream

### I. Two-Phase User Output Model

Do not let streamed optimistic text become the user-facing source of truth.

Split output into:
- provisional work log
- final gate result

Rules:
- intermediate messages must be explicitly provisional
- success wording is allowed only after deterministic gates pass
- final task status comes from workflow state, not model tone

Why this matters:
- fixes defect 12

## 4. What Should Be Prompted vs What Must Be Enforced in Code

Prompt-level guidance is still useful, but only as a local behavior hint.

Safe to keep in prompts:
- "after code changes, run the narrowest relevant verification"
- "do not stop at analysis when execution is possible"
- "resume from the last failed verification step"
- "do not guess skill locations; use tools"

Must move into runtime/code:
- stage ownership
- retry budgets
- status source of truth
- context extraction and compact resume packets
- skill compliance source of truth
- planner schema validation
- template certification gate
- final success/failure determination
- resume checkpoint selection

If you only update prompts, the server will still stop unpredictably because the stopping condition is still model-defined.

## 5. Concrete Module Refactor Map

### `src/controllers/aiController.js`

Keep:
- early phase-0 decision
- dedicated status-query branch

Change:
- route status requests exclusively through a new `WorkflowStateService`
- stop using orchestrator as both executor and workflow reader
- standardize streaming events so provisional vs final states are explicit

### `src/services/Phase0RoutingService.js`

Keep:
- hybrid heuristic + LLM routing direction

Change:
- tighten fallback rules so active-workflow defaulting does not absorb ambiguous questions too aggressively
- emit richer observability fields for final route decisions
- use workflow-state hints when available

### `src/services/OrchestratorService.js`

Primary refactor target.

Change:
- split execution into stage handlers
- persist `currentStage`, `nextAction`, `lastFailure`, retry budgets, verification ledger
- consume compact stage context packets instead of relying on raw long-form history
- own verify-fix-resume loop
- stop deriving final truth from free-form agent summaries
- move skill enforcement to artifact-based validation
- separate planner validation from plan execution

### `src/services/SkillProvider.js`

Change:
- add canonical ref parser/formatter
- distinguish folder skills and root-file skills explicitly
- expose list/resolve APIs that do not leak raw filesystem assumptions to the model

### `src/services/GeminiService.js`

Change:
- instrument `loadSkill` and other key tools to emit structured execution artifacts
- surface repeated-tool-loop errors as stage-level failure classifications
- support prompt assembly from compact workflow context packets plus current-stage artifacts
- avoid relying on model summaries for compliance

### `src/services/templates/*`

Change:
- promote certification and preflight validation into required orchestrator gates
- reject uncertified or inconsistent starter states before implementation begins

### New module: `src/services/WorkflowStateService.js`

Responsibilities:
- read-only workflow status summaries
- current stage / pending task / last verifier / blockers / workspace id
- status formatting for UI/API

### New module: `src/services/WorkflowContextService.js`

Responsibilities:
- extract durable facts from history, tool output, ledgers, and artifacts
- produce compact context packets per stage
- provide rehydration input for resume and continuation calls

### Optional new module: `src/services/WorkflowStageService.js`

Responsibilities:
- stage definitions
- transition rules
- retry budgets
- checkpoint writes

## 6. Phased Rollout Plan

### Phase 1. Stabilize control-plane truth

Scope:
- introduce `WorkflowStateService`
- make status queries read-only end-to-end
- add planner schema validation
- mark streamed outputs as provisional until final gates complete

Expected outcome:
- status no longer launches work
- undefined planner fields stop at source
- user-visible contradictions decrease immediately

### Phase 2. Add context extraction and compact resume packets

Scope:
- introduce `WorkflowContextService`
- define compact packet schema
- write packet snapshots at stage boundaries
- resume from packet + ledgers instead of full chat replay

Expected outcome:
- continuation depends less on fragile long histories
- resumed tasks start from precise extracted state
- prompt context stays smaller and more stable

### Phase 3. Replace prose-based skill enforcement

Scope:
- canonical skill refs
- skill ledger artifacts
- central artifact-based enforcement
- forbid filesystem guessing for skill discovery

Expected outcome:
- false skill failures collapse sharply
- root-level skill files become deterministic

### Phase 4. Introduce orchestrator stage machine

Scope:
- define stage model
- refactor broad coder tasks into bounded stages
- persist per-stage state and retry counts
- map `MAX_TOOL_ITERATIONS_REACHED` and similar errors to stage-local repair flows

Expected outcome:
- tool loops reduce
- the system resumes from a precise stage instead of restarting or stalling

### Phase 5. Add persistent verify-fix-resume behavior

Scope:
- verification ledger
- failure classification
- bounded repair retries per stage
- checkpoint-based resume selection

Expected outcome:
- "continue" actually resumes meaningful unfinished work
- verification becomes the driver of completion, not the last text response

### Phase 6. Enforce certified template front door

Scope:
- require certified templates for supported project types
- scaffold preflight before implementation
- fail early on dependency/config incompatibility

Expected outcome:
- repeated scaffold repair loops drop
- downstream build/runtime failures start from a cleaner baseline

## 7. Priority Order

Recommended implementation order:
1. `WorkflowStateService` + read-only status path hardening
2. planner schema validation
3. provisional vs final output separation
4. `WorkflowContextService` + compact resume packet schema
5. canonical skill refs + skill ledger
6. orchestrator stage machine
7. verification ledger + auto-resume loop
8. template certification as mandatory preflight

Reason:
- the first three reduce user-facing confusion quickly
- the next two fix invalid source-of-truth and context-carry problems
- the last three solve the deeper execution completion problem

## 8. Acceptance Criteria

The refactor should be considered successful only if these behaviors hold:

1. A question like `is verifier completed` never creates a new execution task.
2. A resumed workflow continues from the last incomplete stage, not from generic planning.
3. A resumed workflow uses extracted stage context and ledger state rather than depending on full chat replay.
4. A coder/reviewer/verifier cannot fail only because a prose skill report was formatted incorrectly.
5. `isNewProject` cannot be `undefined` after planner parsing.
6. A certified template failure is detected before implementation begins.
7. A build or runtime failure creates a bounded repair loop with visible retry state.
8. User-facing success wording appears only after final deterministic gates pass.
9. Workflow status can always show:
   - current stage
   - pending/completed/failed counts
   - last verifier result
   - active workspace / request id
   - latest blocker or next action

## 9. Recommended First Deliverable

Do not start with the biggest rewrite. Start with a vertical slice:

- add `WorkflowStateService`
- add planner schema validation
- add provisional/final output states
- add `WorkflowContextService` with a minimal compact packet
- add orchestrator `currentStage` persistence with a minimal stage model:
  - `plan`
  - `implement`
  - `verify`
  - `finalize`

That first slice is enough to prove the new control model and to stop the most obvious premature-stop behavior before the deeper skill/template refactors land.
