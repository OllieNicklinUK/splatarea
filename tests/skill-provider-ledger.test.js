import test from 'node:test';
import assert from 'node:assert/strict';

import skillProvider from '../src/services/SkillProvider.js';
import skillLedgerService from '../src/services/SkillLedgerService.js';
import orchestratorService from '../src/services/OrchestratorService.js';
import verificationLedgerService from '../src/services/VerificationLedgerService.js';
import AgentRegistry from '../src/services/AgentRegistry.js';

test('SkillProvider canonicalizes root-file and folder skill refs', () => {
    assert.equal(
        skillProvider.canonicalizeRef('.', 'viverse-resilience-guide.md'),
        'file:viverse-resilience-guide.md'
    );
    assert.equal(
        skillProvider.canonicalizeRef('viverse-auth', 'SKILL.md'),
        'skill:viverse-auth/SKILL.md'
    );
});

test('SkillLedgerService records entries scoped by workspace and task context', () => {
    const workspace = '/tmp/ws-skill-ledger';
    skillLedgerService.setExecutionContext(workspace, { taskId: 'coder_1', role: 'CODER' });
    const entry = skillLedgerService.record(workspace, {
        requestedRef: './viverse-resilience-guide.md',
        canonicalRef: 'file:viverse-resilience-guide.md',
        resolvedPath: '/skills/viverse-resilience-guide.md',
        success: true
    });

    assert.equal(entry.taskId, 'coder_1');
    assert.equal(entry.role, 'CODER');
    assert.equal(skillLedgerService.getEntries(workspace, { taskId: 'coder_1' }).length > 0, true);
    skillLedgerService.clearExecutionContext(workspace);
});

test('Orchestrator validates required skill loads from ledger artifacts', () => {
    const workspace = '/tmp/ws-skill-validate';
    skillLedgerService.setExecutionContext(workspace, { taskId: 'coder_2', role: 'CODER' });
    skillLedgerService.record(workspace, {
        canonicalRef: 'file:viverse-resilience-guide.md',
        requestedRef: './viverse-resilience-guide.md',
        resolvedPath: '/skills/viverse-resilience-guide.md',
        success: true
    });
    skillLedgerService.record(workspace, {
        canonicalRef: 'skill:viverse-auth/SKILL.md',
        requestedRef: 'viverse-auth/SKILL.md',
        resolvedPath: '/skills/viverse-auth/SKILL.md',
        success: true
    });

    const result = orchestratorService._validateSkillLoadLedger(
        workspace,
        { id: 'coder_2', role: 'CODER' },
        ['file:viverse-resilience-guide.md', 'skill:viverse-auth/SKILL.md']
    );

    assert.equal(result.ok, true);
    skillLedgerService.clearExecutionContext(workspace);
});

test('Orchestrator validates root-file skill loads by resolved path fallback', () => {
    const workspace = '/tmp/ws-skill-path-fallback';
    const resolvedGuidePath = skillProvider.resolveCanonicalRef('file:viverse-resilience-guide.md').resolvedPath;
    skillLedgerService.setExecutionContext(workspace, { taskId: 'coder_3', role: 'CODER' });
    skillLedgerService.record(workspace, {
        canonicalRef: '',
        requestedRef: './viverse-resilience-guide.md',
        resolvedPath: resolvedGuidePath,
        success: true
    });

    const result = orchestratorService._validateSkillLoadLedger(
        workspace,
        { id: 'coder_3', role: 'CODER' },
        ['file:viverse-resilience-guide.md']
    );

    assert.equal(result.ok, true);
    skillLedgerService.clearExecutionContext(workspace);
});

test('Orchestrator validates root-file skill compliance report with canonical alias', () => {
    const result = orchestratorService._validateSkillComplianceReport(
        `[SKILL_COMPLIANCE_REPORT]
- viverse-resilience-guide.md: PASS - 1200ms delay and Strategy 0 recovery active.
- viverse-auth: PASS - Correct domain and profile recovery chain implemented.`,
        ['file:viverse-resilience-guide.md', 'skill:viverse-auth/SKILL.md']
    );

    assert.equal(result.ok, true);
});

test('Orchestrator tolerates missing skill compliance entry when ledger-backed load artifacts exist', () => {
    const workspace = '/tmp/ws-skill-compliance-fallback';
    skillLedgerService.setExecutionContext(workspace, { taskId: 'coder_4', role: 'CODER' });
    skillLedgerService.record(workspace, {
        canonicalRef: 'file:viverse-resilience-guide.md',
        requestedRef: './viverse-resilience-guide.md',
        resolvedPath: '/skills/viverse-resilience-guide.md',
        success: true
    });

    const tolerated = orchestratorService._shouldTolerateMissingSkillCompliance({
        workspacePath: workspace,
        task: { id: 'coder_4', role: 'CODER' },
        requiredRefs: ['file:viverse-resilience-guide.md'],
        reason: "Missing skill compliance entry for 'file:viverse-resilience-guide.md'."
    });

    assert.equal(tolerated, true);
    skillLedgerService.clearExecutionContext(workspace);
});

test('Orchestrator reclassifies obsolete failed skill compliance tasks on resume', () => {
    const workspace = '/tmp/ws-skill-compliance-revive';
    skillLedgerService.setExecutionContext(workspace, { taskId: 'c_fix_1', role: 'CODER' });
    skillLedgerService.record(workspace, {
        canonicalRef: 'file:viverse-resilience-guide.md',
        requestedRef: './viverse-resilience-guide.md',
        resolvedPath: '/skills/viverse-resilience-guide.md',
        success: true
    });
    skillLedgerService.clearExecutionContext(workspace);

    const state = {
        workspacePath: workspace,
        tasks: [
            {
                id: 'c_fix_1',
                role: 'CODER',
                status: 'failed',
                lastError: "Skill enforcement failed: Missing skill compliance entry for 'file:viverse-resilience-guide.md'.",
                requiredSkillRefs: ['file:viverse-resilience-guide.md']
            }
        ],
        runReport: { events: [] }
    };

    const revived = orchestratorService._reclassifyObsoleteSkillComplianceFailures(state, {
        isResumeCommand: true
    });

    assert.deepEqual(revived, ['c_fix_1']);
    assert.equal(state.tasks[0].status, 'completed');
    assert.equal(state.tasks[0].lastError, '');
});

test('Orchestrator revives stale blocked tasks when dependencies are already completed', () => {
    const state = {
        tasks: [
            { id: 'dep_1', status: 'completed' },
            {
                id: 'verifier_gate',
                role: 'Verifier',
                status: 'blocked',
                dependsOn: ['dep_1'],
                lastError: ''
            }
        ]
    };

    const revived = orchestratorService._reviveStaleBlockedTasks(state, {
        isResumeCommand: true
    });

    assert.deepEqual(revived, ['verifier_gate']);
    assert.equal(state.tasks[1].status, 'pending');
});

test('Orchestrator treats verifier pass after latest fix as runtime revalidation', () => {
    const ok = orchestratorService._hasRuntimeRevalidationAfterLatestFix({
        runtimeFlags: {
            lastFixTaskCompletedAt: '2026-04-09T02:00:00.000Z'
        },
        verificationLedger: [
            { type: 'preview_probe', status: 'pass', at: '2026-04-09T01:59:00.000Z' },
            { type: 'verifier', status: 'pass', at: '2026-04-09T02:01:00.000Z' }
        ]
    });

    assert.equal(ok, true);
});

test('Orchestrator treats completed verifier evidence in summary as runtime revalidation fallback', () => {
    const ok = orchestratorService._hasRuntimeRevalidationAfterLatestFix({
        runtimeFlags: {
            lastFixTaskCompletedAt: '2026-04-09T02:00:00.000Z'
        },
        verificationLedger: [],
        tasks: [
            { id: 'verifier_gate', role: 'Verifier', status: 'completed' }
        ],
        projectContextSummary: '- Task verifier_gate completed.\n- Verifier passed all compliance gates.'
    });

    assert.equal(ok, true);
});

test('Orchestrator treats preview probe summary evidence as runtime/browser evidence fallback', () => {
    const ok = orchestratorService._hasAnyPreviewProbeEvent({
        verificationLedger: [],
        runReport: { events: [] },
        projectContextSummary: '- AUTO_TEST preview probe: pass. checks=[auth_profile:pass, matchmaking:pass]'
    });

    assert.equal(ok, true);
});

test('Orchestrator parses preview probe checks from summary fallback', () => {
    const checks = orchestratorService._latestPreviewProbeChecks({
        verificationLedger: [],
        runReport: { events: [] },
        projectContextSummary: '- AUTO_TEST preview probe: pass. checks=[auth_profile:pass, matchmaking:pass]'
    });

    assert.deepEqual(checks, [
        { name: 'auth_profile', status: 'pass' },
        { name: 'matchmaking', status: 'pass' }
    ]);
});

test('Orchestrator falls back to reviewer runtime checks when no preview probe exists', () => {
    const checks = orchestratorService._latestPreviewProbeChecks({
        verificationLedger: [
            {
                type: 'reviewer',
                status: 'pass',
                details: {
                    runtime_checks: [
                        { name: 'auth_profile', status: 'pass' },
                        { name: 'matchmaking', status: 'pass' }
                    ]
                }
            }
        ],
        runReport: { events: [] },
        projectContextSummary: ''
    });

    assert.deepEqual(checks, [
        { name: 'auth_profile', status: 'pass' },
        { name: 'matchmaking', status: 'pass' }
    ]);
});

test('Orchestrator does not require preview probe evidence from reviewer schema keywords alone', () => {
    const required = orchestratorService._requiresPreviewProbeEvidence({
        request: 'Build a memory matching game',
        tasks: [
            {
                id: 'task_reviewer',
                role: 'Reviewer',
                prompt: 'Output STRICT JSON with runtime_checks including auth_profile and matchmaking.'
            }
        ]
    });

    assert.equal(required, false);
});

test('Orchestrator resolves the latest preview URL from summary text', () => {
    const url = orchestratorService._resolveLatestPreviewUrl({
        projectContextSummary: [
            '- IMPORTANT: The VIVERSE Preview URL for this project is: https://worlds.viverse.com/old123?preview',
            '- IMPORTANT: The VIVERSE Preview URL for this project is: https://worlds.viverse.com/new456?preview'
        ].join('\n'),
        runReport: { events: [] }
    });

    assert.equal(url, 'https://worlds.viverse.com/new456?preview');
});

test('Orchestrator strips stale workflow halted notes before successful finalize', () => {
    const cleaned = orchestratorService._stripWorkflowHaltNotes([
        'ORIGINAL USER PROJECT REQUEST: "build app"',
        '- WORKFLOW HALTED: Runtime/browser evidence missing.',
        '- IMPORTANT: The VIVERSE Preview URL for this project is: https://worlds.viverse.com/new456?preview',
        '- WORKFLOW HALTED: Template required gates failed.'
    ].join('\n'));

    assert.doesNotMatch(cleaned, /WORKFLOW HALTED/);
    assert.match(cleaned, /https:\/\/worlds\.viverse\.com\/new456\?preview/);
});

test('Orchestrator does not force multiplayer compliance profile for single-player fix loops', () => {
    const profiles = orchestratorService._deriveComplianceProfiles(
        {
            id: 'c_fix_123',
            role: 'Coder',
            prompt: 'DETERMINISTIC COMPLIANCE FIX REQUIRED. Signature: mp-room-discovery-before-join\nResolve all failed rules from fast gate:\nmp-room-discovery-before-join: Matchmaking must discover rooms before deciding join/create.'
        },
        'ORIGINAL USER PROJECT REQUEST: "Build a simple single-player memory matching card game"',
        {
            request: 'Build a simple single-player memory matching card game using the redpointfish-v1 template.'
        }
    );

    assert.equal(profiles.includes('auth'), true);
    assert.equal(profiles.includes('multiplayer'), false);
});

test('Orchestrator always passes immutable gate (advisory — violations are no longer blocking)', async () => {
    const result = await orchestratorService._evaluateTemplateGate(
        {
            runtimeFlags: {
                lastFixTaskCompletedAt: '2026-04-09T02:00:00.000Z'
            },
            templateContext: {
                contractViolations: [
                    { at: '2026-04-09T01:00:00.000Z', filePath: 'src/hooks/useViverseAuth.js', reason: 'immutable_path_violation' }
                ]
            }
        },
        '/tmp/ws',
        'static.immutable_path_violation',
        ''
    );

    assert.equal(result.status, 'pass');
});

test('Orchestrator always passes immutable gate even with editable-path violations', async () => {
    const result = await orchestratorService._evaluateTemplateGate(
        {
            templateContext: {
                contractViolations: [
                    { at: '2026-04-09T03:00:00.000Z', filePath: '.env', reason: 'editable_path_violation' },
                    { at: '2026-04-09T03:10:00.000Z', filePath: 'CONTRACT.json', reason: 'editable_path_violation' }
                ]
            }
        },
        '/tmp/ws',
        'static.immutable_path_violation',
        ''
    );

    assert.equal(result.status, 'pass');
});

test('Orchestrator always passes immutable gate even when files differ from template', async () => {
    const result = await orchestratorService._evaluateTemplateGate(
        {
            templateContext: {
                templateRoot: '/Users/casper_wang/Projects/AI/viverse-ai-agent/templates/redpointfish-v1',
                contract: {
                    immutablePaths: [
                        'src/hooks/useViverseAuth.js',
                        'src/hooks/useMultiplayer.js',
                        'src/components/ViverseDiagnostic.jsx'
                    ]
                },
                contractViolations: [
                    { at: '2026-04-10T02:34:57.656Z', filePath: 'src/hooks/useViverseAuth.js', reason: 'immutable_path_violation' }
                ]
            }
        },
        '/Users/casper_wang/Projects/AI/viverse-ai-agent/templates/redpointfish-v1',
        'static.immutable_path_violation',
        ''
    );

    assert.equal(result.status, 'pass');
});

test('Orchestrator rewrites template-bound app-id prompts away from mandatory .env truth', () => {
    const tasks = orchestratorService._enforceWorkflowTasks(
        [
            {
                id: 'coder_setup',
                role: 'Coder',
                prompt: "1. Initialize the project using the redpointfish-v1 template.\n2. Run 'viverse-cli app create' to generate a new App ID.\n3. Create a .env file containing 'VITE_VIVERSE_CLIENT_ID=<NEW_APP_ID>' immediately.\n4. Verify the .env file exists before proceeding.",
                dependsOn: [],
                status: 'pending'
            },
            {
                id: 'verifier_gate',
                role: 'Verifier',
                prompt: 'Perform the Grep Gate check: verify that the App ID from the .env file is present in the bundled assets.',
                dependsOn: ['coder_setup'],
                status: 'pending'
            }
        ],
        { message: 'Build a game using the redpointfish-v1 template.' }
    );

    const setup = tasks.find((task) => task.id === 'coder_setup');
    const verifier = tasks.find((task) => task.id === 'verifier_gate');

    assert.ok(setup);
    assert.ok(verifier);
    assert.doesNotMatch(String(setup.prompt), /Verify the \.env file exists/i);
    assert.match(String(setup.prompt), /vite\.config\.js/i);
    assert.doesNotMatch(String(verifier.prompt), /from the \.env file/i);
    assert.match(String(verifier.prompt), /approved App ID source/i);
});

test('Orchestrator records template gate results into verification ledger', () => {
    const workspace = '/tmp/ws-template-gate-ledger';
    const state = {
        workspacePath: workspace,
        runReport: { events: [] }
    };

    orchestratorService._appendRunEvent(state, {
        type: 'template_gate_result',
        templateId: 'redpointfish-v1',
        gate: 'runtime.auth_profile_pass',
        status: 'pass',
        reason: ''
    });

    const entries = verificationLedgerService.getEntries(workspace);
    assert.equal(entries.length > 0, true);
    assert.equal(entries.at(-1).type, 'template_gate');
    assert.equal(entries.at(-1).details.gate, 'runtime.auth_profile_pass');
    assert.equal(entries.at(-1).status, 'pass');
});

test('Summarizer instructions treat workspace lessons as optional and avoid local skills path reads', () => {
    const instruction = String(AgentRegistry.SUMMARIZER.systemInstruction || '');

    assert.match(instruction, /CHECK whether '.viverse_lessons\.json' exists/i);
    assert.match(instruction, /If it does not exist, skip local lesson ingestion without treating that as an error/i);
    assert.doesNotMatch(instruction, /READ 'skills\/viverse-resilience-guide\.md'/i);
});
