import fs from 'fs/promises';
import path from 'path';
import logger from '../../utils/logger.js';

class TemplateContractService {
  _normalizeCompliancePaths(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const normalizeList = (value = []) => (
      Array.isArray(value)
        ? value.map((entry) => String(entry || '').replace(/\\/g, '/').replace(/^\.\//, '').trim()).filter(Boolean)
        : []
    );

    return {
      authFiles: normalizeList(source.authFiles),
      matchmakingHooks: normalizeList(source.matchmakingHooks),
      startupFiles: normalizeList(source.startupFiles)
    };
  }

  _normalizeBuildConfig(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      required: source.required === false ? false : (source.required === true ? true : null),
      type: String(source.type || '').trim() || null,
      command: String(source.command || '').trim() || null,
      outputDir: String(source.outputDir || '').replace(/\\/g, '/').replace(/^\.\//, '').trim(),
      entryHtml: String(source.entryHtml || '').replace(/\\/g, '/').replace(/^\.\//, '').trim(),
      publishSource: String(source.publishSource || '').replace(/\\/g, '/').replace(/^\.\//, '').trim() || null
    };
  }

  _normalizeAppIdPropagation(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const normalizeList = (value = []) => (
      Array.isArray(value)
        ? value.map((entry) => String(entry || '').replace(/\\/g, '/').replace(/^\.\//, '').trim()).filter(Boolean)
        : []
    );

    return {
      strategy: String(source.strategy || '').trim(),
      approvedConfigFiles: normalizeList(source.approvedConfigFiles)
    };
  }

  _normalizeAuthPreflightMode(value = '') {
    const mode = String(value || '').trim().toLowerCase();
    return mode || 'default';
  }

  inferSubsystemForPath(relPath = '', contract = null) {
    const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase();
    if (!rel) return 'general';
    const compliancePaths = contract?.compliancePaths && typeof contract.compliancePaths === 'object'
      ? contract.compliancePaths
      : {};
    if (Array.isArray(compliancePaths.authFiles) && compliancePaths.authFiles.some((entry) => String(entry || '').toLowerCase() === rel)) {
      return 'platform-core.auth';
    }
    if (Array.isArray(compliancePaths.matchmakingHooks) && compliancePaths.matchmakingHooks.some((entry) => String(entry || '').toLowerCase() === rel)) {
      return 'platform-core.matchmaking';
    }
    if (Array.isArray(compliancePaths.startupFiles) && compliancePaths.startupFiles.some((entry) => String(entry || '').toLowerCase() === rel)) {
      return 'platform-core.bootstrap';
    }
    if (rel === 'contract.json') return 'workflow-artifact';
    if (/^artifacts\/|^reports\/|^logs\/|\.log$/i.test(rel)) return 'diagnostics';
    if (/^(dist|build_final)\//.test(rel) || /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.env(\.production)?|vercel\.json)$/i.test(rel)) {
      return 'publish';
    }
    if (/^vite\.config\.(js|cjs|mjs|ts)$/.test(rel)) {
      return 'platform-core.auth';
    }
    if (/^bootstrap\/viverseconfig\./.test(rel)) {
      return 'platform-core.auth';
    }
    if (/^bootstrap\/viversediagnostic\./.test(rel)) {
      return 'diagnostics';
    }
    if (/^bootstrap\/main\./.test(rel) || /^bootstrap\/index\.html$/.test(rel) || /^bootstrap\/upstream-src\/main\./.test(rel)) {
      return 'platform-core.bootstrap';
    }
    if (/^public\/|^assets\/|^src\/assets\/|^src\/styles\/|^src\/components\/|^src\/ui\//.test(rel)) {
      return 'ui';
    }
    if (/^src\/hooks\/useviverseauth\./.test(rel) || /^src\/hooks\/.*auth/i.test(rel)) {
      return 'platform-core.auth';
    }
    if (/^adapters\/auth\//.test(rel) || /^gameplay\/hooks\/.*auth/i.test(rel)) {
      return 'platform-core.auth';
    }
    if (/^src\/hooks\/usemultiplayer\./.test(rel) || /^src\/hooks\/.*room/i.test(rel) || /^src\/.*matchmaking/i.test(rel) || /^src\/network\//.test(rel)) {
      return 'platform-core.matchmaking';
    }
    if (/^adapters\/multiplayer\//.test(rel) || /^bootstrap\/hooks\/usemultiplayer\./.test(rel) || /^gameplay\/hooks\/usemultiplayer\./.test(rel)) {
      return 'platform-core.matchmaking';
    }
    if (/^src\/game\/|^src\/constants\/|^src\/hooks\/usesingleplayergame\./.test(rel) || /^src\/hooks\/usepokergame\./.test(rel) || /^src\/hooks\/usememory/i.test(rel)) {
      return 'gameplay';
    }
    if (Array.isArray(contract?.injectionHooks)) {
      const hookLocations = contract.injectionHooks
        .map((hook) => String(hook?.location || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase())
        .filter(Boolean);
      if (hookLocations.some((location) => rel === location || rel.startsWith(`${location}/`))) {
        return 'gameplay';
      }
    }
    if (/^src\//.test(rel)) return 'gameplay';
    return 'general';
  }

  _normalizeContract(raw = {}, templateRoot = '') {
    const editablePaths = Array.isArray(raw.editablePaths) ? raw.editablePaths.map((v) => String(v)) : [];
    if (!editablePaths.includes('CONTRACT.json')) {
      editablePaths.unshift('CONTRACT.json');
    }

    return {
      id: String(raw.id || ''),
      version: String(raw.version || '0.0.0'),
      upstream: String(raw.upstream || ''),
      capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map((v) => String(v)) : [],
      immutablePaths: Array.isArray(raw.immutablePaths) ? raw.immutablePaths.map((v) => String(v)) : [],
      editablePaths,
      injectionHooks: Array.isArray(raw.injectionHooks) ? raw.injectionHooks : [],
      requiredGates: Array.isArray(raw.requiredGates) ? raw.requiredGates.map((v) => String(v)) : [],
      compliancePaths: this._normalizeCompliancePaths(raw.compliancePaths),
      buildConfig: this._normalizeBuildConfig(raw.buildConfig),
      appIdPropagation: this._normalizeAppIdPropagation(raw.appIdPropagation),
      authPreflightMode: this._normalizeAuthPreflightMode(raw.authPreflightMode),
      rulesetSchemaRef: String(raw.rulesetSchemaRef || ''),
      scenarioSchemaRef: String(raw.scenarioSchemaRef || ''),
      templateRoot,
      raw
    };
  }

  async loadTemplateContract(templatePath) {
    const root = path.resolve(String(templatePath || '').trim());
    const jsonPath = path.join(root, 'template.json');
    const mdPath = path.join(root, 'TEMPLATE.md');

    try {
      const [jsonText, mdText] = await Promise.all([
        fs.readFile(jsonPath, 'utf8'),
        fs.readFile(mdPath, 'utf8').catch(() => '')
      ]);
      const parsed = JSON.parse(jsonText);
      return {
        contract: this._normalizeContract(parsed, root),
        templateMarkdown: mdText,
        files: { jsonPath, mdPath }
      };
    } catch (error) {
      logger.warn(`TemplateContractService: failed to load contract from ${root}: ${error.message}`);
      return null;
    }
  }
}

export default new TemplateContractService();
