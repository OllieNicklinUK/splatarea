class WorkflowFinalStateService {
    buildFinalOutcome(state = {}, { resolveLatestPreviewUrl } = {}) {
        const previewUrl = typeof resolveLatestPreviewUrl === 'function'
            ? String(resolveLatestPreviewUrl(state) || '')
            : '';
        return {
            status: String(state?.status || ''),
            appId: String(state?.runtimeFlags?.appIdAuthority?.value || ''),
            previewUrl,
            templateId: String(state?.templateContext?.templateId || ''),
            request: String(state?.request || ''),
            completedAt: new Date().toISOString()
        };
    }

    buildCanonicalSummary(state = {}, outcome = {}) {
        const lines = [
            `FINAL_STATUS: ${String(outcome.status || state?.status || 'unknown')}`
        ];
        if (outcome.appId) lines.push(`FINAL_APP_ID: ${outcome.appId}`);
        if (outcome.previewUrl) lines.push(`FINAL_PREVIEW_URL: ${outcome.previewUrl}`);
        if (outcome.templateId) lines.push(`FINAL_TEMPLATE_ID: ${outcome.templateId}`);
        if (outcome.completedAt) lines.push(`FINAL_COMPLETED_AT: ${outcome.completedAt}`);
        return lines.join('\n');
    }

    applyCompletionState(state = {}, { resolveLatestPreviewUrl, projectContextSummary = '' } = {}) {
        const outcome = this.buildFinalOutcome(state, { resolveLatestPreviewUrl });
        const cleanedSummary = String(projectContextSummary || '')
            .split('\n')
            .filter((line) => !/^\s*FINAL_(STATUS|APP_ID|PREVIEW_URL|TEMPLATE_ID|COMPLETED_AT):/i.test(String(line || '')))
            .join('\n')
            .trimEnd();
        const canonicalSummary = this.buildCanonicalSummary(state, outcome);
        state.finalOutcome = outcome;
        state.projectContextSummary = [cleanedSummary, canonicalSummary].filter(Boolean).join('\n');
        return outcome;
    }
}

export default new WorkflowFinalStateService();
