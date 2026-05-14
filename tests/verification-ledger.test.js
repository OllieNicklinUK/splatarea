import test from 'node:test';
import assert from 'node:assert/strict';

import verificationLedgerService from '../src/services/VerificationLedgerService.js';

test('VerificationLedgerService records and retrieves latest entries by type', () => {
    const workspace = '/tmp/ws-verification-ledger';

    verificationLedgerService.record(workspace, {
        type: 'verifier',
        taskId: 'verifier_1',
        role: 'VERIFIER',
        status: 'fail',
        summary: 'Verifier failed'
    });
    verificationLedgerService.record(workspace, {
        type: 'verifier',
        taskId: 'verifier_2',
        role: 'VERIFIER',
        status: 'pass',
        summary: 'Verifier passed'
    });
    verificationLedgerService.record(workspace, {
        type: 'preview_probe',
        taskId: 'coder_1',
        role: 'CODER',
        status: 'pass',
        summary: 'Preview probe passed'
    });

    assert.equal(verificationLedgerService.latestVerifierSummary(workspace).taskId, 'verifier_2');
    assert.equal(verificationLedgerService.latestPreviewProbeSummary(workspace).status, 'pass');
});

test('VerificationLedgerService hydrates persisted entries for a workspace', () => {
    const workspace = '/tmp/ws-verification-hydrate';

    const hydrated = verificationLedgerService.hydrate(workspace, [
        {
            at: '2026-04-09T02:00:00.000Z',
            type: 'verifier',
            taskId: 'verify_1',
            role: 'VERIFIER',
            status: 'pass',
            summary: 'Verifier passed',
            details: { ok: true },
            artifactPaths: []
        }
    ]);

    assert.equal(hydrated.length, 1);
    assert.equal(hydrated[0].type, 'verifier');
    assert.equal(verificationLedgerService.latestByType(workspace, 'verifier')?.summary, 'Verifier passed');
});
