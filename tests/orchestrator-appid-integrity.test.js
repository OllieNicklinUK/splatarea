import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import orchestratorService from '../src/services/OrchestratorService.js';

test('OrchestratorService accepts vite config fallback for app id integrity when .env is absent', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-appid-'));
    try {
        await fs.writeFile(
            path.join(workspacePath, 'vite.config.js'),
            'export default { define: { "import.meta.env.VITE_VIVERSE_CLIENT_ID": "ab12cd34ef" } };',
            'utf8'
        );

        const result = await orchestratorService._checkAppIdIntegrity(
            {
                runtimeFlags: {
                    appIdAuthority: {
                        value: 'ab12cd34ef'
                    }
                }
            },
            workspacePath,
            'AUTHORITATIVE_APP_ID: ab12cd34ef'
        );

        assert.equal(result.ok, false);
        assert.match(String(result.reason || ''), /Deterministic App ID propagation check failed|dist missing|source does not reference/);
        assert.doesNotMatch(String(result.reason || ''), /\.env is missing/);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('OrchestratorService locks authoritative app id once established', () => {
    const state = {
        runtimeFlags: {
            appIdAuthority: {
                value: '',
                source: '',
                updatedAt: '',
                locked: false,
                conflict: null
            }
        }
    };

    assert.equal(orchestratorService._setAppIdAuthority(state, 'ab12cd34ef', 'task:task_template_auth'), true);
    assert.equal(state.runtimeFlags.appIdAuthority.value, 'ab12cd34ef');
    assert.equal(state.runtimeFlags.appIdAuthority.locked, true);

    assert.equal(orchestratorService._setAppIdAuthority(state, 'zz98yy76xx', 'task:task_legacy_auth'), false);
    assert.equal(state.runtimeFlags.appIdAuthority.value, 'ab12cd34ef');
    assert.equal(state.runtimeFlags.appIdAuthority.locked, true);
    assert.equal(state.runtimeFlags.appIdAuthority.conflict.attemptedValue, 'zz98yy76xx');
    assert.equal(state.runtimeFlags.appIdAuthority.conflict.attemptedSource, 'task:task_legacy_auth');
});
