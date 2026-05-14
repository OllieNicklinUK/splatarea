#!/usr/bin/env node
/**
 * watch-workspace.mjs
 * Polls .agent_state.json for a workspace and prints a live one-line status.
 * Zero LLM cost — reads local filesystem only.
 * On paused_or_failed, fires ONE sequential resume and waits for it to drain
 * before polling again. Never races concurrent resume calls.
 *
 * Usage:
 *   node scripts/watch-workspace.mjs                          # auto-picks newest req_* workspace
 *   node scripts/watch-workspace.mjs req_1776659378788        # specific workspace id
 *   node scripts/watch-workspace.mjs req_1776659378788 --interval 20
 *   node scripts/watch-workspace.mjs --auto-resume            # POST continue when paused (uses env creds)
 *   node scripts/watch-workspace.mjs --auto-resume --max-resumes 5
 *
 * Env (for --auto-resume):
 *   VIVERSE_TEST_EMAIL
 *   VIVERSE_TEST_PASSWORD
 *   AGENT_BASE_URL  (default: http://127.0.0.1:3000)
 */

import fs from 'fs/promises';
import path from 'path';

const repoRoot   = process.cwd();
const wsRoot     = path.join(repoRoot, '.viverse_workspaces');
const baseUrl    = process.env.AGENT_BASE_URL || 'http://127.0.0.1:3000';
const args       = process.argv.slice(2);

const wsArg      = args.find(a => a.startsWith('req_'));
const intervalIdx = args.indexOf('--interval');
const safeInterval = intervalIdx >= 0 ? Math.max(10, Number(args[intervalIdx + 1]) || 20) * 1000 : 20000;
const autoResume = args.includes('--auto-resume');
const maxResumesIdx = args.indexOf('--max-resumes');
const maxResumes = maxResumesIdx >= 0 ? Math.max(1, Number(args[maxResumesIdx + 1]) || 3) : 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().slice(11, 19);
}

function pad(str, n) {
  return String(str || '').padEnd(n).slice(0, n);
}

async function findNewestWorkspace() {
  const entries = await fs.readdir(wsRoot, { withFileTypes: true });
  const dirs = entries
    .filter(e => e.isDirectory() && e.name.startsWith('req_'))
    .map(e => e.name)
    .sort();
  return dirs.length ? path.join(wsRoot, dirs[dirs.length - 1]) : null;
}

async function readState(wsPath) {
  const raw = await fs.readFile(path.join(wsPath, '.agent_state.json'), 'utf8');
  return JSON.parse(raw);
}

function summarise(state) {
  const tasks     = Array.isArray(state.tasks) ? state.tasks : [];
  const done      = tasks.filter(t => t.status === 'completed').length;
  const pending   = tasks.filter(t => t.status === 'pending').map(t => t.id);
  const failed    = tasks.filter(t => t.status === 'failed').map(t => t.id);
  const blocked   = tasks.filter(t => t.status === 'blocked').map(t => t.id);

  const appId   = state.runtimeFlags?.appIdAuthority?.value || '—';
  const preview = state.finalOutcome?.previewUrl ||
    (() => {
      const m = (state.projectContextSummary || '').match(/https:\/\/worlds\.viverse\.com\/[A-Za-z0-9]+\?preview/);
      return m?.[0] || '—';
    })();

  const ledger   = state.verificationLedger || [];
  const lastGate = [...ledger].reverse().find(e =>
    e.type === 'fast_compliance_gate' || e.type === 'verifier' || e.type === 'preview_probe' || e.type === 'reviewer'
  );
  const gateStr = lastGate ? `${lastGate.type}:${lastGate.status}` : '—';

  return { done, pending, failed, blocked, appId, preview, gateStr,
           status: state.status, stage: state.currentStage };
}

// Fires ONE resume call and fully drains the SSE stream before returning.
// This is intentionally blocking — we never fire concurrent resumes.
async function postResume(reqId, email, password) {
  const res = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `proceed with ${reqId} — execute all pending tasks including the verifier`,
      history: [],
      stream: true,
      credentials: { email, password }
    })
  });
  if (!res.ok) return false;
  // Drain the full SSE stream — this blocks until the agent finishes the task
  const reader = res.body?.getReader();
  if (!reader) return true;
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch { /* ignore stream errors */ }
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let wsPath;
  if (wsArg) {
    wsPath = path.join(wsRoot, wsArg);
  } else {
    wsPath = await findNewestWorkspace();
    if (!wsPath) { console.error('No workspaces found.'); process.exit(1); }
  }

  const reqId = path.basename(wsPath);
  console.log(`\n📡 Watching workspace: ${reqId}`);
  console.log(`   interval: ${safeInterval / 1000}s | auto-resume: ${autoResume} | max-resumes: ${maxResumes}\n`);
  console.log('TIME     | STATUS             | STAGE              | DONE | PENDING / ISSUE                    | GATE');
  console.log('─'.repeat(105));

  let resumeCount = 0;

  while (true) {
    let state;
    try {
      state = await readState(wsPath);
    } catch {
      console.log(`${ts()} | state unreadable — workspace may still be initialising`);
      await new Promise(r => setTimeout(r, safeInterval));
      continue;
    }

    const s = summarise(state);
    const pendingStr = s.pending.length
      ? s.pending.slice(0, 2).join(',') + (s.pending.length > 2 ? `+${s.pending.length - 2}` : '')
      : s.failed.length  ? `FAILED:${s.failed[0]}`
      : s.blocked.length ? `BLOCKED:${s.blocked[0]}`
      : '—';

    console.log(
      `${ts()} | ${pad(s.status, 18)} | ${pad(s.stage, 18)} | ${String(s.done).padStart(4)} | ${pad(pendingStr, 34)} | ${s.gateStr}`
    );

    // ── Terminal: completed ──
    if (s.status === 'completed') {
      console.log('\n✅ COMPLETED');
      console.log(`   App ID:  ${s.appId}`);
      console.log(`   Preview: ${s.preview}`);
      if (s.preview !== '—') {
        try {
          const r = await fetch(s.preview, { method: 'HEAD' });
          console.log(`   HTTP:    ${r.status} ${r.ok ? '✅ reachable' : '❌ not reachable'}`);
        } catch { console.log('   HTTP:    ❌ fetch failed'); }
      }
      process.exit(0);
    }

    // ── paused_or_failed: attempt ONE sequential resume ──
    if (s.status === 'paused_or_failed') {
      if (!autoResume) {
        console.log('\n❌ PAUSED / FAILED — run with --auto-resume to retry automatically.');
        console.log(`   Last gate: ${s.gateStr}`);
        console.log(`   App ID:    ${s.appId}`);
        process.exit(1);
      }

      if (resumeCount >= maxResumes) {
        console.log(`\n❌ Max resumes (${maxResumes}) exhausted.`);
        console.log(`   Last gate: ${s.gateStr}`);
        console.log(`   App ID:    ${s.appId}`);
        process.exit(1);
      }

      const email    = process.env.VIVERSE_TEST_EMAIL;
      const password = process.env.VIVERSE_TEST_PASSWORD;
      if (!email || !password) {
        console.log('\n⚠️  --auto-resume requires VIVERSE_TEST_EMAIL + VIVERSE_TEST_PASSWORD env vars.');
        process.exit(1);
      }

      resumeCount++;
      console.log(`\n🔄 auto-resuming (${resumeCount}/${maxResumes}) — draining full agent stream...`);
      const ok = await postResume(reqId, email, password);
      console.log(`   stream drained: ${ok ? '✅' : '❌ POST failed'}\n`);
      // Wait one full interval before polling — gives the agent time to write state
      await new Promise(r => setTimeout(r, safeInterval));
      continue;
    }

    // ── In progress: wait then poll ──
    await new Promise(r => setTimeout(r, safeInterval));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
