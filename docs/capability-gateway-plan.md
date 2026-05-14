# Capability Gateway Integration Plan

Status: planning note
Last reviewed: 2026-04-27

## Goal

Add hosted, metered third-party capabilities to `viverse-ai-agent` without disrupting current agent workflows, template enforcement, VIVERSE publishing, or Lambda key-protection behavior.

Examples of future capabilities:

- `web_search`
- `geocode`
- `places_search`
- `maps_static`
- `google_3d_tiles`
- `llm_generate`
- `image_generate`

The product goal is to let end users build content without bringing their own API keys, while the platform owns provider credentials and charges by usage.

## Non-Goals

- Do not expose shared provider keys to generated frontend apps.
- Do not bypass `FileService` for file writes, command execution, App ID handling, or publish commands.
- Do not rewrite `OrchestratorService` around a new provider layer.
- Do not replace the existing `lambda-tool-v1` template.
- Do not introduce billing enforcement before current tool execution behavior has parity tests.

## Current Repo Constraints

The repo has important existing safety boundaries:

- `AIService.js` is the AI provider factory and should remain the model-provider boundary.
- `GeminiService` and `OpenAIService` currently execute agent tools directly.
- `FileService` enforces workspace path safety, template high-risk path warnings (advisory), App ID preservation, VIVERSE CLI normalization, and publish-related command behavior.
- `SkillProvider` and `SkillLedgerService` support strict skill loading and compliance validation.
- Template contracts and compliance gates affect whether generated work can proceed.
- `lambda-tool-v1` already provides a VIVERSE Lambda backend pattern for secret-bearing external API calls.

## Correct Layering

Preferred layering:

```text
OrchestratorService
  -> AIService provider boundary
    -> GeminiService / OpenAIService
      -> shared ToolExecution / CapabilityGateway
        -> FileService / SearchService / SkillProvider / external adapters
```

Later, generated apps may call hosted capabilities:

```text
Generated app
  -> hosted capability endpoint or VIVERSE Lambda event
  -> CapabilityGateway
  -> UsageLedger
  -> provider adapter
```

Avoid this layering:

```text
OrchestratorService
  -> new gateway that bypasses AIService, FileService, template checks, or publish checks
```

## Key Risks

### Tool Execution Semantics

`GeminiService` and `OpenAIService` each currently implement direct tool execution. Any gateway migration must preserve:

- convergence guards
- mutation counters
- tool-result sanitization
- fatal tool handling
- skill ledger recording
- provider-specific tool response formatting

### File and Command Safety

All file and command capabilities must continue through `FileService`.

Do not let gateway adapters call `fs`, `exec`, `viverse-cli`, or Lambda sync scripts directly unless they intentionally go through existing safety wrappers.

### Template and Compliance Behavior

The system uses path/subsystem semantics such as:

- `publish`
- `platform-core.auth`
- `platform-core.matchmaking`
- `platform-core.bootstrap`
- `gameplay`
- `ui`
- `diagnostics`

Capability metadata should map to this existing vocabulary to avoid false compliance failures or accidental permission broadening.

### Lambda Contract Gap

`lambda-tool-v1` declares `lambda.event_contracts`, but that gate must be implemented before relying on Lambda capability generation for paid APIs.

The gate should validate:

- declared Lambda event scripts exist
- frontend invokes match script event names
- scripts use `getEnv()` for secrets
- scripts do not hardcode secret values
- scripts validate `context.data`
- scripts use `reply()` with sanitized data
- `.env.lambda.example` documents required keys

### Billing Ledger Separation

Future `UsageLedgerService` must not replace `SkillLedgerService`.

`SkillLedgerService` is for agent skill-load compliance evidence. Usage metering is a separate concern.

## Incremental Implementation Plan

### Phase 1: Read-Only Capability Registry

Add a registry that describes existing tools and future capability metadata. No execution changes.

Suggested file:

```text
src/services/capabilities/CapabilityRegistryService.js
```

Each entry should include:

```js
{
  id: 'web_search',
  kind: 'external_api',
  provider: 'brave',
  subsystem: 'gameplay',
  billingUnit: 'request',
  allowedRuntime: ['server', 'lambda'],
  secretRefs: ['BRAVE_SEARCH_API_KEY']
}
```

For existing agent tools, register current tool names and their backing service:

- `readFile` -> `FileService`
- `writeFile` -> `FileService`
- `runCommand` -> `FileService`
- `searchRooms` -> `SearchService`
- `loadSkill` -> `SkillProvider` plus `SkillLedgerService`

### Phase 2: Shared Tool Execution Facade

Add:

```text
src/services/capabilities/CapabilityGatewayService.js
```

Initial API:

```js
executeTool({
  name,
  args,
  workspacePath,
  role,
  taskId,
  provider
})
```

At first, this service should only delegate to existing services and preserve current behavior.

Do not add paid provider adapters yet.

### Phase 3: Tool Execution Parity

Move shared behavior behind tests before changing provider services.

Parity requirements:

- `GeminiService` tool calls produce equivalent sanitized results.
- `OpenAIService` tool calls produce equivalent sanitized results.
- `writeFile` warns on high-risk template paths (advisory, non-blocking).
- `runCommand` still normalizes VIVERSE CLI and scaffold commands.
- `loadSkill` still records `SkillLedgerService` entries with current task context.
- repeated tool calls still trigger convergence guards.

### Phase 4: Wire AI Providers to Gateway

Update `GeminiService` and `OpenAIService` to call the shared execution facade.

Keep provider-specific response shaping inside provider services.

Do not change `OrchestratorService` routing in this phase.

### Phase 5: Lambda Event Contract Gate

Implement `lambda.event_contracts` validation in the template/compliance path.

Likely integration points:

- `TemplateCertificationService`
- `ComplianceService`
- `OrchestratorService._evaluateTemplateGate`

Validation should be deterministic and not rely on agent prose.

### Phase 6: Usage Ledger in Observe Mode

Add:

```text
src/services/capabilities/UsageLedgerService.js
```

Initial mode:

```env
CAPABILITY_BILLING_MODE=observe
```

Modes:

- `off`: disabled
- `observe`: record usage intent and estimated cost, do not block
- `enforce`: reserve/check quota before provider calls

Usage records should include:

- user or tenant id
- app id or workspace id
- capability id
- provider id
- estimated cost
- actual cost when available
- status
- timestamp

### Phase 7: First External Capability

Start with a low-risk backend-only capability such as `web_search`.

Avoid starting with Google 3D Tiles because browser/runtime key exposure, domain restrictions, and provider terms are harder.

Recommended first candidates:

- Brave Search API
- Tavily
- Exa
- SerpAPI only if Google-like SERP behavior is required

### Phase 8: Hosted Runtime and Lambda Integration

Support two runtime modes:

```text
server
  generated app -> your hosted API -> CapabilityGateway

lambda
  generated app -> VIVERSE Lambda event -> provider or hosted gateway
```

For shared paid keys, prefer hosted backend routes when possible.

Use Lambda when the VIVERSE runtime specifically needs app-local invocation or existing template behavior.

### Phase 9: Enforce Billing

Only enable enforcement after observe-mode logs prove accounting accuracy.

Enforcement flow:

1. Resolve user, app, workspace, and capability.
2. Estimate cost.
3. Check quota or credit balance.
4. Reserve usage.
5. Call provider.
6. Reconcile actual usage.
7. Return sanitized result.

## Acceptance Criteria

- Existing app generation and publish flows behave the same before external capability adapters are enabled.
- Existing `lambda-tool-v1` generation still works.
- High-risk template files are advisory-protected (warn, not block).
- Skill compliance reports and ledgers still work.
- Publish preconditions and App ID preservation still work.
- Capability usage can be observed without blocking users.
- First paid capability can be enabled behind an environment flag.

## Suggested Test Coverage

Add focused tests for:

- `CapabilityRegistryService` metadata resolution
- `CapabilityGatewayService.executeTool` delegation
- `writeFile` high-risk path advisory warning through the gateway
- `runCommand` normalization through the gateway
- `loadSkill` ledger recording through the gateway
- `lambda.event_contracts` pass/fail cases
- observe-mode usage ledger records

## Implementation Order Summary

1. Registry only.
2. Shared execution facade delegating to existing services.
3. Parity tests.
4. Gemini/OpenAI provider migration to facade.
5. Lambda contract gate.
6. Usage ledger in observe mode.
7. First backend-only external capability.
8. Hosted/Lambda capability runtime integration.
9. Billing enforcement.

