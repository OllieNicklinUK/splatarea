#!/usr/bin/env node
/**
 * build-template.mjs
 *
 * Freezes a polished template-sources/<n>/app into templates/<template-id>/.
 *
 * Usage:
 *   node scripts/build-template.mjs --source template-sources/tankarena-3d/app --template tankarena-3d-v1
 *   node scripts/build-template.mjs --source template-sources/blank-webapp/app --template blank-webapp-v1 --dry-run
 *   node scripts/build-template.mjs --source template-sources/lambda-tool/app --template lambda-tool-v1 --skip-diff
 *
 * Flags:
 *   --dry-run    Show what would change without writing anything
 *   --force      Overwrite even if source and frozen are already in sync
 *   --skip-diff  Skip content diff check (use when adding a brand new template)
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

function hasFlag(name) {
  return args.includes(name);
}

const sourceRelPath = getFlag('--source');
const templateId    = getFlag('--template');
const dryRun        = hasFlag('--dry-run');
const force         = hasFlag('--force');
const skipDiff      = hasFlag('--skip-diff');

if (!sourceRelPath || !templateId) {
  console.error('Usage: node scripts/build-template.mjs --source <source-app-dir> --template <template-id>');
  console.error('Example: node scripts/build-template.mjs --source template-sources/blank-webapp/app --template blank-webapp-v1');
  process.exitCode = 1;
  process.exit();
}

const repoRoot     = process.cwd();
const sourceRoot   = path.resolve(repoRoot, sourceRelPath);
const templateRoot = path.resolve(repoRoot, 'templates', templateId);
const contractPath = path.join(templateRoot, 'template.json');
const registryPath = path.resolve(repoRoot, 'templates', 'registry.json');

// ─── Utilities ───────────────────────────────────────────────────────────────

function log(msg)  { console.log(msg); }
function warn(msg) { console.warn(`⚠️  ${msg}`); }
function ok(msg)   { console.log(`✅ ${msg}`); }
function fail(msg) { console.error(`❌ ${msg}`); }
function info(msg) { console.log(`   ${msg}`); }

async function fileHash(filePath) {
  try {
    const buf = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

async function exists(filePath) {
  try { await fs.stat(filePath); return true; } catch { return false; }
}

const EXCLUDED_PREFIXES = [
  'node_modules/',
  'dist/',
  'hand-tracking-101/',
  '.git/',
  '.vscode/',
  '.idea/'
];

const EXCLUDED_BASENAMES = new Set([
  '.DS_Store',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production'
]);

function shouldExcludeRel(relPath = '') {
  const rel = normalizeRel(relPath);
  if (!rel) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix))) return true;

  const parts = rel.split('/');
  const base = parts[parts.length - 1] || '';
  if (EXCLUDED_BASENAMES.has(base)) return true;
  if (/\.zip$/i.test(base)) return true;
  return false;
}

async function walkDir(dir, base = dir, results = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath  = path.relative(base, fullPath).replace(/\\/g, '/');
    if (shouldExcludeRel(relPath)) continue;
    if (entry.isDirectory()) await walkDir(fullPath, base, results);
    else results.push(relPath);
  }
  return results;
}

// ─── Contract Loading ─────────────────────────────────────────────────────────

async function loadContract() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  } catch {
    throw new Error(`Cannot read contract at ${contractPath}. Does templates/${templateId}/template.json exist?`);
  }

  const immutablePaths = Array.isArray(raw.immutablePaths) ? raw.immutablePaths.map(String) : [];
  const editablePaths  = Array.isArray(raw.editablePaths)  ? raw.editablePaths.map(String)  : [];
  const injectionHooks = Array.isArray(raw.injectionHooks) ? raw.injectionHooks : [];

  if (!immutablePaths.length) warn('Contract has no immutablePaths — all files treated as editable.');
  if (!editablePaths.length)  warn('Contract has no editablePaths.');

  return { raw, immutablePaths, editablePaths, injectionHooks };
}

// ─── Path Matching ────────────────────────────────────────────────────────────

function normalizeRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function matchesRule(relPath, rule) {
  const p = normalizeRel(relPath);
  const r = normalizeRel(rule);
  if (!r) return false;
  if (r.endsWith('/**')) {
    const prefix = r.slice(0, -3);
    return p === prefix || p.startsWith(`${prefix}/`);
  }
  return p === r || p.startsWith(`${r}/`);
}

function classifyPath(relPath, contract) {
  const { immutablePaths, editablePaths } = contract;
  if (immutablePaths.some((rule) => matchesRule(relPath, rule))) return 'immutable';
  if (editablePaths.some((rule)  => matchesRule(relPath, rule))) return 'editable';
  return 'unclaimed';
}

// ─── Gates ───────────────────────────────────────────────────────────────────

async function gateInjectionHooks(contract) {
  const results = [];
  for (const hook of contract.injectionHooks) {
    const relFile = normalizeRel(hook.file || '');
    const absPath = path.join(sourceRoot, relFile);
    const present = await exists(absPath);
    results.push({
      gate: `injection_hook.${hook.hookId || relFile}`,
      status: present ? 'pass' : (hook.required ? 'fail' : 'warn'),
      reason: present ? '' : `Hook file missing in source: ${relFile}${hook.required ? '' : ' (optional)'}`
    });
  }
  return results;
}

async function gateImmutablePresence(contract) {
  const results = [];
  for (const rule of contract.immutablePaths) {
    if (rule.includes('*')) continue; // skip globs
    const absPath = path.join(sourceRoot, normalizeRel(rule));
    const present = await exists(absPath);
    results.push({
      gate: `immutable_present.${rule}`,
      status: present ? 'pass' : 'fail',
      reason: present ? '' : `Immutable path missing from source: ${rule}`
    });
  }
  return results;
}

async function gateRegistryEntry() {
  try {
    const reg = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    const found = Array.isArray(reg.templates) && reg.templates.some((t) => t.id === templateId);
    return [{
      gate: 'registry.entry',
      status: found ? 'pass' : 'fail',
      reason: found ? '' : `Template "${templateId}" not found in templates/registry.json`
    }];
  } catch {
    return [{ gate: 'registry.entry', status: 'fail', reason: 'Cannot read templates/registry.json' }];
  }
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

async function diffSourceVsTemplate(contract) {
  const sourceFiles   = await walkDir(sourceRoot);
  const templateFiles = await walkDir(templateRoot);

  const META_FILES    = new Set(['template.json', 'TEMPLATE.md', 'scenario.schema.json']);
  const rulesetPrefix = 'rulesets/';

  const toSync  = sourceFiles.filter((f) => !META_FILES.has(f) && !f.startsWith(rulesetPrefix));
  const changes = [];

  for (const relPath of toSync) {
    const srcHash = await fileHash(path.join(sourceRoot, relPath));
    const dstHash = await fileHash(path.join(templateRoot, relPath));
    const category = classifyPath(relPath, contract);

    if (dstHash === null) changes.push({ relPath, type: 'added', category });
    else if (srcHash !== dstHash) changes.push({ relPath, type: 'modified', category });
  }

  for (const relPath of templateFiles) {
    if (META_FILES.has(relPath) || relPath.startsWith(rulesetPrefix)) continue;
    if (!toSync.includes(relPath)) {
      changes.push({ relPath, type: 'deleted', category: classifyPath(relPath, contract) });
    }
  }

  return changes;
}

// ─── Copy ────────────────────────────────────────────────────────────────────

async function copyFile(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function summarizeGates(gates) {
  const failed = gates.filter((g) => g.status === 'fail');
  return { pass: failed.length === 0, failed, gates };
}

function printGates(label, gates) {
  log(`\n── ${label} ──`);
  for (const g of gates) {
    if (g.status === 'pass')  info(`✅ ${g.gate}`);
    else if (g.status === 'warn') info(`⚠️  ${g.gate}: ${g.reason}`);
    else                      info(`❌ ${g.gate}: ${g.reason}`);
  }
}

function printDiff(changes) {
  log('\n── Diff: source vs frozen template ──');
  if (changes.length === 0) { ok('No differences — source and frozen template are in sync.'); return; }
  for (const c of changes) {
    const badge = c.type === 'added' ? '+ added   ' : c.type === 'modified' ? '~ modified' : '- deleted ';
    const guard = c.category === 'immutable' ? ' [IMMUTABLE]' : '';
    info(`${badge}  ${c.relPath}${guard}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`\n${'='.repeat(60)}`);
  log(`build-template.mjs`);
  log(`  source:   ${sourceRoot}`);
  log(`  template: ${templateRoot}`);
  log(`  dry-run:  ${dryRun}`);
  log(`${'='.repeat(60)}\n`);

  if (!(await exists(sourceRoot))) {
    fail(`Source directory not found: ${sourceRoot}`); process.exitCode = 1; return;
  }
  if (!(await exists(templateRoot))) {
    fail(`Template directory not found: ${templateRoot}`);
    fail(`Create templates/${templateId}/ with template.json first.`);
    process.exitCode = 1; return;
  }

  let contract;
  try {
    contract = await loadContract();
    ok(`Contract loaded (${contract.immutablePaths.length} immutable, ${contract.editablePaths.length} editable paths)`);
  } catch (error) {
    fail(error.message); process.exitCode = 1; return;
  }

  const allPreGates = [
    ...await gateRegistryEntry(),
    ...await gateImmutablePresence(contract),
    ...await gateInjectionHooks(contract)
  ];

  printGates('Pre-flight gates', allPreGates);

  const pre = summarizeGates(allPreGates);
  if (!pre.pass) {
    fail(`\n${pre.failed.length} pre-flight gate(s) failed. Fix before exporting.`);
    process.exitCode = 1; return;
  }
  ok('All pre-flight gates passed.\n');

  let changes = [];
  if (skipDiff) {
    warn('Skipping immutable diff enforcement (--skip-diff).');
    changes = await diffSourceVsTemplate(contract);
  } else {
    changes = await diffSourceVsTemplate(contract);
    printDiff(changes);

    const immutableViolations = changes.filter((c) => c.category === 'immutable');
    if (immutableViolations.length > 0) {
      fail('\nImmutable files differ between source and frozen template:');
      for (const v of immutableViolations) info(`  ${v.type}  ${v.relPath}`);
      fail('Resolve the divergence manually before re-exporting.');
      process.exitCode = 1; return;
    }

    if (changes.length === 0 && !force) {
      ok('Source and frozen template are already in sync. Nothing to do.');
      ok('Use --force to re-export anyway.');
      return;
    }

  }

  if (changes.length === 0 && !force) {
    ok('Source and frozen template are already in sync. Nothing to do.');
    ok('Use --force to re-export anyway.');
    return;
  }

  if (dryRun) { log('\n[dry-run] No files written.'); return; }

  log('\n── Applying changes ──');
  let written = 0, deleted = 0, skipped = 0;

  for (const change of changes) {
    const src = path.join(sourceRoot, change.relPath);
    const dst = path.join(templateRoot, change.relPath);

    if (change.type === 'deleted') {
      if (change.category === 'editable') {
        await fs.unlink(dst).catch(() => {});
        info(`- deleted   ${change.relPath}`);
        deleted++;
      } else {
        warn(`Skipped deletion of unclaimed file: ${change.relPath}`);
        skipped++;
      }
      continue;
    }

    await copyFile(src, dst);
    info(`${change.type === 'added' ? '+ added   ' : '~ updated '} ${change.relPath}`);
    written++;
  }

  log(`\n  written: ${written} | deleted: ${deleted} | skipped: ${skipped}`);

  // Write export manifest
  const sourceName   = sourceRelPath.split('/')[1] || sourceRelPath.split('/')[0];
  const manifestPath = path.join(repoRoot, 'template-sources', sourceName, 'export', 'last-export.json');
  const manifest = {
    templateId,
    exportedAt: new Date().toISOString(),
    sourceRoot: sourceRelPath,
    dryRun,
    contractVersion: contract.raw.version || '0.0.0',
    immutablePaths: contract.immutablePaths,
    editablePaths: contract.editablePaths,
    injectionHooks: contract.injectionHooks.map((h) => ({ hookId: h.hookId, file: h.file }))
  };

  if (!dryRun) {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    ok(`Export manifest → ${path.relative(repoRoot, manifestPath)}`);
  }

  log(`\n${'='.repeat(60)}`);
  ok(dryRun ? 'Dry run complete.' : `Export complete: templates/${templateId}`);
  log(`${'='.repeat(60)}\n`);
}

main().catch((error) => {
  fail(`Unexpected error: ${error.message}`);
  console.error(error);
  process.exitCode = 1;
});
