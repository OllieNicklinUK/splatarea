class WorkflowCompletionService {
    hasUnresolvedAppIdPlaceholder(summary = '') {
        const text = String(summary || '');
        if (/authoritative_app_id:\s*unresolved/i.test(text)) return true;
        if (/app id authority:\s*your_app_id/i.test(text)) return true;
        return false;
    }

    latestVerificationEntry(state = {}, type = '') {
        const entries = Array.isArray(state?.verificationLedger) ? state.verificationLedger : [];
        const filtered = entries.filter((entry) => String(entry?.type || '') === String(type || ''));
        return filtered.length ? filtered[filtered.length - 1] : null;
    }

    async evaluateCompletionVerdict({
        state = {},
        workspacePath = '',
        projectContextSummary = '',
        checkAppIdIntegrity,
        hasRuntimeRevalidationAfterLatestFix,
        detectRuntimeBlockerSignatures,
        requiresPreviewProbeEvidence,
        hasAnyPreviewProbeEvent,
        hasBlockingPreviewProbeFailure,
        runTemplateCompletionGates
    } = {}) {
        if (this.hasUnresolvedAppIdPlaceholder(projectContextSummary)) {
            return { ok: false, code: 'app_id_unresolved', reason: 'App ID authority unresolved' };
        }

        const completionAppIdIntegrity = await checkAppIdIntegrity(state, workspacePath, projectContextSummary);
        if (!completionAppIdIntegrity.ok) {
            return {
                ok: false,
                code: 'app_id_integrity',
                reason: completionAppIdIntegrity.reason || 'App ID integrity check failed.'
            };
        }

        if (!hasRuntimeRevalidationAfterLatestFix(state)) {
            return {
                ok: false,
                code: 'missing_runtime_revalidation',
                reason: 'Missing runtime revalidation after fix'
            };
        }

        const finalRuntimeBlockers = await detectRuntimeBlockerSignatures(workspacePath, []);
        if (finalRuntimeBlockers.length > 0) {
            return {
                ok: false,
                code: 'runtime_blockers',
                reason: `Runtime blocker signatures unresolved (${finalRuntimeBlockers.map((b) => b.id).join(', ')})`
            };
        }

        const latestVerifier = this.latestVerificationEntry(state, 'verifier');
        if (latestVerifier && ['fail', 'error'].includes(String(latestVerifier.status || '').toLowerCase())) {
            return {
                ok: false,
                code: 'verifier_gate',
                reason: latestVerifier.summary || `Verifier ${latestVerifier.status}`
            };
        }

        const latestPreviewProbe = this.latestVerificationEntry(state, 'preview_probe');
        if (requiresPreviewProbeEvidence(state)) {
            if (!latestPreviewProbe && !hasAnyPreviewProbeEvent(state)) {
                return {
                    ok: false,
                    code: 'preview_probe_missing',
                    reason: 'Runtime/browser evidence missing'
                };
            }
            if (latestPreviewProbe && ['fail', 'error'].includes(String(latestPreviewProbe.status || '').toLowerCase())) {
                return {
                    ok: false,
                    code: 'preview_probe_failed',
                    reason: latestPreviewProbe.summary || 'Preview runtime checks failed'
                };
            }
            if (!latestPreviewProbe && hasBlockingPreviewProbeFailure(state)) {
                return {
                    ok: false,
                    code: 'preview_probe_failed',
                    reason: 'Preview runtime checks failed'
                };
            }
        }

        const templateGate = await runTemplateCompletionGates(state, workspacePath, projectContextSummary);
        if (!templateGate.pass) {
            const reasons = (templateGate.blocking || [])
                .map((gate) => `${gate.gate}: ${gate.reason || gate.status}`)
                .join(' | ');
            return {
                ok: false,
                code: 'template_gate',
                reason: `Template required gates failed${reasons ? ` (${reasons})` : ''}`
            };
        }

        return { ok: true, code: 'pass', reason: '' };
    }

    buildOutcomeNotice({ state = {}, completed = false, reason = '', resolveLatestPreviewUrl }) {
        const previewUrl = resolveLatestPreviewUrl(state);
        const appId = String(state?.runtimeFlags?.appIdAuthority?.value || '');
        const headline = completed
            ? '✅ App Generation/Fix Flow Completed'
            : '⚠️ App Generation/Fix Flow Paused';
        const lines = [headline];
        if (reason) lines.push(`Reason: ${reason}`);
        if (appId) lines.push(`App ID: ${appId}`);
        lines.push(`Preview URL: ${previewUrl || 'not available yet'}`);
        // Machine-readable signal for the frontend My Apps gallery
        if (previewUrl) lines.push(`FINAL_PREVIEW_URL: ${previewUrl}`);
        lines.push(completed ? 'Next: open the preview URL to test.' : 'Next: open the preview URL (if available) and continue fix/retest.');
        return lines.join('\n');
    }
}

export default new WorkflowCompletionService();
