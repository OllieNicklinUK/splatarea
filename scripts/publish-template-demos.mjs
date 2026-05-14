#!/usr/bin/env node
/**
 * publish-template-demos.mjs
 *
 * Publishes live demo apps for each game template and writes the resulting
 * demoPlayLink + demoAppId back into templates/registry.json.
 *
 * Usage:
 *   node scripts/publish-template-demos.mjs [--only <templateId>] [--force <templateId>]
 *   node scripts/publish-template-demos.mjs --email user@example.com --password secret
 *
 * Flags:
 *   --email <e>       VIVERSE account email (overrides VIVERSE_EMAIL env var)
 *   --password <p>    VIVERSE account password (overrides VIVERSE_PASSWORD env var)
 *   --only <id>       Process only a single template ID
 *   --force <id>      Force re-deploy even if demoPlayLink is already set
 *                     (can be specified multiple times, or combined with --only)
 *   --dry-run         Parse args and print plan without deploying anything
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'templates', 'registry.json');
const TEMPLATES_DIR = path.join(ROOT, 'templates');

// ── Load .env if present ─────────────────────────────────────────────────────
dotenv.config({ path: path.join(ROOT, '.env') });

// ── Arg parsing ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let email    = process.env.VIVERSE_EMAIL || '';
let password = process.env.VIVERSE_PASSWORD || '';
let onlyId   = null;
const forceIds = new Set();
let dryRun   = false;

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email')    { email    = args[++i]; continue; }
    if (args[i] === '--password') { password = args[++i]; continue; }
    if (args[i] === '--only')     { onlyId   = args[++i]; continue; }
    if (args[i] === '--force')    { forceIds.add(args[++i]); continue; }
    if (args[i] === '--dry-run')  { dryRun   = true; continue; }
}

// ── Locate viverse-cli ───────────────────────────────────────────────────────
function findViverseCli() {
    // Try $PATH first
    try {
        const which = process.platform === 'win32' ? 'where' : 'which';
        const result = execSync(`${which} viverse-cli`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
        if (result && existsSync(result.split('\n')[0].trim())) return result.split('\n')[0].trim();
    } catch { /* not on PATH */ }

    // Common install prefixes
    const candidates = [
        '/opt/homebrew/bin/viverse-cli',
        '/usr/local/bin/viverse-cli',
        path.join(os.homedir(), '.npm-global', 'bin', 'viverse-cli'),
        path.join(os.homedir(), 'node_modules', '.bin', 'viverse-cli'),
        path.join(ROOT, 'node_modules', '.bin', 'viverse-cli'),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return null;
}

const VIVERSE_CLI = findViverseCli();

// ── Per-template build / App ID injection strategies ─────────────────────────
const STRATEGIES = {
    'dashrunner-v1': {
        build: (tmpDir, appId) => {
            npmInstall(tmpDir);
            run(`VITE_VIVERSE_CLIENT_ID=${appId} npm run build`, tmpDir);
        },
        publishDir: 'dist'
    },
    'flow-line-v1': {
        build: (tmpDir, appId) => {
            // Static copy; template.json buildConfig.command handles it
            const cmd = readTemplateJson(tmpDir)?.buildConfig?.command;
            if (cmd) run(cmd, tmpDir);
            sedReplace(path.join(tmpDir, 'dist', 'index.html'), 'YOUR_APP_ID', appId);
        },
        publishDir: 'dist'
    },
    'redpointfish-v1': {
        build: (tmpDir, appId) => {
            npmInstall(tmpDir);
            run(`VITE_VIVERSE_CLIENT_ID=${appId} npm run build`, tmpDir);
        },
        publishDir: 'dist'
    },
    'starter-kit-racing-v1': {
        build: (tmpDir, appId) => {
            // Fully static — no build step; inject directly into index.html
            sedReplace(path.join(tmpDir, 'index.html'), "clientId: ''", `clientId: '${appId}'`);
        },
        publishDir: '.'
    },
    'tankarena-3d-v1': {
        build: (tmpDir, appId) => {
            npmInstall(tmpDir);
            run('npm run build', tmpDir);
            // Inject appId into dist after build
            runRaw(`find dist -name "*.json" -o -name "*.html" | xargs sed -i "" "s/YOUR_APP_ID/${appId}/g"`, tmpDir);
        },
        publishDir: 'dist'
    }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function npmInstall(cwd) {
    const hasLock = existsSync(path.join(cwd, 'package-lock.json')) ||
                    existsSync(path.join(cwd, 'npm-shrinkwrap.json'));
    run(hasLock ? 'npm ci --prefer-offline' : 'npm install --prefer-offline', cwd);
}

function run(cmd, cwd) {
    console.log(`  $ ${cmd}`);
    const result = spawnSync(cmd, { cwd, shell: true, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`Command failed (exit ${result.status}): ${cmd}`);
}

function runRaw(cmd, cwd) {
    console.log(`  $ ${cmd}`);
    execSync(cmd, { cwd, stdio: 'inherit' });
}

function runCapture(cmd, cwd) {
    console.log(`  $ ${cmd}`);
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
}

function sedReplace(filePath, search, replace) {
    console.log(`  sed: ${search} → ${replace} in ${path.basename(filePath)}`);
    if (!existsSync(filePath)) throw new Error(`File not found for sed replacement: ${filePath}`);
    const content = require('fs').readFileSync(filePath, 'utf8');
    const updated = content.split(search).join(replace);
    require('fs').writeFileSync(filePath, updated, 'utf8');
}

function readTemplateJson(dir) {
    try { return JSON.parse(require('fs').readFileSync(path.join(dir, 'template.json'), 'utf8')); }
    catch { return null; }
}

async function copyDir(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath);
        } else {
            await fs.copyFile(srcPath, destPath);
        }
    }
}

function extractAppId(output = '') {
    // viverse-cli prints something like: App ID: ab1234cd5e  or  appId=ab1234cd5e
    const m = output.match(/app[_\s-]?id[:\s=]+([a-z0-9]{10})/i);
    return m ? m[1].toLowerCase() : null;
}

function extractPreviewUrl(output = '') {
    const m = output.match(/https:\/\/worlds\.viverse\.com\/[^\s'"]+/i);
    return m ? m[0] : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    // Validate pre-conditions
    if (!VIVERSE_CLI) {
        console.error([
            '✗ viverse-cli not found.',
            '  Install via: npm install -g @viverse/cli',
            '  Or ensure it is on your PATH / in a known prefix.',
        ].join('\n'));
        process.exit(1);
    }
    console.log(`✓ Using viverse-cli: ${VIVERSE_CLI}`);

    if (!email || !password) {
        console.error('✗ VIVERSE credentials required. Pass --email and --password or set VIVERSE_EMAIL / VIVERSE_PASSWORD.');
        process.exit(1);
    }

    // Load registry
    const registryRaw = await fs.readFile(REGISTRY_PATH, 'utf8');
    const registry = JSON.parse(registryRaw);
    const templates = Array.isArray(registry.templates) ? registry.templates : [];

    // Determine which templates to process
    const GAME_TEMPLATE_IDS = Object.keys(STRATEGIES);
    const targets = templates.filter(t => {
        if (!GAME_TEMPLATE_IDS.includes(t.id)) return false;     // skip utility/unknown
        if (onlyId && t.id !== onlyId) return false;             // --only filter
        if (t.demoPlayLink && !forceIds.has(t.id)) return false; // already deployed (idempotent)
        return true;
    });

    if (targets.length === 0) {
        console.log('Nothing to deploy — all eligible templates already have demoPlayLink set.');
        console.log('Use --force <templateId> to re-deploy a specific template.');
        return;
    }

    console.log(`\nTemplates to deploy: ${targets.map(t => t.id).join(', ')}\n`);

    if (dryRun) {
        console.log('[dry-run] Exiting without deploying.');
        return;
    }

    // Auth login once
    console.log('→ Logging in to VIVERSE...');
    run(`${VIVERSE_CLI} auth login -e "${email}" -p "${password}"`, ROOT);
    console.log('✓ Logged in\n');

    let modified = false;

    for (const template of targets) {
        const { id } = template;
        const strategy = STRATEGIES[id];
        const srcDir = path.join(TEMPLATES_DIR, id);

        console.log(`\n─────────────────────────────────────────`);
        console.log(`Template: ${id}`);
        console.log(`─────────────────────────────────────────`);

        const tmpDir = path.join(os.tmpdir(), `viverse-demo-${id}-${Date.now()}`);
        try {
            // 1. Copy template to temp dir
            console.log(`  Copying ${srcDir} → ${tmpDir}`);
            await copyDir(srcDir, tmpDir);

            // 2. Create a new VIVERSE app and capture App ID
            console.log(`  Creating VIVERSE app: Demo-${id}`);
            const createOut = runCapture(`${VIVERSE_CLI} app create --name "Demo-${id}"`, tmpDir);
            const appId = extractAppId(createOut);
            if (!appId) throw new Error(`Could not extract App ID from viverse-cli output:\n${createOut}`);
            console.log(`  ✓ App ID: ${appId}`);

            // 3. Build + inject App ID
            console.log('  Building...');
            strategy.build(tmpDir, appId);

            // 4. Publish
            const publishDir = strategy.publishDir === '.' ? tmpDir : path.join(tmpDir, strategy.publishDir);
            console.log(`  Publishing from ${publishDir}...`);
            const publishOut = runCapture(`${VIVERSE_CLI} app publish "${publishDir}" --app-id ${appId}`, ROOT);
            const previewUrl = extractPreviewUrl(publishOut);
            if (!previewUrl) throw new Error(`Could not extract preview URL from publish output:\n${publishOut}`);
            console.log(`  ✓ Published: ${previewUrl}`);

            // 5. Write back to registry
            template.demoPlayLink = previewUrl;
            template.demoAppId = appId;
            modified = true;
            console.log(`  ✓ Registry updated for ${id}`);

        } catch (err) {
            console.error(`  ✗ Failed to deploy ${id}: ${err.message}`);
            console.error('  Continuing with next template...');
        } finally {
            // Clean up temp dir
            try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }

    // Save registry if anything changed
    if (modified) {
        registry.updatedAt = new Date().toISOString();
        await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');
        console.log(`\n✓ registry.json updated.`);
    }

    console.log('\nDone.');
}

// Node polyfill: require() in ESM context
const require = createRequire(import.meta.url);

main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});
