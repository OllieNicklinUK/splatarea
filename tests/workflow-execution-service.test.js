import test from 'node:test';
import assert from 'node:assert/strict';

import workflowExecutionService from '../src/services/WorkflowExecutionService.js';

test('WorkflowExecutionService selects ready and deferred retry tasks correctly', () => {
    const now = Date.now();
    const state = {
        tasks: [
            { id: 'done_1', status: 'completed' },
            { id: 'ready_1', status: 'pending', dependsOn: ['done_1'] },
            { id: 'wait_dep', status: 'pending', dependsOn: ['missing_dep'] },
            { id: 'deferred_1', status: 'pending', dependsOn: ['done_1'], transientInfraRetryAt: now + 10_000 }
        ]
    };

    const ready = workflowExecutionService.getReadyTasks(state, now);
    const deferred = workflowExecutionService.getDeferredRetryTasks(state, now);

    assert.deepEqual(ready.map((task) => task.id), ['ready_1']);
    assert.deepEqual(deferred.map((task) => task.id), ['deferred_1']);
});

test('WorkflowExecutionService computes workflow settlement with recovered failed tasks', () => {
    const state = {
        tasks: [
            { id: 'failed_1', status: 'failed' },
            { id: 'blocked_1', status: 'blocked' },
            { id: 'recovered_1', status: 'failed' },
            { id: 'done_1', status: 'completed' }
        ]
    };
    const runEvents = [
        { type: 'task_failed_recovered', taskId: 'recovered_1' }
    ];

    const summary = workflowExecutionService.computeSettlement(state, runEvents);

    assert.equal(summary.hasPendingTasks, false);
    assert.equal(summary.hasBlockingTaskStates, true);
    assert.equal(summary.workflowTasksSettled, false);
    assert.equal(summary.recoveredFailedTaskIds.has('recovered_1'), true);
});

test('WorkflowExecutionService treats completed loop recovery tasks as recovered failures', () => {
    const state = {
        tasks: [
            { id: 'publish_1', status: 'failed' },
            { id: 'review_1', status: 'completed' },
            { id: 'verify_1', status: 'completed' },
            {
                id: 'loop_recover_publish_1',
                status: 'completed',
                recoveryOf: 'publish_1',
                loopRootId: 'publish_1'
            }
        ]
    };

    const summary = workflowExecutionService.computeSettlement(state, []);

    assert.equal(summary.hasPendingTasks, false);
    assert.equal(summary.hasBlockingTaskStates, false);
    assert.equal(summary.workflowTasksSettled, true);
    assert.equal(summary.recoveredFailedTaskIds.has('publish_1'), true);
});
