import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import complianceService from '../src/services/ComplianceService.js';
import fileService from '../src/services/FileService.js';

test('ComplianceService verifyAppIdPropagation accepts vite config fallback when .env is absent', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-compliance-'));
    try {
        await fs.writeFile(
            path.join(workspacePath, 'vite.config.js'),
            'export default { define: { "import.meta.env.VITE_VIVERSE_CLIENT_ID": "ab12cd34ef" } };',
            'utf8'
        );
        await fs.mkdir(path.join(workspacePath, 'dist', 'assets'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'dist', 'assets', 'index.js'),
            'console.log("ab12cd34ef");',
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, 'src.js'),
            'console.log(import.meta.env.VITE_VIVERSE_CLIENT_ID);',
            'utf8'
        );

        const result = await complianceService.verifyAppIdPropagation({
            workspacePath,
            expectedAppId: 'ab12cd34ef'
        });

        assert.equal(result.status, 'pass');
        assert.equal(result.env_app_id, 'ab12cd34ef');
        assert.doesNotMatch(result.reasons.join(' | '), /\.env missing/i);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService verifyAppIdPropagation ignores copied publish bundle directories as source', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-compliance-build-final-'));
    try {
        await fs.writeFile(
            path.join(workspacePath, 'vite.config.js'),
            'export default { define: { "import.meta.env.VITE_VIVERSE_CLIENT_ID": "ab12cd34ef" } };',
            'utf8'
        );
        await fs.mkdir(path.join(workspacePath, 'dist', 'assets'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'dist', 'assets', 'index.js'),
            'console.log("ab12cd34ef");',
            'utf8'
        );
        await fs.mkdir(path.join(workspacePath, 'build_final', 'assets'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'build_final', 'assets', 'index.js'),
            'console.log("ab12cd34ef");',
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, 'src.js'),
            'console.log(import.meta.env.VITE_VIVERSE_CLIENT_ID);',
            'utf8'
        );

        const result = await complianceService.verifyAppIdPropagation({
            workspacePath,
            expectedAppId: 'ab12cd34ef'
        });

        assert.equal(result.status, 'pass');
        assert.deepEqual(result.source_hardcoded_app_id_files, []);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService ignores .env.example placeholders for publish placeholder rule', () => {
    const result = complianceService._checkRule(
        {
            id: 'publish-no-placeholder-appid',
            type: 'forbidden_any',
            pattern: 'YOUR_APP_ID'
        },
        [
            { relPath: '.env.example', text: 'VITE_VIVERSE_CLIENT_ID=YOUR_APP_ID' },
            { relPath: 'src/main.js', text: 'console.log(import.meta.env.VITE_VIVERSE_CLIENT_ID);' }
        ],
        ''
    );

    assert.equal(result.pass, true);
});

test('ComplianceService verifyAppIdPropagation ignores CONTRACT.json app_id and .env.example placeholder from source failures', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-compliance-contract-'));
    try {
        await fs.writeFile(
            path.join(workspacePath, 'vite.config.js'),
            'export default { define: { "import.meta.env.VITE_VIVERSE_CLIENT_ID": "ab12cd34ef" } };',
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, 'CONTRACT.json'),
            JSON.stringify({ app_id: 'ab12cd34ef' }, null, 2),
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, '.env.example'),
            'VITE_VIVERSE_CLIENT_ID=YOUR_APP_ID\n',
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, 'src.js'),
            'console.log(import.meta.env.VITE_VIVERSE_CLIENT_ID);',
            'utf8'
        );
        await fs.mkdir(path.join(workspacePath, 'dist', 'assets'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'dist', 'assets', 'index.js'),
            'console.log("ab12cd34ef");',
            'utf8'
        );

        const result = await complianceService.verifyAppIdPropagation({
            workspacePath,
            expectedAppId: 'ab12cd34ef'
        });

        assert.equal(result.status, 'pass');
        assert.deepEqual(result.source_hardcoded_app_id_files, []);
        assert.deepEqual(result.source_placeholder_files, []);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService verifyAppIdPropagation accepts tankarena runtime config and hostname strategy', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-compliance-tankarena-'));
    try {
        await fs.writeFile(
            path.join(workspacePath, 'index.html'),
            `<!doctype html>
<script>
window.__TANKARENA_CONFIG__ = { clientId: "ab12cd34ef" };
</script>`,
            'utf8'
        );
        await fs.mkdir(path.join(workspacePath, 'src'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'src', 'viverseConfig.js'),
            `const HOSTNAME_APP_ID_PATTERN = /^([a-z0-9]{10})(?:-preview)?\\.world\\.viverse\\.app$/i;
const runtimeConfig = window.__TANKARENA_CONFIG__ || {};
const explicit = String(runtimeConfig.clientId || runtimeConfig.appId || "").trim();
const hostMatch = window.location.hostname.match(HOSTNAME_APP_ID_PATTERN);
console.log(explicit, hostMatch);`,
            'utf8'
        );
        await fs.mkdir(path.join(workspacePath, 'dist', 'assets'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'dist', 'assets', 'index.js'),
            'console.log("ab12cd34ef");',
            'utf8'
        );

        const result = await complianceService.verifyAppIdPropagation({
            workspacePath,
            expectedAppId: 'ab12cd34ef',
            templateContext: {
                contract: {
                    appIdPropagation: {
                        strategy: 'runtime-config-or-hostname',
                        approvedConfigFiles: ['index.html', 'src/viverseConfig.js']
                    }
                }
            }
        });

        assert.equal(result.status, 'pass');
        assert.equal(result.env_app_id, 'ab12cd34ef');
        assert.deepEqual(result.source_hardcoded_app_id_files, []);
        assert.ok(result.source_env_ref_files.includes('index.html'));
        assert.ok(result.source_env_ref_files.includes('src/viverseConfig.js'));
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService verifyAppIdPropagation tolerates dist placeholder when tankarena runtime config already embeds expected app id', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-compliance-tankarena-dist-'));
    try {
        await fs.writeFile(
            path.join(workspacePath, 'index.html'),
            `<!doctype html>
<script>
window.__TANKARENA_CONFIG__ = { clientId: "ab12cd34ef" };
</script>`,
            'utf8'
        );
        await fs.mkdir(path.join(workspacePath, 'src'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'src', 'viverseConfig.js'),
            `const HOSTNAME_APP_ID_PATTERN = /^([a-z0-9]{10})(?:-preview)?\\.world\\.viverse\\.app$/i;
const runtimeConfig = window.__TANKARENA_CONFIG__ || {};
const explicit = String(runtimeConfig.clientId || runtimeConfig.appId || "").trim();
const hostMatch = window.location.hostname.match(HOSTNAME_APP_ID_PATTERN);
console.log(explicit, hostMatch);`,
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, 'src', 'createHud.js'),
            'export const DEBUG_APP_ID = import.meta.env.VITE_VIVERSE_CLIENT_ID || "";',
            'utf8'
        );
        await fs.mkdir(path.join(workspacePath, 'dist', 'assets'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'dist', 'assets', 'index.js'),
            'console.log("ab12cd34ef"); const leftover = "YOUR_APP_ID";',
            'utf8'
        );

        const result = await complianceService.verifyAppIdPropagation({
            workspacePath,
            expectedAppId: 'ab12cd34ef',
            templateContext: {
                contract: {
                    appIdPropagation: {
                        strategy: 'runtime-config-or-hostname',
                        approvedConfigFiles: ['index.html', 'src/viverseConfig.js']
                    }
                }
            }
        });

        assert.equal(result.status, 'pass');
        assert.ok(result.dist_placeholder_files.includes('dist/assets/index.js'));
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService verifyAppIdPropagation ignores publish_dist as generated publish output, not source', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-compliance-publish-dist-'));
    try {
        await fs.writeFile(
            path.join(workspacePath, '.env'),
            'VITE_VIVERSE_CLIENT_ID=ab12cd34ef\n',
            'utf8'
        );
        await fs.mkdir(path.join(workspacePath, 'src'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'src', 'main.js'),
            'console.log(import.meta.env.VITE_VIVERSE_CLIENT_ID);',
            'utf8'
        );
        await fs.mkdir(path.join(workspacePath, 'publish_dist'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'publish_dist', 'index.html'),
            '<script>window.__TANKARENA_CONFIG__={clientId:"ab12cd34ef"}</script>',
            'utf8'
        );
        await fs.mkdir(path.join(workspacePath, 'dist', 'assets'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'dist', 'assets', 'index.js'),
            'console.log("ab12cd34ef");',
            'utf8'
        );

        const result = await complianceService.verifyAppIdPropagation({
            workspacePath,
            expectedAppId: 'ab12cd34ef'
        });

        assert.equal(result.status, 'pass');
        assert.deepEqual(result.source_hardcoded_app_id_files, []);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService fast gate skips generic publish app id rules for runtime-config-or-hostname templates', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-compliance-tankarena-fast-gate-'));
    try {
        await fs.writeFile(
            path.join(workspacePath, 'index.html'),
            `<!doctype html>
<script>
window.__TANKARENA_CONFIG__ = { clientId: "YOUR_APP_ID" };
</script>`,
            'utf8'
        );
        await fs.mkdir(path.join(workspacePath, 'src'), { recursive: true });
        await fs.writeFile(
            path.join(workspacePath, 'src', 'viverseConfig.js'),
            `const HOSTNAME_APP_ID_PATTERN = /^([a-z0-9]{10})(?:-preview)?\\.world\\.viverse\\.app$/i;
const runtimeConfig = window.__TANKARENA_CONFIG__ || {};
const explicit = String(runtimeConfig.clientId || runtimeConfig.appId || "").trim();
const hostMatch = window.location.hostname.match(HOSTNAME_APP_ID_PATTERN);
console.log(explicit, hostMatch);`,
            'utf8'
        );

        const result = await complianceService.runFastGate({
            workspacePath,
            taskPrompt: 'Publish the tankarena template build with the established App ID.',
            profileHints: ['publishing'],
            gatePhase: 'publish',
            templateContext: {
                templateId: 'tankarena-3d-v1',
                contract: {
                    id: 'tankarena-3d-v1',
                    appIdPropagation: {
                        strategy: 'runtime-config-or-hostname',
                        approvedConfigFiles: ['index.html', 'src/viverseConfig.js']
                    }
                }
            }
        });

        assert.equal(result.status, 'skip');
        assert.deepEqual(result.findings, []);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('FileService.addLesson requires explicit workspace scope', async () => {
    const result = await fileService.addLesson('Do not leak lessons globally.', '');

    assert.equal(result.success, false);
    assert.match(String(result.error || ''), /workspacePath required/i);
});
