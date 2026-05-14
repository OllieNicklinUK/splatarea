class WorkflowPolicyService {
    classifyFailure(reason = '', { role = '', taskId = '' } = {}) {
        const text = String(reason || '');
        const lower = text.toLowerCase();
        const roleUpper = String(role || '').toUpperCase();

        if (/invalid_credentials/i.test(text)) {
            return { category: 'permission_block', retryable: false, action: 'stop', reason };
        }
        if (
            /gemini rest(?: stream)? error\s+5\d\d/i.test(text) ||
            lower.includes('service unavailable') ||
            lower.includes('gateway timeout') ||
            lower.includes('bad gateway') ||
            lower.includes('upstream connect error') ||
            lower.includes('fetch failed') ||
            lower.includes('network error') ||
            lower.includes('socket hang up') ||
            lower.includes('etimedout') ||
            lower.includes('econnreset')
        ) {
            return { category: 'provider_error', retryable: true, action: 'retry_transient_infra', reason };
        }
        if (/MAX_TOOL_ITERATIONS_REACHED|CONVERGENCE_GUARD|AGENT_TASK_IDLE_TIMEOUT|AGENT_TASK_DURATION_TIMEOUT/i.test(text)) {
            return {
                category: 'tool_loop_error',
                retryable: true,
                action: roleUpper === 'VERIFIER' ? 'schedule_verifier_loop_recovery' : 'schedule_coder_loop_recovery',
                reason
            };
        }
        if (/planner schema validation failed|Field "isNewProject"|tasks" must be a non-empty array/i.test(text)) {
            return { category: 'planner_schema_error', retryable: true, action: 'retry_planner', reason };
        }
        if (/Skill enforcement failed|Missing skill load artifact|Skill load artifact reported failure/i.test(text)) {
            return { category: 'skill_resolution_error', retryable: false, action: 'stop', reason };
        }
        return { category: 'unknown_error', retryable: false, action: 'stop', reason, taskId };
    }

    shouldRetryTransientInfra(classification = {}, task = {}, maxRetries = 0) {
        if (classification.action !== 'retry_transient_infra') return false;
        const prevAttempts = Number(task?.transientInfraRetryCount || 0);
        return prevAttempts < Number(maxRetries || 0);
    }

    shouldScheduleLoopRecovery(classification = {}, role = '', previousRecoveries = 0) {
        const action = String(classification?.action || '');
        const roleUpper = String(role || '').toUpperCase();
        if (roleUpper === 'VERIFIER') {
            return action === 'schedule_verifier_loop_recovery' && previousRecoveries < 1;
        }
        return action === 'schedule_coder_loop_recovery' && previousRecoveries < 1;
    }

    recordPolicyDecision(state = {}, entry = {}) {
        state.recoveryLedger = Array.isArray(state.recoveryLedger) ? state.recoveryLedger : [];
        state.recoveryLedger.push({
            at: new Date().toISOString(),
            category: String(entry.category || ''),
            action: String(entry.action || ''),
            taskId: String(entry.taskId || ''),
            role: String(entry.role || ''),
            reason: String(entry.reason || '')
        });
        if (state.recoveryLedger.length > 100) {
            state.recoveryLedger = state.recoveryLedger.slice(-100);
        }
    }
}

export default new WorkflowPolicyService();
