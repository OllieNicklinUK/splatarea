import fs from 'fs/promises';
import path from 'path';

const repoRoot = process.cwd();
const workspacesRoot = path.join(repoRoot, '.viverse_workspaces');

function buildFallbackContract(state = {}, workspaceName = '') {
  return {
    schemaVersion: '1.0',
    generatedBy: 'scripts/backfill-completed-contracts',
    generatedAt: new Date().toISOString(),
    sourceWorkspace: workspaceName,
    request: String(state?.request || ''),
    summary: String(state?.projectContextSummary || '').slice(0, 4000),
    integrationContracts: {
      appIdAuthority: String(state?.runtimeFlags?.appIdAuthority?.value || ''),
      templateId: String(state?.templateContext?.templateId || ''),
      requiredRuntimeChecks: ['auth_profile', 'matchmaking']
    }
  };
}

async function main() {
  const dirents = await fs.readdir(workspacesRoot, { withFileTypes: true }).catch(() => []);
  const workspaces = dirents.filter((entry) => entry.isDirectory() && entry.name.startsWith('req_'));
  const updated = [];

  for (const entry of workspaces) {
    const workspacePath = path.join(workspacesRoot, entry.name);
    const statePath = path.join(workspacePath, '.agent_state.json');
    const contractPath = path.join(workspacePath, 'CONTRACT.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8').catch(() => 'null'));
    if (!state || String(state.status || '').toLowerCase() !== 'completed') continue;

    const hasContract = await fs.stat(contractPath).then((stat) => stat.isFile()).catch(() => false);
    if (hasContract) continue;

    const payload = buildFallbackContract(state, entry.name);
    await fs.writeFile(contractPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    updated.push(entry.name);
  }

  console.log(JSON.stringify({ updatedCount: updated.length, updated }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
