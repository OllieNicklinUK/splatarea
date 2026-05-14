import path from 'path';

class WorkflowContextService {
    _deriveStageFromTask(task = {}) {
        const id = String(task?.id || '').toLowerCase();
        const prompt = String(task?.prompt || '').toLowerCase();
        const text = `${id}\n${prompt}`;

        if (/architect|contract|plan/.test(text)) return 'plan';
        if (/publish|deploy|viverse-cli\s+app\s+publish/.test(text)) return 'publish';
        if (/verifier|verify|preview probe|runtime verification|review/.test(text)) return 'verify';
        if (/build|vite build|npm run build/.test(text)) return 'build_verify';
        if (/scaffold|create-vite|template/.test(text)) return 'scaffold_preflight';
        return 'implement';
    }

    _computeCounts(tasks = []) {
        return {
            pending: tasks.filter((t) => t?.status === 'pending').length,
            completed: tasks.filter((t) => t?.status === 'completed').length,
            failed: tasks.filter((t) => t?.status === 'failed').length,
            blocked: tasks.filter((t) => t?.status === 'blocked').length
        };
    }

    _latestFailure(tasks = []) {
        const failedOrBlocked = tasks.filter((t) => t?.status === 'failed' || t?.status === 'blocked');
        if (!failedOrBlocked.length) return null;
        const last = failedOrBlocked[failedOrBlocked.length - 1];
        return {
            taskId: String(last.id || ''),
            role: String(last.role || ''),
            status: String(last.status || ''),
            reason: String(last.lastError || last.failureReason || last.reason || last.error || '')
        };
    }

    buildPacket(state = {}, { workspacePath = '', message = '', history = [] } = {}) {
        const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
        const counts = this._computeCounts(tasks);
        const nextActionTaskId = String(state?.nextAction || '').match(/task\s+([A-Za-z0-9_:-]+)/i)?.[1] || '';
        const pendingTask = (
            tasks.find((t) => t?.status === 'pending' && String(t?.id || '') === nextActionTaskId) ||
            tasks.find((t) => t?.status === 'pending') ||
            null
        );
        const latestVerifier = [...tasks].reverse().find((t) => String(t?.role || '').toUpperCase() === 'VERIFIER') || null;
        const currentStage = String(state?.currentStage || '') || this._deriveStageFromTask(pendingTask);
        const latestFailure = this._latestFailure(tasks);
        const requestId = path.basename(String(workspacePath || state?.workspacePath || '')) || '';
        const nextAction = String(state?.nextAction || '').trim() || (
            pendingTask
                ? `Run pending task ${pendingTask.id} (${pendingTask.role})`
                : (latestFailure ? `Resolve ${latestFailure.status} task ${latestFailure.taskId}` : 'Finalize workflow')
        );

        const packet = {
            at: new Date().toISOString(),
            requestId,
            workspacePath: String(workspacePath || state?.workspacePath || ''),
            stateFlag: String(state?.status || 'unknown'),
            currentStage,
            counts,
            pendingTask: pendingTask
                ? {
                    id: String(pendingTask.id || ''),
                    role: String(pendingTask.role || ''),
                    prompt: String(pendingTask.prompt || '')
                }
                : null,
            latestVerifier: latestVerifier
                ? {
                    id: String(latestVerifier.id || ''),
                    status: String(latestVerifier.status || ''),
                    prompt: String(latestVerifier.prompt || '')
                }
                : null,
            latestFailure,
            nextAction,
            authoritativeAppId: String(state?.runtimeFlags?.appIdAuthority?.value || ''),
            requestScopePrimary: String(state?.runtimeFlags?.requestScope?.primary || ''),
            allowedSubsystems: Array.isArray(state?.runtimeFlags?.requestScope?.allowedSubsystems)
                ? state.runtimeFlags.requestScope.allowedSubsystems.slice(0, 8)
                : [],
            templateId: String(state?.templateContext?.templateId || ''),
            request: String(message || state?.request || ''),
            recentHistory: Array.isArray(history) ? history.slice(-2) : []
        };
        packet.summaryText = this.summarizePacket(packet);
        return packet;
    }

    summarizePacket(packet = {}) {
        const lines = [
            `CURRENT_STAGE: ${String(packet.currentStage || 'unknown')}`,
            `STATE_FLAG: ${String(packet.stateFlag || 'unknown')}`,
            `REQUEST_ID: ${String(packet.requestId || 'unknown')}`,
            `NEXT_ACTION: ${String(packet.nextAction || 'unknown')}`
        ];
        if (packet.pendingTask?.id) {
            lines.push(`PENDING_TASK: ${packet.pendingTask.id} (${packet.pendingTask.role})`);
            if (packet.pendingTask.prompt) lines.push(`PENDING_PROMPT: ${packet.pendingTask.prompt.slice(0, 220)}`);
        }
        if (packet.latestVerifier?.id) {
            lines.push(`LATEST_VERIFIER: ${packet.latestVerifier.id} (${packet.latestVerifier.status || 'unknown'})`);
        }
        if (packet.latestFailure?.taskId) {
            lines.push(`LATEST_FAILURE: ${packet.latestFailure.taskId} [${packet.latestFailure.status}] ${packet.latestFailure.reason || ''}`.trim());
        }
        if (packet.authoritativeAppId) {
            lines.push(`AUTHORITATIVE_APP_ID: ${packet.authoritativeAppId}`);
        }
        if (packet.requestScopePrimary) {
            lines.push(`REQUEST_SCOPE: ${packet.requestScopePrimary}`);
        }
        if (Array.isArray(packet.allowedSubsystems) && packet.allowedSubsystems.length) {
            lines.push(`ALLOWED_SUBSYSTEMS: ${packet.allowedSubsystems.join(', ')}`);
        }
        if (packet.templateId) {
            lines.push(`TEMPLATE_ID: ${packet.templateId}`);
        }
        return lines.join('\n');
    }

    applyToState(state = {}, options = {}) {
        const packet = this.buildPacket(state, options);
        state.contextPackets = Array.isArray(state.contextPackets) ? state.contextPackets : [];
        state.contextPackets.push(packet);
        if (state.contextPackets.length > 20) {
            state.contextPackets = state.contextPackets.slice(-20);
        }
        state.latestContextPacket = packet;
        return packet;
    }

    getLatestPacket(state = {}) {
        if (state?.latestContextPacket && typeof state.latestContextPacket === 'object') {
            return state.latestContextPacket;
        }
        const packets = Array.isArray(state?.contextPackets) ? state.contextPackets : [];
        return packets.length ? packets[packets.length - 1] : null;
    }

    getPromptContext(state = {}, fallbackSummary = '') {
        const latest = this.getLatestPacket(state);
        return String(latest?.summaryText || fallbackSummary || '');
    }
}

export default new WorkflowContextService();
