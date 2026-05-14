import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import workflowStateService from '../src/services/WorkflowStateService.js';
import verificationLedgerService from '../src/services/VerificationLedgerService.js';

test('WorkflowStateService returns read-only summary for req workspace', async () => {
    const originalCwd = process.cwd();
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-workflow-state-'));

    try {
        const workspaceRoot = path.join(tmpRoot, '.viverse_workspaces');
        const reqPath = path.join(workspaceRoot, 'req_202604080001');
        await fs.mkdir(reqPath, { recursive: true });
        await fs.writeFile(
            path.join(reqPath, '.agent_state.json'),
            JSON.stringify({
                status: 'running',
                latestContextPacket: {
                    currentStage: 'verify',
                    nextAction: 'Run pending task verifier_1 (VERIFIER)',
                    requestScopePrimary: 'gameplay'
                },
                verificationLedger: [
                    {
                        type: 'verifier',
                        status: 'pass',
                        summary: 'Verifier passed',
                        at: '2026-04-08T00:00:00.000Z'
                    },
                    {
                        type: 'preview_probe',
                        status: 'pass',
                        summary: 'Preview probe passed',
                        at: '2026-04-08T00:01:00.000Z'
                    }
                ],
                recoveryLedger: [
                    {
                        at: '2026-04-08T00:02:00.000Z',
                        category: 'tool_loop_error',
                        action: 'schedule_coder_loop_recovery',
                        taskId: 'coder_1',
                        role: 'CODER',
                        reason: 'MAX_TOOL_ITERATIONS_REACHED'
                    }
                ],
                tasks: [
                    { id: 'architect_1', role: 'ARCHITECT', status: 'completed', prompt: 'Plan app' },
                    { id: 'verifier_1', role: 'VERIFIER', status: 'pending', prompt: 'Verify preview' }
                ]
            }, null, 2),
            'utf8'
        );

        process.chdir(tmpRoot);
        workflowStateService.setActiveProjects(new Map());

        const summary = await workflowStateService.getWorkflowStatus('is verifier completed for req_202604080001', [], null);

        assert.equal(summary.found, true);
        assert.equal(summary.requestId, 'req_202604080001');
        assert.equal(summary.verifier.status, 'pending');
        assert.equal(summary.pendingTask.id, 'verifier_1');
        assert.equal(summary.currentStage, 'verify');
        assert.equal(summary.requestScope, 'gameplay');
        assert.ok(summary.latestVerifierGate);
        assert.ok(summary.latestPreviewProbe);
        assert.ok(summary.latestRecovery);
        assert.equal(summary.latestVerifierGate.status, 'pass');
        assert.equal(summary.latestPreviewProbe.status, 'pass');
        assert.equal(summary.latestRecovery.category, 'tool_loop_error');
        assert.match(summary.text, /Next action: Run pending task verifier_1/);
        assert.match(summary.text, /Request scope: gameplay/);
        assert.match(summary.text, /Verifier gate: pass/);
        assert.match(summary.text, /Preview probe: pass/);
        assert.match(summary.text, /Latest recovery: tool_loop_error -> schedule_coder_loop_recovery/);
        assert.match(summary.text, /Workflow status:/);
    } finally {
        process.chdir(originalCwd);
        await fs.rm(tmpRoot, { recursive: true, force: true });
    }
});
