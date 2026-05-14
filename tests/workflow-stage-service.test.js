import test from 'node:test';
import assert from 'node:assert/strict';

import workflowStageService from '../src/services/WorkflowStageService.js';

test('WorkflowStageService derives workflow stage from task role and prompt', () => {
    assert.equal(
        workflowStageService.stageForTask({ id: 'task_architect', role: 'ARCHITECT', prompt: 'Generate CONTRACT.json' }),
        'plan'
    );
    assert.equal(
        workflowStageService.stageForTask({ id: 'task_verifier', role: 'VERIFIER', prompt: 'Verify preview probe' }),
        'verify'
    );
    assert.equal(
        workflowStageService.stageForTask({ id: 'auth_preflight', role: 'CODER', prompt: 'AUTH PREFLIGHT ONLY: Implement and verify minimal auth bootstrap' }),
        'auth_preflight'
    );
    assert.equal(
        workflowStageService.stageForTask({ id: 'task_publish', role: 'CODER', prompt: 'Run viverse-cli app publish' }),
        'publish'
    );
    assert.equal(
        workflowStageService.stageForTask({ id: 'task_impl', role: 'CODER', prompt: 'Implement game logic' }),
        'implement'
    );
    assert.equal(
        workflowStageService.stageForTask({ id: 'task_setup', role: 'CODER', prompt: 'Authenticate, create app id, and verify build output' }),
        'implement'
    );
});

test('WorkflowStageService records stage transitions and next action', () => {
    const state = {};
    workflowStageService.transition(state, 'plan', {
        reason: 'planning',
        nextAction: 'Generate plan'
    });
    workflowStageService.transitionForTask(state, {
        id: 'task_verifier',
        role: 'VERIFIER',
        prompt: 'Verify preview'
    }, {
        reason: 'task_started'
    });
    workflowStageService.markFinalize(state, {
        reason: 'completed'
    });

    assert.equal(state.currentStage, 'finalize');
    assert.equal(Array.isArray(state.stageHistory), true);
    assert.equal(state.stageHistory.length >= 3, true);
    assert.equal(state.stageHistory[0].to, 'plan');
});
