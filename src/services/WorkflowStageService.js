class WorkflowStageService {
    stageForTask(task = {}) {
        const role = String(task?.role || '').toUpperCase();
        const id = String(task?.id || '').toLowerCase();
        const prompt = String(task?.prompt || '').toLowerCase();
        const text = `${role}\n${id}\n${prompt}`;

        if (id === 'auth_preflight' || /auth preflight only/.test(text)) return 'auth_preflight';
        if (role === 'ARCHITECT' || /contract|plan/.test(text)) return 'plan';
        if (/publish|deploy|viverse-cli\s+app\s+publish/.test(text)) return 'publish';
        if (/scaffold|create-vite|template/.test(text)) return 'scaffold_preflight';
        if (
            role === 'VERIFIER' ||
            role === 'REVIEWER' ||
            /\b(verifier|reviewer|preview probe|runtime verification|grep gate)\b/.test(text)
        ) return 'verify';
        return 'implement';
    }

    transition(state = {}, stage = '', meta = {}) {
        const nextStage = String(stage || '').trim();
        if (!nextStage) return state;
        const previousStage = String(state.currentStage || '').trim();
        state.currentStage = nextStage;
        state.nextAction = String(meta.nextAction || state.nextAction || '');
        state.stageHistory = Array.isArray(state.stageHistory) ? state.stageHistory : [];
        if (previousStage !== nextStage || meta.forceRecord) {
            state.stageHistory.push({
                at: new Date().toISOString(),
                from: previousStage || '',
                to: nextStage,
                reason: String(meta.reason || ''),
                taskId: String(meta.taskId || ''),
                role: String(meta.role || '')
            });
            if (state.stageHistory.length > 100) {
                state.stageHistory = state.stageHistory.slice(-100);
            }
        }
        return state;
    }

    transitionForTask(state = {}, task = {}, meta = {}) {
        const stage = this.stageForTask(task);
        const nextAction = meta.nextAction || `Execute task ${String(task?.id || '')} (${String(task?.role || '')})`;
        return this.transition(state, stage, {
            ...meta,
            nextAction,
            taskId: String(task?.id || ''),
            role: String(task?.role || '')
        });
    }

    markFinalize(state = {}, meta = {}) {
        return this.transition(state, 'finalize', {
            ...meta,
            nextAction: String(meta.nextAction || 'Finalize workflow outcome')
        });
    }
}

export default new WorkflowStageService();
