import fs from 'fs/promises';
import path from 'path';
import workflowContextService from './WorkflowContextService.js';
import verificationLedgerService from './VerificationLedgerService.js';

class WorkflowStateService {
    setActiveProjects(activeProjects) {
        this.activeProjects = activeProjects instanceof Map ? activeProjects : new Map();
    }

    _extractAppIdCandidates(text = "") {
        const matches = String(text).match(/\b[a-z0-9]{10}\b/gi) || [];
        return [...new Set(matches.map((m) => m.toLowerCase()))];
    }

    _buildWorkflowStatusSummary(state = {}, workspacePath = "") {
        const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
        const counts = {
            pending: tasks.filter((t) => t?.status === 'pending').length,
            completed: tasks.filter((t) => t?.status === 'completed').length,
            failed: tasks.filter((t) => t?.status === 'failed').length,
            blocked: tasks.filter((t) => t?.status === 'blocked').length
        };
        const pendingTask = tasks.find((t) => t?.status === 'pending') || null;
        const verifierTasks = tasks.filter((t) => String(t?.role || '').toUpperCase() === 'VERIFIER');
        const latestVerifier = verifierTasks.length ? verifierTasks[verifierTasks.length - 1] : null;
        const verifierStatus = latestVerifier?.status || 'not_scheduled';
        const workflowStatus = String(state?.status || 'unknown');
        const latestPacket = workflowContextService.getLatestPacket(state);
        const persistedVerificationEntries = Array.isArray(state?.verificationLedger) ? state.verificationLedger : [];
        const latestPersistedOfType = (type) => {
            const filtered = persistedVerificationEntries.filter((entry) => String(entry?.type || '') === String(type || ''));
            return filtered.length ? filtered[filtered.length - 1] : null;
        };
        const latestVerifierEntry = verificationLedgerService.latestVerifierSummary(workspacePath) || latestPersistedOfType('verifier');
        const latestPreviewProbeEntry = verificationLedgerService.latestPreviewProbeSummary(workspacePath) || latestPersistedOfType('preview_probe');
        const recoveryLedger = Array.isArray(state?.recoveryLedger) ? state.recoveryLedger : [];
        const latestRecovery = recoveryLedger.length ? recoveryLedger[recoveryLedger.length - 1] : null;
        const hasBlocking = counts.failed > 0 || counts.blocked > 0;
        const isSettled = counts.pending === 0 && !hasBlocking;
        const overall = hasBlocking ? 'blocked_or_failed' : (isSettled ? 'completed' : 'in_progress');
        const requestId = path.basename(String(workspacePath || '')) || '';

        const lines = [
            `Workflow status: ${overall}`,
            `Workspace: ${workspacePath || 'unknown'}`,
            `Request ID: ${requestId || 'unknown'}`,
            `State flag: ${workflowStatus}`,
            `Task counts: pending=${counts.pending}, completed=${counts.completed}, failed=${counts.failed}, blocked=${counts.blocked}`,
            `Verifier: ${verifierStatus}`
        ];
        if (latestPacket?.currentStage) lines.push(`Current stage: ${latestPacket.currentStage}`);
        if (latestPacket?.nextAction) lines.push(`Next action: ${latestPacket.nextAction}`);
        if (latestPacket?.requestScopePrimary) lines.push(`Request scope: ${latestPacket.requestScopePrimary}`);
        if (latestVerifierEntry?.status) lines.push(`Verifier gate: ${latestVerifierEntry.status}`);
        if (latestPreviewProbeEntry?.status) lines.push(`Preview probe: ${latestPreviewProbeEntry.status}`);
        if (latestRecovery?.category) lines.push(`Latest recovery: ${latestRecovery.category} -> ${latestRecovery.action}`);
        if (latestVerifier?.id) lines.push(`Latest verifier task: ${latestVerifier.id}`);
        if (pendingTask?.id) lines.push(`Current pending task: ${pendingTask.id} (${pendingTask.role})`);
        if (pendingTask?.prompt) lines.push(`Pending prompt: ${String(pendingTask.prompt).slice(0, 160)}`);

        return {
            found: true,
            workspacePath,
            requestId,
            overall,
            stateFlag: workflowStatus,
            currentStage: String(latestPacket?.currentStage || ''),
            nextAction: String(latestPacket?.nextAction || ''),
            requestScope: String(latestPacket?.requestScopePrimary || ''),
            latestVerifierGate: latestVerifierEntry
                ? {
                    status: latestVerifierEntry.status,
                    summary: latestVerifierEntry.summary,
                    at: latestVerifierEntry.at
                }
                : null,
            latestPreviewProbe: latestPreviewProbeEntry
                ? {
                    status: latestPreviewProbeEntry.status,
                    summary: latestPreviewProbeEntry.summary,
                    at: latestPreviewProbeEntry.at
                }
                : null,
            latestRecovery: latestRecovery
                ? {
                    category: latestRecovery.category,
                    action: latestRecovery.action,
                    taskId: latestRecovery.taskId,
                    at: latestRecovery.at
                }
                : null,
            counts,
            verifier: latestVerifier
                ? { id: latestVerifier.id, status: latestVerifier.status, prompt: latestVerifier.prompt }
                : { status: 'not_scheduled' },
            pendingTask: pendingTask
                ? { id: pendingTask.id, role: pendingTask.role, prompt: pendingTask.prompt }
                : null,
            text: lines.join('\n')
        };
    }

    async _pickWorkspace(workSpaceDir, { appIds = [], preferredWorkspace = null } = {}) {
        const files = await fs.readdir(workSpaceDir, { withFileTypes: true });
        const dirs = files
            .filter((f) => f.isDirectory() && f.name.startsWith('req_'))
            .map((f) => f.name)
            .sort((a, b) => b.localeCompare(a));

        let best = null;
        for (const name of dirs) {
            const candidate = path.join(workSpaceDir, name);
            const statePath = path.join(candidate, '.agent_state.json');
            try {
                const content = await fs.readFile(statePath, 'utf8');
                const parsed = JSON.parse(content);
                const summary = String(parsed?.projectContextSummary || "");
                let score = 0;

                if (preferredWorkspace && preferredWorkspace === candidate) score += 1000;
                for (const id of appIds) {
                    if (summary.includes(id)) score += 200;
                }
                if (Array.isArray(parsed?.tasks) && parsed.tasks.some((t) => t.status === 'pending')) score += 20;
                if ((await fs.stat(candidate).catch(() => null))?.isDirectory()) score += 1;

                if (!best || score > best.score) {
                    best = { path: candidate, state: parsed, score };
                }
            } catch {
                // Ignore invalid workspace state.
            }
        }

        return best;
    }

    async getWorkflowStatus(message = "", history = [], credentials = null) {
        const workSpaceDir = path.resolve(process.cwd(), '.viverse_workspaces');
        const appIdsFromMsg = this._extractAppIdCandidates(message);
        const appIdsFromHistory = this._extractAppIdCandidates(JSON.stringify(history || []));
        const appIds = [...new Set([...appIdsFromMsg, ...appIdsFromHistory])];
        const userKey = credentials?.email ? String(credentials.email).toLowerCase() : "";
        const reqHint = String(message || '').match(/\b(req_\d{8,})\b/i)?.[1] || "";
        const explicitWorkspaceHint = reqHint ? path.join(workSpaceDir, reqHint) : null;
        const preferredWorkspace = explicitWorkspaceHint || (userKey ? this.activeProjects?.get(userKey) : null);

        const best = await this._pickWorkspace(workSpaceDir, { appIds, preferredWorkspace });
        if (!best?.state) {
            return {
                found: false,
                overall: 'not_found',
                requestId: reqHint || '',
                text: 'No workflow state found to report. Provide a req_id (e.g., req_123...) or run a project task first.'
            };
        }
        return this._buildWorkflowStatusSummary(best.state, best.path);
    }
}

export default new WorkflowStateService();
