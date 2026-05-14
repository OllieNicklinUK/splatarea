import test from 'node:test';
import assert from 'node:assert/strict';

import workflowContextService from '../src/services/WorkflowContextService.js';

test('WorkflowContextService builds compact packet from workflow state', () => {
    const state = {
        status: 'running',
        workspacePath: '/tmp/.viverse_workspaces/req_202604080002',
        runtimeFlags: {
            appIdAuthority: { value: 'ab12cd34ef' },
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            }
        },
        tasks: [
            { id: 'architect_1', role: 'ARCHITECT', status: 'completed', prompt: 'Plan app' },
            { id: 'verifier_1', role: 'VERIFIER', status: 'pending', prompt: 'Verify preview URL and app id' }
        ]
    };

    const packet = workflowContextService.buildPacket(state, {
        workspacePath: state.workspacePath,
        message: 'continue'
    });

    assert.equal(packet.requestId, 'req_202604080002');
    assert.equal(packet.currentStage, 'verify');
    assert.equal(packet.pendingTask.id, 'verifier_1');
    assert.equal(packet.requestScopePrimary, 'gameplay');
    assert.deepEqual(packet.allowedSubsystems, ['gameplay', 'ui']);
    assert.match(packet.summaryText, /CURRENT_STAGE: verify/);
    assert.match(packet.summaryText, /NEXT_ACTION:/);
    assert.match(packet.summaryText, /REQUEST_SCOPE: gameplay/);
    assert.match(packet.summaryText, /ALLOWED_SUBSYSTEMS: gameplay, ui/);
});

test('WorkflowContextService persists latest packet into state', () => {
    const state = {
        status: 'running',
        workspacePath: '/tmp/.viverse_workspaces/req_202604080003',
        tasks: [{ id: 'task_1', role: 'CODER', status: 'pending', prompt: 'Implement feature' }]
    };

    const packet = workflowContextService.applyToState(state, {
        workspacePath: state.workspacePath,
        message: 'build feature'
    });

    assert.equal(state.latestContextPacket.requestId, 'req_202604080003');
    assert.equal(state.contextPackets.length, 1);
    assert.equal(workflowContextService.getPromptContext(state, 'fallback'), packet.summaryText);
});
