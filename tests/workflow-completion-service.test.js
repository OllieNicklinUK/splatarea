import test from 'node:test';
import assert from 'node:assert/strict';

import workflowCompletionService from '../src/services/WorkflowCompletionService.js';

test('WorkflowCompletionService detects unresolved app id placeholders', () => {
    assert.equal(
        workflowCompletionService.hasUnresolvedAppIdPlaceholder('AUTHORITATIVE_APP_ID: unresolved'),
        true
    );
    assert.equal(
        workflowCompletionService.hasUnresolvedAppIdPlaceholder('App ID authority: YOUR_APP_ID'),
        true
    );
    assert.equal(
        workflowCompletionService.hasUnresolvedAppIdPlaceholder('AUTHORITATIVE_APP_ID: ab12cd34ef'),
        false
    );
});

test('WorkflowCompletionService returns latest verification entry by type', () => {
    const state = {
        verificationLedger: [
            { type: 'verifier', status: 'fail', summary: 'old fail' },
            { type: 'preview_probe', status: 'pass', summary: 'probe pass' },
            { type: 'verifier', status: 'pass', summary: 'new pass' }
        ]
    };

    const latestVerifier = workflowCompletionService.latestVerificationEntry(state, 'verifier');
    assert.equal(latestVerifier.summary, 'new pass');
});

test('WorkflowCompletionService builds outcome notice with preview url and app id', () => {
    const notice = workflowCompletionService.buildOutcomeNotice({
        state: {
            runtimeFlags: {
                appIdAuthority: { value: 'ab12cd34ef' }
            }
        },
        completed: false,
        reason: 'Preview runtime checks failed',
        resolveLatestPreviewUrl: () => 'https://worlds.viverse.com/example?preview'
    });

    assert.match(notice, /App ID: ab12cd34ef/);
    assert.match(notice, /Preview URL: https:\/\/worlds\.viverse\.com\/example\?preview/);
    assert.match(notice, /Reason: Preview runtime checks failed/);
});

test('WorkflowCompletionService blocks unresolved placeholder app id in completion verdict', async () => {
    const verdict = await workflowCompletionService.evaluateCompletionVerdict({
        state: { verificationLedger: [] },
        workspacePath: '/tmp/ws',
        projectContextSummary: 'AUTHORITATIVE_APP_ID: unresolved',
        checkAppIdIntegrity: async () => ({ ok: true }),
        hasRuntimeRevalidationAfterLatestFix: () => true,
        detectRuntimeBlockerSignatures: async () => [],
        requiresPreviewProbeEvidence: () => false,
        hasAnyPreviewProbeEvent: () => false,
        hasBlockingPreviewProbeFailure: () => false,
        runTemplateCompletionGates: async () => ({ pass: true, blocking: [] })
    });

    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'app_id_unresolved');
});

test('WorkflowCompletionService prefers verifier ledger failure in completion verdict', async () => {
    const verdict = await workflowCompletionService.evaluateCompletionVerdict({
        state: {
            verificationLedger: [
                { type: 'verifier', status: 'fail', summary: 'Verifier blocked release' }
            ]
        },
        workspacePath: '/tmp/ws',
        projectContextSummary: 'AUTHORITATIVE_APP_ID: ab12cd34ef',
        checkAppIdIntegrity: async () => ({ ok: true }),
        hasRuntimeRevalidationAfterLatestFix: () => true,
        detectRuntimeBlockerSignatures: async () => [],
        requiresPreviewProbeEvidence: () => false,
        hasAnyPreviewProbeEvent: () => false,
        hasBlockingPreviewProbeFailure: () => false,
        runTemplateCompletionGates: async () => ({ pass: true, blocking: [] })
    });

    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'verifier_gate');
    assert.equal(verdict.reason, 'Verifier blocked release');
});

test('WorkflowCompletionService passes completion verdict when ledger-backed gates are satisfied', async () => {
    const verdict = await workflowCompletionService.evaluateCompletionVerdict({
        state: {
            runtimeFlags: {
                lastFixTaskCompletedAt: '2026-04-08T00:00:00.000Z'
            },
            verificationLedger: [
                { type: 'reviewer', status: 'pass', at: '2026-04-08T00:01:00.000Z', summary: 'Reviewer passed' },
                { type: 'preview_probe', status: 'pass', at: '2026-04-08T00:02:00.000Z', summary: 'Preview passed' },
                { type: 'verifier', status: 'pass', at: '2026-04-08T00:03:00.000Z', summary: 'Verifier passed' }
            ],
            request: 'run preview probe and verify',
            tasks: []
        },
        workspacePath: '/tmp/ws',
        projectContextSummary: 'AUTHORITATIVE_APP_ID: ab12cd34ef',
        checkAppIdIntegrity: async () => ({ ok: true }),
        hasRuntimeRevalidationAfterLatestFix: () => true,
        detectRuntimeBlockerSignatures: async () => [],
        requiresPreviewProbeEvidence: () => true,
        hasAnyPreviewProbeEvent: () => true,
        hasBlockingPreviewProbeFailure: () => false,
        runTemplateCompletionGates: async () => ({ pass: true, blocking: [] })
    });

    assert.equal(verdict.ok, true);
    assert.equal(verdict.code, 'pass');
});
