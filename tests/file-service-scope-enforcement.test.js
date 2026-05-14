import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import fileService from '../src/services/FileService.js';

test('FileService blocks cross-scope template writes as scope violations', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-scope-block-'));

    try {
        fileService.setWorkspaceTemplateContext(workspacePath, {
            templateId: 'redpointfish-v1',
            enforcementMode: 'enforce',
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            },
            contract: {
                editablePaths: ['src/**', 'vite.config.js', 'CONTRACT.json'],
                immutablePaths: []
            }
        });

        await assert.rejects(
            () => fileService.writeFile('src/hooks/useMultiplayer.js', 'export default {};\n', workspacePath),
            /TEMPLATE_SCOPE_VIOLATION: platform-core\.matchmaking/i
        );

        const violations = fileService.consumeTemplateViolations(workspacePath);
        assert.equal(violations.length, 1);
        assert.equal(violations[0].reason, 'scope_violation');
        assert.equal(violations[0].subsystem, 'platform-core.matchmaking');
    } finally {
        fileService.clearWorkspaceTemplateContext(workspacePath);
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('FileService allows in-scope gameplay writes for gameplay-scoped template runs', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-scope-allow-'));

    try {
        fileService.setWorkspaceTemplateContext(workspacePath, {
            templateId: 'redpointfish-v1',
            enforcementMode: 'enforce',
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            },
            contract: {
                editablePaths: ['src/**', 'CONTRACT.json'],
                immutablePaths: []
            }
        });

        const result = await fileService.writeFile('src/game/ofcp-engine.js', 'export const ready = true;\n', workspacePath);
        assert.equal(result.success, true);
        const written = await fs.readFile(path.join(workspacePath, 'src/game/ofcp-engine.js'), 'utf8');
        assert.match(written, /ready = true/);
    } finally {
        fileService.clearWorkspaceTemplateContext(workspacePath);
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('FileService blocks battletanks bootstrap runtime rewrites during gameplay-scoped runs', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-scope-battletanks-bootstrap-'));

    try {
        fileService.setWorkspaceTemplateContext(workspacePath, {
            templateId: 'battletanks-v1',
            enforcementMode: 'enforce',
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            },
            contract: {
                editablePaths: ['bootstrap/**', 'gameplay/**', 'adapters/**', 'CONTRACT.json'],
                immutablePaths: []
            }
        });

        await assert.rejects(
            () => fileService.writeFile('bootstrap/main.ts', 'console.log("broken bootstrap");\n', workspacePath),
            /TEMPLATE_SCOPE_VIOLATION: platform-core\.bootstrap/i
        );
    } finally {
        fileService.clearWorkspaceTemplateContext(workspacePath);
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('FileService falls back to template build command when package.json is absent', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-build-fallback-'));

    try {
        await fs.writeFile(path.join(workspacePath, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8');
        fileService.setWorkspaceTemplateContext(workspacePath, {
            templateId: 'battletanks-v1',
            enforcementMode: 'enforce',
            requestScope: {
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            },
            contract: {
                editablePaths: ['bootstrap/**', 'gameplay/**', 'adapters/**', 'CONTRACT.json'],
                immutablePaths: [],
                buildConfig: {
                    command: 'npx vite build',
                    entryHtml: 'index.html',
                    outputDir: 'dist'
                }
            }
        });

        const normalized = await fileService._normalizeBuildCommand('npm run build', workspacePath);
        assert.equal(normalized, 'npx vite build');
    } finally {
        fileService.clearWorkspaceTemplateContext(workspacePath);
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});
