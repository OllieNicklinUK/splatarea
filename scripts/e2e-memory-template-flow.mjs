import fs from 'fs/promises';
import path from 'path';

const baseUrl = process.env.AGENT_BASE_URL || 'http://127.0.0.1:3010';
const repoRoot = process.cwd();
const requestMessage = process.env.E2E_MEMORY_REQUEST ||
  "Build a simple single-player memory matching card game using the redpointfish-v1 template. Keep the template auth/runtime foundation intact and implement the game logic, UI, and score tracking inside allowed extension points.";
const testEmail = process.env.VIVERSE_TEST_EMAIL || '';
const testPassword = process.env.VIVERSE_TEST_PASSWORD || '';

function requireTestCredentials() {
  if (testEmail && testPassword) {
    return { email: testEmail, password: testPassword };
  }
  throw new Error(
    'Missing VIVERSE_TEST_EMAIL or VIVERSE_TEST_PASSWORD for e2e-memory-template-flow.mjs'
  );
}

async function postChat(message) {
  const payload = {
    message,
    stream: false,
    history: [],
    credentials: requireTestCredentials()
  };
  const response = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function findNewestWorkspace() {
  const root = path.join(repoRoot, '.viverse_workspaces');
  const dirents = await fs.readdir(root, { withFileTypes: true });
  const names = dirents.filter((entry) => entry.isDirectory() && entry.name.startsWith('req_')).map((entry) => entry.name).sort();
  return names.length ? path.join(root, names[names.length - 1]) : '';
}

async function readState(workspacePath) {
  const statePath = path.join(workspacePath, '.agent_state.json');
  return JSON.parse(await fs.readFile(statePath, 'utf8'));
}

async function waitForSettlement(workspacePath, maxAttempts = 40) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const state = await readState(workspacePath);
    const status = String(state?.status || '').toLowerCase();
    if (status === 'completed' || status === 'paused_or_failed') return state;
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  throw new Error('Timed out waiting for workflow settlement');
}

async function main() {
  await postChat(requestMessage);
  const workspacePath = await findNewestWorkspace();
  if (!workspacePath) throw new Error('No workspace found after request');
  const state = await waitForSettlement(workspacePath);
  const result = {
    workspacePath,
    status: state.status,
    appId: state?.runtimeFlags?.appIdAuthority?.value || '',
    previewUrl: state?.finalOutcome?.previewUrl || '',
    currentStage: state?.currentStage || ''
  };
  console.log(JSON.stringify(result, null, 2));
  if (String(state.status || '').toLowerCase() !== 'completed') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
