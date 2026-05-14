import test from 'node:test';
import assert from 'node:assert/strict';

import orchestratorService from '../src/services/OrchestratorService.js';
import geminiService from '../src/services/GeminiService.js';
import workflowEventService from '../src/services/WorkflowEventService.js';

test('Orchestrator planner generation retries once on schema validation failure', async () => {
    const originalGenerateResponse = geminiService.generateResponse;
    const responses = [
        JSON.stringify({
            tasks: [{ role: 'Coder', prompt: 'Build app' }]
        }),
        JSON.stringify({
            isNewProject: false,
            tasks: [{ id: 'task_1', role: 'Coder', prompt: 'Build app', dependsOn: [] }]
        })
    ];
    let calls = 0;
    geminiService.generateResponse = async () => responses[calls++];

    try {
        const result = await orchestratorService._generatePlanWithValidation('plan prompt', [], [], { maxAttempts: 2 });
        assert.equal(result.ok, true);
        assert.equal(calls, 2);
        assert.equal(result.parsedPlan.isNewProject, false);
        assert.equal(result.attempts[0].validation.ok, false);
        assert.equal(result.attempts[1].validation.ok, true);
    } finally {
        geminiService.generateResponse = originalGenerateResponse;
    }
});

test('WorkflowEventService marks provisional and final workflow events explicitly', () => {
    const provisional = workflowEventService.provisionalStatus('planning...', { phase: 'planning' });
    const final = workflowEventService.finalStatus('done', { phase: 'finalize' });
    const outcome = workflowEventService.workflowOutcome({ completed: true, workspacePath: '/tmp/ws' });

    assert.equal(provisional.provisional, true);
    assert.equal(final.provisional, false);
    assert.equal(outcome.type, 'workflow_outcome');
    assert.equal(outcome.completed, true);
});
