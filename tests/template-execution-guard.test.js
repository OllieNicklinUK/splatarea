import test from 'node:test';
import assert from 'node:assert/strict';

import orchestratorService from '../src/services/OrchestratorService.js';
import workflowRecoveryService from '../src/services/WorkflowRecoveryService.js';

test('OrchestratorService builds template execution guard with high-risk and editable paths', () => {
    const block = orchestratorService._buildTemplateExecutionGuardBlock({
        templateContext: {
            templateId: 'redpointfish-v1',
            enforcementMode: 'enforce',
            contract: {
                immutablePaths: ['src/hooks/useViverseAuth.js'],
                editablePaths: ['src/game/**'],
                injectionHooks: [
                    {
                        hookId: 'game-engine',
                        location: 'src/game/engine.js',
                        purpose: 'extend gameplay logic'
                    }
                ]
            },
            contractViolations: [
                { filePath: 'src/hooks/useViverseAuth.js', reason: 'immutable_path_violation' }
            ]
        }
    });

    assert.match(block, /\[TEMPLATE_EXECUTION_GUARD\]/);
    assert.match(block, /High-risk paths/);
    assert.match(block, /src\/hooks\/useViverseAuth\.js/);
    assert.match(block, /src\/game\/\*\*/);
    assert.match(block, /game-engine @ src\/game\/engine\.js/);
    assert.match(block, /Recent high-risk file writes/);
});

test('WorkflowRecoveryService carries template guard into coder loop recovery task', () => {
    const state = {
        tasks: [],
        runtimeFlags: {}
    };
    const result = workflowRecoveryService.handleStreamFailure({
        state,
        task: {
            id: 'task_2',
            role: 'Coder'
        },
        reason: 'MAX_TOOL_ITERATIONS_REACHED',
        templateGuardBlock: '[TEMPLATE_EXECUTION_GUARD]\n- High-risk paths (read fully before editing).',
        taskStartedAt: Date.now() - 25,
        projectContextSummary: 'running',
        maxTransientInfraRetriesPerTask: 0,
        computeTransientInfraRetryDelayMs: () => 0,
        appendRunEvent: () => {}
    });

    assert.equal(result.disposition, 'recovery_scheduled');
    assert.equal(result.retryId.startsWith('loop_recover_'), true);
    assert.equal(result.classification.category, 'tool_loop_error');
    assert.match(result.projectContextSummary, /LOOP RECOVERY scheduled/);
    assert.match(state.tasks[0].prompt, /\[TEMPLATE_EXECUTION_GUARD\]/);
});

test('OrchestratorService builds logic-task execution guard that forbids publish drift', () => {
    const block = orchestratorService._buildTaskExecutionGuard({
        id: 'coder_logic',
        role: 'Coder',
        prompt: 'Implement OFC engine, royalties, 13-card placement rules, and heuristic AI.'
    }, {
        runtimeFlags: {
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            }
        }
    });

    assert.match(block, /\[TASK_EXECUTION_GUARD\]/);
    assert.match(block, /Scope: gameplay logic only/);
    assert.match(block, /Request scope authority: gameplay/);
    assert.match(block, /Allowed subsystems for this run: gameplay, ui/);
    assert.match(block, /do NOT modify platform-core auth, platform-core matchmaking, publish, or diagnostics files/i);
    assert.match(block, /Do NOT run viverse-cli auth login, viverse-cli app create, or viverse-cli app publish/);
});

test('OrchestratorService builds app-setup guard that stops repeated .env retries', () => {
    const block = orchestratorService._buildTaskExecutionGuard({
        id: 'coder_auth',
        role: 'Coder',
        prompt: 'Create a new app and wire VITE_VIVERSE_CLIENT_ID into the template.'
    }, {
        runtimeFlags: {
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            }
        }
    });

    assert.match(block, /Scope: app setup and App ID wiring only/);
    assert.match(block, /If AUTHORITATIVE_APP_ID is already resolved in the context, do NOT run viverse-cli app create again/);
    assert.match(block, /If \.env or \.env\.production writes are blocked by template rules, do NOT keep retrying them/);
    assert.match(block, /Do NOT write App ID metadata into package\.json/);
});

test('OrchestratorService builds ui-task guard with advisory auth hook guidance', () => {
    const block = orchestratorService._buildTaskExecutionGuard({
        id: 'coder_ui',
        role: 'Coder',
        prompt: 'Finalize OFCP overlay UI and design-system styling.'
    }, {
        runtimeFlags: {
            requestScope: {
                primary: 'ui',
                allowedSubsystems: ['ui', 'assets']
            }
        }
    });

    assert.match(block, /Scope: UI implementation only/);
    assert.match(block, /Request scope authority: ui/);
    assert.match(block, /Allowed subsystems for this run: ui, assets/);
    assert.match(block, /do NOT modify gameplay engine, platform-core auth, platform-core matchmaking, publish, or diagnostics files/i);
    assert.match(block, /Avoid editing core runtime\/auth hooks/);
    assert.match(block, /Route UI changes through editable components, view-model hooks, and OFC-specific extension files/);
});

test('OrchestratorService builds auth-preflight guard that forbids .env and report writes', () => {
    const block = orchestratorService._buildTaskExecutionGuard({
        id: 'auth_preflight',
        role: 'Coder',
        prompt: 'AUTH PREFLIGHT ONLY: verify auth bootstrap and minimal build sanity.'
    });

    assert.match(block, /Scope: auth preflight only/);
    assert.match(block, /Do NOT write \.env, \.env\.production, PREFLIGHT_REPORT\.md/);
    assert.match(block, /Record evidence in the task response and rely on workflow state \/ compliance ledgers/);
});

test('OrchestratorService classifies matchmaking compliance signatures into scoped fix prompts', () => {
    const subsystem = orchestratorService._inferFailureSubsystem({
        issueLines: ['mp-room-discovery-before-join: Matchmaking must discover rooms before deciding join/create.'],
        task: {
            id: 'c_fix_1',
            role: 'Coder',
            prompt: 'DETERMINISTIC COMPLIANCE FIX REQUIRED'
        },
        state: {
            request: 'Build an OFCP game using the redpointfish-v1 template',
            runtimeFlags: {
                requestScope: {
                    primary: 'gameplay',
                    allowedSubsystems: ['gameplay', 'ui']
                }
            }
        }
    });

    const block = orchestratorService._buildScopedFixGuard({
        subsystem,
        issueLines: ['mp-room-discovery-before-join: Matchmaking must discover rooms before deciding join/create.']
    });

    assert.equal(subsystem, 'platform-core.matchmaking');
    assert.match(block, /Scope: matchmaking\/runtime coordination only/);
    assert.match(block, /Do NOT rewrite auth bootstrap, gameplay rules, leaderboard, or publish flow/);
});

test('OrchestratorService classifies reviewer UI findings into ui-scoped fix prompts', () => {
    const subsystem = orchestratorService._inferFailureSubsystem({
        issueLines: ['LeaderboardManager panel covers gameplay controls on small screens.'],
        task: {
            id: 'fix_1',
            role: 'Coder',
            prompt: 'Fix the following blocking issues raised by the Reviewer.'
        },
        state: {
            request: 'Adjust the leaderboard panel UI for the template game',
            runtimeFlags: {
                requestScope: {
                    primary: 'ui',
                    allowedSubsystems: ['ui', 'assets']
                }
            }
        }
    });

    const block = orchestratorService._buildScopedFixGuard({
        subsystem,
        issueLines: ['LeaderboardManager panel covers gameplay controls on small screens.']
    });

    assert.equal(subsystem, 'ui');
    assert.match(block, /Scope: UI only/);
    assert.match(block, /Do NOT rewrite gameplay engine, auth, matchmaking, or publish flow/);
});
