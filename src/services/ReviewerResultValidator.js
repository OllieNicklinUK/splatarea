class ReviewerResultValidator {
    _extractPreviewUrlFallback(state = {}) {
        const candidates = [
            String(state?.projectContextSummary || ''),
            JSON.stringify(state?.runReport?.events || [])
        ];
        for (const text of candidates) {
            const match = String(text).match(/https:\/\/worlds\.viverse\.com\/[^\s)"']+/i);
            if (match?.[0]) return match[0];
        }
        return '';
    }

    parse(fullResponse = '') {
        const reviewJson = JSON.parse(String(fullResponse || '').replace(/```json\n?|\n?```/g, '').trim());
        const validStatus = reviewJson && (reviewJson.status === 'pass' || reviewJson.status === 'fail');
        if (!validStatus) {
            throw new Error('INVALID_REVIEWER_SCHEMA: missing status');
        }

        return {
            status: reviewJson.status,
            feedback: String(reviewJson.feedback || ''),
            severity: String(reviewJson.severity || ''),
            blockingItems: Array.isArray(reviewJson.blocking_items) ? [...reviewJson.blocking_items] : [],
            evidence: Array.isArray(reviewJson.evidence) ? [...reviewJson.evidence] : [],
            runtimeChecks: Array.isArray(reviewJson.runtime_checks) ? reviewJson.runtime_checks : [],
            artifactPaths: Array.isArray(reviewJson.artifact_paths) ? reviewJson.artifact_paths : [],
            previewUrlTested: String(reviewJson.preview_url_tested || '').trim()
        };
    }

    finalize({
        parsed = {},
        state = {},
        requiredChecks = [],
        runtimeBlockers = [],
        baselineRegressions = []
    } = {}) {
        const reviewJson = {
            status: String(parsed.status || ''),
            feedback: String(parsed.feedback || ''),
            severity: String(parsed.severity || '')
        };
        const blockingItems = Array.isArray(parsed.blockingItems) ? [...parsed.blockingItems] : [];
        const evidence = Array.isArray(parsed.evidence) ? [...parsed.evidence] : [];
        const runtimeChecks = Array.isArray(parsed.runtimeChecks) ? parsed.runtimeChecks : [];
        const artifactPaths = Array.isArray(parsed.artifactPaths) ? parsed.artifactPaths : [];
        const previewUrlTested = String(parsed.previewUrlTested || this._extractPreviewUrlFallback(state) || '').trim();

        const lastClaim = state?.runtimeFlags?.lastCoderComplianceClaim;
        const lastGate = state?.runtimeFlags?.lastCoderGate;
        const conflictingClaim =
            !!lastClaim?.claimed &&
            String(lastGate?.status || '').toLowerCase() === 'fail' &&
            Array.isArray(lastGate?.findings) &&
            lastGate.findings.length > 0;

        if (conflictingClaim) {
            const findingLines = lastGate.findings
                .slice(0, 8)
                .map((f) => `${f.ruleId || 'unknown-rule'}: ${f.message || 'failed'}`);
            reviewJson.status = 'fail';
            reviewJson.feedback = `${String(reviewJson.feedback || '')}\nGate conflict: coder claimed compliance but deterministic gate still has findings.`;
            for (const line of findingLines) {
                if (!blockingItems.includes(line)) blockingItems.push(line);
            }
            if (!evidence.includes('deterministic fast gate reported unresolved findings after coder compliance claim')) {
                evidence.push('deterministic fast gate reported unresolved findings after coder compliance claim');
            }
        }

        for (const blocker of runtimeBlockers) {
            const line = `${blocker.message} Evidence: ${Array.isArray(blocker.artifacts) ? blocker.artifacts.join(', ') : ''}`;
            if (!blockingItems.includes(line)) blockingItems.push(line);
        }

        if (baselineRegressions.length > 0) {
            reviewJson.status = 'fail';
            const baselineLines = baselineRegressions.map((entry) => `Baseline contract regression detected: ${entry}`);
            for (const line of baselineLines) {
                if (!blockingItems.includes(line)) blockingItems.push(line);
            }
            if (!evidence.includes('baseline-contract guard failed in reviewer parse gate')) {
                evidence.push('baseline-contract guard failed in reviewer parse gate');
            }
        }

        const normalizedRequiredChecks = (Array.isArray(requiredChecks) && requiredChecks.length
            ? requiredChecks
            : ['auth_profile', 'matchmaking'])
            .map((value) => String(value || '').trim().toLowerCase())
            .filter(Boolean);
        const checkMap = new Map(
            runtimeChecks
                .filter((entry) => entry && typeof entry === 'object')
                .map((entry) => [String(entry.name || '').trim().toLowerCase(), String(entry.status || '').trim().toLowerCase()])
        );
        const missingChecks = normalizedRequiredChecks.filter((key) => !checkMap.has(key));

        if (reviewJson.status === 'fail') {
            if (blockingItems.length === 0) {
                throw new Error('INVALID_REVIEWER_SCHEMA: blocking_items required when status=fail');
            }
        } else {
            if (runtimeBlockers.length > 0) {
                throw new Error(
                    `INVALID_REVIEWER_SCHEMA: pass status cannot include runtime blocker signatures (${runtimeBlockers.map((b) => b.id).join(', ')})`
                );
            }
            if (missingChecks.length > 0) {
                throw new Error(`INVALID_REVIEWER_SCHEMA: missing runtime_checks: ${missingChecks.join(', ')}`);
            }
            if (normalizedRequiredChecks.some((key) => checkMap.get(key) !== 'pass')) {
                throw new Error(`INVALID_REVIEWER_SCHEMA: pass status requires ${normalizedRequiredChecks.join('+')} runtime_checks=pass`);
            }
            if (evidence.length < 2) {
                throw new Error('INVALID_REVIEWER_SCHEMA: pass status requires at least 2 evidence entries');
            }
            if (artifactPaths.length < 1) {
                throw new Error('INVALID_REVIEWER_SCHEMA: pass status requires at least 1 artifact path');
            }
            if (!previewUrlTested) {
                throw new Error('INVALID_REVIEWER_SCHEMA: pass status requires preview_url_tested');
            }
        }

        return {
            status: reviewJson.status,
            feedback: String(reviewJson.feedback || ''),
            severity: String(reviewJson.severity || ''),
            blockingItems,
            evidence,
            runtimeChecks,
            artifactPaths,
            previewUrlTested,
            requiredChecks: normalizedRequiredChecks,
            missingChecks
        };
    }

    parseAndValidate(input = {}) {
        return this.finalize({
            ...input,
            parsed: this.parse(input.fullResponse)
        });
    }
}

export default new ReviewerResultValidator();
