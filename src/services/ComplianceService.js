import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import skillProvider from './SkillProvider.js';

const TEXT_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.html', '.css', '.json']);
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.next',
  'build',
  'coverage',
  '.viverse_workspaces',
  'artifacts'
]);
const IGNORE_FILES = [
  /^\.agent_state\.json$/i,
  /^\.viverse_lessons\.json$/i,
  /^run_report\.json$/i,
  /^\.compliance_cache\.json$/i
];
const DIST_SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.json']);

function safeRegex(pattern, flags = 'm') {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function normalizeText(v) {
  return String(v || '').toLowerCase();
}

function isDotEnvFileName(name = '') {
  const base = String(name || '').toLowerCase();
  return base === '.env' || base.startsWith('.env.');
}

class ComplianceService {
  constructor() {
    const serviceDir = path.dirname(fileURLToPath(import.meta.url));
    this.skillsDir = skillProvider.getSkillsDir() || path.resolve(serviceDir, '../../skills');
    this.ruleCache = null;
    this.ruleCacheLoadedAt = 0;
  }

  _extractCanonicalAppId(text = '') {
    const raw = String(text || '');
    const contextualPatterns = [
      /(?:^|\b)(?:app[\s_-]?id|app_id|VITE_VIVERSE_CLIENT_ID)\s*[:=]\s*["']?([a-z0-9]{10})\b/i,
      /\bviverse-cli\s+app\s+publish\b[\s\S]{0,200}--app-id\s+([a-z0-9]{10})\b/i,
      /"app_id"\s*:\s*"([a-z0-9]{10})"/i
    ];
    for (const re of contextualPatterns) {
      const match = raw.match(re);
      const candidate = String(match?.[1] || '').toLowerCase();
      if (candidate) return candidate;
    }

    const matches = raw.match(/\b[a-z0-9]{10}\b/gi) || [];
    const candidate = matches.map((m) => String(m).toLowerCase()).find((id) => /^[a-z0-9]{10}$/.test(id));
    return candidate || '';
  }

  async _readConfiguredAppIdFallback(workspacePath = '') {
    const ws = String(workspacePath || '').trim();
    if (!ws) return { appId: '', source: '' };

    const candidates = [
      { path: path.join(ws, '.env.example'), source: '.env.example' },
      { path: path.join(ws, 'vite.config.js'), source: 'vite.config.js' },
      { path: path.join(ws, 'vite.config.mjs'), source: 'vite.config.mjs' },
      { path: path.join(ws, 'vite.config.ts'), source: 'vite.config.ts' }
    ];

    for (const candidate of candidates) {
      try {
        const raw = await fs.readFile(candidate.path, 'utf8');
        const appId = this._extractCanonicalAppId(raw);
        if (/^[a-z0-9]{10}$/i.test(appId)) {
          return { appId: String(appId).toLowerCase(), source: candidate.source };
        }
      } catch {
        // ignore
      }
    }

    return { appId: '', source: '' };
  }

  inferProfiles(text = '') {
    const t = normalizeText(text);
    const profiles = new Set();

    if (/(auth|sso|checkauth|login|logout|profile|avatar|identity)/.test(t)) profiles.add('auth');
    if (/(multiplayer|matchmaking|room|join|create room|start game|session_id|actor)/.test(t)) profiles.add('multiplayer');
    if (/(publish|deploy|app id|viverse-cli)/.test(t)) profiles.add('publishing');

    return [...profiles];
  }

  async _loadRules(force = false) {
    const now = Date.now();
    if (!force && this.ruleCache && now - this.ruleCacheLoadedAt < 30000) {
      return this.ruleCache;
    }

    const candidates = [
      path.join(this.skillsDir, 'viverse-auth', 'rules.json'),
      path.join(this.skillsDir, 'viverse-multiplayer', 'rules.json'),
      path.join(this.skillsDir, 'viverse-world-publishing', 'rules.json')
    ];

    const all = [];
    for (const p of candidates) {
      try {
        const raw = await fs.readFile(p, 'utf8');
        const parsed = JSON.parse(raw);
        const rules = Array.isArray(parsed?.rules) ? parsed.rules : [];
        for (const rule of rules) {
          all.push({
            ...rule,
            _source: p
          });
        }
      } catch (err) {
        logger.warn(`ComplianceService: unable to load rules from ${p}: ${err.message}`);
      }
    }

    this.ruleCache = all;
    this.ruleCacheLoadedAt = now;
    return all;
  }

  async _listFilesRecursive(rootDir) {
    const out = [];
    const walk = async (dir) => {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORE_DIRS.has(e.name)) continue;
          await walk(abs);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        const isTextExt = TEXT_EXT.has(ext);
        const isDotEnv = isDotEnvFileName(e.name);
        if (!isTextExt && !isDotEnv) continue;
        if (IGNORE_FILES.some((re) => re.test(e.name))) continue;
        out.push(abs);
      }
    };
    await walk(rootDir);
    return out;
  }

  async _listDistFilesRecursive(rootDir) {
    const out = [];
    const walk = async (dir) => {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(abs);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!DIST_SCAN_EXT.has(ext)) continue;
        out.push(abs);
      }
    };
    await walk(rootDir);
    return out;
  }

  async _collectFileMetas(workspacePath) {
    const files = await this._listFilesRecursive(workspacePath);
    const metas = [];
    for (const f of files) {
      try {
        const st = await fs.stat(f);
        if (st.size > 512000) continue;
        metas.push({
          absPath: f,
          relPath: path.relative(workspacePath, f),
          size: st.size,
          mtimeMs: Number(st.mtimeMs || 0)
        });
      } catch {
        // skip unreadable file
      }
    }
    return metas;
  }

  async _readTextFilesIncremental(workspacePath, cache = {}) {
    const metas = await this._collectFileMetas(workspacePath);
    const prevIndex = cache?.fileIndex && typeof cache.fileIndex === 'object' ? cache.fileIndex : {};
    const nextIndex = {};
    const payloads = [];

    for (const m of metas) {
      const prev = prevIndex[m.relPath];
      if (prev && prev.size === m.size && prev.mtimeMs === m.mtimeMs && typeof prev.text === 'string') {
        const reused = { ...m, text: prev.text };
        payloads.push(reused);
        nextIndex[m.relPath] = reused;
        continue;
      }

      try {
        const text = await fs.readFile(m.absPath, 'utf8');
        const next = { ...m, text };
        payloads.push(next);
        nextIndex[m.relPath] = next;
      } catch {
        // skip unreadable file
      }
    }

    return { files: payloads, nextIndex };
  }

  _buildSnapshotKey(files = [], profiles = []) {
    const fileSig = files
      .map((f) => `${f.relPath}:${f.size}:${Math.floor(f.mtimeMs)}`)
      .sort()
      .join('|');
    return `${profiles.sort().join(',')}::${fileSig}`;
  }

  _checkRule(rule, files, corpus) {
    const kind = String(rule?.type || '');
    const ruleId = String(rule?.id || '');
    const pattern = String(rule?.pattern || '');
    const patterns = Array.isArray(rule?.patterns) ? rule.patterns.map((p) => String(p)) : [];

    if (kind === 'required_any') {
      const re = safeRegex(pattern, rule?.flags || 'm');
      if (!re) return { pass: false, detail: 'Invalid regex pattern' };
      const hit = files.find((f) => re.test(f.text));
      return hit
        ? { pass: true, detail: `Matched in ${hit.relPath}` }
        : { pass: false, detail: `Missing required pattern: ${pattern}` };
    }

    if (kind === 'forbidden_any') {
      const re = safeRegex(pattern, rule?.flags || 'm');
      if (!re) return { pass: false, detail: 'Invalid regex pattern' };
      const hit = files.find((f) => {
        const relPath = String(f?.relPath || '').replace(/\\/g, '/');
        if (ruleId === 'publish-no-placeholder-appid' && /(^|\/)\.env\.example$/i.test(relPath)) {
          return false;
        }
        // CONTRACT.json publishCommand field is a reference template, not shipped source — skip
        if (ruleId === 'publish-no-placeholder-appid' && /(^|\/)CONTRACT\.json$/i.test(relPath)) {
          return false;
        }
        return re.test(f.text);
      });
      return hit
        ? { pass: false, detail: `Forbidden pattern found in ${hit.relPath}` }
        : { pass: true, detail: 'Forbidden pattern not found' };
    }

    if (kind === 'required_sequence_anyfile') {
      const perFile = files.some((f) => {
        let cursor = 0;
        for (const p of patterns) {
          const re = safeRegex(p, 'm');
          if (!re) return false;
          const slice = f.text.slice(cursor);
          const m = slice.match(re);
          if (!m || typeof m.index !== 'number') return false;
          cursor += m.index + m[0].length;
        }
        return true;
      });
      return perFile
        ? { pass: true, detail: 'Sequence matched in a single file' }
        : { pass: false, detail: 'Sequence not found in any single file' };
    }

    return { pass: true, detail: `Unknown rule type: ${kind} (ignored)` };
  }

  _getFilePayload(files = [], relPath = '') {
    const wanted = String(relPath || '').replace(/\\/g, '/').toLowerCase();
    return (Array.isArray(files) ? files : []).find((f) => String(f?.relPath || '').replace(/\\/g, '/').toLowerCase() === wanted) || null;
  }

  _getFirstMatchingFilePayload(files = [], relPaths = []) {
    for (const relPath of Array.isArray(relPaths) ? relPaths : []) {
      const match = this._getFilePayload(files, relPath);
      if (match) return match;
    }
    return null;
  }

  _hasWorldLaunchSequence(startupFile = null, files = []) {
    const startupText = String(startupFile?.text || '');
    if (
      /new\s+World\s*\(/m.test(startupText) ||
      /window\.world\s*=/m.test(startupText) ||
      /GameManager\.(?:start|bootstrap)\s*\(/m.test(startupText) ||
      /startGameWorld\s*\(/m.test(startupText) ||
      // ViverseApp pattern (dashrunner-v1, blank-webapp-v1, lambda-tool-v1)
      /new\s+ViverseApp\s*\(/m.test(startupText) ||
      /viverseApp\.(?:start|init|mount|launch)\s*\(/m.test(startupText) ||
      /app\.(?:start|init|mount|launch)\s*\(/m.test(startupText) ||
      /createApp\s*\(/m.test(startupText) ||
      /import.*['"].*viverse(?:App|app).*['"]/.test(startupText)
    ) {
      return true;
    }

    const importMatch = startupText.match(/import\s+["'](.+?)["'];?/m);
    if (!importMatch?.[1] || !startupFile?.relPath) return false;

    const importerDir = path.posix.dirname(String(startupFile.relPath).replace(/\\/g, '/'));
    let importedRel = path.posix.normalize(path.posix.join(importerDir, importMatch[1]));
    if (!/\.[a-z0-9]+$/i.test(importedRel)) importedRel += '.ts';
    const importedFile = this._getFilePayload(files, importedRel);
    if (!importedFile) return false;

    const importedText = String(importedFile.text || '');
    return (
      /new\s+World\s*\(/m.test(importedText) ||
      /window\.world\s*=/m.test(importedText) ||
      /GameManager\.(?:start|bootstrap)\s*\(/m.test(importedText) ||
      /startGameWorld\s*\(/m.test(importedText)
    );
  }

  _extractLambdaInvokeEventNames(files = []) {
    const eventNames = new Set();
    for (const file of Array.isArray(files) ? files : []) {
      const relPath = String(file?.relPath || '').replace(/\\/g, '/');
      if (/^lambda\//i.test(relPath)) continue;
      const text = String(file?.text || '');
      const directInvokeRe = /(?:ViverseLambda|\w+)?\.invoke\s*\(\s*['"]([a-z0-9_-]+)['"]/gi;
      let match = null;
      while ((match = directInvokeRe.exec(text))) {
        eventNames.add(String(match[1] || '').trim());
      }
    }
    return [...eventNames];
  }

  _extractLambdaEnvKeys(text = '') {
    const keys = new Set();
    const re = /getEnv\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g;
    let match = null;
    while ((match = re.exec(String(text || '')))) {
      keys.add(String(match[1] || '').trim());
    }
    return [...keys];
  }

  _runLambdaEventContractChecks({ files = [], templateContext = null } = {}) {
    const findings = [];
    const ctx = templateContext && typeof templateContext === 'object' ? templateContext : {};
    const contract = ctx?.contract && typeof ctx.contract === 'object' ? ctx.contract : {};
    const requiredGates = new Set(
      (Array.isArray(ctx?.requiredEvidence) ? ctx.requiredEvidence : Array.isArray(contract?.requiredGates) ? contract.requiredGates : [])
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    );

    if (!requiredGates.has('lambda.event_contracts')) return findings;

    const lambdaConfig = contract?.lambdaConfig && typeof contract.lambdaConfig === 'object'
      ? contract.lambdaConfig
      : {};
    const scriptDir = String(lambdaConfig.scriptDir || 'lambda').replace(/\\/g, '/').replace(/\/$/, '');
    const envFile = String(lambdaConfig.envFile || '.env.lambda.example').replace(/\\/g, '/');
    const invokeClient = String(lambdaConfig.invokeClient || 'src/viverseLambda.js').replace(/\\/g, '/');

    const invokeClientFile = this._getFilePayload(files, invokeClient);
    if (!invokeClientFile) {
      findings.push({
        ruleId: 'lambda-invoke-client-missing',
        severity: 'critical',
        message: `Lambda invoke client is missing: ${invokeClient}.`,
        detail: 'Template contract requires an invoke client file for hosted Lambda calls.'
      });
      return findings;
    }

    const envExampleFile = this._getFilePayload(files, envFile);
    if (!envExampleFile) {
      findings.push({
        ruleId: 'lambda-env-example-missing',
        severity: 'critical',
        message: `Lambda env example is missing: ${envFile}.`,
        detail: 'Template contract requires a documented .env.lambda.example for Lambda secrets.'
      });
    }

    const lambdaFiles = (Array.isArray(files) ? files : []).filter((file) => {
      const relPath = String(file?.relPath || '').replace(/\\/g, '/');
      return relPath.startsWith(`${scriptDir}/`) && /_event\.(js|mjs|cjs|ts)$/i.test(relPath);
    });

    if (!lambdaFiles.length) {
      findings.push({
        ruleId: 'lambda-event-script-missing',
        severity: 'critical',
        message: `No Lambda event scripts found under ${scriptDir}/.`,
        detail: 'Expected at least one *_event script for lambda.event_contracts validation.'
      });
      return findings;
    }

    const invokedEvents = this._extractLambdaInvokeEventNames(files);
    const scriptNames = new Set(
      lambdaFiles.map((file) => path.basename(String(file.relPath || '').replace(/\\/g, '/')).replace(/\.[^.]+$/, ''))
    );

    if (!invokedEvents.length) {
      findings.push({
        ruleId: 'lambda-event-invoke-missing',
        severity: 'high',
        message: 'No Lambda event invocations were found in source files.',
        detail: 'Expected source code to call ViverseLambda.invoke with a literal event name.'
      });
    }

    for (const eventName of invokedEvents) {
      if (!scriptNames.has(eventName)) {
        findings.push({
          ruleId: 'lambda-event-script-mismatch',
          severity: 'critical',
          message: `No matching Lambda script found for invoked event '${eventName}'.`,
          detail: `Expected ${scriptDir}/${eventName}.js or equivalent event script to exist.`
        });
      }
    }

    const envExampleText = String(envExampleFile?.text || '');
    for (const scriptFile of lambdaFiles) {
      const relPath = String(scriptFile.relPath || '').replace(/\\/g, '/');
      const text = String(scriptFile.text || '');
      const envKeys = this._extractLambdaEnvKeys(text);

      if (!/getEnv\(/.test(text)) {
        findings.push({
          ruleId: 'lambda-script-getenv-missing',
          severity: 'high',
          message: `Lambda script must use getEnv() for secrets: ${relPath}.`,
          detail: 'Use getEnv() instead of hardcoding secrets inside event scripts.'
        });
      }

      if (!/context\.data/.test(text)) {
        findings.push({
          ruleId: 'lambda-script-context-data-missing',
          severity: 'high',
          message: `Lambda script must validate context.data: ${relPath}.`,
          detail: 'Read and validate context.data before calling upstream providers.'
        });
      }

      if (!/reply\(/.test(text)) {
        findings.push({
          ruleId: 'lambda-script-reply-missing',
          severity: 'critical',
          message: `Lambda script must return via reply(): ${relPath}.`,
          detail: 'Lambda scripts should reply with sanitized application data.'
        });
      }

      if (/reply\([\s\S]{0,200}(apiKey|accessToken|secret|authorization)\b/i.test(text)) {
        findings.push({
          ruleId: 'lambda-script-secret-leak-risk',
          severity: 'critical',
          message: `Lambda script may expose secret-bearing fields in reply(): ${relPath}.`,
          detail: 'Never return raw secrets, tokens, or authorization headers from Lambda scripts.'
        });
      }

      for (const envKey of envKeys) {
        if (envExampleText && !new RegExp(`(^|\\n)\\s*#?\\s*${envKey}\\s*=`, 'm').test(envExampleText)) {
          findings.push({
            ruleId: 'lambda-env-example-key-missing',
            severity: 'high',
            message: `Lambda env example does not document ${envKey}.`,
            detail: `${envFile} must list every getEnv() key referenced by ${relPath}.`
          });
        }
      }
    }

    return findings;
  }

  _runTemplateStaticChecks({ files = [], templateContext = null, profiles = [], gatePhase = '', requestScope = null } = {}) {
    const findings = [];
    const ctx = templateContext && typeof templateContext === 'object' ? templateContext : {};
    const contract = ctx?.contract && typeof ctx.contract === 'object' ? ctx.contract : {};
    const requiredGates = new Set(
      (Array.isArray(ctx?.requiredEvidence) ? ctx.requiredEvidence : Array.isArray(contract?.requiredGates) ? contract.requiredGates : [])
        .map((v) => String(v || '').trim())
        .filter(Boolean)
    );
    const allowedSubsystems = Array.isArray(requestScope?.allowedSubsystems) ? requestScope.allowedSubsystems : [];
    const templateId = String(ctx?.templateId || contract?.id || '').trim();
    if (!templateId) return findings;

    // Only run matchmaking checks for templates that declare multiplayer/matchmaking capability.
    // Templates without these capabilities (e.g. flow-line-v1) must never trigger mp-* rules.
    const templateCaps = Array.isArray(contract?.capabilities) ? contract.capabilities : [];
    const templateSupportsMultiplayer = templateCaps.length === 0 ||
      templateCaps.includes('multiplayer') || templateCaps.includes('matchmaking');
    const shouldCheckMatchmaking =
      String(gatePhase || '') !== 'auth_preflight' &&
      templateSupportsMultiplayer &&
      (
        profiles.includes('multiplayer') ||
        requiredGates.has('runtime.matchmaking_pass') ||
        allowedSubsystems.includes('platform-core.matchmaking')
      );

    if (shouldCheckMatchmaking) {
      const configuredHooks = Array.isArray(contract?.compliancePaths?.matchmakingHooks)
        ? contract.compliancePaths.matchmakingHooks
        : [];
      const hookCandidates = configuredHooks.length ? configuredHooks : ['src/hooks/useMultiplayer.js'];
      const multiplayerHook = this._getFirstMatchingFilePayload(files, hookCandidates);
      const hookLabel = multiplayerHook?.relPath || hookCandidates[0] || 'src/hooks/useMultiplayer.js';
      if (!multiplayerHook) {
        findings.push({
          ruleId: 'template-matchmaking-hook-missing',
          severity: 'critical',
          message: `Template multiplayer hook is missing: ${hookLabel}.`,
          detail: 'Expected template-owned matchmaking hook was not found in workspace source.'
        });
        return findings;
      }

      // Fast gate only checks unambiguous structural presence, not semantic patterns.
      // Semantic checks (room discovery order, variable naming, null guards) belong in the Reviewer.
      const text = String(multiplayerHook.text || '');
      const setActorGuardRe = /typeof\s+\w+\.setActor\s*(?:={2,3}|!={1,2})\s*['"']function['"']|\w+\.setActor\?\./m;
      if (!setActorGuardRe.test(text)) {
        findings.push({
          ruleId: 'mp-setactor-capability-guard',
          severity: 'high',
          message: 'Matchmaking actor assignment must use a capability guard.',
          detail: `Expected guarded setActor usage is missing from ${hookLabel}.`
        });
      }
    }

    // World bootstrap: only verify startup file exists — launch pattern varies by template.
    const startupCandidates = Array.isArray(contract?.compliancePaths?.startupFiles)
      ? contract.compliancePaths.startupFiles
      : [];
    if (startupCandidates.length) {
      const startupFile = this._getFirstMatchingFilePayload(files, startupCandidates);
      if (!startupFile || !String(startupFile.text || '').trim()) {
        findings.push({
          ruleId: 'template-world-bootstrap-missing',
          severity: 'critical',
          message: 'Template startup file is missing or empty.',
          detail: `Expected startup file not found: ${startupCandidates[0]}`
        });
      }
    }

    if (templateId === 'flow-line-v1') {
      const validateFlowLineConfig = (filePayload, relPath) => {
        if (!filePayload) {
          findings.push({
            ruleId: 'flowline-config-missing',
            severity: 'critical',
            message: `Required PlayCanvas config is missing: ${relPath}.`,
            detail: 'Flow Line must keep a full PlayCanvas config.json; replacing it with an App ID stub breaks app.configure().'
          });
          return;
        }

        let parsed = null;
        try {
          parsed = JSON.parse(String(filePayload.text || ''));
        } catch {
          findings.push({
            ruleId: 'flowline-config-invalid-json',
            severity: 'critical',
            message: `PlayCanvas config is not valid JSON: ${relPath}.`,
            detail: 'Flow Line config.json must remain parseable PlayCanvas configuration JSON.'
          });
          return;
        }

        const appProps = parsed?.application_properties;
        const hasCoreShape =
          appProps &&
          typeof appProps === 'object' &&
          Number.isFinite(Number(appProps.maxAssetRetries)) &&
          Array.isArray(parsed?.scenes) &&
          parsed?.assets &&
          typeof parsed.assets === 'object';

        if (!hasCoreShape) {
          findings.push({
            ruleId: 'flowline-config-shape-invalid',
            severity: 'critical',
            message: `PlayCanvas config shape is invalid in ${relPath}.`,
            detail: 'Expected application_properties.maxAssetRetries, scenes[], and assets{} to exist. This template must not replace config.json with a VITE/VIVERSE App ID stub.'
          });
        }
      };

      // Only enforce config.json shape at publish time (after dist/ is built).
      // During coding/fixing phases the root config.json may have extra App-ID fields
      // temporarily injected by the coder; this is recoverable and not a hard block.
      if (String(gatePhase || '').toLowerCase() === 'publish') {
        validateFlowLineConfig(this._getFirstMatchingFilePayload(files, ['config.json']), 'config.json');
        validateFlowLineConfig(this._getFirstMatchingFilePayload(files, ['dist/config.json']), 'dist/config.json');
      }
    }

    findings.push(
      ...this._runLambdaEventContractChecks({
        files,
        templateContext
      })
    );

    return findings;
  }


  // ── Persisted file index cache (2.0) ──────────────────────────────
  // Saves/loads the fileIndex (mtime+size+text per file) to .compliance_cache.json
  // so it survives server restarts. Without this, every new run re-reads all files.
  async _loadPersistedFileIndex(workspacePath) {
    try {
      const raw = await fs.readFile(
        path.join(workspacePath, '.compliance_cache.json'), 'utf8'
      );
      return JSON.parse(raw)?.fileIndex || null;
    } catch { return null; }
  }

  async _savePersistedFileIndex(workspacePath, fileIndex) {
    try {
      await fs.writeFile(
        path.join(workspacePath, '.compliance_cache.json'),
        JSON.stringify({ fileIndex, savedAt: new Date().toISOString() }),
        'utf8'
      );
    } catch { /* non-fatal — cache miss on next run is acceptable */ }
  }

  async runFastGate({
    workspacePath,
    taskPrompt = '',
    profileHints = [],
    gatePhase = '',
    cache = {},
    templateContext = null,
    requestScope = null
  }) {
    if (!workspacePath) {
      return { status: 'skip', reason: 'no workspacePath', findings: [], profiles: [] };
    }

    // Load persisted file index if in-memory cache doesn't have it (2.0)
    if (workspacePath && !cache?.fileIndex) {
      const persistedIndex = await this._loadPersistedFileIndex(workspacePath);
      if (persistedIndex) cache = { ...cache, fileIndex: persistedIndex };
    }

    const templateContract = templateContext?.contract && typeof templateContext.contract === 'object'
      ? templateContext.contract
      : {};

    let profiles;
    if (profileHints.length) {
      profiles = [...new Set(profileHints)];
    } else {
      const inferred = this.inferProfiles(taskPrompt);
      // When inferring profiles from task prompt, filter by template capabilities to prevent
      // mp-* rules from firing on non-multiplayer templates whose fix prompts mention "matchmaking"
      // in the SCOPED FIX EXECUTION section added by the orchestrator.
      const caps = Array.isArray(templateContract?.capabilities) ? templateContract.capabilities : null;
      if (caps !== null && caps.length > 0) {
        const supported = new Set();
        if (caps.some(c => c === 'auth' || c === 'leaderboard')) supported.add('auth');
        if (caps.includes('publish')) supported.add('publishing');
        if (caps.includes('multiplayer')) supported.add('multiplayer');
        profiles = supported.size ? inferred.filter(p => supported.has(p)) : inferred;
      } else {
        profiles = inferred;
      }
    }
    if (!profiles.length) {
      return { status: 'skip', reason: 'no matching profile', findings: [], profiles: [] };
    }
    const appIdPropagation = templateContract?.appIdPropagation && typeof templateContract.appIdPropagation === 'object'
      ? templateContract.appIdPropagation
      : {};
    const propagationStrategy = String(appIdPropagation.strategy || '').trim().toLowerCase();
    const skipGenericPublishAppIdRules = propagationStrategy === 'runtime-config-or-hostname';

    const allRules = await this._loadRules();
    const _buildType = String(
      templateContract?.buildConfig?.type ||
      templateContract?.raw?.buildConfig?.type ||
      ''
    ).toLowerCase();
    const activeRules = allRules.filter((r) => {
      const ruleId = String(r?.id || '').trim();
      if (
        skipGenericPublishAppIdRules &&
        [
          'publish-app-id-configured',
          'publish-app-id-needs-digit',
          'publish-source-app-id-reference',
          'publish-no-placeholder-appid'
        ].includes(ruleId)
      ) {
        return false;
      }
      // Skip rules tagged skipIfBuildType when the template matches
      const skipBuildType = String(r?.skipIfBuildType || '').toLowerCase();
      if (skipBuildType && _buildType && skipBuildType === _buildType) return false;

      const tags = Array.isArray(r?.profiles) ? r.profiles : [];
      const profilePass = tags.some((p) => profiles.includes(String(p)));
      if (!profilePass) return false;

      const phases = Array.isArray(r?.phases) ? r.phases.map((p) => String(p)) : [];
      if (!gatePhase || !phases.length) return true;
      return phases.includes(String(gatePhase));
    });

    if (!activeRules.length) {
      return { status: 'skip', reason: 'no active rules', findings: [], profiles };
    }

    const { files: _rawFiles, nextIndex } = await this._readTextFilesIncremental(workspacePath, cache);
    // High-risk (formerly "immutable") paths are now advisory — files CAN be modified.
    // All files are scanned uniformly for both required and forbidden pattern checks.
    // We still track the set for observability but no longer exclude from scans.
    const _highRiskBasenames = new Set(
      Array.isArray(templateContract?.immutablePaths)
        ? templateContract.immutablePaths.map(p => path.basename(String(p || '')))
        : []
    );
    // Use full file list for all rules — no exclusion
    const files = _rawFiles;
    const snapshotKey = this._buildSnapshotKey(files, profiles);
    if (cache?.lastSnapshotKey === snapshotKey && cache?.lastResult) {
      return { ...cache.lastResult, cacheHit: true };
    }

    const _corpusFull    = files.map((f) => `\n// FILE:${f.relPath}\n${f.text}`).join('\n');
    const findings = [];

    for (const rule of activeRules) {
      // All rules now scan all files uniformly (high-risk files are advisory, not excluded)
      const _ruleFiles  = files;
      const _ruleCorpus = _corpusFull;
      const check = this._checkRule(rule, _ruleFiles, _ruleCorpus);
      if (!check.pass) {
        findings.push({
          ruleId: rule.id || 'unnamed-rule',
          severity: rule.severity || 'high',
          message: rule.message || check.detail,
          detail: check.detail
        });
      }
    }

    findings.push(
      ...this._runTemplateStaticChecks({
        files,
        templateContext,
        profiles,
        gatePhase,
        requestScope
      })
    );

    const status = findings.length ? 'fail' : 'pass';
    const result = {
      status,
      findings,
      profiles,
      checkedRules: activeRules.length,
      scannedFiles: files.length,
      cacheHit: false
    };

    const finalResult = {
      ...result,
      _snapshotKey: snapshotKey,
      _nextCache: {
        lastSnapshotKey: snapshotKey,
        lastResult: {
          status: result.status,
          findings: result.findings,
          profiles: result.profiles,
          checkedRules: result.checkedRules,
          scannedFiles: result.scannedFiles
        },
        fileIndex: nextIndex
      }
    };

    // Persist fileIndex to disk so the next server restart skips re-reading (2.0)
    if (workspacePath && nextIndex) {
      this._savePersistedFileIndex(workspacePath, nextIndex); // fire-and-forget
    }

    return finalResult;
  }

  async verifyAppIdPropagation({
    workspacePath,
    expectedAppId = '',
    sourceFiles = [],
    templateContext = null
  }) {
    const templateContract = templateContext?.contract && typeof templateContext.contract === 'object'
      ? templateContext.contract
      : {};
    const appIdPropagation = templateContract?.appIdPropagation && typeof templateContract.appIdPropagation === 'object'
      ? templateContract.appIdPropagation
      : {};
    const propagationStrategy = String(appIdPropagation.strategy || '').trim().toLowerCase();
    const approvedConfigFiles = new Set(
      Array.isArray(appIdPropagation.approvedConfigFiles)
        ? appIdPropagation.approvedConfigFiles
          .map((entry) => String(entry || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase().trim())
          .filter(Boolean)
        : []
    );

    const result = {
      status: 'fail',
      expected_app_id: String(expectedAppId || '').trim().toLowerCase(),
      env_app_id: '',
      source_uses_env_client_id: false,
      dist_mentions_expected: false,
      source_env_ref_files: [],
      source_hardcoded_app_id_files: [],
      dist_match_files: [],
      source_placeholder_files: [],
      dist_placeholder_files: [],
      reasons: []
    };

    if (!workspacePath) {
      result.reasons.push('workspace path missing');
      return result;
    }

    const expected = result.expected_app_id;
    if (!/^[a-z0-9]{10}$/i.test(expected)) {
      result.reasons.push('expected app id is missing or invalid (must be 10 lowercase alnum chars)');
      return result;
    }

    const envPath = path.join(workspacePath, '.env');
    let envText = '';
    let configSource = '.env';
    try {
      envText = await fs.readFile(envPath, 'utf8');
    } catch {
      // ignore; template-mode runs may intentionally use config fallback instead
    }

    if (envText) {
      const match = envText.match(/(^|\n)\s*VITE_VIVERSE_CLIENT_ID\s*=\s*([a-z0-9]{10})\s*($|\n)/i);
      if (match && match[2]) {
        result.env_app_id = String(match[2]).toLowerCase();
      }
    }

    if (!result.env_app_id) {
      const fallback = await this._readConfiguredAppIdFallback(workspacePath);
      if (fallback.appId) {
        result.env_app_id = fallback.appId;
        configSource = fallback.source;
      }
    }

    if (!result.env_app_id && propagationStrategy === 'runtime-config-or-hostname') {
      for (const relPath of approvedConfigFiles) {
        try {
          const raw = await fs.readFile(path.join(workspacePath, relPath), 'utf8');
          const appId = this._extractCanonicalAppId(raw);
          if (/^[a-z0-9]{10}$/i.test(appId)) {
            result.env_app_id = String(appId).toLowerCase();
            configSource = relPath;
            break;
          }
        } catch {
          // ignore
        }
      }
    }

    if (!result.env_app_id) {
      result.reasons.push('no valid VITE_VIVERSE_CLIENT_ID found in .env or approved fallback config');
    }

    if (result.env_app_id && result.env_app_id !== expected) {
      result.reasons.push(`${configSource} app id mismatch (expected ${expected}, got ${result.env_app_id})`);
    }

    const allSourceFiles = sourceFiles.length
      ? sourceFiles
      : await this._listFilesRecursive(workspacePath);

    const sourceFilesWithText = [];
    for (const file of allSourceFiles) {
      const rel = path.relative(workspacePath, file).replace(/\\/g, '/');
      if (
        rel.startsWith('node_modules/') ||
        rel.startsWith('dist/') ||
        rel.startsWith('publish_dist/') ||
        rel.startsWith('build_final/') ||
        rel.startsWith('.git/')
      ) continue;
      try {
        const txt = await fs.readFile(file, 'utf8');
        sourceFilesWithText.push({ rel, txt });
      } catch {
        // ignore unreadable source files
      }
    }

    for (const { rel, txt } of sourceFilesWithText) {
      const normalizedRel = String(rel || '').replace(/\\/g, '/').toLowerCase();
      if (/import\.meta\.env\.VITE_VIVERSE_CLIENT_ID|process\.env\.VITE_VIVERSE_CLIENT_ID/.test(txt)) {
        result.source_env_ref_files.push(rel);
        continue;
      }
      if (
        propagationStrategy === 'runtime-config-or-hostname' &&
        approvedConfigFiles.has(normalizedRel) &&
        (
          /window\.__tankarena_config__/i.test(txt) ||
          /window\.location\.hostname\.match\(HOSTNAME_APP_ID_PATTERN\)/.test(txt) ||
          /HOSTNAME_APP_ID_PATTERN/.test(txt)
        )
      ) {
        result.source_env_ref_files.push(rel);
      }
    }
    result.source_uses_env_client_id = result.source_env_ref_files.length > 0;
    if (!result.source_uses_env_client_id) {
      if (propagationStrategy === 'runtime-config-or-hostname') {
        result.reasons.push('source does not reference approved runtime App ID config or hostname fallback');
      } else {
        result.reasons.push('source does not reference VITE_VIVERSE_CLIENT_ID via env (import.meta.env/process.env)');
      }
    }

    for (const { rel, txt } of sourceFilesWithText) {
      const normalizedRel = String(rel || '').replace(/\\/g, '/').toLowerCase();
      if (
        txt.includes(expected) &&
        !/\.env(\.|$)/i.test(rel) &&
        !/vite\.config\.(js|ts|mjs|cjs)$/i.test(rel) &&
        !/^CONTRACT\.json$/i.test(rel) &&
        !(propagationStrategy === 'runtime-config-or-hostname' && approvedConfigFiles.has(normalizedRel))
      ) {
        result.source_hardcoded_app_id_files.push(rel);
      }
    }
    // For runtime-config-or-hostname templates, app ID in editable source files is expected
    // (coder puts real ID in auth/config files). Only flag if dist does NOT contain the ID.
    if (result.source_hardcoded_app_id_files.length > 0 && propagationStrategy !== 'runtime-config-or-hostname') {
      result.reasons.push(`source contains hardcoded app id literal (${result.source_hardcoded_app_id_files.slice(0, 6).join(', ')})`);
    }

    for (const { rel, txt } of sourceFilesWithText) {
      if (/YOUR_APP_ID/i.test(txt) && !/(^|\/)(\.env\.example|CONTRACT\.json|\.compliance_cache\.json)$/i.test(rel)) {
        result.source_placeholder_files.push(rel);
      }
    }
    if (result.source_placeholder_files.length > 0) {
      result.reasons.push(`source still contains placeholder YOUR_APP_ID (${result.source_placeholder_files.slice(0, 6).join(', ')})`);
    }

    const distPath = path.join(workspacePath, 'dist');
    let distFiles = [];
    try {
      const distStat = await fs.stat(distPath);
      if (!distStat.isDirectory()) {
        result.reasons.push('dist missing');
      } else {
        distFiles = await this._listDistFilesRecursive(distPath);
      }
    } catch {
      result.reasons.push('dist missing');
    }

    for (const file of distFiles) {
      try {
        const txt = await fs.readFile(file, 'utf8');
        if (txt.includes(expected)) {
          result.dist_match_files.push(path.relative(workspacePath, file).replace(/\\/g, '/'));
        }
      } catch {
        // ignore unreadable dist files
      }
    }

    result.dist_mentions_expected = result.dist_match_files.length > 0;
    if (!result.dist_mentions_expected) {
      result.reasons.push('expected app id not found in dist artifacts');
    }

    for (const file of distFiles) {
      try {
        const txt = await fs.readFile(file, 'utf8');
        if (/YOUR_APP_ID/i.test(txt)) {
          result.dist_placeholder_files.push(path.relative(workspacePath, file).replace(/\\/g, '/'));
        }
      } catch {
        // ignore unreadable dist files
      }
    }
    const tolerateRuntimeConfigDistPlaceholder =
      propagationStrategy === 'runtime-config-or-hostname' &&
      result.dist_mentions_expected &&
      result.source_hardcoded_app_id_files.length === 0 &&
      result.source_uses_env_client_id;

    if (result.dist_placeholder_files.length > 0 && !tolerateRuntimeConfigDistPlaceholder) {
      result.reasons.push(`dist still contains placeholder YOUR_APP_ID (${result.dist_placeholder_files.slice(0, 6).join(', ')})`);
    }

    // For runtime-config-or-hostname: dist has the real ID + no placeholder = pass.
    // This covers templates where the approved config resolves ID at runtime (not in .env).
    if (propagationStrategy === 'runtime-config-or-hostname' &&
        result.dist_mentions_expected &&
        result.dist_placeholder_files.length === 0 &&
        result.source_placeholder_files.length === 0) {
      result.reasons = result.reasons.filter(r =>
        !r.includes('no valid VITE_VIVERSE_CLIENT_ID') &&
        !r.includes('source does not reference approved runtime') &&
        !r.includes('source contains hardcoded app id')
      );
    }

    if (result.reasons.length === 0) {
      result.status = 'pass';
    }

    return result;
  }
}

export default new ComplianceService();
