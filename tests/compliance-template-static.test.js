import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import complianceService from '../src/services/ComplianceService.js';

test('ComplianceService fast gate catches missing template matchmaking discovery flow and capability guard', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-template-static-'));
    try {
        await fs.mkdir(path.join(workspacePath, 'src/hooks'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'src/hooks/useMultiplayer.js'),
            `
            export default function useMultiplayer(mm) {
              async function autoMatch() {
                return await createRoom('BrokenFlow');
              }
              async function setMe(matchmakingClient, payload) {
                return await matchmakingClient.setActor(payload);
              }
              return { autoMatch, setMe };
            }
            `,
            'utf8'
        );

        const gate = await complianceService.runFastGate({
            workspacePath,
            taskPrompt: 'Fix multiplayer room flow',
            profileHints: ['multiplayer'],
            gatePhase: 'fix',
            templateContext: {
                templateId: 'redpointfish-v1',
                contract: {
                    id: 'redpointfish-v1',
                    requiredGates: ['runtime.matchmaking_pass']
                }
            },
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            }
        });

        assert.equal(gate.status, 'fail');
        const ruleIds = gate.findings.map((finding) => finding.ruleId);
        assert.equal(ruleIds.includes('mp-room-discovery-before-join'), true);
        assert.equal(ruleIds.includes('mp-setactor-capability-guard'), true);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService fast gate passes intact template matchmaking flow checks', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-template-static-ok-'));
    try {
        await fs.mkdir(path.join(workspacePath, 'src/hooks'), { recursive: true });
        const templateHook = await fs.readFile(
            path.join(process.cwd(), 'templates/redpointfish-v1/src/hooks/useMultiplayer.js'),
            'utf8'
        );
        await fs.writeFile(path.join(workspacePath, 'src/hooks/useMultiplayer.js'), templateHook, 'utf8');

        const gate = await complianceService.runFastGate({
            workspacePath,
            taskPrompt: 'Fix multiplayer room flow',
            profileHints: ['multiplayer'],
            gatePhase: 'fix',
            templateContext: {
                templateId: 'redpointfish-v1',
                contract: {
                    id: 'redpointfish-v1',
                    requiredGates: ['runtime.matchmaking_pass']
                }
            },
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            }
        });

        const ruleIds = gate.findings.map((finding) => finding.ruleId);
        assert.equal(ruleIds.includes('mp-room-discovery-before-join'), false);
        assert.equal(ruleIds.includes('mp-setactor-capability-guard'), false);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService fast gate uses battletanks template matchmaking hook path', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-template-static-battletanks-'));
    try {
        await fs.mkdir(path.join(workspacePath, 'adapters/multiplayer'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'adapters/multiplayer/useMultiplayer.js'),
            `
            export const useMultiplayer = () => {
              async function autoMatch(mm) {
                const roomsRes = await (mm.getAvailableRooms?.() || mm.getRoomList?.());
                const availableRooms = roomsRes?.rooms || roomsRes || [];
                const openRoom = availableRooms.find((room) => room?.is_open);
                if (openRoom) {
                  await joinRoom(openRoom.id);
                  return openRoom;
                }
                return createRoom('Fallback');
              }
              async function bindActor(matchmakingClient, actor) {
                if (typeof matchmakingClient.setActor !== 'function') return;
                return matchmakingClient.setActor?.(actor);
              }
              return { autoMatch, bindActor };
            };
            `,
            'utf8'
        );

        const gate = await complianceService.runFastGate({
            workspacePath,
            taskPrompt: 'Polish tank game visuals',
            profileHints: ['multiplayer'],
            gatePhase: 'gameplay',
            templateContext: {
                templateId: 'battletanks-v1',
                contract: {
                    id: 'battletanks-v1',
                    requiredGates: ['runtime.matchmaking_pass'],
                    compliancePaths: {
                        matchmakingHooks: ['adapters/multiplayer/useMultiplayer.js'],
                        startupFiles: ['bootstrap/main.ts']
                    }
                }
            },
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            }
        });

        const ruleIds = gate.findings.map((finding) => finding.ruleId);
        assert.equal(ruleIds.includes('template-matchmaking-hook-missing'), false);
        assert.equal(ruleIds.includes('mp-room-discovery-before-join'), false);
        assert.equal(ruleIds.includes('mp-setactor-capability-guard'), false);
        assert.equal(ruleIds.includes('template-world-bootstrap-missing'), true);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService fast gate passes battletanks startup when bootstrap launches world', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-template-static-battletanks-startup-'));
    try {
        await fs.mkdir(path.join(workspacePath, 'adapters/multiplayer'), { recursive: true });
        await fs.mkdir(path.join(workspacePath, 'bootstrap'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'adapters/multiplayer/useMultiplayer.js'),
            `
            export const useMultiplayer = () => {
              async function autoMatch(mm) {
                const roomsRes = await mm.getAvailableRooms();
                const availableRooms = roomsRes?.rooms || roomsRes || [];
                const existing = availableRooms.find(Boolean);
                if (existing) return joinRoom(existing.id);
                return createRoom('Fallback');
              }
              async function bindActor(matchmakingClient, actor) {
                if (typeof matchmakingClient.setActor !== 'function') return;
                return matchmakingClient.setActor?.(actor);
              }
              return { autoMatch, bindActor };
            };
            `,
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, 'bootstrap/main.ts'),
            `
            import { World } from './upstream-src/World';
            function main() {
              const world = new World();
              window.world = world;
            }
            main();
            `,
            'utf8'
        );

        const gate = await complianceService.runFastGate({
            workspacePath,
            taskPrompt: 'Polish tank game visuals',
            profileHints: ['multiplayer'],
            gatePhase: 'gameplay',
            templateContext: {
                templateId: 'battletanks-v1',
                contract: {
                    id: 'battletanks-v1',
                    requiredGates: ['runtime.matchmaking_pass'],
                    compliancePaths: {
                        matchmakingHooks: ['adapters/multiplayer/useMultiplayer.js'],
                        startupFiles: ['bootstrap/main.ts']
                    }
                }
            },
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            }
        });

        const ruleIds = gate.findings.map((finding) => finding.ruleId);
        assert.equal(ruleIds.includes('template-world-bootstrap-missing'), false);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService fast gate accepts battletanks bridge startup entrypoint', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-template-static-battletanks-bridge-'));
    try {
        await fs.mkdir(path.join(workspacePath, 'bootstrap/upstream-src'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'bootstrap/main.ts'),
            `import "./upstream-src/main";\n`,
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, 'bootstrap/upstream-src/main.ts'),
            `
            import { World } from './World';
            function main() {
              const world = new World();
              window.world = world;
            }
            main();
            `,
            'utf8'
        );

        const gate = await complianceService.runFastGate({
            workspacePath,
            taskPrompt: 'Polish tank game visuals',
            profileHints: ['auth'],
            gatePhase: 'fix',
            templateContext: {
                templateId: 'battletanks-v1',
                contract: {
                    id: 'battletanks-v1',
                    requiredGates: ['runtime.auth_profile_pass'],
                    compliancePaths: {
                        startupFiles: ['bootstrap/main.ts', 'bootstrap/upstream-src/main.ts']
                    }
                }
            },
            requestScope: {
                primary: 'ui',
                allowedSubsystems: ['ui', 'assets']
            }
        });

        const ruleIds = gate.findings.map((finding) => finding.ruleId);
        assert.equal(ruleIds.includes('template-world-bootstrap-missing'), false);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService fast gate accepts battletanks service-style auth guards', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-template-static-battletanks-auth-'));
    try {
        await fs.mkdir(path.join(workspacePath, 'adapters/auth'), { recursive: true });
        const authTemplate = await fs.readFile(
            path.join(process.cwd(), 'templates/battletanks-v1/adapters/auth/ViverseAuthService.ts'),
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, 'adapters/auth/ViverseAuthService.ts'),
            authTemplate,
            'utf8'
        );

        const gate = await complianceService.runFastGate({
            workspacePath,
            taskPrompt: 'Verify battletanks auth bootstrap',
            profileHints: ['auth'],
            gatePhase: 'fix',
            templateContext: {
                templateId: 'battletanks-v1',
                contract: {
                    id: 'battletanks-v1',
                    requiredGates: ['runtime.auth_profile_pass'],
                    compliancePaths: {
                        authFiles: ['adapters/auth/ViverseAuthService.ts']
                    }
                }
            },
            requestScope: {
                primary: 'auth',
                allowedSubsystems: ['platform-core.auth']
            }
        });

        const ruleIds = gate.findings.map((finding) => finding.ruleId);
        assert.equal(ruleIds.includes('auth-sdk-global-detection'), false);
        assert.equal(ruleIds.includes('auth-single-bootstrap-guard'), false);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService fast gate accepts tankarena auth sdk globals in any order', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-template-static-tankarena-auth-'));
    try {
        await fs.mkdir(path.join(workspacePath, 'src'), { recursive: true });
        const authTemplate = await fs.readFile(
            path.join(process.cwd(), 'templates/tankarena-3d-v1/src/viverseAuth.js'),
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, 'src/viverseAuth.js'),
            authTemplate,
            'utf8'
        );

        const gate = await complianceService.runFastGate({
            workspacePath,
            taskPrompt: 'Verify tankarena auth bootstrap',
            profileHints: ['auth'],
            gatePhase: 'auth_preflight',
            templateContext: {
                templateId: 'tankarena-3d-v1',
                contract: {
                    id: 'tankarena-3d-v1',
                    requiredGates: ['runtime.auth_profile_pass'],
                    compliancePaths: {
                        authFiles: ['src/viverseAuth.js']
                    }
                }
            },
            requestScope: {
                primary: 'platform-core.auth',
                allowedSubsystems: ['platform-core.auth']
            }
        });

        const ruleIds = gate.findings.map((finding) => finding.ruleId);
        assert.equal(ruleIds.includes('auth-sdk-global-detection'), false);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});
