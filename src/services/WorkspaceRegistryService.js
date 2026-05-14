import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';

// ──────────────────────────────────────────────────────────────────────
// WorkspaceRegistryService
//
// Maintains a lightweight .viverse_workspaces/.registry.json index of
// saved workspaces so users can reference and resume past projects by
// name rather than req_ ID.
//
// Registry entry shape:
// {
//   reqId:       "req_1776738163663",
//   label:       "Countdown Timer",         // human-readable name
//   appId:       "gx2t3m59xp",
//   templateId:  "blank-webapp-v1",
//   previewUrl:  "https://worlds.viverse.com/...",
//   request:     "Create a utility site...",  // first 120 chars
//   status:      "completed",
//   savedAt:     "2026-04-21T...",
//   completedAt: "2026-04-21T..."
// }
// ──────────────────────────────────────────────────────────────────────

const REGISTRY_FILENAME = '.registry.json';

class WorkspaceRegistryService {
    constructor() {
        this._cache = null;          // in-memory cache of registry
        this._registryPath = null;   // resolved on first use
    }

    // ── Path resolution ───────────────────────────────────────────────

    _getRegistryPath(workSpaceDir) {
        return path.join(workSpaceDir, REGISTRY_FILENAME);
    }

    // ── Read / write ──────────────────────────────────────────────────

    async _load(workSpaceDir) {
        const p = this._getRegistryPath(workSpaceDir);
        try {
            const raw = await fs.readFile(p, 'utf8');
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    async _save(workSpaceDir, registry) {
        const p = this._getRegistryPath(workSpaceDir);
        try {
            await fs.writeFile(p, JSON.stringify(registry, null, 2), 'utf8');
        } catch (err) {
            logger.warn(`WorkspaceRegistryService: failed to save registry: ${err.message}`);
        }
    }

    // ── Label derivation ─────────────────────────────────────────────

    /**
     * Derives a short human label from the workflow state.
     * Priority:
     *   1. Explicit label passed in
     *   2. App name extracted from SUMMARIZER text in projectContextSummary
     *   3. Cleaned-up first sentence of the original request
     */
    deriveLabel(state = {}, explicitLabel = '') {
        if (explicitLabel && String(explicitLabel).trim()) {
            return String(explicitLabel).trim().slice(0, 60);
        }

        // Try to extract app name from SUMMARIZER output in projectContextSummary
        const summary = String(state?.projectContextSummary || '');
        const appNamePatterns = [
            /\*\*"([^"]{3,50})"\*\*/,                     // **"App Name"**
            /app(?:\s+name)?[:\s]+\*\*([^*]{3,50})\*\*/i,  // App Name: **Foo**
            /named?\s+\*\*"?([^"*\n]{3,50})"?\*\*/i,       // named **Foo**
            /created.*?application.*?"([^"]{3,50})"/i,      // created application "Foo"
            /CountdownTimer|WorldClock|TankArena|DashRunner/i // common names
        ];
        for (const re of appNamePatterns) {
            const m = summary.match(re);
            if (m?.[1]) return String(m[1]).trim().slice(0, 60);
        }

        // Fall back to first meaningful fragment of the original request
        const req = String(state?.request || '').trim();
        const cleaned = req
            .replace(/using template \S+/i, '')
            .replace(/Use rulesetId \S+/i, '')
            .replace(/Preserve auth.*/i, '')
            .trim()
            .slice(0, 60);
        return cleaned || 'Untitled Project';
    }

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Register a completed workspace in the registry.
     * Called automatically by OrchestratorService on workflow completion.
     */
    async register(workSpaceDir, state = {}, { label = '' } = {}) {
        if (!workSpaceDir || !state?.workspacePath) return null;
        const reqId = path.basename(String(state.workspacePath));
        if (!reqId.startsWith('req_')) return null;

        const registry = await this._load(workSpaceDir);
        const derivedLabel = this.deriveLabel(state, label);
        const entry = {
            reqId,
            label: derivedLabel,
            appId:       String(state?.finalOutcome?.appId || state?.runtimeFlags?.appIdAuthority?.value || ''),
            templateId:  String(state?.templateContext?.templateId || state?.finalOutcome?.templateId || ''),
            previewUrl:  String(state?.finalOutcome?.previewUrl || ''),
            request:     String(state?.request || '').slice(0, 120),
            status:      String(state?.status || 'completed'),
            savedAt:     new Date().toISOString(),
            completedAt: String(state?.finalOutcome?.completedAt || state?.runReport?.endedAt || '')
        };

        registry[reqId] = entry;
        await this._save(workSpaceDir, registry);
        logger.info(`WorkspaceRegistryService: saved workspace ${reqId} as "${derivedLabel}"`);
        return entry;
    }

    /**
     * Update the label on an existing registry entry.
     */
    async relabel(workSpaceDir, reqId, newLabel = '') {
        if (!workSpaceDir || !reqId || !newLabel.trim()) return null;
        const registry = await this._load(workSpaceDir);
        if (!registry[reqId]) return null;
        registry[reqId].label = String(newLabel).trim().slice(0, 60);
        registry[reqId].labelledAt = new Date().toISOString();
        await this._save(workSpaceDir, registry);
        return registry[reqId];
    }

    /**
     * Unpin a workspace (remove from registry, keep files on disk).
     */
    async unregister(workSpaceDir, reqId) {
        const registry = await this._load(workSpaceDir);
        const entry = registry[reqId] || null;
        delete registry[reqId];
        await this._save(workSpaceDir, registry);
        return entry;
    }

    /**
     * List all registered workspaces, newest first.
     */
    async list(workSpaceDir) {
        const registry = await this._load(workSpaceDir);
        return Object.values(registry).sort((a, b) =>
            String(b.savedAt || '').localeCompare(String(a.savedAt || ''))
        );
    }

    /**
     * Find registry entries whose label matches keywords in a message.
     * Returns entries scored by keyword overlap, best first.
     * Used by _pickWorkspace to boost saved workspaces.
     */
    async findByKeywords(workSpaceDir, message = '') {
        const registry = await this._load(workSpaceDir);
        const words = String(message || '').toLowerCase()
            .split(/\W+/)
            .filter(w => w.length > 3);

        return Object.values(registry)
            .map(entry => {
                const target = `${entry.label} ${entry.request} ${entry.appId} ${entry.templateId}`.toLowerCase();
                const score = words.reduce((s, w) => s + (target.includes(w) ? 1 : 0), 0);
                return { ...entry, _matchScore: score };
            })
            .filter(e => e._matchScore > 0)
            .sort((a, b) => b._matchScore - a._matchScore);
    }

    /**
     * Get a single registry entry by reqId.
     */
    async get(workSpaceDir, reqId) {
        const registry = await this._load(workSpaceDir);
        return registry[reqId] || null;
    }
}

export default new WorkspaceRegistryService();
