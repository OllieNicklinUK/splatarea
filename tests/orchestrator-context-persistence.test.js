import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import orchestratorService from '../src/services/OrchestratorService.js';
import fileService from '../src/services/FileService.js';
import verificationLedgerService from '../src/services/VerificationLedgerService.js';
import geminiService from '../src/services/GeminiService.js';
import workflowCompletionService from '../src/services/WorkflowCompletionService.js';

test('OrchestratorService._saveState writes latest context packet before persisting', async () => {
    const originalWriteFile = fileService.writeFile;
    const writes = [];

    fileService.writeFile = async (target, content) => {
        writes.push({ target, content: JSON.parse(content) });
    };

    try {
        verificationLedgerService.record('/tmp/.viverse_workspaces/req_202604080004', {
            type: 'preview_probe',
            taskId: 'task_1',
            role: 'CODER',
            status: 'pass',
            summary: 'Preview probe passed'
        });
        const state = {
            workspacePath: '/tmp/.viverse_workspaces/req_202604080004',
            request: 'continue',
            status: 'running',
            currentStage: 'implement',
            nextAction: 'Execute task task_1 (CODER)',
            tasks: [{ id: 'task_1', role: 'CODER', status: 'pending', prompt: 'Implement feature' }],
            runtimeFlags: {}
        };

        await orchestratorService._saveState(state);

        const stateWrite = writes.find((entry) => entry.target.endsWith('/.agent_state.json'));
        assert.ok(stateWrite);
        assert.equal(stateWrite.content.latestContextPacket.requestId, 'req_202604080004');
        assert.equal(stateWrite.content.latestContextPacket.pendingTask.id, 'task_1');
        assert.equal(stateWrite.content.currentStage, 'implement');
        assert.equal(Array.isArray(stateWrite.content.verificationLedger), true);
        assert.equal(stateWrite.content.verificationLedger[0].type, 'preview_probe');
    } finally {
        fileService.writeFile = originalWriteFile;
    }
});

test('Orchestrator final summarizer call keeps workspace scope for knowledge evolution', async () => {
    const originalRefreshKnowledge = geminiService.refreshKnowledge;
    const originalGenerateResponse = geminiService.generateResponse;
    const originalPickWorkspace = orchestratorService._pickWorkspace;
    const originalBindTemplateContextForRun = orchestratorService._bindTemplateContextForRun;
    const originalSaveState = orchestratorService._saveState;
    const originalFinalizeWorkflowState = orchestratorService._finalizeWorkflowState;
    const originalEvaluateCompletionVerdict = workflowCompletionService.evaluateCompletionVerdict;

    const workspacePath = '/tmp/.viverse_workspaces/req_202604090001';
    const captured = [];

    geminiService.refreshKnowledge = async () => {};
    geminiService.generateResponse = async (_prompt, _history, roleKey, passedWorkspacePath) => {
        captured.push({ roleKey, passedWorkspacePath });
        return 'final summary';
    };
    orchestratorService._pickWorkspace = async () => ({
        path: workspacePath,
        state: {
            workspacePath,
            request: 'continue req_202604090001',
            tasks: [],
            history: [],
            projectContextSummary: 'summary',
            runtimeFlags: {},
            currentStage: 'finalize',
            nextAction: 'Finalize workflow',
            runReport: { startedAt: new Date().toISOString(), events: [] }
        }
    });
    orchestratorService._bindTemplateContextForRun = async () => {};
    orchestratorService._saveState = async () => {};
    orchestratorService._finalizeWorkflowState = async (state, outcome) => {
        state.status = outcome;
    };
    workflowCompletionService.evaluateCompletionVerdict = async () => ({ ok: true, reason: '' });

    try {
        const events = [];
        for await (const event of orchestratorService.processRequest(
            'continue req_202604090001',
            [],
            { email: 'user@example.com', password: 'secret' },
            []
        )) {
            events.push(event);
        }

        const summarizerCall = captured.find((entry) => entry.roleKey === 'SUMMARIZER');
        assert.ok(summarizerCall);
        assert.equal(summarizerCall.passedWorkspacePath, workspacePath);
        assert.ok(events.some((event) => event.type === 'workflow_outcome' && event.completed === true));
    } finally {
        geminiService.refreshKnowledge = originalRefreshKnowledge;
        geminiService.generateResponse = originalGenerateResponse;
        orchestratorService._pickWorkspace = originalPickWorkspace;
        orchestratorService._bindTemplateContextForRun = originalBindTemplateContextForRun;
        orchestratorService._saveState = originalSaveState;
        orchestratorService._finalizeWorkflowState = originalFinalizeWorkflowState;
        workflowCompletionService.evaluateCompletionVerdict = originalEvaluateCompletionVerdict;
    }
});

test('Orchestrator schedules architect contract retry when CONTRACT.json is missing', async () => {
    const workspacePath = '/tmp/.viverse_workspaces/req_missing_contract';
    const state = {
        workspacePath,
        tasks: [
            { id: 'task_1', role: 'Architect', status: 'completed', dependsOn: [] },
            { id: 'task_2', role: 'Coder', status: 'pending', dependsOn: ['task_1'] }
        ],
        runReport: { events: [] }
    };

    const result = await orchestratorService._ensureArchitectContract(
        state,
        state.tasks[0],
        workspacePath,
        'summary'
    );

    assert.equal(result.scheduled, true);
    assert.ok(String(result.retryTaskId || '').startsWith('architect_contract_retry_'));
    assert.equal(state.tasks.some((task) => task.id === result.retryTaskId && task.role === 'Architect'), true);
    assert.deepEqual(state.tasks.find((task) => task.id === 'task_2').dependsOn, [result.retryTaskId]);
});

test('Orchestrator persists fallback CONTRACT.json artifact from architect response when file is missing', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-contract-'));

    try {
        const state = {
            request: 'Build a memory game',
            workspacePath
        };
        const task = {
            id: 'task_1',
            role: 'Architect',
            prompt: 'Design the system and generate CONTRACT.json.'
        };

        const result = await orchestratorService._persistArchitectContractArtifact(
            state,
            task,
            workspacePath,
            'Architecture summary without JSON file output'
        );

        assert.equal(result.persisted, true);
        const contract = JSON.parse(await fs.readFile(path.join(workspacePath, 'CONTRACT.json'), 'utf8'));
        assert.equal(contract.generatedBy, 'orchestrator_architect_fallback');
        assert.equal(contract.sourceTaskId, 'task_1');
        assert.equal(contract.request, 'Build a memory game');
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('Orchestrator short-circuits completed workspace resume without rerunning summarizer', async () => {
    const originalRefreshKnowledge = geminiService.refreshKnowledge;
    const originalGenerateResponse = geminiService.generateResponse;
    const originalPickWorkspace = orchestratorService._pickWorkspace;
    const originalBindTemplateContextForRun = orchestratorService._bindTemplateContextForRun;

    let summarizerCalls = 0;
    const workspacePath = '/tmp/.viverse_workspaces/req_completed_resume';

    geminiService.refreshKnowledge = async () => {};
    geminiService.generateResponse = async () => {
        summarizerCalls += 1;
        return 'should not run';
    };
    orchestratorService._pickWorkspace = async () => ({
        path: workspacePath,
        state: {
            workspacePath,
            request: 'continue req_completed_resume',
            status: 'completed',
            tasks: [
                { id: 'task_1', role: 'Architect', status: 'completed', prompt: 'architect' },
                { id: 'task_2', role: 'Coder', status: 'completed', prompt: 'coder' }
            ],
            history: [],
            projectContextSummary: '- IMPORTANT: The VIVERSE Preview URL for this project is: https://worlds.viverse.com/final123?preview',
            runtimeFlags: {
                appIdAuthority: { value: 'ab12cd34ef' }
            },
            currentStage: 'finalize',
            nextAction: 'Workflow completed',
            runReport: { startedAt: new Date().toISOString(), events: [] }
        }
    });
    orchestratorService._bindTemplateContextForRun = async () => {};

    try {
        const events = [];
        for await (const event of orchestratorService.processRequest(
            'continue req_completed_resume',
            [],
            { email: 'user@example.com', password: 'secret' },
            []
        )) {
            events.push(event);
        }

        assert.equal(summarizerCalls, 0);
        assert.ok(events.some((event) => event.type === 'status' && /already completed/i.test(String(event.content || ''))));
        assert.ok(events.some((event) => event.type === 'workflow_outcome' && event.completed === true));
        assert.ok(events.some((event) => event.type === 'text' && /final123\?preview/.test(String(event.content || ''))));
    } finally {
        geminiService.refreshKnowledge = originalRefreshKnowledge;
        geminiService.generateResponse = originalGenerateResponse;
        orchestratorService._pickWorkspace = originalPickWorkspace;
        orchestratorService._bindTemplateContextForRun = originalBindTemplateContextForRun;
    }
});

test('Orchestrator persists awaiting_credentials state for template fallback plans', async () => {
    const originalGeneratePlanWithValidation = orchestratorService._generatePlanWithValidation;
    const originalPickWorkspace = orchestratorService._pickWorkspace;
    const originalSaveState = orchestratorService._saveState;

    const savedStates = [];

    orchestratorService._generatePlanWithValidation = async () => ({
        ok: true,
        parsedPlan: { error: 'CREDENTIALS_REQUIRED', message: 'need creds' },
        attempts: [{ attempt: 1, response: '{"error":"CREDENTIALS_REQUIRED"}', parsed: { error: 'CREDENTIALS_REQUIRED' }, validation: { ok: true, errors: [] } }]
    });
    orchestratorService._pickWorkspace = async () => null;
    orchestratorService._saveState = async (state) => {
        savedStates.push(JSON.parse(JSON.stringify(state)));
    };

    try {
        const events = [];
        for await (const event of orchestratorService.processRequest(
            'Template Mode Enabled.\nTemplate ID: redpointfish-v1\nTemplate Name: RedPointFish Template\nPlease generate using this template unless I explicitly request another template.\n\nUser Request:\nBuild an Open Face Chinese Poker game with a single-player computer opponent using this template.',
            [],
            null,
            []
        )) {
            events.push(event);
        }

        const saved = savedStates[savedStates.length - 1];
        assert.ok(saved);
        assert.equal(saved.status, 'awaiting_credentials');
        assert.equal(saved.nextAction, 'Provide VIVERSE credentials to continue planned workflow');
        assert.equal(saved.runtimeFlags.requestScope.primary, 'gameplay');
        assert.equal(saved.templateContext.templateId, 'redpointfish-v1');
        assert.equal(typeof saved.templateContext.enforcementMode, 'string');
        assert.deepEqual(
            saved.tasks.map((task) => task.id),
            ['task_1', 'task_template_auth', 'task_template_logic', 'task_template_publish', 'task_reviewer', 'task_verifier']
        );
        assert.ok(events.some((event) => event.type === 'action' && event.action === 'require_credentials'));
    } finally {
        orchestratorService._generatePlanWithValidation = originalGeneratePlanWithValidation;
        orchestratorService._pickWorkspace = originalPickWorkspace;
        orchestratorService._saveState = originalSaveState;
    }
});
