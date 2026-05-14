import test from 'node:test';
import assert from 'node:assert/strict';

import workflowRecoveryService from '../src/services/WorkflowRecoveryService.js';

test('WorkflowRecoveryService schedules transient infra retry with bounded metadata', () => {
    const state = { tasks: [] };
    const task = { id: 'coder_1', role: 'Coder', status: 'running', transientInfraRetryCount: 0 };
    const events = [];

    const result = workflowRecoveryService.handleStreamFailure({
        state,
        task,
        reason: 'Gemini REST stream error 503: service unavailable',
        taskStartedAt: Date.now() - 250,
        projectContextSummary: 'ctx',
        maxTransientInfraRetriesPerTask: 2,
        computeTransientInfraRetryDelayMs: () => 4000,
        appendRunEvent: (_state, event) => events.push(event)
    });

    assert.equal(result.disposition, 'retry_scheduled');
    assert.equal(task.status, 'pending');
    assert.equal(task.transientInfraRetryCount, 1);
    assert.match(result.statusMessage, /Auto-retrying in ~4s/);
    assert.equal(events[0].type, 'task_retry_scheduled');
});

test('WorkflowRecoveryService schedules deterministic verifier loop recovery', () => {
    const state = {
        tasks: [
            { id: 'next_1', status: 'pending', dependsOn: ['verifier_1'] }
        ]
    };
    const task = { id: 'verifier_1', role: 'Verifier', status: 'running' };
    const events = [];

    const result = workflowRecoveryService.handleStreamFailure({
        state,
        task,
        reason: 'AGENT_TASK_IDLE_TIMEOUT:180000',
        taskStartedAt: Date.now() - 100,
        projectContextSummary: 'ctx',
        maxTransientInfraRetriesPerTask: 2,
        computeTransientInfraRetryDelayMs: () => 1000,
        appendRunEvent: (_state, event) => events.push(event)
    });

    assert.equal(result.disposition, 'recovery_scheduled');
    assert.match(result.retryId, /^loop_recover_verifier_/);
    assert.equal(task.status, 'failed');
    assert.equal(state.tasks.some((entry) => entry.id === result.retryId && entry.role === 'Verifier'), true);
    assert.deepEqual(state.tasks[0].dependsOn, [result.retryId]);
    assert.equal(events[0].type, 'task_failed_recovered');
});

test('WorkflowRecoveryService returns terminal failure when recovery is not allowed', () => {
    const state = { tasks: [] };
    const task = { id: 'coder_2', role: 'Coder', status: 'running' };
    const events = [];

    const result = workflowRecoveryService.handleStreamFailure({
        state,
        task,
        reason: 'Skill enforcement failed: Missing skill load artifact',
        taskStartedAt: Date.now() - 100,
        projectContextSummary: 'ctx',
        maxTransientInfraRetriesPerTask: 2,
        computeTransientInfraRetryDelayMs: () => 1000,
        appendRunEvent: (_state, event) => events.push(event)
    });

    assert.equal(result.disposition, 'terminal_failure');
    assert.equal(task.status, 'failed');
    assert.match(result.detailMessage, /Coder task failed/i);
    assert.equal(events[0].type, 'task_failed');
    assert.equal(state.recoveryLedger[0].category, 'skill_resolution_error');
});
