import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import orchestratorService from '../src/services/OrchestratorService.js';

test('OrchestratorService._pickWorkspace prefers resumable blocked workspace over unrelated pending workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-pick-workspace-'));
    try {
        const older = path.join(root, 'req_1775658823697');
        const newer = path.join(root, 'req_1775659624379');
        await fs.mkdir(older, { recursive: true });
        await fs.mkdir(newer, { recursive: true });

        await fs.writeFile(
            path.join(older, '.agent_state.json'),
            JSON.stringify({
                projectContextSummary: 'older workspace',
                tasks: [
                    { id: 'code_01', status: 'failed' },
                    { id: 'code_02', status: 'pending' }
                ]
            }),
            'utf8'
        );

        await fs.writeFile(
            path.join(newer, '.agent_state.json'),
            JSON.stringify({
                projectContextSummary: 'newer workspace',
                tasks: [
                    { id: 'dep_1', status: 'completed' },
                    {
                        id: 'verifier_gate',
                        status: 'blocked',
                        dependsOn: ['dep_1'],
                        lastError: ''
                    }
                ]
            }),
            'utf8'
        );

        const best = await orchestratorService._pickWorkspace(root, {});

        assert.equal(best?.path, newer);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
