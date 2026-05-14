import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';

// ──────────────────────────────────────────────────────────────────────
// FixOrchestrationService  (Phase 2 — fix loop improvements)
//
//  A) snapshotWorkspace / recordFixAttempt       (2.2)
//     Cheap mtime+size fingerprint. Detects "Coder ran but wrote nothing".
//
//  B) resolveFixStrategy / recordFixBudgetUsage  (2.4)
//     Per-signature attempt counter → diagnosis_guided → regenerate_component → exhausted
//
//  C) runDiagnosis / buildDiagnosisBlock         (2.1)
//     One cheap LLM call returning root cause + fix strategy before a fix task is created.
//
//  D) buildDeltaVerifierPrompt                   (2.3)
//     Prepends a DELTA VERIFICATION block listing only previously-failed gates.
// ──────────────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
    'node_modules', 'dist', '.git', '.next', 'build',
    'coverage', '.viverse_workspaces', 'artifacts'
]);

const SOURCE_EXTS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.html', '.css', '.json'
]);

// ── A) Workspace snapshot ─────────────────────────────────────────────

async function snapshotWorkspace(workspacePath = '') {
    if (!workspacePath) return '';
    try {
        const parts = [];
        const walk = async (dir) => {
            let entries;
            try { entries = await fs.readdir(dir, { withFileTypes: true }); }
            catch { return; }
            for (const e of entries) {
                const abs = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (!IGNORE_DIRS.has(e.name)) await walk(abs);
                    continue;
                }
                const ext = path.extname(e.name).toLowerCase();
                const isDotEnv = e.name === '.env' || e.name.startsWith('.env.');
                if (!SOURCE_EXTS.has(ext) && !isDotEnv) continue;
                try {
                    const st = await fs.stat(abs);
                    parts.push(`${path.relative(workspacePath, abs)}:${st.size}:${Math.floor(st.mtimeMs)}`);
                } catch { /* skip unreadable */ }
            }
        };
        await walk(workspacePath);
        parts.sort();
        return crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 16);
    } catch (err) {
        logger.warn(`FixOrchestrationService.snapshotWorkspace error: ${err.message}`);
        return '';
    }
}

async function recordFixAttempt(state, { taskId, signature, snapshotBefore, workspacePath }) {
    const snapshotAfter = await snapshotWorkspace(workspacePath);
    state.fixAttemptLedger = Array.isArray(state.fixAttemptLedger) ? state.fixAttemptLedger : [];
    const entry = {
        taskId: String(taskId || ''),
        signature: String(signature || ''),
        snapshotBefore: String(snapshotBefore || ''),
        snapshotAfter,
        noChange: Boolean(snapshotBefore && snapshotBefore === snapshotAfter),
        at: new Date().toISOString()
    };
    state.fixAttemptLedger.push(entry);
    if (state.fixAttemptLedger.length > 50) {
        state.fixAttemptLedger = state.fixAttemptLedger.slice(-50);
    }
    if (entry.noChange) {
        logger.warn(`FixOrchestrationService: fix task ${taskId} made NO file changes (sig: ${signature})`);
    }
    return entry;
}

function lastAttemptForSignature(state, signature) {
    const ledger = Array.isArray(state.fixAttemptLedger) ? state.fixAttemptLedger : [];
    return ledger.slice().reverse()
        .find(a => String(a.signature || '') === String(signature || '')) || null;
}

// ── B) Fix budget + strategy ──────────────────────────────────────────

function resolveFixStrategy(state, signature) {
    const budget = state.fixBudget || {};
    const attempts = Number(budget[String(signature || '')] || 0);
    if (attempts === 0) return { strategy: 'diagnosis_guided', attempt: 1 };
    if (attempts === 1) return { strategy: 'regenerate_component', attempt: 2 };
    return { strategy: 'exhausted', attempt: attempts + 1 };
}

function recordFixBudgetUsage(state, signature) {
    state.fixBudget = state.fixBudget || {};
    const key = String(signature || '');
    state.fixBudget[key] = Number(state.fixBudget[key] || 0) + 1;
}

function buildRegenerateBlock(targetFiles = []) {
    const fileList = targetFiles.filter(Boolean).length
        ? targetFiles.filter(Boolean).map(f => `  - ${f}`).join('\n')
        : '  (identify the root failing file from the evidence above and rewrite it)';
    return `\u26a0\ufe0f  REGENERATION MODE (previous patch attempts failed):\n` +
        `DELETE the following file(s) entirely and rewrite them from scratch.\n` +
        `Do NOT attempt incremental patches \u2014 the existing implementation is broken at a structural level.\n` +
        `Files to regenerate:\n${fileList}\n` +
        `After rewriting, rebuild and verify the specific failing gates only.`;
}

// ── C) Root-cause diagnosis ───────────────────────────────────────────

const DIAGNOSIS_PROMPT_PREFIX =
    `You are a root cause analyst for a multi-agent code generation pipeline.\n` +
    `Output STRICT JSON only. No markdown, no prose, no backticks.\n` +
    `Schema: {"rootCause":"<one sentence>","fixStrategy":"<one sentence>","targetFiles":["<rel path>"],"doNotTouch":["<rel path>"]}\n` +
    `- rootCause: what is actually wrong structurally, not the symptom\n` +
    `- fixStrategy: the single concrete change that will fix it\n` +
    `- targetFiles: files the Coder MUST touch (max 5)\n` +
    `- doNotTouch: files changed in a previous failed attempt that should not be touched again`;

async function runDiagnosis(geminiService, failureReasons = [], previousAttempts = []) {
    if (!failureReasons.length) return null;
    try {
        const prevBlock = previousAttempts.length
            ? `Previous fix attempts (DO NOT repeat):\n${previousAttempts.slice(-3)
                .map((a, i) => `  Attempt ${i + 1}: taskId=${a.taskId}, noChange=${a.noChange}`)
                .join('\n')}`
            : 'No previous fix attempts.';

        const prompt = `${DIAGNOSIS_PROMPT_PREFIX}\n\nFailure reasons:\n${
            failureReasons.map(r => `- ${r}`).join('\n')
        }\n\n${prevBlock}\n\nOutput JSON:`;

        const raw = await geminiService.generateResponse(prompt, [], 'GENERAL');
        const cleaned = String(raw || '').replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (!parsed.rootCause || !parsed.fixStrategy) return null;
        return {
            rootCause: String(parsed.rootCause || ''),
            fixStrategy: String(parsed.fixStrategy || ''),
            targetFiles: Array.isArray(parsed.targetFiles) ? parsed.targetFiles.map(String).filter(Boolean) : [],
            doNotTouch: Array.isArray(parsed.doNotTouch) ? parsed.doNotTouch.map(String).filter(Boolean) : []
        };
    } catch (err) {
        logger.warn(`FixOrchestrationService.runDiagnosis failed (non-fatal): ${err.message}`);
        return null;
    }
}

function buildDiagnosisBlock(diagnosis) {
    if (!diagnosis) return '';
    const lines = [
        `ROOT CAUSE ANALYSIS (read before writing any code):`,
        `- Root cause: ${diagnosis.rootCause}`,
        `- Fix strategy: ${diagnosis.fixStrategy}`
    ];
    if (diagnosis.targetFiles.length) lines.push(`- Files to change: ${diagnosis.targetFiles.join(', ')}`);
    if (diagnosis.doNotTouch.length) lines.push(`- DO NOT touch (already tried): ${diagnosis.doNotTouch.join(', ')}`);
    return lines.join('\n');
}

// ── D) Delta verifier prompt ──────────────────────────────────────────

function buildDeltaVerifierPrompt(taskPrompt, lastVerifierEntry, fixAttemptLedger = []) {
    if (!lastVerifierEntry || lastVerifierEntry.status !== 'fail') return taskPrompt;

    const failedReasons = Array.isArray(lastVerifierEntry.details?.reasons)
        ? lastVerifierEntry.details.reasons
        : (lastVerifierEntry.summary ? [lastVerifierEntry.summary] : []);

    if (!failedReasons.length) return taskPrompt;

    const lastFix = Array.isArray(fixAttemptLedger) && fixAttemptLedger.length
        ? fixAttemptLedger[fixAttemptLedger.length - 1]
        : null;

    const changedNote = lastFix && !lastFix.noChange
        ? `Changes were made by fix task ${lastFix.taskId} \u2014 re-verify only the affected gates.`
        : lastFix?.noChange
            ? `\u26a0\ufe0f WARNING: The last fix task (${lastFix.taskId}) made NO file changes. These failures may be structural.`
            : '';

    const deltaBlock = [
        `DELTA VERIFICATION MODE:`,
        `Re-check ONLY these previously-failed gates (skip gates that already passed):`,
        ...failedReasons.map(r => `  - ${r}`),
        changedNote,
        `Do NOT run broad recursive scans. Focus only on the listed gates and files changed by the last fix.`
    ].filter(Boolean).join('\n');

    return `${deltaBlock}\n\n${taskPrompt}`;
}

export default {
    snapshotWorkspace,
    recordFixAttempt,
    lastAttemptForSignature,
    resolveFixStrategy,
    recordFixBudgetUsage,
    buildRegenerateBlock,
    runDiagnosis,
    buildDiagnosisBlock,
    buildDeltaVerifierPrompt
};
