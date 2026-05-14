class VerificationLedgerService {
    constructor() {
        this.entriesByWorkspace = new Map();
    }

    record(workspacePath = '', entry = {}) {
        const key = String(workspacePath || '').trim();
        if (!key) return null;
        const list = this.entriesByWorkspace.get(key) || [];
        const normalized = {
            at: new Date().toISOString(),
            type: String(entry.type || ''),
            taskId: String(entry.taskId || ''),
            role: String(entry.role || ''),
            status: String(entry.status || ''),
            summary: String(entry.summary || ''),
            details: entry.details && typeof entry.details === 'object' ? entry.details : {},
            artifactPaths: Array.isArray(entry.artifactPaths) ? entry.artifactPaths : [],
            sourceHash: String(entry.sourceHash || '')  // workspace fingerprint for skip-on-unchanged (3.1)
        };
        list.push(normalized);
        if (list.length > 300) {
            this.entriesByWorkspace.set(key, list.slice(-300));
        } else {
            this.entriesByWorkspace.set(key, list);
        }
        return normalized;
    }

    hydrate(workspacePath = '', entries = []) {
        const key = String(workspacePath || '').trim();
        if (!key) return [];
        const normalizedEntries = Array.isArray(entries)
            ? entries
                .filter((entry) => entry && typeof entry === 'object')
                .map((entry) => ({
                    at: String(entry.at || ''),
                    type: String(entry.type || ''),
                    taskId: String(entry.taskId || ''),
                    role: String(entry.role || ''),
                    status: String(entry.status || ''),
                    summary: String(entry.summary || ''),
                    details: entry.details && typeof entry.details === 'object' ? entry.details : {},
                    artifactPaths: Array.isArray(entry.artifactPaths) ? entry.artifactPaths : []
                }))
            : [];
        this.entriesByWorkspace.set(key, normalizedEntries.slice(-300));
        return this.getEntries(key);
    }

    getEntries(workspacePath = '', filter = {}) {
        const key = String(workspacePath || '').trim();
        const list = this.entriesByWorkspace.get(key) || [];
        return list.filter((entry) => {
            if (filter.type && String(entry.type || '') !== String(filter.type || '')) return false;
            if (filter.taskId && String(entry.taskId || '') !== String(filter.taskId || '')) return false;
            return true;
        });
    }

    latestByType(workspacePath = '', type = '') {
        const entries = this.getEntries(workspacePath, { type });
        return entries.length ? entries[entries.length - 1] : null;
    }

    latestVerifierSummary(workspacePath = '') {
        return this.latestByType(workspacePath, 'verifier');
    }

    latestPreviewProbeSummary(workspacePath = '') {
        return this.latestByType(workspacePath, 'preview_probe');
    }
}

export default new VerificationLedgerService();
