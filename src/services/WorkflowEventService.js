class WorkflowEventService {
    provisionalStatus(content = '', extra = {}) {
        return {
            type: 'status',
            content,
            provisional: true,
            ...extra
        };
    }

    finalStatus(content = '', extra = {}) {
        return {
            type: 'status',
            content,
            provisional: false,
            ...extra
        };
    }

    workflowOutcome({ completed = false, reason = '', workspacePath = '' } = {}) {
        return {
            type: 'workflow_outcome',
            provisional: false,
            completed: !!completed,
            reason: String(reason || ''),
            workspacePath: String(workspacePath || '')
        };
    }
}

export default new WorkflowEventService();
