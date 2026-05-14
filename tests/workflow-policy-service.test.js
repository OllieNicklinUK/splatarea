import test from 'node:test';
import assert from 'node:assert/strict';

import workflowPolicyService from '../src/services/WorkflowPolicyService.js';

test('WorkflowPolicyService classifies transient provider errors as retryable infra failures', () => {
    const result = workflowPolicyService.classifyFailure('Gemini REST stream error 503: service unavailable', {
        role: 'CODER',
        taskId: 'coder_1'
    });

    assert.equal(result.category, 'provider_error');
    assert.equal(result.retryable, true);
    assert.equal(result.action, 'retry_transient_infra');
});

test('WorkflowPolicyService classifies tool-loop failures into deterministic recovery actions', () => {
    const coderResult = workflowPolicyService.classifyFailure('MAX_TOOL_ITERATIONS_REACHED', {
        role: 'CODER',
        taskId: 'coder_1'
    });
    const verifierResult = workflowPolicyService.classifyFailure('AGENT_TASK_IDLE_TIMEOUT:180000', {
        role: 'VERIFIER',
        taskId: 'verifier_1'
    });

    assert.equal(coderResult.category, 'tool_loop_error');
    assert.equal(coderResult.action, 'schedule_coder_loop_recovery');
    assert.equal(verifierResult.action, 'schedule_verifier_loop_recovery');
});

test('WorkflowPolicyService retry and recovery helpers enforce bounded budgets', () => {
    const transient = { action: 'retry_transient_infra' };
    const coderLoop = { action: 'schedule_coder_loop_recovery' };

    assert.equal(
        workflowPolicyService.shouldRetryTransientInfra(transient, { transientInfraRetryCount: 0 }, 2),
        true
    );
    assert.equal(
        workflowPolicyService.shouldRetryTransientInfra(transient, { transientInfraRetryCount: 2 }, 2),
        false
    );
    assert.equal(
        workflowPolicyService.shouldScheduleLoopRecovery(coderLoop, 'CODER', 0),
        true
    );
    assert.equal(
        workflowPolicyService.shouldScheduleLoopRecovery(coderLoop, 'CODER', 1),
        false
    );
});

test('WorkflowPolicyService records policy decisions into state recovery ledger', () => {
    const state = {};
    workflowPolicyService.recordPolicyDecision(state, {
        category: 'tool_loop_error',
        action: 'schedule_coder_loop_recovery',
        taskId: 'coder_2',
        role: 'CODER',
        reason: 'MAX_TOOL_ITERATIONS_REACHED'
    });

    assert.equal(Array.isArray(state.recoveryLedger), true);
    assert.equal(state.recoveryLedger.length, 1);
    assert.equal(state.recoveryLedger[0].category, 'tool_loop_error');
});
