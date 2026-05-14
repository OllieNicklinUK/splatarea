class VerifierResultValidator {
    _extractJsonObject(text = '') {
        const raw = String(text || '').trim();
        if (!raw) return {};

        const fenced = raw.match(/```json\s*([\s\S]*?)```/i)?.[1];
        const candidate = String(fenced || raw).trim();

        try {
            return JSON.parse(candidate);
        } catch {}

        const start = candidate.indexOf('{');
        if (start < 0) {
            throw new Error('INVALID_VERIFIER_SCHEMA: missing json object');
        }

        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < candidate.length; i += 1) {
            const ch = candidate[i];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (ch === '\\') {
                    escaped = true;
                } else if (ch === '"') {
                    inString = false;
                }
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === '{') depth += 1;
            if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    return JSON.parse(candidate.slice(start, i + 1));
                }
            }
        }

        throw new Error('INVALID_VERIFIER_SCHEMA: missing complete json object');
    }

    parseAndValidate(fullResponse = '') {
        const verifierJson = this._extractJsonObject(fullResponse);
        const status = String(verifierJson?.status || '').trim().toLowerCase();
        if (status !== 'pass' && status !== 'fail') {
            throw new Error('INVALID_VERIFIER_SCHEMA: missing status');
        }

        const reasons = Array.isArray(verifierJson.reasons)
            ? verifierJson.reasons.map((reason) => String(reason || '')).filter(Boolean)
            : [String(verifierJson.reasons || '').trim()].filter(Boolean);

        return {
            status,
            reasons,
            details: verifierJson
        };
    }
}

export default new VerifierResultValidator();
