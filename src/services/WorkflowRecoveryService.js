import workflowPolicyService from './WorkflowPolicyService.js';

class WorkflowRecoveryService {
    handleStreamFailure({
        state = {},
        task = {},
        reason = '',
        templateGuardBlock = '',
        taskStartedAt = Date.now(),
        projectContextSummary = '',
        maxTransientInfraRetriesPerTask = 0,
        computeTransientInfraRetryDelayMs = (attempt) => Number(attempt || 0),
        appendRunEvent = () => {}
    } = {}) {
        const roleUpper = String(task.role || '').toUpperCase();
        const classification = workflowPolicyService.classifyFailure(reason, {
            role: task.role,
            taskId: task.id
        });

        workflowPolicyService.recordPolicyDecision(state, {
            category: classification.category,
            action: classification.action,
            taskId: task.id,
            role: task.role,
            reason
        });

        if (workflowPolicyService.shouldRetryTransientInfra(classification, task, maxTransientInfraRetriesPerTask)) {
            const prevAttempts = Number(task.transientInfraRetryCount || 0);
            const nextAttempt = prevAttempts + 1;
            const delayMs = computeTransientInfraRetryDelayMs(nextAttempt);
            task.status = 'pending';
            task.transientInfraRetryCount = nextAttempt;
            task.transientInfraRetryAt = Date.now() + delayMs;
            task.lastError = reason;
            appendRunEvent(state, {
                type: 'task_retry_scheduled',
                taskId: task.id,
                role: task.role,
                reason,
                retryClass: 'transient_infra',
                attempt: nextAttempt,
                delayMs,
                failureCategory: classification.category
            });
            return {
                disposition: 'retry_scheduled',
                classification,
                projectContextSummary:
                    `${projectContextSummary}\n- ${task.role} transient infra failure on ${task.id}; ` +
                    `retry ${nextAttempt}/${maxTransientInfraRetriesPerTask} in ${Math.ceil(delayMs / 1000)}s.`,
                statusMessage:
                    `Task ${task.id} hit transient AI infrastructure issue. ` +
                    `Auto-retrying in ~${Math.ceil(delayMs / 1000)}s ` +
                    `(attempt ${nextAttempt}/${maxTransientInfraRetriesPerTask}).`
            };
        }

        state.runtimeFlags = state.runtimeFlags || {};
        state.runtimeFlags.loopRecovery = state.runtimeFlags.loopRecovery || {};
        const loopRootId = String(task?.loopRootId || task?.recoveryOf || task.id);
        const recoveryKey = `${roleUpper}:${loopRootId}`;
        const prevRecoveryCount = Number(state.runtimeFlags.loopRecovery[recoveryKey] || 0);

        if (workflowPolicyService.shouldScheduleLoopRecovery(classification, task.role, prevRecoveryCount)) {
            const retryId = roleUpper === 'VERIFIER'
                ? `loop_recover_verifier_${Date.now()}`
                : `loop_recover_${Date.now()}`;
            state.runtimeFlags.loopRecovery[recoveryKey] = prevRecoveryCount + 1;
            state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
            state.tasks.push(this._buildLoopRecoveryTask({ task, reason, loopRootId, retryId, roleUpper, templateGuardBlock }));
            this._rewirePendingDependencies(state.tasks, task.id, retryId);
            task.status = 'failed';
            appendRunEvent(state, {
                type: 'task_failed_recovered',
                taskId: task.id,
                role: task.role,
                durationMs: Date.now() - taskStartedAt,
                reason,
                failureCategory: classification.category
            });
            return {
                disposition: 'recovery_scheduled',
                classification,
                retryId,
                projectContextSummary:
                    `${projectContextSummary}\n- ${task.role} LOOP RECOVERY scheduled from ${task.id}: ${reason}`,
                statusMessage: roleUpper === 'VERIFIER'
                    ? `Task ${task.id} entered a verifier tool loop. Scheduling deterministic recovery task ${retryId}.`
                    : `Task ${task.id} entered a tool loop. Scheduling deterministic recovery task ${retryId}.`
            };
        }

        task.status = 'failed';
        task.lastError = reason;
        appendRunEvent(state, {
            type: 'task_failed',
            taskId: task.id,
            role: task.role,
            durationMs: Date.now() - taskStartedAt,
            reason,
            failureCategory: classification.category
        });
        return {
            disposition: 'terminal_failure',
            classification,
            projectContextSummary: `${projectContextSummary}\n- ${task.role} FAILED: ${reason}`,
            statusMessage: `Task ${task.id} failed: ${reason}. Workflow paused for manual intervention.`,
            detailMessage: `\n\n⚠️ **${task.role} task failed**\nReason: ${reason}`
        };
    }

    _rewirePendingDependencies(tasks = [], oldTaskId = '', replacementTaskId = '') {
        for (const task of tasks) {
            if (task.status !== 'pending' || !Array.isArray(task.dependsOn) || !task.dependsOn.includes(oldTaskId)) {
                continue;
            }
            task.dependsOn = task.dependsOn.filter((dep) => dep !== oldTaskId);
            if (!task.dependsOn.includes(replacementTaskId)) {
                task.dependsOn.push(replacementTaskId);
            }
        }
    }

    _buildLoopRecoveryTask({ task = {}, reason = '', loopRootId = '', retryId = '', roleUpper = '', templateGuardBlock = '' } = {}) {
        if (roleUpper === 'VERIFIER') {
            return {
                id: retryId,
                role: 'Verifier',
                recoveryOf: loopRootId,
                loopRootId,
                prompt: `LOOP RECOVERY TASK (deterministic): Previous verifier task '${task.id}' failed due to tool loop (${reason}).
Use existing workspace artifacts only; do NOT run broad recursive scans or repeated token-hunting loops.
1) Read latest preview probe report under artifacts/preview-tests (most recent preview-*.json and linked browser-report.json).
2) Return STRICT JSON with:
   - status (pass/fail)
   - runtime_checks.auth_profile.status/proof
   - runtime_checks.matchmaking.status/proof
   - preview_url_tested
   - artifact_paths (exact files used)
3) If evidence is stale/missing, run at most ONE targeted preview probe and then report once.`,
                dependsOn: [],
                status: 'pending'
            };
        }

        return {
            id: retryId,
            role: 'Coder',
            recoveryOf: loopRootId,
            loopRootId,
            prompt: `LOOP RECOVERY TASK (deterministic): Previous coder task '${task.id}' failed due to tool loop (${reason}).
1) Determine authoritative App ID (10-char alnum with at least one digit) from the approved template source or viverse-cli output.
2) Ensure the authoritative App ID is present only in approved propagation files for this template; do NOT invent a new fallback path.
3) Ensure source uses the template-approved App ID propagation strategy and contains no placeholder tokens.
4) Run ONE build or template publish-packaging step only if the template requires it.
5) Run ONE dist verification using the exact authoritative app id; do NOT run token-hunting grep loops.
6) If verification fails, fix only the approved propagation/build files once. Then stop and summarize exact mismatch.

${String(templateGuardBlock || '')}`,
            dependsOn: [],
            status: 'pending'
        };
    }
}

export default new WorkflowRecoveryService();
