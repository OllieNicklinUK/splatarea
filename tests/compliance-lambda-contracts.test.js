import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import complianceService from '../src/services/ComplianceService.js';

async function collectTextFiles(rootDir) {
    const files = [];
    const walk = async (dir) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const absPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(absPath);
                continue;
            }
            const text = await fs.readFile(absPath, 'utf8');
            files.push({
                relPath: path.relative(rootDir, absPath).replace(/\\/g, '/'),
                text
            });
        }
    };
    await walk(rootDir);
    return files;
}

test('ComplianceService lambda event contracts pass for the reference lambda template shape', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-lambda-contract-pass-'));
    try {
        await fs.mkdir(path.join(workspacePath, 'src'), { recursive: true });
        await fs.mkdir(path.join(workspacePath, 'lambda'), { recursive: true });

        const templateJson = JSON.parse(
            await fs.readFile(path.join(process.cwd(), 'templates/lambda-tool-v1/template.json'), 'utf8')
        );

        await fs.copyFile(
            path.join(process.cwd(), 'templates/lambda-tool-v1/src/app.js'),
            path.join(workspacePath, 'src/app.js')
        );
        await fs.copyFile(
            path.join(process.cwd(), 'templates/lambda-tool-v1/src/viverseLambda.js'),
            path.join(workspacePath, 'src/viverseLambda.js')
        );
        await fs.copyFile(
            path.join(process.cwd(), 'templates/lambda-tool-v1/lambda/prices_event.js'),
            path.join(workspacePath, 'lambda/prices_event.js')
        );
        await fs.copyFile(
            path.join(process.cwd(), 'templates/lambda-tool-v1/.env.lambda.example'),
            path.join(workspacePath, '.env.lambda.example')
        );

        const files = await collectTextFiles(workspacePath);
        const findings = complianceService._runTemplateStaticChecks({
            files,
            templateContext: {
                templateId: 'lambda-tool-v1',
                contract: templateJson
            },
            profiles: ['publishing'],
            gatePhase: 'fix',
            requestScope: {
                primary: 'platform-core.auth',
                allowedSubsystems: ['platform-core.auth']
            }
        });

        const ruleIds = findings.map((finding) => finding.ruleId);
        assert.equal(ruleIds.includes('lambda-event-script-missing'), false);
        assert.equal(ruleIds.includes('lambda-event-script-mismatch'), false);
        assert.equal(ruleIds.includes('lambda-script-getenv-missing'), false);
        assert.equal(ruleIds.includes('lambda-script-context-data-missing'), false);
        assert.equal(ruleIds.includes('lambda-env-example-key-missing'), false);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});

test('ComplianceService lambda event contracts fail when invoke and script contract drift apart', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'viverse-lambda-contract-fail-'));
    try {
        await fs.mkdir(path.join(workspacePath, 'src'), { recursive: true });
        await fs.mkdir(path.join(workspacePath, 'lambda'), { recursive: true });

        await fs.writeFile(
            path.join(workspacePath, 'src/app.js'),
            `import ViverseLambda from './viverseLambda.js';\nexport async function run(accessToken, appId, userId) {\n  return ViverseLambda.invoke('weather_event', { city: 'Taipei' }, accessToken, { appId, userId });\n}\n`,
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, 'src/viverseLambda.js'),
            `export default { invoke() {} };\n`,
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, 'lambda/prices_event.js'),
            `var input = {}; reply({ success: true, apiKey: 'leak' });\n`,
            'utf8'
        );
        await fs.writeFile(
            path.join(workspacePath, '.env.lambda.example'),
            `LAMBDA_AUTHKEY=replace\n`,
            'utf8'
        );

        const files = await collectTextFiles(workspacePath);
        const findings = complianceService._runTemplateStaticChecks({
            files,
            templateContext: {
                templateId: 'lambda-tool-v1',
                contract: {
                    id: 'lambda-tool-v1',
                    requiredGates: ['lambda.event_contracts'],
                    lambdaConfig: {
                        envFile: '.env.lambda.example',
                        scriptDir: 'lambda',
                        invokeClient: 'src/viverseLambda.js'
                    }
                }
            },
            profiles: ['publishing'],
            gatePhase: 'fix',
            requestScope: {
                primary: 'platform-core.auth',
                allowedSubsystems: ['platform-core.auth']
            }
        });

        const ruleIds = findings.map((finding) => finding.ruleId);
        assert.equal(ruleIds.includes('lambda-event-script-mismatch'), true);
        assert.equal(ruleIds.includes('lambda-script-getenv-missing'), true);
        assert.equal(ruleIds.includes('lambda-script-context-data-missing'), true);
        assert.equal(ruleIds.includes('lambda-script-secret-leak-risk'), true);
    } finally {
        await fs.rm(workspacePath, { recursive: true, force: true });
    }
});