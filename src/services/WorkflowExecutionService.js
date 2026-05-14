class WorkflowExecutionService {
    getRecoveredFailedTaskIds(state = {}, runEvents = []) {
        const eventRecoveredIds = (Array.isArray(runEvents) ? runEvents : [])
            .filter((entry) => entry && entry.type === 'task_failed_recovered' && entry.taskId)
            .map((entry) => String(entry.taskId));
        const taskRecoveredIds = (Array.isArray(state?.tasks) ? state.tasks : [])
            .filter((task) => task && task.status === 'completed' && (task.recoveryOf || task.loopRootId))
            .flatMap((task) => [task.recoveryOf, task.loopRootId])
            .filter(Boolean)
            .map((taskId) => String(taskId));
        return new Set([...eventRecoveredIds, ...taskRecoveredIds]);
    }

    getPendingTasks(state = {}) {
        const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
        return tasks.filter((task) => task?.status === 'pending');
    }

    getReadyTasks(state = {}, nowMs = Date.now()) {
        const pendingTasks = this.getPendingTasks(state);
        return pendingTasks.filter((task) => {
            const depsReady = (!task.dependsOn || task.dependsOn.length === 0) || task.dependsOn.every((depId) => {
                const dep = (state?.tasks || []).find((candidate) => candidate.id === depId);
                return dep && dep.status === 'completed';
            });
            if (!depsReady) return false;
            const retryAt = Number(task?.transientInfraRetryAt || 0);
            return !(retryAt > nowMs);
        });
    }

    getDeferredRetryTasks(state = {}, nowMs = Date.now()) {
        const pendingTasks = this.getPendingTasks(state);
        return pendingTasks.filter((task) => {
            const depsReady = (!task.dependsOn || task.dependsOn.length === 0) || task.dependsOn.every((depId) => {
                const dep = (state?.tasks || []).find((candidate) => candidate.id === depId);
                return dep && dep.status === 'completed';
            });
            if (!depsReady) return false;
            const retryAt = Number(task?.transientInfraRetryAt || 0);
            return retryAt > nowMs;
        });
    }

    computeSettlement(state = {}, runEvents = []) {
        const recoveredFailedTaskIds = this.getRecoveredFailedTaskIds(state, runEvents);
        const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
        const hasPendingTasks = tasks.some((task) => task.status === 'pending');
        const hasBlockingTaskStates = tasks.some((task) => {
            const id = String(task?.id || '');
            if (task.status === 'blocked') return true;
            if (task.status === 'failed' && !recoveredFailedTaskIds.has(id)) return true;
            return false;
        });

        return {
            recoveredFailedTaskIds,
            hasPendingTasks,
            hasBlockingTaskStates,
            workflowTasksSettled: !hasPendingTasks && !hasBlockingTaskStates
        };
    }
}

export default new WorkflowExecutionService();
