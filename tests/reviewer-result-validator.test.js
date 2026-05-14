import test from 'node:test';
import assert from 'node:assert/strict';

import reviewerResultValidator from '../src/services/ReviewerResultValidator.js';

test('ReviewerResultValidator forces fail on deterministic gate conflict', () => {
    const result = reviewerResultValidator.parseAndValidate({
        fullResponse: JSON.stringify({
            status: 'pass',
            feedback: 'looks good',
            evidence: ['a', 'b'],
            runtime_checks: [
                { name: 'auth_profile', status: 'pass' },
                { name: 'matchmaking', status: 'pass' }
            ],
            artifact_paths: ['artifacts/review.json'],
            preview_url_tested: 'https://worlds.viverse.com/x'
        }),
        state: {
            runtimeFlags: {
                lastCoderComplianceClaim: { claimed: true },
                lastCoderGate: {
                    status: 'fail',
                    findings: [{ ruleId: 'sdk-rule', message: 'still broken' }]
                }
            }
        },
        runtimeBlockers: [],
        baselineRegressions: []
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.blockingItems.some((line) => line.includes('sdk-rule: still broken')), true);
});

test('ReviewerResultValidator rejects pass without required runtime checks', () => {
    assert.throws(() => reviewerResultValidator.parseAndValidate({
        fullResponse: JSON.stringify({
            status: 'pass',
            feedback: 'looks good',
            evidence: ['a', 'b'],
            runtime_checks: [{ name: 'auth_profile', status: 'pass' }],
            artifact_paths: ['artifacts/review.json'],
            preview_url_tested: 'https://worlds.viverse.com/x'
        }),
        state: {},
        runtimeBlockers: [],
        baselineRegressions: []
    }), /missing runtime_checks/);
});

test('ReviewerResultValidator accepts preview url fallback from workflow state', () => {
    const result = reviewerResultValidator.parseAndValidate({
        fullResponse: JSON.stringify({
            status: 'pass',
            feedback: 'looks good',
            evidence: ['build passed', 'runtime checks passed'],
            runtime_checks: [
                { name: 'auth_profile', status: 'pass' },
                { name: 'matchmaking', status: 'pass' }
            ],
            artifact_paths: ['artifacts/review.json']
        }),
        state: {
            projectContextSummary: 'Latest preview: https://worlds.viverse.com/example123?preview'
        },
        runtimeBlockers: [],
        baselineRegressions: []
    });

    assert.equal(result.status, 'pass');
    assert.equal(result.previewUrlTested, 'https://worlds.viverse.com/example123?preview');
});
