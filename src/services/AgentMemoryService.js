import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import logger from '../utils/logger.js';

// ──────────────────────────────────────────────────────────────────────
// AgentMemoryService  (Phase 4.2 — cross-session persistent memory)
//
// Inspired by Hermes Agent's MEMORY.md + USER.md pattern:
//   agentNotes  — env facts, App IDs, template lessons, project history
//   userProfile — email pattern, stack preference, communication style
//
// Both are injected as a frozen block at session start so the LLM's
// prefix cache is preserved. Updates are written to disk but do NOT
// affect the current session's system prompt (only the next one).
//
// Security: all writes are scanned for prompt injection patterns.
//
// Storage: .viverse_agent_memory.json in process.cwd()
// ──────────────────────────────────────────────────────────────────────

const MEMORY_FILE = path.resolve(process.cwd(), '.viverse_agent_memory.json');
const MAX_NOTES   = 20;   // max agentNotes entries
const MAX_PROFILE = 10;   // max userProfile entries

// Injection patterns — anything matching these is rejected before storage
const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?(?:previous|prior|above)\s+instructions/i,
    /you\s+are\s+now\s+(a|an|the)\s+\w+/i,
    /\bsystem\s*:\s*/i,
    /do\s+not\s+follow\b/i,
    /\boverride\s+(your\s+)?instructions/i,
    /[\u200b-\u200f\u202a-\u202e\ufeff]/,   // invisible Unicode
];

function sanitize(text = '') {
    const t = String(text || '').trim();
    for (const re of INJECTION_PATTERNS) {
        if (re.test(t)) throw new Error(`Memory entry rejected: matches injection pattern`);
    }
    return t.slice(0, 300); // hard length cap per entry
}

function emailKey(email = '') {
    return crypto.createHash('sha256')
        .update(String(email).trim().toLowerCase())
        .digest('hex')
        .slice(0, 16);
}

function maskEmail(email = '') {
    const [name, domain] = String(email).split('@');
    if (!name || !domain) return 'unknown';
    return `${name.slice(0, 2)}***@${domain}`;
}

class AgentMemoryService {
    constructor() {
        this._cache = null;
    }

    // ── I/O ───────────────────────────────────────────────────────────

    async _load() {
        if (this._cache) return this._cache;
        try {
            const raw = await fs.readFile(MEMORY_FILE, 'utf8');
            this._cache = JSON.parse(raw);
        } catch {
            this._cache = { agentNotes: [], userProfile: [], updatedAt: null };
        }
        return this._cache;
    }

    async _save(memory) {
        try {
            memory.updatedAt = new Date().toISOString();
            await fs.writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2), 'utf8');
            this._cache = memory;
        } catch (err) {
            logger.warn(`AgentMemoryService: save failed: ${err.message}`);
        }
    }

    // ── Read ──────────────────────────────────────────────────────────

    /**
     * Returns a frozen snapshot string for injection into system prompts.
     * Format mirrors Hermes MEMORY.md pattern.
     */
    async getSystemPromptBlock() {
        const mem = await this._load();
        const notes   = Array.isArray(mem.agentNotes)   ? mem.agentNotes   : [];
        const profile = Array.isArray(mem.userProfile)  ? mem.userProfile  : [];
        if (!notes.length && !profile.length) return '';

        const lines = ['[AGENT_MEMORY — frozen snapshot from prior sessions]'];
        if (notes.length) {
            lines.push('Agent notes:');
            notes.forEach(n => lines.push(`  - ${n}`));
        }
        if (profile.length) {
            lines.push('User profile:');
            profile.forEach(p => lines.push(`  - ${p}`));
        }
        lines.push('[END AGENT_MEMORY]');
        return lines.join('\n');
    }

    // ── Write ─────────────────────────────────────────────────────────

    /**
     * Add a note to agentNotes (environment facts, App IDs, lessons).
     * Deduplicates. Evicts oldest when over MAX_NOTES.
     */
    async addNote(text = '') {
        const entry = sanitize(text);
        if (!entry) return;
        const mem = await this._load();
        mem.agentNotes = Array.isArray(mem.agentNotes) ? mem.agentNotes : [];
        if (mem.agentNotes.includes(entry)) return; // dedupe
        mem.agentNotes.push(entry);
        if (mem.agentNotes.length > MAX_NOTES) {
            mem.agentNotes = mem.agentNotes.slice(-MAX_NOTES);
        }
        await this._save(mem);
    }

    /**
     * Add or update a user profile entry.
     * If an entry with the same key prefix exists, replace it.
     */
    async upsertProfile(text = '') {
        const entry = sanitize(text);
        if (!entry) return;
        const mem = await this._load();
        mem.userProfile = Array.isArray(mem.userProfile) ? mem.userProfile : [];
        // Match on first 20 chars as key
        const prefix = entry.slice(0, 20).toLowerCase();
        const idx = mem.userProfile.findIndex(e =>
            String(e).toLowerCase().slice(0, 20) === prefix
        );
        if (idx >= 0) {
            mem.userProfile[idx] = entry; // update
        } else {
            mem.userProfile.push(entry);
            if (mem.userProfile.length > MAX_PROFILE) {
                mem.userProfile = mem.userProfile.slice(-MAX_PROFILE);
            }
        }
        await this._save(mem);
    }

    /**
     * Remove a note or profile entry by substring match.
     */
    async remove(substring = '', target = 'notes') {
        const mem = await this._load();
        const key = target === 'profile' ? 'userProfile' : 'agentNotes';
        mem[key] = (mem[key] || []).filter(e =>
            !String(e).toLowerCase().includes(String(substring).toLowerCase())
        );
        await this._save(mem);
    }

    // ── Auto-update after workflow completion ─────────────────────────

    /**
     * Called by OrchestratorService after a successful workflow.
     * Extracts email pattern, App ID, template, and any stack signals.
     */
    async recordCompletedWorkflow(state = {}, credentials = null) {
        try {
            const appId      = state?.runtimeFlags?.appIdAuthority?.value || '';
            const templateId = state?.templateContext?.templateId || '';
            const label      = state?.finalOutcome?.appId
                ? (state?.registered ? '' : '') // label from registry if available
                : '';
            const previewUrl = state?.finalOutcome?.previewUrl || '';
            const request    = String(state?.request || '').slice(0, 80);

            // Record App ID + template
            if (appId && templateId) {
                await this.addNote(
                    `Published app: appId=${appId} template=${templateId}` +
                    (previewUrl ? ` url=${previewUrl}` : '')
                );
            }

            // Record masked email for credential-pattern recognition
            if (credentials?.email) {
                const masked = maskEmail(credentials.email);
                await this.upsertProfile(`Known VIVERSE account: ${masked}`);
            }

            // Detect stack preference from request
            const req = String(request).toLowerCase();
            if (/react|r3f|jsx/.test(req)) {
                await this.upsertProfile('Stack preference: React/R3F (mentioned in recent requests)');
            } else if (/playcanvas/.test(req)) {
                await this.upsertProfile('Stack preference: PlayCanvas (mentioned in recent requests)');
            } else if (/three\.?js|vanilla/.test(req)) {
                await this.upsertProfile('Stack preference: Vanilla Three.js (mentioned in recent requests)');
            }

            logger.info(`AgentMemoryService: recorded completed workflow (appId: ${appId})`);
        } catch (err) {
            logger.warn(`AgentMemoryService: recordCompletedWorkflow failed: ${err.message}`);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────

    async list() {
        const mem = await this._load();
        return {
            agentNotes:  mem.agentNotes  || [],
            userProfile: mem.userProfile || [],
            updatedAt:   mem.updatedAt   || null
        };
    }

    async clear(target = 'all') {
        const mem = await this._load();
        if (target === 'notes'   || target === 'all') mem.agentNotes  = [];
        if (target === 'profile' || target === 'all') mem.userProfile = [];
        await this._save(mem);
    }
}

export default new AgentMemoryService();
