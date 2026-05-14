# Capability Gateway Charging Policy Plan

Status: planning note
Last reviewed: 2026-04-27

Implementation note:

- Initial scaffold may be added in isolated services only.
- Do not rewire existing `GeminiService` or `OpenAIService` execution paths until parity tests exist.
- Observe-mode usage recording is safe to ship before billing enforcement.
- Existing runnable logic must remain behaviorally unchanged while gateway and billing services are introduced.

## Goal

Define a practical charging policy for hosted third-party capabilities in `viverse-ai-agent`.

The platform will own provider credentials, meter usage, and charge users through platform credits or subscription allowances instead of requiring users to bring their own API keys.

This document complements:

```text
docs/capability-gateway-plan.md
```

## Principles

- Charge users for platform capabilities, not raw provider API keys.
- Keep provider costs internal and configurable.
- Never expose shared provider credentials to generated apps.
- Always estimate and authorize usage before making paid provider calls.
- Start in observe mode before enforcing billing.
- Prefer predictable user-facing units over raw provider-specific units.
- Leave enough margin for provider price changes, failed requests, retries, abuse, support, and infrastructure.

## Recommended Billing Model

Use a platform credit wallet.

```text
User balance
  -> capability request
  -> estimated credit reservation
  -> provider call
  -> actual usage reconciliation
  -> final credit debit
```

Recommended public-facing model:

- Users buy or receive platform credits.
- Each capability consumes credits.
- Paid plans include monthly credits.
- Overages require top-up or plan upgrade.
- Advanced users may use BYOK for some capabilities later.

Avoid showing users raw provider pricing as the main billing unit. Provider costs can change and differ by region, model, route, or feature.

## Capability Pricing Units

Each capability should define a normalized charge unit.

Examples:

```js
{
  id: 'web_search',
  unit: 'request',
  chargePolicy: 'per_request'
}
```

```js
{
  id: 'llm_generate',
  unit: 'token',
  chargePolicy: 'input_output_tokens'
}
```

```js
{
  id: 'google_3d_tiles',
  unit: 'tile_session_or_tile_request',
  chargePolicy: 'provider_metered'
}
```

Suggested categories:

- `per_request`: search, geocode, places lookup, moderation.
- `per_token`: LLM generation, embedding, reranking.
- `per_image`: image generation, image editing.
- `per_second`: video/audio generation or transcription.
- `per_session`: map/tiles sessions, interactive services.
- `provider_metered`: APIs with complex upstream billing.

## Internal Pricing Formula

Use this internal formula:

```text
user_charge = max(minimum_charge, estimated_provider_cost * markup_multiplier + platform_fee)
```

Recommended fields:

```js
{
  capabilityId: 'web_search',
  providerId: 'brave',
  providerCostUnit: 'request',
  providerCostUsd: 0.0,
  markupMultiplier: 2.0,
  platformFeeCredits: 1,
  minimumChargeCredits: 1,
  userVisibleUnit: 'search'
}
```

Do not hardcode prices in source code. Store pricing in config or database.

## Credit System

Use integer credits to avoid floating-point billing issues.

Example:

```text
1000 credits = 1 USD
```

This ratio can be changed, but it should be stable once users buy credits.

Store monetary values as integers:

- `estimatedCostCredits`
- `reservedCredits`
- `actualCostCredits`
- `refundedCredits`

## Usage Authorization Flow

Before every paid provider call:

1. Resolve user, tenant, app, workspace, and capability.
2. Validate that the user has access to the capability.
3. Estimate worst-case or configured maximum cost.
4. Check daily/monthly/user/app quotas.
5. Reserve credits.
6. Execute provider call.
7. Reconcile actual usage.
8. Refund unused reservation.
9. Save usage record.
10. Return sanitized result.

If reservation fails, do not call the provider.

## Reservation Policy

Use reservations because actual cost is often unknown before execution.

Examples:

- Search request: reserve fixed charge.
- LLM request: reserve based on max output tokens plus input tokens.
- Image generation: reserve fixed charge by size/model.
- Map tiles: reserve per session or per capped request window.

Reservation record:

```js
{
  reservationId,
  userId,
  appId,
  workspaceId,
  capabilityId,
  providerId,
  status: 'reserved',
  reservedCredits,
  expiresAt
}
```

Expired reservations should be released by a background cleanup job.

## Failed Request Policy

Not all failed calls should be charged.

Recommended policy:

- User validation error: no charge.
- Platform validation block: no charge.
- Provider auth/config error: no charge.
- Provider 5xx or timeout: no charge or partial platform-defined charge.
- Provider returns billable result but app processing fails: charge provider cost, optionally waive margin.
- User cancellation after provider call starts: charge if provider billed.
- Abuse/rate-limit violation: may charge reservation or block further usage.

Always record failure reason and whether the provider likely billed the platform.

## Retry Policy

Retries can silently multiply cost.

Recommended policy:

- Internal retry count must be capped per capability.
- Do not charge users for platform-caused retries unless the provider charges and the request eventually succeeds.
- For expensive capabilities, require explicit retry authorization after failure.
- For LLM calls, avoid retrying with larger models unless policy allows it.

Usage records should link retry attempts:

```js
{
  requestGroupId,
  attemptIndex,
  retryReason
}
```

## Quotas and Limits

Use multiple layers:

- User daily credit spend limit.
- User monthly credit spend limit.
- App daily request limit.
- Capability-specific rate limit.
- Provider-specific fallback limit.
- Anonymous or trial-user stricter limit.
- Abuse-detection temporary block.

Example:

```js
{
  capabilityId: 'web_search',
  perUserDailyLimit: 100,
  perAppDailyLimit: 500,
  burstLimitPerMinute: 10
}
```

## Plan Tiers

Suggested structure:

```text
Free
  - small monthly credits
  - low rate limits
  - no expensive capabilities by default

Creator
  - monthly included credits
  - paid top-up
  - standard capabilities

Pro
  - higher monthly credits
  - higher rate limits
  - premium LLM/search/image capabilities

Enterprise
  - contract pricing
  - custom provider routing
  - audit logs
  - optional BYOK
```

Do not make plan tier the only enforcement mechanism. Always enforce actual usage and quotas.

## BYOK Policy

Support BYOK later as an advanced mode.

Recommended behavior:

- BYOK users are not charged provider markup for that provider.
- They may still be charged platform execution/hosting fee.
- BYOK keys must be stored server-side or in provider-approved secure runtime.
- BYOK should not be required for normal users.

BYOK is useful for:

- enterprise compliance
- high-volume customers
- user-owned domains
- provider terms requiring customer-owned credentials

## Provider Terms Policy

Every capability must have a terms classification:

```js
{
  capabilityId: 'google_3d_tiles',
  termsClass: 'restricted_client_runtime',
  resaleAllowed: false,
  requiresHostedDomain: true,
  byokRecommendedForExport: true
}
```

Suggested classes:

- `server_side_ok`: safe to call from platform backend.
- `client_key_restricted`: browser key allowed only with strict domain restrictions.
- `restricted_client_runtime`: needs special care, usually hosted domain only.
- `byok_required_for_export`: user must provide key for self-hosted/exported deployment.
- `contract_required`: do not enable without provider approval.

For services like Google Maps or 3D Tiles, prefer hosted-domain usage first and BYOK for exported/user-domain deployments.

## Capability Pricing Config

Suggested config shape:

```js
{
  id: 'web_search',
  enabled: true,
  billingMode: 'observe',
  providerPriority: ['brave', 'tavily'],
  userVisibleUnit: 'search',
  estimate: {
    type: 'fixed',
    credits: 5
  },
  quota: {
    perUserDaily: 100,
    perAppDaily: 500,
    burstPerMinute: 10
  },
  margin: {
    minimumCredits: 5,
    markupMultiplier: 2.0
  }
}
```

For token-based capabilities:

```js
{
  id: 'llm_generate',
  enabled: true,
  billingMode: 'observe',
  estimate: {
    type: 'token_budget',
    inputTokenCreditsPer1k: 10,
    outputTokenCreditsPer1k: 40,
    reserveMaxOutputTokens: true
  }
}
```

## Billing Modes

Use staged rollout modes:

```text
off
  no usage records, no charges

observe
  record estimated and actual usage, do not block

warn
  record usage and emit warnings when limits would be exceeded

enforce
  reserve credits before provider call and block if unavailable
```

Start with `observe`.

Move to `warn` before `enforce` for existing users.

## Usage Record Schema

Suggested durable record:

```js
{
  usageId,
  requestId,
  requestGroupId,
  userId,
  tenantId,
  appId,
  workspaceId,
  capabilityId,
  providerId,
  billingMode,
  status,
  unit,
  quantity,
  estimatedCostCredits,
  reservedCredits,
  actualCostCredits,
  refundedCredits,
  providerCostRaw,
  providerCostCurrency,
  providerRequestId,
  errorCode,
  errorClass,
  createdAt,
  completedAt
}
```

Do not store raw secrets.

Store prompts, queries, or generated content only if product policy explicitly allows it. Prefer metadata-only by default.

## User-Facing Receipts

Users should see:

- capability name
- app or workspace
- time
- credit cost
- status
- short reason on failure

Avoid exposing:

- provider API keys
- provider account identifiers
- raw internal provider costs
- sensitive prompts or private inputs by default

## Admin Controls

Admins need:

- enable/disable capability
- set provider priority
- set pricing config
- set quotas
- inspect usage by user/app/capability/provider
- block abusive users/apps
- switch billing mode
- export monthly usage

## Abuse Controls

Minimum controls before enforcement:

- per-user quotas
- per-app quotas
- per-IP or session burst limits
- suspicious retry detection
- generated-app capability allowlist
- max request payload size
- max response size
- provider fallback cap
- admin kill switch

## First Rollout Recommendation

1. Add usage records in `observe` mode.
2. Meter existing internal capabilities without charging.
3. Add `web_search` as first paid-like capability in observe mode.
4. Compare estimated cost vs provider invoices.
5. Add user-facing usage page.
6. Move to `warn` mode.
7. Move selected beta users to `enforce`.
8. Enable top-up payments only after reconciliation is accurate.

## Open Questions

- What is the credit-to-USD ratio?
- Are credits prepaid, subscription-included, or both?
- Should unused monthly credits expire?
- Should generated apps have separate budgets from user accounts?
- Should VIVERSE app owners be able to set end-user quotas?
- Which capabilities require provider approval before commercial launch?
- What data retention policy applies to prompts, queries, coordinates, and generated results?

## Acceptance Criteria

- Every paid provider call has a usage record.
- Enforce mode blocks calls before provider cost is incurred.
- Failed request charging policy is deterministic.
- Reservations are reconciled or expired.
- Provider prices are configurable without code changes.
- Existing workflows can run with billing mode `off` or `observe`.
- Admins can disable a capability immediately.

