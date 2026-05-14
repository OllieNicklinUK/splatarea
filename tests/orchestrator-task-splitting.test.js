import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import orchestratorService from '../src/services/OrchestratorService.js';
import complianceService from '../src/services/ComplianceService.js';
import templateContractService from '../src/services/templates/TemplateContractService.js';

test('OrchestratorService splits combined coder task into auth, logic, and publish stages', () => {
    const tasks = orchestratorService._enforceWorkflowTasks([
        {
            id: 'task_2',
            role: 'Coder',
            prompt: "Initialize the template, run viverse-cli app create, extract App ID, implement Open Face Chinese Poker logic and heuristic AI, then publish dist.",
            dependsOn: ['arch_1'],
            status: 'pending'
        }
    ], {
        message: 'Build an Open Face Chinese Poker game using the redpointfish-v1 template.'
    });

    const ids = tasks.map((t) => t.id);
    assert.equal(ids.includes('task_2'), false);
    assert.equal(ids.includes('task_2_auth'), true);
    assert.equal(ids.includes('task_2_logic'), true);
    assert.equal(ids.includes('task_2_publish'), true);

    const authTask = tasks.find((t) => t.id === 'task_2_auth');
    const logicTask = tasks.find((t) => t.id === 'task_2_logic');
    const publishTask = tasks.find((t) => t.id === 'task_2_publish');

    assert.deepEqual(authTask.dependsOn, ['arch_1']);
    assert.deepEqual(logicTask.dependsOn, ['task_2_auth']);
    assert.deepEqual(publishTask.dependsOn, ['task_2_logic']);
});

test('OrchestratorService prunes legacy template tasks when split flow exists', () => {
    const tasks = orchestratorService._enforceWorkflowTasks([
        {
            id: 'task_1',
            role: 'Architect',
            prompt: 'Create CONTRACT.json for OFCP.',
            dependsOn: [],
            status: 'pending'
        },
        {
            id: 'task_2',
            role: 'Coder',
            prompt: "Login using viverse-cli, create app, wire app id, and implement auth resilience.",
            dependsOn: ['task_1'],
            status: 'pending'
        },
        {
            id: 'task_3',
            role: 'Coder',
            prompt: 'Implement Open Face Chinese Poker gameplay logic and AI.',
            dependsOn: ['task_2'],
            status: 'pending'
        },
        {
            id: 'task_4',
            role: 'Coder',
            prompt: 'Implement matchmaking v4.2 and multiplayer sync.',
            dependsOn: ['task_3'],
            status: 'pending'
        },
        {
            id: 'task_5',
            role: 'Coder',
            prompt: 'Run npm run build and publish dist preview url.',
            dependsOn: ['task_4'],
            status: 'pending'
        },
        {
            id: 'task_7',
            role: 'Coder',
            prompt: "Initialize the template, run viverse-cli app create, extract App ID, implement Open Face Chinese Poker logic and heuristic AI, then publish dist.",
            dependsOn: ['task_1'],
            status: 'pending'
        }
    ], {
        message: 'Build an Open Face Chinese Poker game using the redpointfish-v1 template.'
    });

    const ids = tasks.map((t) => t.id);
    assert.equal(ids.includes('task_2'), false);
    assert.equal(ids.includes('task_3'), false);
    assert.equal(ids.includes('task_4'), false);
    assert.equal(ids.includes('task_5'), false);
    assert.equal(ids.includes('task_7_auth'), true);
    assert.equal(ids.includes('task_7_logic'), true);
    assert.equal(ids.includes('task_7_publish'), true);
});

test('OrchestratorService canonicalizes legacy template chains into auth, logic, and publish stages', () => {
    const tasks = orchestratorService._enforceWorkflowTasks([
        {
            id: 'task_1',
            role: 'Architect',
            prompt: 'Create CONTRACT.json for OFCP.',
            dependsOn: [],
            status: 'pending'
        },
        {
            id: 'task_2',
            role: 'Coder',
            prompt: 'Authenticate with viverse-cli, create the app, and wire the App ID.',
            dependsOn: ['task_1'],
            status: 'pending'
        },
        {
            id: 'task_3',
            role: 'Coder',
            prompt: 'Implement OFCP game rules and UI.',
            dependsOn: ['task_2'],
            status: 'pending'
        },
        {
            id: 'task_4',
            role: 'Coder',
            prompt: 'Publish the final dist output and return the preview URL.',
            dependsOn: ['task_3'],
            status: 'pending'
        },
        {
            id: 'task_reviewer',
            role: 'Reviewer',
            prompt: 'Review the generated app.',
            dependsOn: ['task_4'],
            status: 'pending'
        }
    ], {
        message: 'Build an Open Face Chinese Poker game using the redpointfish-v1 template.'
    });

    const ids = tasks.map((t) => t.id);
    assert.equal(ids.includes('task_2'), false);
    assert.equal(ids.includes('task_3'), false);
    assert.equal(ids.includes('task_4'), false);
    assert.equal(ids.includes('task_template_auth'), true);
    assert.equal(ids.includes('task_template_logic'), true);
    assert.equal(ids.includes('task_template_publish'), true);

    const authTask = tasks.find((t) => t.id === 'task_template_auth');
    const logicTask = tasks.find((t) => t.id === 'task_template_logic');
    const publishTask = tasks.find((t) => t.id === 'task_template_publish');
    const reviewerTask = tasks.find((t) => t.id === 'task_reviewer');

    assert.deepEqual(authTask.dependsOn, ['task_1']);
    assert.deepEqual(logicTask.dependsOn, ['task_template_auth']);
    assert.deepEqual(publishTask.dependsOn, ['task_template_logic']);
    assert.deepEqual(reviewerTask.dependsOn, ['task_template_publish']);
});

test('OrchestratorService scrubs credential literals from normalized task prompts', () => {
    const [task] = orchestratorService._normalizeTasks([
        {
            id: 'task_2',
            role: 'Coder',
            prompt: 'Login with viverse-cli auth login -e test@example.invalid -p not-a-real-password. Email: test@example.invalid Password: not-a-real-password',
            dependsOn: []
        }
    ]);

    assert.match(task.prompt, /<email>/);
    assert.match(task.prompt, /<runtime-provided-email>/);
    assert.match(task.prompt, /<runtime-provided-password>/);
    assert.doesNotMatch(task.prompt, /caspertest@yopmail\.com/i);
    assert.doesNotMatch(task.prompt, /Aa0110test/);
});

test('OrchestratorService builds deterministic template fallback plan', () => {
    const plan = orchestratorService._buildTemplateFallbackPlan(
        'Build an Open Face Chinese Poker game using the redpointfish-v1 template.'
    );

    assert.equal(plan.isNewProject, true);
    assert.deepEqual(
        plan.tasks.map((task) => task.id),
        ['task_1', 'task_template_auth', 'task_template_logic', 'task_template_publish']
    );
    assert.match(plan.tasks[1].prompt, /authoritative App ID/i);
    assert.match(plan.tasks[2].prompt, /minimum necessary gameplay and related UI changes/i);
    assert.match(plan.tasks[3].prompt, /publish/i);
});

test('OrchestratorService rehardens loaded template state tasks on resume', () => {
    const state = {
        templateContext: {
            templateId: 'redpointfish-v1'
        },
        tasks: [
            {
                id: 'task_1',
                role: 'Architect',
                prompt: 'Create CONTRACT.json for OFCP.',
                dependsOn: [],
                status: 'completed'
            },
            {
                id: 'task_2',
                role: 'Coder',
            prompt: 'Login with viverse-cli auth login -e test@example.invalid -p not-a-real-password, create app, and wire App ID.',
                dependsOn: ['task_1'],
                status: 'pending'
            },
            {
                id: 'task_3',
                role: 'Coder',
                prompt: 'Implement OFCP game rules and UI.',
                dependsOn: ['task_2'],
                status: 'pending'
            },
            {
                id: 'task_4',
                role: 'Coder',
                prompt: 'Publish the final dist output and return the preview URL.',
                dependsOn: ['task_3'],
                status: 'pending'
            }
        ]
    };

    const changed = orchestratorService._rehardenLoadedStateTasks(state, {
        message: 'continue req_1234 and keep using the redpointfish-v1 template'
    });

    assert.equal(changed, true);
    const ids = state.tasks.map((task) => task.id);
    assert.equal(ids.includes('task_2'), false);
    assert.equal(ids.includes('task_3'), false);
    assert.equal(ids.includes('task_4'), false);
    assert.equal(ids.includes('task_template_auth'), true);
    assert.equal(ids.includes('task_template_logic'), true);
    assert.equal(ids.includes('task_template_publish'), true);

    const authTask = state.tasks.find((task) => task.id === 'task_template_auth');
    assert.match(authTask.prompt, /authoritative App ID/i);
    assert.doesNotMatch(authTask.prompt, /caspertest@yopmail\.com/i);
    assert.doesNotMatch(authTask.prompt, /Aa0110test/);
});

test('OrchestratorService retires stale App-ID loop recovery tasks when bootstrap blocker supersedes them', async () => {
    const originalRunFastGate = complianceService.runFastGate;
    complianceService.runFastGate = async () => ({
        status: 'fail',
        findings: [
            {
                ruleId: 'template-world-bootstrap-missing',
                severity: 'high',
                message: 'Startup file never launches the world.'
            }
        ]
    });

    try {
        const state = {
            projectContextSummary: 'Existing project summary.',
            templateContext: {
                templateId: 'battletanks-v1'
            },
            runtimeFlags: {
                requestScope: {
                    primary: 'gameplay',
                    allowedSubsystems: ['gameplay', 'ui']
                }
            },
            tasks: [
                {
                    id: 'task_template_logic',
                    role: 'Coder',
                    prompt: 'Implement gameplay and UI changes.',
                    status: 'failed'
                },
                {
                    id: 'loop_recover_123',
                    role: 'Coder',
                    recoveryOf: 'task_template_logic',
                    loopRootId: 'task_template_logic',
                    prompt: "LOOP RECOVERY TASK (deterministic): Previous coder task 'task_template_logic' failed due to tool loop.\n1) Determine authoritative App ID.\n2) Ensure VITE_VIVERSE_CLIENT_ID is wired.",
                    status: 'pending'
                }
            ]
        };

        const changed = await orchestratorService._retireObsoletePendingRecoveryTasks(
            state,
            '/tmp/workspace'
        );

        assert.equal(changed, true);
        assert.equal(state.tasks[1].status, 'blocked');
        assert.match(String(state.tasks[1].lastError || ''), /bootstrap missing/i);
        assert.match(String(state.projectContextSummary || ''), /missing world bootstrap/i);
    } finally {
        complianceService.runFastGate = originalRunFastGate;
    }
});

test('OrchestratorService auto-resolves stale App-ID loop recovery tasks when app-id findings are gone', async () => {
    const originalRunFastGate = complianceService.runFastGate;
    complianceService.runFastGate = async () => ({
        status: 'fail',
        findings: [
            {
                ruleId: 'mp-room-discovery-before-join',
                severity: 'high',
                message: 'Discover rooms before join/create.'
            }
        ]
    });

    try {
        const state = {
            projectContextSummary: 'Existing project summary.',
            templateContext: {
                templateId: 'battletanks-v1'
            },
            runtimeFlags: {
                requestScope: {
                    primary: 'gameplay',
                    allowedSubsystems: ['gameplay', 'ui']
                }
            },
            tasks: [
                {
                    id: 'loop_recover_456',
                    role: 'Coder',
                    recoveryOf: 'task_template_logic',
                    loopRootId: 'task_template_logic',
                    prompt: "LOOP RECOVERY TASK (deterministic): Determine authoritative App ID and verify VITE_VIVERSE_CLIENT_ID.",
                    status: 'pending'
                }
            ]
        };

        const changed = await orchestratorService._retireObsoletePendingRecoveryTasks(
            state,
            '/tmp/workspace'
        );

        assert.equal(changed, true);
        assert.equal(state.tasks[0].status, 'completed');
        assert.match(String(state.projectContextSummary || ''), /App-ID recovery tasks/i);
    } finally {
        complianceService.runFastGate = originalRunFastGate;
    }
});

test('OrchestratorService blocks publish when template startup bootstrap is missing', async () => {
    const originalRunFastGate = complianceService.runFastGate;
    complianceService.runFastGate = async () => ({
        status: 'fail',
        findings: [
            {
                ruleId: 'template-world-bootstrap-missing',
                severity: 'high',
                message: 'Startup file never launches the world.'
            }
        ]
    });

    try {
        const result = await orchestratorService._checkPublishPreconditions(
            {
                id: 'task_template_publish',
                role: 'Coder',
                prompt: 'Publish the final dist output.'
            },
            {
                templateContext: {
                    templateId: 'battletanks-v1'
                },
                runtimeFlags: {
                    requestScope: {
                        primary: 'gameplay',
                        allowedSubsystems: ['gameplay', 'ui']
                    }
                }
            },
            '/tmp/workspace',
            'Publish the template build.'
        );

        assert.equal(result.ok, false);
        assert.match(String(result.reason || ''), /startup\/runtime bootstrap is missing the world launch path/i);
    } finally {
        complianceService.runFastGate = originalRunFastGate;
    }
});

test('OrchestratorService infers bootstrap subsystem for template world bootstrap blocker', () => {
    const subsystem = orchestratorService._inferFailureSubsystem({
        issueLines: [
            'template-world-bootstrap-missing: Template runtime bootstrap must launch the game world.'
        ],
        task: {
            prompt: 'Fix the failing template runtime bootstrap.'
        },
        state: {
            request: 'Make the battletanks template girly for kids.'
        }
    });

    assert.equal(subsystem, 'platform-core.bootstrap');
});

test('OrchestratorService rehardens pending fix task scope when bootstrap blocker is present', () => {
    const state = {
        runtimeFlags: {
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            }
        },
        tasks: [
            {
                id: 'c_fix_1',
                role: 'Coder',
                status: 'pending',
                prompt: `DETERMINISTIC COMPLIANCE FIX REQUIRED. Signature: publish-no-placeholder-appid || template-world-bootstrap-missing
Target subsystem: platform-core.matchmaking
Resolve all failed rules from fast gate:
publish-no-placeholder-appid: Publishing config/source contains placeholder App ID tokens.
template-world-bootstrap-missing: Template runtime bootstrap must launch the game world.

Task context: publish

SCOPED FIX EXECUTION (MANDATORY):
- Scope: matchmaking/runtime coordination only.
- Touch only room discovery.
FIX SCOPE LOCK (MANDATORY):
- Apply a minimal patch.`
            }
        ]
    };

    const changed = orchestratorService._rehardenPendingFixTaskScopes(state);

    assert.equal(changed, true);
    assert.match(state.tasks[0].prompt, /Target subsystem: platform-core\.bootstrap/);
    assert.match(state.tasks[0].prompt, /Scope: startup\/bootstrap runtime only\./);
});

test('OrchestratorService derives task request scope from issue block before stale target label', () => {
    const scope = orchestratorService._deriveTaskRequestScope(
        {
            prompt: `DETERMINISTIC COMPLIANCE FIX REQUIRED. Signature: publish-no-placeholder-appid || template-world-bootstrap-missing
Target subsystem: platform-core.matchmaking
Resolve all failed rules from fast gate:
publish-no-placeholder-appid: Publishing config/source contains placeholder App ID tokens.
template-world-bootstrap-missing: Template runtime bootstrap must launch the game world.

Task context: publish`
        },
        {
            runtimeFlags: {
                requestScope: {
                    primary: 'gameplay',
                    allowedSubsystems: ['gameplay', 'ui']
                }
            }
        }
    );

    assert.equal(scope.primary, 'platform-core.bootstrap');
    assert.deepEqual(scope.allowedSubsystems, ['platform-core.bootstrap', 'platform-core.auth']);
});

test('OrchestratorService forces auth_preflight task scope to platform-core.auth', () => {
    const scope = orchestratorService._deriveTaskRequestScope({
        id: 'auth_preflight',
        role: 'Coder',
        prompt: 'AUTH PREFLIGHT ONLY: verify auth bootstrap and stop after evidence.'
    }, {
        runtimeFlags: {
            requestScope: {
                primary: 'matchmaking',
                allowedSubsystems: ['platform-core.matchmaking']
            }
        }
    });

    assert.equal(scope.primary, 'platform-core.auth');
    assert.deepEqual(scope.allowedSubsystems, ['platform-core.auth']);
});

test('OrchestratorService forces task_template_auth scope to platform-core.auth', () => {
    const scope = orchestratorService._deriveTaskRequestScope({
        id: 'task_template_auth',
        role: 'Coder',
        prompt: 'Authenticate with the VIVERSE CLI, create the app if needed, extract one authoritative App ID, and wire that App ID through allowed template extension points only. If .env writes are blocked, use vite.config.ts or vite.config.js fallback and stop after one exact build verification.'
    }, {
        runtimeFlags: {
            requestScope: {
                primary: 'ui',
                allowedSubsystems: ['ui', 'assets']
            }
        }
    });

    assert.equal(scope.primary, 'platform-core.auth');
    assert.deepEqual(scope.allowedSubsystems, ['platform-core.auth']);
});

test('OrchestratorService auth acceptance accepts tankarena sdk globals in any order', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-auth-preflight-'));
    try {
        await fs.writeFile(
            path.join(workspacePath, 'viverseAuth.js'),
            `function detectSdkGlobal() {
  return window.viverse || window.VIVERSE_SDK || window.vSdk || null;
}
async function run(client) {
  await delay(1200);
  const authResult = await client.checkAuth();
  const token = authResult?.accessToken || authResult?.access_token || authResult?.accountId || authResult?.account_id || "";
  if (!token) return null;
  return client.getUserInfo();
}`,
            'utf8'
        );

        const result = await orchestratorService._runAuthAcceptanceGate(workspacePath);

        assert.equal(result.ok, true);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('OrchestratorService injects verify-only auth preflight prompt for tankarena template requests', () => {
    const tasks = orchestratorService._enforceWorkflowTasks([
        {
            id: 'task_1',
            role: 'Architect',
            prompt: 'Create CONTRACT.json for the tank arena variant.',
            dependsOn: [],
            status: 'pending'
        },
        {
            id: 'task_2_logic',
            role: 'Coder',
            prompt: 'Implement the requested tank arena gameplay and HUD changes.',
            dependsOn: ['task_1'],
            status: 'pending'
        }
    ], {
        message: 'Create a new game using template tankarena-3d-v1. Keep auth, leaderboard, and matchmaking stable while turning it into a neon desert tank arena with lighter bot difficulty.'
    });

    const preflight = tasks.find((task) => task.id === 'auth_preflight');
    assert.ok(preflight);
    assert.match(preflight.prompt, /VERIFY existing VIVERSE auth\/bootstrap surfaces/i);
    assert.match(preflight.prompt, /do NOT rewrite source files/i);
});

test('OrchestratorService classifies duplicate auth bootstrap reviewer failures as bootstrap, not matchmaking', () => {
    const scope = orchestratorService._deriveTaskRequestScope(
        {
            id: 'fix_auth_bootstrap_dup',
            role: 'Coder',
            prompt: `Fix the following blocking issues raised by the Reviewer.
Target subsystem: platform-core.matchmaking
Authentication bootstrap is executed twice (once in index.html and once in src/main.js), violating mandatory gate #9 of the viverse-auth skill.

Reviewer feedback: The auth bootstrap MUST run exactly once per page mount/session.`
        },
        {
            runtimeFlags: {
                requestScope: {
                    primary: 'gameplay',
                    allowedSubsystems: ['gameplay', 'ui']
                }
            }
        }
    );

    assert.equal(scope.primary, 'platform-core.bootstrap');
    assert.deepEqual(scope.allowedSubsystems, ['platform-core.bootstrap', 'platform-core.auth']);
});

test('OrchestratorService keeps publish-stage tasks in publish scope even when request mentions matchmaking stability', () => {
    const scope = orchestratorService._deriveTaskRequestScope(
        {
            id: 'code_01_publish',
            role: 'Coder',
            prompt: 'Using the already-established authoritative App ID, run one final build verification and publish the dist output. Do not rewrite gameplay or UI unless a release blocker directly proves they are broken.'
        },
        {
            request: 'Create a new game using template tankarena-3d-v1. Keep auth, leaderboard, and matchmaking stable while turning it into a toy-brick 3D tank battler.',
            runtimeFlags: {
                requestScope: {
                    primary: 'gameplay',
                    allowedSubsystems: ['gameplay', 'ui']
                }
            }
        }
    );

    assert.equal(scope.primary, 'publish');
    assert.deepEqual(scope.allowedSubsystems, ['publish']);
});

test('OrchestratorService keeps logic-stage tasks in gameplay scope even when request mentions matchmaking stability', () => {
    const scope = orchestratorService._deriveTaskRequestScope(
        {
            id: 'code_01_logic',
            role: 'Coder',
            prompt: 'Implement the requested tank battler gameplay, AI, hooks, and HUD changes.'
        },
        {
            request: 'Create a new game using template tankarena-3d-v1. Keep auth, leaderboard, and matchmaking stable while turning it into a toy-brick 3D tank battler.',
            runtimeFlags: {
                requestScope: {
                    primary: 'gameplay',
                    allowedSubsystems: ['gameplay', 'ui']
                }
            }
        }
    );

    assert.equal(scope.primary, 'gameplay');
    assert.deepEqual(scope.allowedSubsystems, ['gameplay', 'ui']);
});

test('OrchestratorService does not revive blocked verifier tasks while coder work is still pending', () => {
    const state = {
        tasks: [
            { id: 'task_template_logic', role: 'Coder', status: 'pending', dependsOn: [] },
            { id: 'task_verifier', role: 'Verifier', status: 'blocked', dependsOn: [] }
        ]
    };

    const revived = orchestratorService._reviveStaleBlockedTasks(state, { isResumeCommand: true });

    assert.deepEqual(revived, []);
    assert.equal(state.tasks[1].status, 'blocked');
});

test('OrchestratorService derives fix-task compliance profile from the active failure subsystem', () => {
    const profiles = orchestratorService._deriveComplianceProfiles(
        {
            id: 'c_fix_1',
            role: 'Coder',
            prompt: `DETERMINISTIC COMPLIANCE FIX REQUIRED. Signature: auth-sdk-global-detection || mp-room-discovery-before-join
Target subsystem: platform-core.bootstrap
Resolve all failed rules from fast gate:
auth-sdk-global-detection: Auth must detect SDK from all supported globals.
mp-room-discovery-before-join: Matchmaking must discover rooms before deciding join/create.

Task context: Make the BattleTanks game more girly for kids. Preserve template-owned auth, matchmaking, leaderboard, diagnostics, and publish flow unless a blocker explicitly requires a targeted change.`
        },
        'BattleTanks template summary mentioning matchmaking preservation.',
        {
            request: 'Make the BattleTanks game more girly for kids using the battletanks-v1 template.',
            templateContext: {
                requiredEvidence: [
                    'static.immutable_path_violation',
                    'build.app_id_propagation',
                    'runtime.auth_profile_pass'
                ],
                contract: {
                    capabilities: ['auth', 'leaderboard', 'publish', 'r3f', 'matchmaking'],
                    requiredGates: [
                        'static.immutable_path_violation',
                        'build.app_id_propagation',
                        'runtime.auth_profile_pass'
                    ]
                }
            },
            runtimeFlags: {
                requestScope: {
                    primary: 'ui',
                    allowedSubsystems: ['ui', 'assets']
                }
            }
        }
    );

    assert.deepEqual(profiles, ['multiplayer']);
});

test('OrchestratorService does not re-add multiplayer to fix tasks when template does not support it', () => {
    const profiles = orchestratorService._deriveComplianceProfiles(
        {
            id: 'c_fix_2',
            role: 'Coder',
            prompt: `DETERMINISTIC COMPLIANCE FIX REQUIRED. Signature: auth-single-bootstrap-guard
Target subsystem: platform-core.bootstrap
Resolve all failed rules from fast gate:
auth-single-bootstrap-guard: Auth initialization must be guarded as one-shot to prevent repeated checkAuth loops.

Task context: Publish the existing BattleTanks template build after auth verification.`
        },
        'BattleTanks template summary with old multiplayer wording in prior prompts.',
        {
            request: 'Continue battletanks-v1 template run.',
            templateContext: {
                requiredEvidence: [
                    'build.app_id_propagation',
                    'runtime.auth_profile_pass'
                ],
                contract: {
                    capabilities: ['auth', 'leaderboard', 'publish', 'r3f'],
                    requiredGates: [
                        'build.app_id_propagation',
                        'runtime.auth_profile_pass'
                    ]
                }
            },
            runtimeFlags: {
                requestScope: {
                    primary: 'ui',
                    allowedSubsystems: ['ui', 'assets']
                }
            }
        }
    );

    assert.deepEqual(profiles, ['auth']);
});

test('OrchestratorService keeps publish-scoped fix profiles on publishing only', () => {
    const profiles = orchestratorService._deriveComplianceProfiles(
        {
            id: 'c_fix_publish',
            role: 'Coder',
            prompt: `DETERMINISTIC COMPLIANCE FIX REQUIRED. Signature: mp-room-discovery-before-join || publish-no-placeholder-appid
Target subsystem: publish
Resolve all failed rules from fast gate:
mp-room-discovery-before-join: Matchmaking must discover rooms before deciding join/create.
publish-no-placeholder-appid: Publishing config/source contains placeholder App ID tokens.

Task context: Create a new 3D tank arena game using template tankarena-3d-v1.`
        },
        'TankArena summary mentioning multiplayer room lifecycle.',
        {
            request: 'Create a new 3D tank arena game using template tankarena-3d-v1.',
            templateContext: {
                requiredEvidence: [
                    'build.app_id_propagation'
                ],
                contract: {
                    capabilities: ['auth', 'leaderboard', 'matchmaking', 'publish'],
                    requiredGates: ['build.app_id_propagation']
                }
            },
            runtimeFlags: {
                requestScope: {
                    primary: 'gameplay',
                    allowedSubsystems: ['gameplay', 'ui']
                }
            }
        }
    );

    assert.deepEqual(profiles, ['publishing']);
});

test('OrchestratorService classifies redpointfish hold-em rule failures as gameplay, not matchmaking', () => {
    const scope = orchestratorService._deriveTaskRequestScope(
        {
            id: 'fix_holdem',
            role: 'Coder',
            prompt: `Fix the following blocking issues raised by the Reviewer.
Target subsystem: platform-core.matchmaking
Game logic implements a card capture game (sum-to-10 matching) instead of Texas Hold'em.
The deck dealing and capture mechanics in src/hooks/usePokerGame.js are incompatible with Texas Hold'em rules.
src/constants/poker.js contains logic for capturing cards by value sum, which is not a poker mechanic.

Reviewer feedback: The VIVERSE SDK integration (Auth, Matchmaking, Multiplayer) is technically excellent, but the actual game logic is fundamentally incorrect for Texas Hold'em.`
        },
        {
            runtimeFlags: {
                requestScope: {
                    primary: 'gameplay',
                    allowedSubsystems: ['gameplay', 'ui']
                }
            }
        }
    );

    assert.equal(scope.primary, 'gameplay');
    assert.deepEqual(scope.allowedSubsystems, ['gameplay', 'ui']);
});

test('OrchestratorService rehardens generic fix tasks on resume using updated subsystem inference', () => {
    const state = {
        runtimeFlags: {
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            }
        },
        tasks: [
            {
                id: 'fix_holdem_resume',
                status: 'failed',
                prompt: `Fix the following blocking issues raised by the Reviewer.
Target subsystem: platform-core.matchmaking
Resolve all failed rules from fast gate:
Game logic implements a card capture game (sum-to-10 matching) instead of Texas Hold'em.
The deck dealing and capture mechanics in src/hooks/usePokerGame.js are incompatible with Texas Hold'em rules.
src/constants/poker.js contains logic for capturing cards by value sum, which is not a poker mechanic.

Task context: Create a new poker app using template redpointfish-v1.

SCOPED FIX EXECUTION (MANDATORY):
- Scope: matchmaking/runtime coordination only.
- Touch only room discovery, join/create decision flow, actor/session authority, and capability guards.
FIX SCOPE LOCK (MANDATORY):`
            }
        ]
    };

    const changed = orchestratorService._rehardenPendingFixTaskScopes(state);

    assert.equal(changed, true);
    assert.match(state.tasks[0].prompt, /Target subsystem: gameplay/);
    assert.match(state.tasks[0].prompt, /Scope: gameplay only\./);
});

test('OrchestratorService summarizes nested fix task context before creating a new compliance fix prompt', () => {
    const summary = orchestratorService._summarizeFixTaskContext(`DETERMINISTIC COMPLIANCE FIX REQUIRED. Signature: mp-room-discovery-before-join
Target subsystem: platform-core.matchmaking
Resolve all failed rules from fast gate:
mp-room-discovery-before-join: Matchmaking must discover rooms before deciding join/create.

Task context: Fix the following blocking issues raised by the Reviewer.
Target subsystem: platform-core.bootstrap
Authentication bootstrap is executed twice (once in index.html and once in src/main.js).

Reviewer feedback: Bootstrap must only run once.

SCOPED FIX EXECUTION (MANDATORY):
- Scope: matchmaking/runtime coordination only.`);

    assert.equal(
        summary,
        `Fix the following blocking issues raised by the Reviewer.
Target subsystem: platform-core.bootstrap
Authentication bootstrap is executed twice (once in index.html and once in src/main.js).

Reviewer feedback: Bootstrap must only run once.`
    );
});

test('OrchestratorService retires failed compliance-fix tasks when their signature is no longer active', async () => {
    const originalRunFastGate = complianceService.runFastGate;
    complianceService.runFastGate = async () => ({
        status: 'pass',
        findings: [],
        profiles: ['publishing']
    });

    try {
        const state = {
            projectContextSummary: 'Tankarena regression state',
            runtimeFlags: {
                requestScope: {
                    primary: 'gameplay',
                    allowedSubsystems: ['gameplay', 'ui']
                }
            },
            tasks: [
                {
                    id: 'c_fix_stale',
                    role: 'Coder',
                    status: 'failed',
                    lastError: 'Skill enforcement failed',
                    prompt: `DETERMINISTIC COMPLIANCE FIX REQUIRED. Signature: publish-app-id-configured || template-world-bootstrap-missing
Target subsystem: platform-core.bootstrap
Resolve all failed rules from fast gate:
publish-app-id-configured: Publishing requires a valid 10-char VITE_VIVERSE_CLIENT_ID in project config.
template-world-bootstrap-missing: Template runtime bootstrap must launch the game world.

Task context: Implement the requested app functionality inside the template workspace.`
                }
            ]
        };

        const changed = await orchestratorService._retireObsoleteFailedComplianceFixTasks(
            state,
            '/tmp/fake-workspace',
            'Tankarena regression state'
        );

        assert.equal(changed, true);
        assert.equal(state.tasks[0].status, 'completed');
        assert.equal(state.tasks[0].lastError, null);
    } finally {
        complianceService.runFastGate = originalRunFastGate;
    }
});

test('OrchestratorService treats paused workflows with all tasks completed as completed on resume', async () => {
    const state = {
        status: 'paused_or_failed',
        tasks: [
            { id: 'task_1', status: 'completed' },
            { id: 'task_2', status: 'completed' }
        ]
    };

    const completed = orchestratorService._isCompletedWorkflowState(state);

    assert.equal(completed, true);

    const originalSaveState = orchestratorService._saveState;
    orchestratorService._saveState = async () => {};
    try {
        await orchestratorService._finalizeWorkflowState(state, 'completed');
        assert.equal(state.status, 'completed');
        assert.equal(state.runReport.outcome, 'completed');
    } finally {
        orchestratorService._saveState = originalSaveState;
    }
});

test('OrchestratorService does not derive multiplayer or publish profiles for holdem gameplay reviewer fixes', () => {
    const profiles = orchestratorService._deriveComplianceProfiles(
        {
            id: 'fix_holdem_live',
            role: 'Coder',
            prompt: `Fix the following blocking issues raised by the Reviewer.
Target subsystem: platform-core.matchmaking
Game logic implements a card capture game (sum-to-10 matching) instead of Texas Hold'em.
The deck dealing and capture mechanics in src/hooks/usePokerGame.js are incompatible with Texas Hold'em rules.
src/constants/poker.js contains logic for capturing cards by value sum, which is not a poker mechanic.

Reviewer feedback: The VIVERSE SDK integration is technically excellent, but the actual game logic is fundamentally incorrect for Texas Hold'em.

SCOPED FIX EXECUTION (MANDATORY):
- Scope: matchmaking/runtime coordination only.
- Touch only room discovery, join/create decision flow, actor/session authority, and capability guards.
FIX SCOPE LOCK (MANDATORY):`
        },
        'redpointfish template summary mentioning auth and multiplayer stability.',
        {
            request: 'Create a new poker app using template redpointfish-v1 and turn it into a polished multiplayer Texas Hold’em experience.',
            templateContext: {
                requiredEvidence: [
                    'build.app_id_propagation',
                    'runtime.auth_profile_pass',
                    'runtime.matchmaking_pass'
                ],
                contract: {
                    capabilities: ['auth', 'leaderboard', 'matchmaking', 'publish'],
                    requiredGates: [
                        'build.app_id_propagation',
                        'runtime.auth_profile_pass',
                        'runtime.matchmaking_pass'
                    ]
                }
            },
            runtimeFlags: {
                requestScope: {
                    primary: 'gameplay',
                    allowedSubsystems: ['gameplay', 'ui']
                }
            }
        }
    );

    assert.deepEqual(profiles, []);
});

test('OrchestratorService lets reviewer issue lines outrank stale publish text when inferring failure subsystem', () => {
    const subsystem = orchestratorService._inferFailureSubsystem({
        issueLines: [
            "Game logic implements a card capture game (sum-to-10 matching) instead of Texas Hold'em.",
            'The deck dealing and capture mechanics in src/hooks/usePokerGame.js are incompatible with Texas Hold\'em rules.',
            'src/constants/poker.js contains logic for capturing cards by value sum, which is not a poker mechanic.'
        ],
        task: {
            id: 'fix_holdem_publish_stale',
            prompt: `Fix the following blocking issues raised by the Reviewer.
Target subsystem: publish
Extracted App ID: zz97sqkwky.
publish-no-placeholder-appid: source still contains placeholder App ID.`
        },
        state: {
            request: 'Create a new poker app using template redpointfish-v1.',
            runtimeFlags: {
                requestScope: {
                    primary: 'gameplay',
                    allowedSubsystems: ['gameplay', 'ui']
                }
            }
        }
    });

    assert.equal(subsystem, 'gameplay');
});

test('OrchestratorService ignores preservation clauses when deriving template logic compliance profiles', () => {
    const profiles = orchestratorService._deriveComplianceProfiles(
        {
            id: 'task_template_logic',
            role: 'Coder',
            prompt: `Implement only the minimum necessary gameplay and related UI changes required by the request.
Request focus: Make the BattleTanks game more girly for kids.
Preserve template-owned auth, matchmaking, leaderboard, diagnostics, and publish flow unless a blocker explicitly requires a targeted change.`
        },
        'BattleTanks template summary.',
        {
            request: 'Make the BattleTanks game more girly for kids using the battletanks-v1 template.',
            templateContext: {
                requiredEvidence: [
                    'build.app_id_propagation',
                    'runtime.auth_profile_pass'
                ],
                contract: {
                    capabilities: ['auth', 'leaderboard', 'publish', 'r3f'],
                    requiredGates: [
                        'build.app_id_propagation',
                        'runtime.auth_profile_pass'
                    ]
                }
            },
            runtimeFlags: {
                requestScope: {
                    primary: 'ui',
                    allowedSubsystems: ['ui', 'assets']
                }
            }
        }
    );

    assert.deepEqual(profiles, []);
});

test('OrchestratorService does not treat a generic workspace as battletanks template surface', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'battletanks-surface-'));
    try {
        await fs.writeFile(path.join(dir, 'TEMPLATE.md'), '# not battletanks\n', 'utf8');
        await fs.mkdir(path.join(dir, 'rulesets'), { recursive: true });
        await fs.writeFile(path.join(dir, 'scenario.schema.json'), '{}', 'utf8');

        const loaded = await templateContractService.loadTemplateContract(
            path.resolve('/Users/casper_wang/Projects/AI/viverse-ai-agent/template-sources/_archive/battletanks-v1-broken')
        );
        const result = await orchestratorService._workspaceHasTemplateSurface(dir, loaded.contract);
        assert.equal(result, false);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
