class SkillLedgerService {
    constructor() {
        this.entriesByWorkspace = new Map();
        this.contextByWorkspace = new Map();
    }

    setExecutionContext(workspacePath = '', context = {}) {
        const key = String(workspacePath || '').trim();
        if (!key) return;
        this.contextByWorkspace.set(key, {
            taskId: String(context.taskId || ''),
            role: String(context.role || '')
        });
    }

    clearExecutionContext(workspacePath = '') {
        const key = String(workspacePath || '').trim();
        if (!key) return;
        this.contextByWorkspace.delete(key);
    }

    record(workspacePath = '', entry = {}) {
        const key = String(workspacePath || '').trim();
        if (!key) return null;
        const list = this.entriesByWorkspace.get(key) || [];
        const context = this.contextByWorkspace.get(key) || {};
        const normalized = {
            at: new Date().toISOString(),
            taskId: String(entry.taskId || context.taskId || ''),
            role: String(entry.role || context.role || ''),
            requestedRef: String(entry.requestedRef || ''),
            canonicalRef: String(entry.canonicalRef || ''),
            resolvedPath: String(entry.resolvedPath || ''),
            success: entry.success === true,
            error: String(entry.error || '')
        };
        list.push(normalized);
        if (list.length > 200) {
            this.entriesByWorkspace.set(key, list.slice(-200));
        } else {
            this.entriesByWorkspace.set(key, list);
        }
        return normalized;
    }

    getEntries(workspacePath = '', filter = {}) {
        const key = String(workspacePath || '').trim();
        const list = this.entriesByWorkspace.get(key) || [];
        return list.filter((entry) => {
            if (filter.taskId && String(entry.taskId || '') !== String(filter.taskId)) return false;
            if (filter.role && String(entry.role || '') !== String(filter.role || '')) return false;
            return true;
        });
    }
}

export default new SkillLedgerService();
