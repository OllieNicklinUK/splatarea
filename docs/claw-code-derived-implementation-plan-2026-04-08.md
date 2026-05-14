# Claw-Code Derived Implementation Plan

Date: 2026-04-08
Purpose: summarize the `claw-code` features worth porting into the Viverse agent server and convert them into a reviewable implementation plan.

Primary reference sources:
- [claw-code README](https://github.com/ultraworkers/claw-code)
- [claw-code PHILOSOPHY.md](https://raw.githubusercontent.com/ultraworkers/claw-code/main/PHILOSOPHY.md)
- [claw-code USAGE.md](https://raw.githubusercontent.com/ultraworkers/claw-code/main/USAGE.md)
- [claw-code rust/README.md](https://raw.githubusercontent.com/ultraworkers/claw-code/main/rust/README.md)
- [claw-code ROADMAP.md](https://raw.githubusercontent.com/ultraworkers/claw-code/main/ROADMAP.md)

Related internal docs:
- [agent-defect-summary-2026-04-08.md](/Users/casper_wang/Projects/AI/viverse-ai-agent/docs/agent-defect-summary-2026-04-08.md)
- [agent-server-refactor-plan-2026-04-08.md](/Users/casper_wang/Projects/AI/viverse-ai-agent/docs/agent-server-refactor-plan-2026-04-08.md)

## 1. Bottom Line

`claw-code` does not mainly offer a better prompt. It offers a better harness shape.

The parts worth porting into the Viverse agent server are:
- state machine first execution
- typed events instead of prose-derived truth
- recovery before escalation
- context-window preflight and compact status summaries
- typed task packets instead of long natural-language-only requests
- session persistence and reliable resume
- machine-readable status surfaces
- deterministic parity and harness testing

The parts that are less relevant to port directly are:
- REPL slash-command breadth
- terminal UX
- Discord-specific delivery model
- tmux-oriented worker boot mechanics as-is

## 2. Features We Need From Claw-Code

### A. Explicit Worker / Workflow Lifecycle

`claw-code` roadmap emphasizes explicit lifecycle states such as `spawning`, `ready_for_prompt`, `running`, `blocked`, `finished`, and `failed`.

What we should port:
- explicit workflow state enum for every active run
- explicit stage enum inside the workflow
- explicit blocked vs failed vs interrupted classification
- explicit ready/running/finished transitions instead of inferring from chat output

Why we need it:
- your current defects show truth still leaks through model summaries and broad orchestrator logic

### B. Typed Events Over Scraped Prose

`claw-code` roadmap repeatedly pushes event-first design and machine-readable status over log scraping.

What we should port:
- typed workflow events
- structured failure events
- structured recovery-attempt events
- structured completion events
- structured degraded-mode events

Why we need it:
- fixes contradictory success/failure outputs
- removes dependence on natural-language skill reports and noisy tool logs

### C. Actionable Summary Compression

The roadmap explicitly calls for summary compression into:
- current phase
- last successful checkpoint
- current blocker
- recommended next recovery action

What we should port:
- compact workflow summaries generated from runtime state
- compact resume packets for the next model call
- UI status summaries derived from typed state, not raw logs

Why we need it:
- directly addresses context-cut / extraction
- reduces history bloat and fragile continuation behavior

### D. Recovery Before Escalation

`claw-code` roadmap makes automatic recovery a first-class policy:
- retry known failures once
- emit the attempted recovery
- escalate only after bounded repair fails

What we should port:
- known recovery recipes
- bounded automatic retry policy
- failure-class-based repair routing
- recovery ledger

Why we need it:
- your agent currently stops too early or loops without deterministic ownership

### E. Failure Taxonomy

The roadmap defines failure classes such as:
- prompt delivery
- trust gate
- branch divergence
- compile
- test
- plugin startup
- MCP startup
- tool runtime
- infra

What we should port:
- a normalized failure classification layer for the Viverse server

Recommended Viverse-specific classes:
- `routing_error`
- `planner_schema_error`
- `skill_resolution_error`
- `template_preflight_error`
- `build_error`
- `runtime_probe_error`
- `tool_loop_error`
- `mcp_error`
- `provider_error`
- `permission_block`
- `requirements_block`

Why we need it:
- auto-recovery only works if failure types are machine-classified

### F. Typed Task Packets

`claw-code` roadmap proposes structured task packets with:
- objective
- scope
- repo/worktree
- branch policy
- acceptance tests
- commit policy
- reporting contract
- escalation policy

What we should port:
- structured execution packet from router/orchestrator to role agents
- explicit acceptance criteria and retry policy in that packet

Why we need it:
- reduces dependence on long natural-language prompts
- makes retries and resume deterministic

### G. Session Persistence and Resume

`claw-code` already exposes session persistence and `--resume`, and the roadmap keeps tightening machine-readable resumed status.

What we should port:
- durable checkpointed workflow state
- resume from latest incomplete stage
- resume with compact context packet and ledgers
- machine-readable resumed status parity with fresh status

Why we need it:
- this is the direct answer to your current stop-without-resume defect

### H. Context-Window Preflight

The roadmap notes a completed context-window preflight improvement to block oversized requests before they are sent.

What we should port:
- prompt assembly budget checks
- stage-specific compact context packets
- hard failure or compression before oversized requests leave the process

Why we need it:
- prevents prompt bloat from causing silent degradation or context loss

### I. Machine-Readable Status and Diagnostics

`claw-code` pushes JSON status/doctor/sandbox output as a contract, not a convenience.

What we should port:
- machine-readable workflow status endpoint
- machine-readable diagnostics / preflight report
- machine-readable verifier/build/probe results

Why we need it:
- lets orchestration, UI, and future automations depend on stable structures

### J. Deterministic Harness / Parity Testing

`claw-code` includes a deterministic mock parity harness with scripted scenarios for provider/tool behavior.

What we should port:
- deterministic orchestration harness for the Viverse server
- scripted scenarios for routing, resume, skill loading, scaffold preflight, verification failure, and recovery

Why we need it:
- the refactor will be too risky without reproducible end-to-end regression coverage

## 3. Features We Should Not Copy Literally

Do not copy directly:
- tmux-centric trust prompt lifecycle
- Discord delivery assumptions
- extremely broad CLI command surface
- default `danger-full-access` security posture

Reason:
- your agent server is a web/server orchestrator, not primarily a terminal product

## 4. Proposed Viverse Architecture Additions

Add these modules or equivalent responsibilities:

### `WorkflowStateService`
- read-only workflow truth
- current stage
- counts
- blockers
- last verifier result
- next action

### `WorkflowContextService`
- extract durable facts from history and artifacts
- compact context into stage packets
- rehydrate resume context without replaying full chat logs

### `WorkflowEventService`
- canonical typed event emitter
- event normalization
- summary compression

### `WorkflowPolicyService`
- recovery recipes
- retry budgets
- escalation rules
- completion policy

### `PlannerSchemaValidator`
- hard validation and repair/retry contract for planner outputs

### `SkillLedgerService`
- canonical skill refs
- structured load results
- enforcement against artifacts

### `VerificationLedgerService`
- build/test/probe/reviewer/verifier outcomes
- retry history
- final gate truth

## 5. Reviewable Implementation Plan

### Phase 1. Machine-Readable Truth Layer

Implement:
- `WorkflowStateService`
- normalized workflow status schema
- typed workflow event schema
- read-only status path for `STATUS_QUERY`
- provisional vs final user output separation

Files likely touched:
- [aiController.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/controllers/aiController.js)
- [OrchestratorService.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- new `src/services/WorkflowStateService.js`
- new `src/services/WorkflowEventService.js`

Review focus:
- no status request should start execution
- final success wording must come only from deterministic state

### Phase 2. Context Extraction and Resume Packets

Implement:
- `WorkflowContextService`
- compact context packet schema
- context-window budget checks during prompt assembly
- checkpoint writes on stage transitions
- resume from latest valid context packet

Files likely touched:
- [OrchestratorService.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- [GeminiService.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/GeminiService.js)
- new `src/services/WorkflowContextService.js`

Review focus:
- resumed runs should not depend on replaying entire history
- oversized prompt assemblies should fail early or compact automatically

### Phase 3. Typed Task Packets and Planner Hardening

Implement:
- task packet schema
- planner schema validator
- planner retry with schema feedback
- task dispatch using structured packets instead of loose prompt blobs

Files likely touched:
- [OrchestratorService.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- [AgentRegistry.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/AgentRegistry.js)
- new `src/services/PlannerSchemaValidator.js`

Review focus:
- no `isNewProject: undefined`
- acceptance criteria and retry rules should be explicit in task packets

### Phase 4. Skill and Verification Ledgers

Implement:
- canonical skill references
- structured skill load artifacts
- verification ledger for build/test/probe/reviewer/verifier
- artifact-based compliance instead of prose-based compliance

Files likely touched:
- [SkillProvider.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/SkillProvider.js)
- [GeminiService.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/GeminiService.js)
- [OrchestratorService.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- possibly [ComplianceService.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/ComplianceService.js)

Review focus:
- a task must not fail purely because prose formatting is wrong
- root-level skill files must resolve canonically

### Phase 5. Recovery Policy and Auto-Fix Loops

Implement:
- failure taxonomy
- recovery recipes
- bounded verify-fix-retry loop
- stage-local retry counters
- recovery-attempt event emission

Files likely touched:
- [OrchestratorService.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/OrchestratorService.js)
- new `src/services/WorkflowPolicyService.js`

Review focus:
- repairable failures retry automatically
- non-repairable failures become explicit blockers
- repeated loops without progress should stop deterministically

### Phase 6. Template Front Door and Deterministic E2E Harness

Implement:
- mandatory scaffold preflight using template certification
- deterministic scenario harness for routing/resume/recovery
- scripted regressions for the defect summary cases

Files likely touched:
- [TemplateRegistryService.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/templates/TemplateRegistryService.js)
- [TemplateCertificationService.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/templates/TemplateCertificationService.js)
- [TemplateContractService.js](/Users/casper_wang/Projects/AI/viverse-ai-agent/src/services/templates/TemplateContractService.js)
- new test harness files

Review focus:
- invalid scaffold states should fail before implementation starts
- defect-summary cases should become regression tests

## 6. Acceptance Criteria For Review

The implementation should be approved only if these are demonstrably true:

1. Status queries remain read-only.
2. Resume continues from the last incomplete stage.
3. Resume uses compact extracted context, not full history replay.
4. Planner output is schema-valid before task creation.
5. Skill compliance is artifact-based, not prose-based.
6. Verification failures enter a bounded auto-fix loop.
7. Looping without progress is classified and stopped deterministically.
8. Final user-facing success is impossible before deterministic gates pass.
9. Template preflight catches starter-state defects before coding.
10. A deterministic test harness covers at least the current defect-summary scenarios.

## 7. Recommended Scope Cut

For the first implementation slice, do not attempt full parity with `claw-code`.

Build first:
- workflow status truth
- context packets
- planner validation
- skill ledger
- verification ledger
- bounded retry policy

Defer:
- rich command surfaces
- advanced plugin marketplace features
- terminal-first UX surfaces

## 8. Conclusion

The correct lesson from `claw-code` is:
- make the harness machine-readable
- keep control state outside agent prose
- compress noisy execution into actionable summaries
- encode recovery as policy
- persist enough structured state that resume is reliable

That is the subset that should be implemented in the Viverse agent server.
