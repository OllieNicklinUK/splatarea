import test from 'node:test';
import assert from 'node:assert/strict';

import { chat } from '../src/controllers/aiController.js';
import workflowStateService from '../src/services/WorkflowStateService.js';
import orchestratorService from '../src/services/OrchestratorService.js';
import geminiService from '../src/services/GeminiService.js';
import { createMockResponse } from './helpers/mockResponse.js';

test('chat uses WorkflowStateService for STATUS_QUERY without invoking execution', async () => {
    const originalWorkflowStatus = workflowStateService.getWorkflowStatus;
    const originalOrchestratorStatus = orchestratorService.getWorkflowStatus;
    const originalProcessRequest = orchestratorService.processRequest;
    const originalGenerateResponse = geminiService.generateResponse;

    let workflowCalls = 0;
    let orchestratorStatusCalls = 0;
    let processRequestCalls = 0;

    workflowStateService.getWorkflowStatus = async () => {
        workflowCalls += 1;
        return {
            found: true,
            overall: 'in_progress',
            text: 'Workflow status: in_progress'
        };
    };
    orchestratorService.getWorkflowStatus = async () => {
        orchestratorStatusCalls += 1;
        return { found: true, overall: 'in_progress', text: 'orchestrator status should not be used' };
    };
    orchestratorService.processRequest = async function* () {
        processRequestCalls += 1;
        yield { type: 'text', content: 'unexpected execution' };
    };
    geminiService.generateResponse = async () => {
        throw new Error('generateResponse should not be called for high-confidence status query');
    };

    try {
        const req = {
            body: {
                message: 'is verifier completed',
                history: [],
                stream: false,
                credentials: null
            }
        };
        const res = createMockResponse();

        await chat(req, res);

        assert.equal(res.result.statusCode, 200);
        assert.equal(res.result.body.success, true);
        assert.equal(res.result.body.workflowStatus.text, 'Workflow status: in_progress');
        assert.equal(workflowCalls, 1);
        assert.equal(orchestratorStatusCalls, 0);
        assert.equal(processRequestCalls, 0);
    } finally {
        workflowStateService.getWorkflowStatus = originalWorkflowStatus;
        orchestratorService.getWorkflowStatus = originalOrchestratorStatus;
        orchestratorService.processRequest = originalProcessRequest;
        geminiService.generateResponse = originalGenerateResponse;
    }
});
