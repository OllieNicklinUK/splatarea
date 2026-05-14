import fs from 'fs/promises';
import path from 'path';

class TemplateCertificationService {
  async runStaticGates({ templateRoot, contract }) {
    const results = [];

    results.push({
      gate: 'contract.id',
      status: contract?.id ? 'pass' : 'fail',
      reason: contract?.id ? '' : 'template.json missing id'
    });
    results.push({
      gate: 'contract.immutablePaths',
      status: 'pass',
      reason: Array.isArray(contract?.immutablePaths) && contract.immutablePaths.length > 0
        ? 'immutablePaths present (advisory — high-risk files)'
        : 'immutablePaths empty (no high-risk files declared)'
    });
    results.push({
      gate: 'contract.editablePaths',
      status: Array.isArray(contract?.editablePaths) && contract.editablePaths.length > 0 ? 'pass' : 'fail',
      reason: Array.isArray(contract?.editablePaths) && contract.editablePaths.length > 0 ? '' : 'editablePaths missing'
    });

    const rulesetsDir = path.join(templateRoot, 'rulesets');
    const rulesetFiles = await fs.readdir(rulesetsDir).catch(() => []);
    results.push({
      gate: 'rulesets.exists',
      status: rulesetFiles.length > 0 ? 'pass' : 'fail',
      reason: rulesetFiles.length > 0
        ? ''
        : 'no ruleset files found — add rulesets/default.json (see templates/REQUIRED_STRUCTURE.md and skill: viverse-template-generation)'
    });

    const certification = contract?.certification || contract?.raw?.certification || {};
    const requiredFiles = Array.isArray(certification?.requiredFiles)
      ? certification.requiredFiles
      : [];
    if (requiredFiles.length > 0) {
      const missing = [];
      for (const relPath of requiredFiles) {
        const absPath = path.join(templateRoot, String(relPath || ''));
        try {
          await fs.stat(absPath);
        } catch {
          missing.push(String(relPath || ''));
        }
      }
      results.push({
        gate: 'certification.required_files',
        status: missing.length === 0 ? 'pass' : 'fail',
        reason: missing.length === 0 ? '' : `missing required template files: ${missing.join(', ')}`
      });
    }

    return results;
  }

  async runStaticTemplateAppIdGate(templateDir, contract) {
    // Static templates must have YOUR_APP_ID in each approvedConfigFile so
    // the auth Coder can inject the real App ID generically via sed/seeding.
    const buildType = String(contract?.buildConfig?.type || '').toLowerCase();
    if (buildType !== 'static') return { gate: 'static.appid_placeholder', status: 'skip', reason: 'not a static template' };
    const approvedFiles = Array.isArray(contract?.appIdPropagation?.approvedConfigFiles)
        ? contract.appIdPropagation.approvedConfigFiles : [];
    if (!approvedFiles.length) return { gate: 'static.appid_placeholder', status: 'skip', reason: 'no approvedConfigFiles defined' };
    const missing = [];
    for (const relPath of approvedFiles) {
        const abs = path.join(templateDir, relPath);
        try {
            const txt = await fs.readFile(abs, 'utf8').catch(() => '');
            if (txt && !txt.includes('YOUR_APP_ID')) missing.push(relPath);
        } catch { /* not found in template dir — seeding will handle it */ }
    }
    if (missing.length) return {
        gate: 'static.appid_placeholder',
        status: 'warn',
        reason: `YOUR_APP_ID placeholder not found in template source: ${missing.join(', ')}. Seeding will auto-inject for JSON files; HTML files need manual placeholder.`
    };
    return { gate: 'static.appid_placeholder', status: 'pass' };
  }

  summarize(gates = []) {
    const failed = gates.filter((g) => g.status !== 'pass');
    return {
      pass: failed.length === 0,
      failed,
      gates
    };
  }
}

export default new TemplateCertificationService();
