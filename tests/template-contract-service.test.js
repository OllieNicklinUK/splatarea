import test from 'node:test';
import assert from 'node:assert/strict';

import templateContractService from '../src/services/templates/TemplateContractService.js';

test('TemplateContractService always allows CONTRACT.json as editable workflow artifact', () => {
    const normalized = templateContractService._normalizeContract({
        id: 'redpointfish-v1',
        editablePaths: ['src/**', 'vite.config.js']
    }, '/tmp/template');

    assert.deepEqual(normalized.editablePaths.slice(0, 3), [
        'CONTRACT.json',
        'src/**',
        'vite.config.js'
    ]);
});

test('TemplateContractService does not duplicate CONTRACT.json when already declared', () => {
    const normalized = templateContractService._normalizeContract({
        id: 'redpointfish-v1',
        editablePaths: ['CONTRACT.json', 'src/**']
    }, '/tmp/template');

    assert.equal(
        normalized.editablePaths.filter((entry) => entry === 'CONTRACT.json').length,
        1
    );
});

test('TemplateContractService normalizes template compliance paths', () => {
    const normalized = templateContractService._normalizeContract({
        id: 'battletanks-v1',
        editablePaths: ['adapters/**'],
        compliancePaths: {
            authFiles: ['./adapters/auth/ViverseAuthService.ts'],
            matchmakingHooks: ['adapters/multiplayer/useMultiplayer.js', '', null]
        }
    }, '/tmp/template');

    assert.deepEqual(normalized.compliancePaths, {
        authFiles: ['adapters/auth/ViverseAuthService.ts'],
        matchmakingHooks: ['adapters/multiplayer/useMultiplayer.js'],
        startupFiles: []
    });
    assert.deepEqual(normalized.buildConfig, {
        command: '',
        outputDir: '',
        entryHtml: ''
    });
});

test('TemplateContractService classifies battletanks auth wiring surfaces as platform-core.auth', () => {
    assert.equal(
        templateContractService.inferSubsystemForPath('vite.config.ts'),
        'platform-core.auth'
    );
    assert.equal(
        templateContractService.inferSubsystemForPath('bootstrap/ViverseConfig.ts'),
        'platform-core.auth'
    );
});

test('TemplateContractService normalizes tankarena app id propagation strategy', async () => {
    const loaded = await templateContractService.loadTemplateContract(
        '/Users/casper_wang/Projects/AI/viverse-ai-agent/templates/tankarena-3d-v1'
    );

    assert.equal(loaded.contract.authPreflightMode, 'verify_only');
    assert.equal(loaded.contract.appIdPropagation.strategy, 'runtime-config-or-hostname');
    assert.deepEqual(
        loaded.contract.appIdPropagation.approvedConfigFiles,
        ['index.html', 'src/viverseConfig.js']
    );
    assert.deepEqual(
        loaded.contract.compliancePaths,
        {
            authFiles: ['src/viverseAuth.js', 'src/viverseConfig.js'],
            matchmakingHooks: ['src/viverseMultiplayer.js'],
            startupFiles: ['index.html', 'src/main.js']
        }
    );
    assert.equal(
        templateContractService.inferSubsystemForPath('index.html', loaded.contract),
        'platform-core.bootstrap'
    );
});
