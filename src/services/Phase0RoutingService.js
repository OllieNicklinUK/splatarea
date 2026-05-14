class Phase0RoutingService {
    _textParts(parts = []) {
        if (!Array.isArray(parts)) return [];
        return parts
            .map((p) => {
                if (typeof p === 'string') return p;
                if (p && typeof p.text === 'string') return p.text;
                return '';
            })
            .filter(Boolean);
    }

    _historyToText(history = []) {
        if (!Array.isArray(history)) return '';
        const recent = history.slice(-10);
        const lines = [];
        for (const turn of recent) {
            const role = String(turn?.role || '');
            const texts = this._textParts(turn?.parts || []);
            const fallback = typeof turn?.content === 'string' ? turn.content : (typeof turn?.text === 'string' ? turn.text : '');
            const content = [...texts, fallback].filter(Boolean).join('\n').trim();
            if (!content) continue;
            lines.push(`[${role}] ${content.slice(0, 600)}`);
        }
        return lines.join('\n');
    }

    _isContinuationRequest(text = '') {
        return /^(resume|continue|proceed|go on|next step|keep going)\b/i.test(text) ||
            /\b(same request|same task|follow up|follow-up|based on previous)\b/i.test(text);
    }

    _isExplicitNewRequest(text = '') {
        return /\b(new request|new project|from scratch|start over|ignore previous|separate task)\b/i.test(text);
    }

    _hasProjectSignals(text = '') {
        const projectSignals = [
            /\b(build|create|generate|implement|code|publish|deploy|fix|debug|bug|error|exception|retest|test)\b/i,
            /\b(app|project|repo|workspace|template|viverse|sdk|playwright|leaderboard|matchmaking|auth)\b/i,
            /\b(req_\d{8,})\b/i
        ];
        return projectSignals.some((re) => re.test(text));
    }

    // True when message contains an explicit execution/action verb — actually wants something DONE.
    // "build", "create a project", "implement", "deploy", "publish" etc.
    // Deliberately narrow: domain words like "app", "auth", "template" alone do NOT qualify.
    _hasExplicitActionVerb(text = '') {
        return (
            /\b(build|implement|deploy|publish|scaffold|generate\s+(?:a|an|the|my)|create\s+(?:a|an|the|my)|set\s+up|integrate|add\s+(?:a|an|the))\b/i.test(text) ||
            /\b(fix|debug|patch|rewrite|refactor|migrate)\b.*\b(code|function|file|app|component|class|module|script)\b/i.test(text) ||
            /\b(run|execute|start|launch|restart|rebuild|retest|republish)\b.*\b(app|server|build|test|workflow)\b/i.test(text)
        );
    }

    // True when message is phrased as an information request / question.
    // These should go to GENERAL even if they contain project-domain vocabulary.
    _hasInfoQueryIntent(text = '') {
        return (
            /^(what|how|why|when|where|who|which|is|are|does|do|can|could|should|would|tell me|explain|describe|clarify|search|find|list|show me|give me|help me understand|what'?s|how'?s)\b/i.test(text) ||
            /\b(what is|what are|what does|what do|how does|how do|how can|how should|why does|why is|when should|which one|can you explain|help me understand|tell me about|search for|look up|find out)\b/i.test(text)
        );
    }

    _hasGeneralSignals(text = '') {
        return /^(hi|hello|hey|thanks|thank you|good morning|good night)\b/i.test(text) ||
            /\b(what is|how are you|who are you|tell me about)\b/i.test(text);
    }

    _historyHasActiveWorkflow(historyText = '') {
        const workflowSignals = [
            /\bagent \[(architect|coder|reviewer|verifier)\]/i,
            /\bworkflow\b/i,
            /\btask[_\s-]?(started|failed|completed)\b/i,
            /\breq_\d{8,}\b/i,
            /\bcompliance gate\b/i,
            /\bpreview url\b/i,
            /\bsandboxed workspace\b/i
        ];
        return workflowSignals.some((re) => re.test(historyText));
    }

    _hasDebugSignals(text = '') {
        return /\b(debug|fix|bug|error|failing|failure|stack trace|exception|regression)\b/i.test(text);
    }

    _hasStatusQuerySignals(text = '') {
        return (
            /\b(status|progress|state|completed|done|finish|finished|pending|failed|block(ed)?|running)\b/i.test(text) &&
            /\b(verifier|reviewer|coder|architect|workflow|task|job|run|req_\d{8,})\b/i.test(text)
        ) || /^(is|did|has)\s+.*\b(verifier|reviewer|coder|architect)\b.*\b(done|completed|finish|finished)\b/i.test(text);
    }

    _toConfidence(value, fallback = 0.6) {
        const n = Number(value);
        if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
        return fallback;
    }

    _extractJsonObject(raw = '') {
        const text = String(raw || '').trim();
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch (_) {
            // fall through to fenced/block extraction
        }
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fenced?.[1]) {
            try {
                return JSON.parse(fenced[1]);
            } catch (_) {
                // fall through
            }
        }
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
            const candidate = text.slice(start, end + 1);
            try {
                return JSON.parse(candidate);
            } catch (_) {
                return null;
            }
        }
        return null;
    }

    interpret({ message = '', history = [] } = {}) {
        const text = String(message || '').trim();
        const lower = text.toLowerCase();
        const historyText = this._historyToText(history);
        const hasActiveWorkflow = this._historyHasActiveWorkflow(historyText);
        const hasDebugSignals = this._hasDebugSignals(lower);
        const hasStatusSignals = this._hasStatusQuerySignals(lower);
        const shortAckFollowUp = hasActiveWorkflow && /^(ok|yes|do it|do this|please do|then|and then|next)$/i.test(lower);

        if (!text) {
            return { route: 'GENERAL', phase0Mode: 'general', reason: 'empty_message', confidence: 1, intentType: 'GENERAL_QA' };
        }

        // Explicit workspace ID in message = unambiguous continuation — skip all other routing
        if (/\breq_\d{8,}\b/i.test(text) && this._isContinuationRequest(lower)) {
            return {
                route: 'PROJECT',
                phase0Mode: 'continuation',
                reason: 'explicit_workspace_id_continuation',
                confidence: 1.0,
                intentType: 'EXECUTION'
            };
        }

        // STATUS_QUERY must be checked before info-query guard — "is verifier completed"
        // starts with "is" which would otherwise be swallowed by _hasInfoQueryIntent.
        if (hasStatusSignals && !this._isContinuationRequest(lower)) {
            return {
                route: 'PROJECT',
                phase0Mode: hasActiveWorkflow ? 'continuation' : 'new_request',
                reason: hasActiveWorkflow ? 'status_query_with_active_workflow' : 'status_query_without_active_workflow',
                confidence: hasActiveWorkflow ? 0.95 : 0.86,
                intentType: 'STATUS_QUERY'
            };
        }

        // Info queries go to GENERAL regardless of domain vocabulary or workflow history.
        // "what is auth" / "how does leaderboard work" / "explain templates" → GENERAL.
        // Only override to PROJECT if there's also an explicit action verb.
        if (this._hasInfoQueryIntent(lower) && !this._hasExplicitActionVerb(lower)) {
            return {
                route: 'GENERAL',
                phase0Mode: 'general',
                reason: 'info_query_intent',
                confidence: 0.88,
                intentType: 'GENERAL_QA'
            };
        }

        if (this._isExplicitNewRequest(lower)) {
            return { route: 'PROJECT', phase0Mode: 'new_request', reason: 'explicit_new_request', confidence: 0.95, intentType: 'EXECUTION' };
        }

        if (this._isContinuationRequest(lower)) {
            return { route: 'PROJECT', phase0Mode: 'continuation', reason: 'explicit_continuation', confidence: 0.95, intentType: 'EXECUTION' };
        }

        if (shortAckFollowUp) {
            return { route: 'PROJECT', phase0Mode: 'continuation', reason: 'short_followup_with_active_workflow', confidence: 0.92, intentType: 'EXECUTION' };
        }

        const hasProjectSignals = this._hasProjectSignals(lower);
        const hasGeneralSignals = this._hasGeneralSignals(lower);

        if (hasProjectSignals && hasActiveWorkflow) {
            // Only treat as workflow continuation if there's actual execution intent.
            // Pure domain questions ("what is auth?") with workflow history stay GENERAL.
            if (this._hasExplicitActionVerb(lower) || hasDebugSignals) {
                return { route: 'PROJECT', phase0Mode: 'continuation', reason: 'project_signals_with_active_workflow', confidence: 0.9 };
            }
        }

        if (hasProjectSignals) {
            return {
                route: 'PROJECT',
                phase0Mode: hasDebugSignals ? 'continuation' : 'new_request',
                reason: hasDebugSignals ? 'debug_signals' : 'project_signals',
                confidence: hasDebugSignals ? 0.7 : 0.78,
                intentType: 'EXECUTION'
            };
        }

        if (hasGeneralSignals) {
            return { route: 'GENERAL', phase0Mode: 'general', reason: 'general_signals', confidence: 0.88, intentType: 'GENERAL_QA' };
        }

        if (hasActiveWorkflow) {
            return { route: 'PROJECT', phase0Mode: 'continuation', reason: 'default_to_continuation_with_active_workflow', confidence: 0.7, intentType: 'EXECUTION' };
        }

        return { route: 'GENERAL', phase0Mode: 'general', reason: 'default_general', confidence: 0.62, intentType: 'GENERAL_QA' };
    }

    needsLlmRouting(heuristic = {}) {
        const confidence = this._toConfidence(heuristic?.confidence, 0.6);
        const reason = String(heuristic?.reason || '').toLowerCase();
        if (confidence < 0.82) return true;
        if (reason.includes('default')) return true;
        if (reason.includes('debug_signals')) return true;
        return false;
    }

    buildRouterPrompt({ message = '', history = [], heuristic = null } = {}) {
        const historyText = this._historyToText(history);
        return [
            'You are Phase-0 request router for a multi-agent coding assistant.',
            'Decide if request is continuation or new request, and route target worker.',
            '',
            'Return STRICT JSON ONLY (no markdown):',
            '{"route":"GENERAL|PROJECT","phase0Mode":"general|continuation|new_request","targetAgent":"GENERAL|ORCHESTRATOR","intentType":"STATUS_QUERY|EXECUTION|GENERAL_QA","confidence":0.0,"reason":"short_reason"}',
            '',
            'Rules:',
            '- GENERAL for casual Q&A/chat not requiring project execution.',
            '- PROJECT for build/fix/debug/test/publish/app coding requests.',
            '- continuation when clearly following active prior workflow/task.',
            '- new_request when user starts a separate/new task.',
            '- STATUS_QUERY when user asks about current progress/completion of workflow/agent/task.',
            '- targetAgent GENERAL only when route=GENERAL; otherwise ORCHESTRATOR.',
            '',
            `Current message:\n${String(message || '').slice(0, 2000)}`,
            '',
            `Recent history:\n${historyText || '(none)'}`,
            '',
            `Heuristic guess:\n${JSON.stringify(heuristic || {}, null, 2)}`
        ].join('\n');
    }

    parseLlmDecision(raw = '') {
        const parsed = this._extractJsonObject(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const route = String(parsed.route || '').toUpperCase();
        const phase0Mode = String(parsed.phase0Mode || '').toLowerCase();
        const targetAgent = String(parsed.targetAgent || '').toUpperCase();
        const intentType = String(parsed.intentType || '').toUpperCase();
        if (!['GENERAL', 'PROJECT'].includes(route)) return null;
        if (!['general', 'continuation', 'new_request'].includes(phase0Mode)) return null;
        const normalizedTarget = route === 'GENERAL' ? 'GENERAL' : 'ORCHESTRATOR';
        if (targetAgent && !['GENERAL', 'ORCHESTRATOR'].includes(targetAgent)) return null;
        const normalizedIntent = ['STATUS_QUERY', 'EXECUTION', 'GENERAL_QA'].includes(intentType)
            ? intentType
            : (route === 'GENERAL' ? 'GENERAL_QA' : 'EXECUTION');
        return {
            route,
            phase0Mode,
            targetAgent: normalizedTarget,
            intentType: normalizedIntent,
            confidence: this._toConfidence(parsed.confidence, 0.75),
            reason: String(parsed.reason || 'llm_router')
        };
    }

    resolveDecision(heuristic = {}, llm = null) {
        const base = {
            route: heuristic?.route || 'GENERAL',
            phase0Mode: heuristic?.phase0Mode || 'general',
            targetAgent: heuristic?.route === 'PROJECT' ? 'ORCHESTRATOR' : 'GENERAL',
            intentType: heuristic?.intentType || (heuristic?.route === 'GENERAL' ? 'GENERAL_QA' : 'EXECUTION'),
            reason: heuristic?.reason || 'heuristic_default',
            confidence: this._toConfidence(heuristic?.confidence, 0.6),
            decisionSource: 'heuristic'
        };
        if (!llm) return base;
        return {
            route: llm.route,
            phase0Mode: llm.phase0Mode,
            targetAgent: llm.targetAgent,
            intentType: llm.intentType || (llm.route === 'GENERAL' ? 'GENERAL_QA' : 'EXECUTION'),
            reason: `llm:${llm.reason}`,
            confidence: this._toConfidence(llm.confidence, 0.75),
            decisionSource: 'llm'
        };
    }
}

export default new Phase0RoutingService();
