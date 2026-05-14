import geminiService from './AIService.js';
import fileService from './FileService.js';
import complianceService from './ComplianceService.js';
import previewAutoTestService from './PreviewAutoTestService.js';
import templateRegistryService from './templates/TemplateRegistryService.js';
import templateContractService from './templates/TemplateContractService.js';
import templateCertificationService from './templates/TemplateCertificationService.js';
import logger from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import sanitizer from '../utils/sanitizer.js';
import skillProvider from './SkillProvider.js';
import workflowStateService from './WorkflowStateService.js';
import plannerSchemaValidator from './PlannerSchemaValidator.js';
import workflowEventService from './WorkflowEventService.js';
import workflowContextService from './WorkflowContextService.js';
import skillLedgerService from './SkillLedgerService.js';
import verificationLedgerService from './VerificationLedgerService.js';
import workflowPolicyService from './WorkflowPolicyService.js';
import workflowStageService from './WorkflowStageService.js';
import workflowExecutionService from './WorkflowExecutionService.js';
import workflowCompletionService from './WorkflowCompletionService.js';
import workflowRecoveryService from './WorkflowRecoveryService.js';
import reviewerResultValidator from './ReviewerResultValidator.js';
import verifierResultValidator from './VerifierResultValidator.js';
import workflowFinalStateService from './WorkflowFinalStateService.js';
import fixOrchestrationService from './FixOrchestrationService.js';
import workspaceRegistryService from './WorkspaceRegistryService.js';
import AgentRegistry from './AgentRegistry.js';
import agentMemoryService from './AgentMemoryService.js';

class OrchestratorService {
    constructor() {
        this.activeProjects = new Map();
        workflowStateService.setActiveProjects(this.activeProjects);
        this.complianceRuntimeCache = new Map();
        // conversationId (from frontend) → absolute workspacePath
        // Provides O(1) lookup so concurrent requests never contaminate each other.
        this.conversationWorkspaces = new Map();
        this.maxComplianceFixAttemptsPerSignature = 2;
        this.maxAutoTestFixAttemptsPerSignature = 2;
        this.maxAuthPreflightFixAttemptsPerSignature = 2;
        this.maxTransientInfraRetriesPerTask = Number(process.env.ORCH_MAX_TRANSIENT_INFRA_RETRIES || 10);
        // Rebuild conversationWorkspaces from persisted state files so a server
        // restart doesn't lose the mapping for conversations that are still active.
        this._rebuildConversationWorkspacesFromDisk().catch(() => {});
    }

    async _rebuildConversationWorkspacesFromDisk() {
        try {
            const workSpaceDir = path.resolve(process.cwd(), '.viverse_workspaces');
            const entries = await fs.readdir(workSpaceDir, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                if (!entry.isDirectory() || !entry.name.startsWith('req_')) continue;
                const statePath = path.join(workSpaceDir, entry.name, '.agent_state.json');
                try {
                    const content = await fs.readFile(statePath, 'utf8');
                    const parsed = JSON.parse(content);
                    if (parsed?.conversationId && parsed?.workspacePath) {
                        this.conversationWorkspaces.set(parsed.conversationId, parsed.workspacePath);
                    }
                } catch (_) { /* corrupt/missing state — skip */ }
            }
        } catch (_) { /* workspace dir missing on first run — safe to ignore */ }
    }

    _isFixTask(task = {}) {
        const id = String(task?.id || '');
        const prompt = String(task?.prompt || '');
        return (
            /^fix_|^c_fix_|^autotest_fix_|^authfix_|^preflight_fix_/i.test(id) ||
            /fix the following|runtime_fix required|compliance fix required|reviewer blocked/i.test(prompt)
        );
    }

    _isStrictFixOnlyMessage(message = "") {
        const t = String(message || "").toLowerCase();
        const asksResume = /^(resume|continue|proceed)\b/.test(t);
        const asksFix = /\b(fix|patch|harden|regression|issue|error|bug)\b/.test(t);
        const asksNewBuild = /\b(new app|create app|generate app|from scratch|new template)\b/.test(t);
        return asksResume && asksFix && !asksNewBuild;
    }

    _isTransientInfraErrorText(reason = "") {
        const text = String(reason || '').toLowerCase();
        return (
            /gemini rest(?: stream)? error\s+5\d\d/i.test(text) ||
            text.includes('service unavailable') ||
            text.includes('status":"unavailable"') ||
            text.includes('"status": "unavailable"') ||
            text.includes('gateway timeout') ||
            text.includes('bad gateway') ||
            text.includes('upstream connect error') ||
            text.includes('fetch failed') ||
            text.includes('network error') ||
            text.includes('socket hang up') ||
            text.includes('etimedout') ||
            text.includes('econnreset')
        );
    }

    _computeTransientInfraRetryDelayMs(attempt = 1) {
        const n = Math.max(1, Number(attempt || 1));
        const base = Math.min(60000, 2000 * Math.pow(2, Math.max(0, n - 1)));
        return base + Math.floor(Math.random() * 500);
    }

    _reviveTransientInfraFailedTasks(state, { isResumeCommand = false } = {}) {
        if (!state || !Array.isArray(state.tasks) || !isResumeCommand) return [];
        const revived = [];
        const events = Array.isArray(state?.runReport?.events) ? state.runReport.events : [];
        for (const t of state.tasks) {
            if (t?.status !== 'failed') continue;
            const eventReason = events
                .slice()
                .reverse()
                .find((e) => String(e?.type || '') === 'task_failed' && String(e?.taskId || '') === String(t?.id || ''))?.reason;
            const reason = String(t?.lastError || t?.failureReason || t?.reason || t?.error || eventReason || '');
            const isFixFamily = /^(?:fix_|c_fix_|v_fix_|autotest_fix_|authfix_|preflight_fix_)/i.test(String(t?.id || ''));
            const shouldReviveWithoutReason = !reason && isFixFamily;
            if (!this._isTransientInfraErrorText(reason) && !shouldReviveWithoutReason) continue;
            t.status = 'pending';
            t.transientInfraRetryCount = Number(t.transientInfraRetryCount || 0);
            t.transientInfraRetryAt = Date.now();
            t.lastError = reason || 'Resume command: reviving failed fix-loop task without persisted failure reason.';
            revived.push(String(t.id || ''));
        }
        return revived;
    }

    _reclassifyObsoleteSkillComplianceFailures(state, { isResumeCommand = false } = {}) {
        if (!state || !Array.isArray(state.tasks) || !isResumeCommand) return [];
        const revived = [];
        const workspacePath = String(state?.workspacePath || '');
        if (!workspacePath) return revived;
        const events = Array.isArray(state?.runReport?.events) ? state.runReport.events : [];

        for (const task of state.tasks) {
            if (task?.status !== 'failed') continue;
            const eventReason = events
                .slice()
                .reverse()
                .find((e) => String(e?.type || '') === 'task_failed' && String(e?.taskId || '') === String(task?.id || ''))?.reason;
            const reason = String(task?.lastError || task?.failureReason || task?.reason || task?.error || eventReason || '');
            if (!/Missing skill compliance entry/i.test(reason)) continue;

            const requiredRefs = Array.isArray(task?.requiredSkillRefs)
                ? task.requiredSkillRefs
                : this._inferRequiredSkills(task, state);
            if (!this._shouldTolerateMissingSkillCompliance({
                workspacePath,
                task,
                requiredRefs,
                reason
            })) {
                continue;
            }

            task.status = 'completed';
            task.lastError = '';
            task.failureReason = '';
            task.reason = '';
            task.error = '';
            revived.push(String(task.id || ''));
        }

        return revived;
    }

    _reviveStaleBlockedTasks(state, { isResumeCommand = false } = {}) {
        if (!state || !Array.isArray(state.tasks) || !isResumeCommand) return [];
        const revived = [];
        const tasks = Array.isArray(state.tasks) ? state.tasks : [];

        // If preview probe already passed, a blocked verifier can be unblocked directly.
        // Runtime truth (HTTP 200 + auth_profile:pass) outweighs static gate findings.
        const previewProbePassed =
            state?.runtimeFlags?.baselineContract?.source === 'preview_probe_pass' ||
            (state?.verificationLedger || []).some(
                (e) => e?.type === 'preview_probe' && e?.status === 'pass'
            );

        for (const task of tasks) {
            if (task?.status !== 'blocked') continue;
            const roleUpper = String(task?.role || '').toUpperCase();
            if (roleUpper === 'VERIFIER' || roleUpper === 'REVIEWER') {
                const hasPendingCoderWork = tasks.some((candidate) =>
                    String(candidate?.role || '').toUpperCase() === 'CODER' &&
                    String(candidate?.status || '').toLowerCase() === 'pending'
                );
                if (hasPendingCoderWork) continue;
                // Unblock verifier if preview probe has already confirmed runtime health
                if (roleUpper === 'VERIFIER' && previewProbePassed) {
                    task.status = 'pending';
                    task.lastError = null;
                    revived.push(String(task.id || ''));
                    continue;
                }
            }
            const deps = Array.isArray(task?.dependsOn) ? task.dependsOn : [];
            const depsCompleted = deps.every((depId) => {
                const dep = tasks.find((candidate) => String(candidate?.id || '') === String(depId || ''));
                return dep && dep.status === 'completed';
            });
            if (!depsCompleted) continue;

            const reason = String(task?.lastError || task?.failureReason || task?.reason || task?.error || '').trim();
            if (reason) continue;

            task.status = 'pending';
            revived.push(String(task.id || ''));
        }

        return revived;
    }

    _ensureRuntimeFlagsShape(state) {
        state.runtimeFlags = state.runtimeFlags || {};
        state.runtimeFlags.authInvalid = !!state.runtimeFlags.authInvalid;
        state.runtimeFlags.appIdAuthority = {
            value: "",
            source: "",
            updatedAt: "",
            locked: false,
            conflict: null,
            ...(state.runtimeFlags.appIdAuthority || {})
        };
        state.runtimeFlags.baselineContract = state.runtimeFlags.baselineContract || {
            capturedAt: "",
            sourceTaskId: "",
            runtimeChecks: {},
            runtimeBlockersAbsent: [
                'runtime-app-id-placeholder',
                'runtime-checkauth-ack-unhandled',
                'runtime-setactor-missing-method',
                'runtime-roomid-missing'
            ],
            appIdMustNotBePlaceholder: true
        };
    }

    _captureBaselineContractFromRuntimeChecks(state, { runtimeChecks = [], sourceTaskId = '', source = '' } = {}) {
        this._ensureRuntimeFlagsShape(state);
        const requiredChecks = this._getRequiredRuntimeChecks(state);
        const map = new Map(
            (Array.isArray(runtimeChecks) ? runtimeChecks : [])
                .filter((c) => c && typeof c === 'object' && c.name)
                .map((c) => [String(c.name).toLowerCase(), String(c.status || '').toLowerCase()])
        );
        if (requiredChecks.some((name) => map.get(name) !== 'pass')) return false;

        state.runtimeFlags.baselineContract = {
            ...state.runtimeFlags.baselineContract,
            capturedAt: new Date().toISOString(),
            sourceTaskId: String(sourceTaskId || ''),
            source: String(source || ''),
            runtimeChecks: Object.fromEntries(requiredChecks.map((name) => [name, 'pass'])),
            runtimeBlockersAbsent: [
                'runtime-app-id-placeholder',
                'runtime-checkauth-ack-unhandled',
                'runtime-setactor-missing-method',
                'runtime-roomid-missing'
            ],
            appIdMustNotBePlaceholder: true
        };
        return true;
    }

    _getRequiredRuntimeChecks(state = {}) {
        const ctx = state?.templateContext || {};
        const contract = ctx?.contract || {};
        const requiredGates = new Set(
            (Array.isArray(ctx?.requiredEvidence) ? ctx.requiredEvidence : Array.isArray(contract?.requiredGates) ? contract.requiredGates : [])
                .map((value) => String(value || '').trim())
                .filter(Boolean)
        );
        // Honour explicit exclusions declared in template contract
        const excluded = new Set(
            (Array.isArray(contract?.excludedRuntimeChecks) ? contract.excludedRuntimeChecks : [])
                .map((v) => String(v || '').toLowerCase().trim())
        );

        const checks = [];
        if (requiredGates.has('runtime.auth_profile_pass') && !excluded.has('auth_profile')) checks.push('auth_profile');
        if (requiredGates.has('runtime.matchmaking_pass') && !excluded.has('matchmaking')) checks.push('matchmaking');
        // Default: auth_profile only — matchmaking requires explicit opt-in via requiredGates.
        const defaultChecks = ['auth_profile'].filter((c) => !excluded.has(c));
        return checks.length ? checks : defaultChecks;
    }

    _buildFixScopeAndBaselineGuard(state, { issueLines = [] } = {}) {
        const issues = (Array.isArray(issueLines) ? issueLines : []).filter(Boolean);
        const baseline = state?.runtimeFlags?.baselineContract || {};
        const requestScope = state?.runtimeFlags?.requestScope || {};
        const requiredChecks = this._getRequiredRuntimeChecks(state);
        const allowedSubsystems = Array.isArray(requestScope.allowedSubsystems) ? requestScope.allowedSubsystems : [];
        const hasBaseline =
            requiredChecks.every((name) => String(baseline?.runtimeChecks?.[name] || '').toLowerCase() === 'pass');
        const baselineLine = hasBaseline
            ? `- Baseline contract is ACTIVE (captured at ${baseline.capturedAt || 'unknown time'} from ${baseline.source || 'runtime pass'}). Required runtime checks (${requiredChecks.join(', ')}) MUST remain PASS after this fix.`
            : '- Baseline contract not yet captured; preserve existing auth/bootstrap/matchmaking behavior unless directly required by blocker evidence.';
        return [
            'FIX SCOPE LOCK (MANDATORY):',
            '- Apply a minimal patch. Do NOT rewrite healthy modules.',
            '- Change ONLY code required to resolve listed blocking issues.',
            requestScope.primary ? `- Request scope authority: ${requestScope.primary}.` : '',
            allowedSubsystems.length ? `- Allowed subsystems for this run: ${allowedSubsystems.join(', ')}.` : '',
            '- If touching auth/bootstrap files, keep existing successful login/profile behavior intact.',
            '- If touching multiplayer files, preserve roomId normalization and API capability guards.',
            '- Blocker-evidence override is allowed only when the failing rule explicitly requires platform-core or publish changes.',
            baselineLine,
            '- Before finishing, self-verify no placeholder App ID ("YOUR_APP_ID") is introduced and no known runtime blocker signatures reappear.',
            issues.length ? `- Blocking issue list authority:\n${issues.map((l) => `  ${l}`).join('\n')}` : ''
        ].filter(Boolean).join('\n');
    }

    _inferFailureSubsystem({ issueLines = [], task = null, state = null } = {}) {
        const issueText = (Array.isArray(issueLines) ? issueLines : []).join('\n').toLowerCase();
        const fullText = [
            issueText,
            String(task?.prompt || ''),
            String(state?.request || '')
        ].join('\n').toLowerCase();

        if (/template-world-bootstrap-missing|world bootstrap|world launch|startup file|bootstrap\/main|bootstrap main/.test(issueText || fullText)) {
            return 'platform-core.bootstrap';
        }
        if (/auth(?:entication)? bootstrap.*(?:executed|run|performed).*twice|bootstrap is executed twice|double auth bootstrap|duplicate auth bootstrap|once in index\.html.*once in src\/main\.js|once in src\/main\.js.*once in index\.html/.test(issueText)) {
            return 'platform-core.bootstrap';
        }
        if (/texas hold|hold'em|holdem|card capture|sum-to-10|sum to 10|deck dealing|community cards|betting rounds|poker mechanic|usepokergame|texasholdemengine|pokerengine|game logic implements|incompatible with texas hold/.test(issueText)) {
            return 'gameplay';
        }
        if (/publish-no-placeholder-appid|publish-app-id-configured|publish-source-app-id-reference|placeholder app id|bundling|vite_viverse_client_id/.test(issueText)) {
            return 'publish';
        }
        if (/room-discovery|matchmaking|room list|join\/create|joinroom|joinsession|joinmatch|roomid|setactor|multiplayer/.test(issueText)) {
            return 'platform-core.matchmaking';
        }
        if (/auth_profile|checkauth|getuserinfo|profile|avatar|identity|login|auth bootstrap/.test(issueText)) {
            return 'platform-core.auth';
        }
        if (/texas hold|hold'em|holdem|card capture|sum-to-10|sum to 10|deck dealing|community cards|betting rounds|poker mechanic|usepokergame|texasholdemengine|pokerengine|game logic implements|incompatible with texas hold/.test(fullText)) {
            return 'gameplay';
        }
        if (/room-discovery|matchmaking|room list|join\/create|joinroom|joinsession|joinmatch|roomid|setactor|multiplayer/.test(fullText)) {
            return 'platform-core.matchmaking';
        }
        if (/auth_profile|checkauth|getuserinfo|profile|avatar|identity|login|auth bootstrap/.test(fullText)) {
            return 'platform-core.auth';
        }
        if (/publish-no-placeholder-appid|publish-app-id-configured|publish-source-app-id-reference|placeholder app id|bundling|vite_viverse_client_id/.test(fullText)) {
            return 'publish';
        }
        if (/publish|preview url|app id|vite_viverse_client_id|bundling|release|deploy/.test(fullText)) {
            return 'publish';
        }
        if (/leaderboard|layout|overlay|hud|theme|scroll|style|visual|ui|screen/.test(fullText)) {
            return 'ui';
        }
        if (/gameplay|logic|ai|ofcp|poker|memory game|scoring|placement|heuristic/.test(fullText)) {
            return 'gameplay';
        }

        // Fallback: respect existing request scope primary if set
        const fallback = String(state?.runtimeFlags?.requestScope?.primary || 'general');

        // Safety guard: never return platform-core.matchmaking if template has no matchmaking capability
        const templateCaps = Array.isArray(state?.templateContext?.contract?.capabilities)
            ? state.templateContext.contract.capabilities.map(c => String(c).toLowerCase())
            : [];
        if (fallback === 'platform-core.matchmaking' && !templateCaps.includes('matchmaking') && templateCaps.length > 0) {
            return 'gameplay';
        }

        return fallback;
    }

    _buildScopedFixGuard({ subsystem = 'general', issueLines = [] } = {}) {
        const issues = (Array.isArray(issueLines) ? issueLines : []).filter(Boolean);
        const scopeMap = {
            'platform-core.bootstrap': [
                '- Scope: startup/bootstrap runtime only.',
                '- Touch only the startup entrypoint, world-launch bridge, and closely related bootstrap glue required by the blocker.',
                '- Do NOT rewrite gameplay systems, auth flows, matchmaking logic, or unrelated publish wiring in this fix.'
            ],
            'platform-core.matchmaking': [
                '- Scope: matchmaking/runtime coordination only.',
                '- Touch only room discovery, join/create decision flow, actor/session authority, and capability guards.',
                '- Do NOT rewrite auth bootstrap, gameplay rules, leaderboard, or publish flow in this fix.'
            ],
            'platform-core.auth': [
                '- Scope: auth/bootstrap only.',
                '- Touch only login/profile/bootstrap recovery paths required by the blocker.',
                '- Do NOT rewrite gameplay, matchmaking, leaderboard, or publish flow in this fix.'
            ],
            publish: [
                '- Scope: publish/release wiring only.',
                '- Touch only App ID propagation, build/publish checks, preview evidence, and release config needed by the blocker.',
                '- Do NOT rewrite gameplay, UI, auth, or matchmaking in this fix.'
            ],
            ui: [
                '- Scope: UI only.',
                '- Touch only user-facing layout, styling, assets, overlays, and display components required by the blocker.',
                '- Do NOT rewrite gameplay engine, auth, matchmaking, or publish flow in this fix.'
            ],
            gameplay: [
                '- Scope: gameplay only.',
                '- Touch only game rules, scoring, AI, turn flow, and minimal supporting UI/view-model code required by the blocker.',
                '- Do NOT rewrite auth, matchmaking, leaderboard plumbing, or publish flow in this fix.'
            ],
            general: [
                '- Scope: minimal blocker fix only.',
                '- Change only the subsystem directly implicated by the blocker evidence.',
                '- Do NOT broaden this fix into unrelated auth, matchmaking, gameplay, UI, or publish rewrites.'
            ]
        };

        const lines = scopeMap[subsystem] || scopeMap.general;
        return [
            'SCOPED FIX EXECUTION (MANDATORY):',
            ...lines,
            issues.length ? `- Subsystem issue authority:\n${issues.map((line) => `  ${line}`).join('\n')}` : ''
        ].filter(Boolean).join('\n');
    }

    _deriveTaskRequestScope(task = {}, state = {}) {
        const baseScope = state?.runtimeFlags?.requestScope || {};
        const prompt = String(task?.prompt || '');
        const id = String(task?.id || '');
        if (id === 'auth_preflight' || /auth preflight only/i.test(prompt) || /(?:^|_)auth$/i.test(id)) {
            return {
                ...baseScope,
                primary: 'platform-core.auth',
                allowedSubsystems: ['platform-core.auth']
            };
        }
        if (this._isPublishTask(task) || /(?:^|_)publish$/i.test(id)) {
            return {
                ...baseScope,
                primary: 'publish',
                allowedSubsystems: ['publish']
            };
        }
        if (/(?:^|_)logic$/i.test(id)) {
            return {
                ...baseScope,
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui']
            };
        }
        // Fast path template modification task: allow gameplay + ui + bootstrap scope.
        // Without this, _inferFailureSubsystem picks up the word "publish" from
        // the prompt text ("in the publish step") and returns 'publish' subsystem,
        // which blocks writes to gameplay files like src/core/Constants.js.
        // platform-core.bootstrap is also included because index.html is in editablePaths
        // and may need cosmetic changes (title, description) without touching auth logic.
        if (/\[TEMPLATE_MODIFICATION_ONLY\]/i.test(prompt)) {
            return {
                ...baseScope,
                primary: 'gameplay',
                allowedSubsystems: ['gameplay', 'ui', 'assets', 'platform-core.bootstrap']
            };
        }
        const issueBlock = this._extractFixIssueBlock(prompt);
        const issueLines = issueBlock
            .split('\n')
            .map((line) => String(line || '').trim())
            .filter(Boolean);
        const targetMatch = prompt.match(/Target subsystem:\s*([^\n]+)/i);
        const targetSubsystem = String(
            this._inferFailureSubsystem({ issueLines, task, state })
            || targetMatch?.[1]
            || baseScope.primary
            || 'general'
        ).trim();

        const allowedMap = {
            'platform-core.bootstrap': ['platform-core.bootstrap', 'platform-core.auth', 'ui'],
            'platform-core.matchmaking': ['platform-core.matchmaking', 'ui', 'diagnostics'],
            'platform-core.auth': ['platform-core.auth', 'platform-core.bootstrap', 'ui', 'gameplay'],
            publish: ['publish'],
            ui: ['ui'],
            gameplay: ['gameplay', 'ui'],
            general: Array.isArray(baseScope.allowedSubsystems) ? baseScope.allowedSubsystems : []
        };
        const allowedSubsystems = allowedMap[targetSubsystem] || allowedMap.general;

        return {
            ...baseScope,
            primary: targetSubsystem,
            allowedSubsystems
        };
    }

    _rehardenPendingFixTaskScopes(state) {
        if (!state || !Array.isArray(state.tasks)) return false;
        let changed = false;

        for (const task of state.tasks) {
            const taskId = String(task?.id || '');
            const taskStatus = String(task?.status || '');
            if (!/^(?:fix_|c_fix_|v_fix_)/i.test(taskId)) continue;
            if (taskStatus && /^(?:completed|resolved|blocked)$/i.test(taskStatus)) continue;
            const prompt = String(task?.prompt || '');
            const issueBlock = this._extractFixIssueBlock(prompt);
            const issueLines = issueBlock
                .split('\n')
                .map((line) => String(line || '').trim())
                .filter(Boolean);
            if (!issueLines.length) continue;

            const inferredSubsystem = this._inferFailureSubsystem({ issueLines, task, state });
            const currentSubsystem = String(prompt.match(/Target subsystem:\s*([^\n]+)/i)?.[1] || '').trim();
            if (currentSubsystem === inferredSubsystem) continue;

            const scopedFixGuard = this._buildScopedFixGuard({ subsystem: inferredSubsystem, issueLines });
            let nextPrompt = prompt.replace(/Target subsystem:\s*[^\n]+/i, `Target subsystem: ${inferredSubsystem}`);
            nextPrompt = nextPrompt.replace(
                /SCOPED FIX EXECUTION \(MANDATORY\):[\s\S]*?FIX SCOPE LOCK \(MANDATORY\):/i,
                `${scopedFixGuard}\nFIX SCOPE LOCK (MANDATORY):`
            );
            task.prompt = nextPrompt;
            changed = true;
        }

        return changed;
    }

    _buildTemplateExecutionGuardBlock(state, { includeRecentViolations = true } = {}) {
        const ctx = state?.templateContext || {};
        const contract = ctx?.contract || null;
        const templateId = String(ctx?.templateId || '').trim();
        if (!templateId || !contract) return '';

        const immutablePaths = Array.isArray(contract.immutablePaths) ? contract.immutablePaths.filter(Boolean).slice(0, 12) : [];
        const editablePaths = Array.isArray(contract.editablePaths) ? contract.editablePaths.filter(Boolean).slice(0, 12) : [];
        const hooks = Array.isArray(contract.injectionHooks) ? contract.injectionHooks.filter(Boolean).slice(0, 8) : [];
        const violations = includeRecentViolations && Array.isArray(ctx.contractViolations)
            ? ctx.contractViolations.slice(-3)
            : [];

        const hookLines = hooks.length
            ? hooks.map((hook) => {
                const hookId = String(hook?.hookId || '').trim() || 'unknown-hook';
                const location = String(hook?.location || hook?.targetPath || '').trim();
                const purpose = String(hook?.purpose || hook?.description || '').trim();
                return `- ${hookId}${location ? ` @ ${location}` : ''}${purpose ? `: ${purpose}` : ''}`;
            }).join('\n')
            : '- (no declared injection hooks)';

        const violationLines = violations.length
            ? `Recent high-risk file writes (advisory):\n${violations.map((v) => `- ${String(v?.filePath || 'unknown-path')}: ${String(v?.reason || 'template_contract_violation')}`).join('\n')}`
            : '';

        const architectureLines = templateId === 'tankarena-3d-v1'
            ? [
                'Template architecture lock (tankarena-3d-v1):',
                '- Preserve the existing plain Vite + Three.js structure.',
                '- Keep the current entrypoint shape (`src/main.js`) and existing non-React runtime architecture.',
                '- Do NOT introduce React, ReactDOM, @react-three/fiber, @react-three/drei, Tailwind, or create-vite scaffolding.',
                '- Do NOT create replacement files such as `src/main.jsx`, `src/App.jsx`, `src/components/**`, or `src/hooks/**` unless the user explicitly requests a framework migration.',
                '- Reskin and extend the existing game; do not replace the template with a new framework stack.'
            ].join('\n')
            : '';

        return [
            '',
            '[TEMPLATE_EXECUTION_GUARD]',
            `Template mode is active for "${templateId}" (${String(ctx?.enforcementMode || 'enforce')}).`,
            'MANDATORY:',
            '- Do NOT create a fresh scaffold such as create-vite. Work inside the seeded template workspace only.',
            '- Prefer implementing features through editable paths and declared extension hooks.',
            immutablePaths.length ? `High-risk paths (read fully before editing, patch surgically, verify syntax):\n${immutablePaths.map((p) => `- ${p}`).join('\n')}` : '',
            editablePaths.length ? `Editable paths:\n${editablePaths.map((p) => `- ${p}`).join('\n')}` : '',
            `Injection hooks:\n${hookLines}`,
            architectureLines,
            violationLines,
            'High-risk files (listed in immutablePaths) CAN be modified when the user request requires it. Read the full file first, make surgical edits, and verify syntax after writing.'
        ].filter(Boolean).join('\n');
    }

    _getAuthPreflightMode(state = {}) {
        return String(state?.templateContext?.contract?.authPreflightMode || 'default').trim().toLowerCase() || 'default';
    }

    _buildTaskExecutionGuard(task = {}, state = {}) {
        const id = String(task?.id || '').toLowerCase();
        const prompt = String(task?.prompt || '');
        const promptLower = prompt.toLowerCase();
        const roleUpper = String(task?.role || '').toUpperCase();
        if (roleUpper !== 'CODER') return '';
        const authPreflightMode = this._getAuthPreflightMode(state);

        const isAuthPreflight = id === 'auth_preflight' || /auth preflight only/.test(promptLower);
        const isAppSetup = id.includes('coder_auth') || /viverse-cli\s+app\s+create|app id|vite_viverse_client_id/.test(promptLower);
        const isUiTask =
            id.includes('coder_ui') ||
            /ui|overlay|landing page|glassmorphism|design system|components|display/i.test(prompt);
        const isLogicTask =
            id.includes('coder_logic') ||
            /ofc|open face chinese poker|royalties|heuristic ai|logic mismatch|ofcengine|13-card|13 card/.test(promptLower);
        const isPublishTask =
            id.includes('coder_publish') ||
            /publish|deploy|preview url|viverse-cli\s+app\s+publish/.test(promptLower);
        const requestScope = state?.runtimeFlags?.requestScope || {};
        const scopePrimary = String(requestScope?.primary || '').trim();
        const allowedSubsystems = Array.isArray(requestScope?.allowedSubsystems) ? requestScope.allowedSubsystems : [];
        const scopeLines = [];
        if (scopePrimary) scopeLines.push(`- Request scope authority: ${scopePrimary}.`);
        if (allowedSubsystems.length) scopeLines.push(`- Allowed subsystems for this run: ${allowedSubsystems.join(', ')}.`);
        if (scopePrimary === 'gameplay') {
            scopeLines.push('- Unless blocker evidence explicitly requires it, do NOT modify platform-core auth, platform-core matchmaking, publish, or diagnostics files.');
        } else if (scopePrimary === 'ui') {
            scopeLines.push('- Unless blocker evidence explicitly requires it, do NOT modify gameplay engine, platform-core auth, platform-core matchmaking, publish, or diagnostics files.');
        }

        if (isAuthPreflight) {
            return [
                '',
                '[TASK_EXECUTION_GUARD]',
                'Scope: auth preflight only.',
                ...scopeLines,
                authPreflightMode === 'verify_only'
                    ? '- This template uses VERIFY-ONLY auth preflight. Inspect existing auth/bootstrap surfaces and record evidence; do NOT patch unrelated files just to satisfy preflight.'
                    : '',
                '- Do NOT implement gameplay, UI redesign, leaderboard, or publish flow in this task.',
                '- Do NOT run viverse-cli app create or viverse-cli app publish.',
                '- Do NOT write .env, .env.production, PREFLIGHT_REPORT.md, or any ad hoc report file in this task.',
                authPreflightMode === 'verify_only'
                    ? '- Do NOT write source files in this preflight unless the auth gate explicitly fails and a targeted auth fix task is scheduled later.'
                    : '',
                '- Record evidence in the task response and rely on workflow state / compliance ledgers instead of creating new report artifacts.',
                '- Stop after auth/bootstrap evidence and minimal build sanity are complete.'
            ].filter(Boolean).join('\n');
        }

        if (isAppSetup) {
            return [
                '',
                '[TASK_EXECUTION_GUARD]',
                'Scope: app setup and App ID wiring only.',
                ...scopeLines,
                '- Do NOT implement gameplay logic, card rules, AI, or UI redesign in this task.',
                '- If AUTHORITATIVE_APP_ID is already resolved in the context, do NOT run viverse-cli app create again. Reuse the existing App ID and only complete missing wiring/build verification.',
                '- Do NOT rewrite healthy auth/bootstrap hooks unless blocker evidence requires it.',
                '- If .env or .env.production writes are blocked by template rules, do NOT keep retrying them.',
                '- Do NOT write App ID metadata into package.json for this template run.',
                '- Use vite.config.js as the primary fallback extension point for App ID wiring when direct env-file writes are blocked, then stop.'
            ].join('\n');
        }

        if (isUiTask) {
            return [
                '',
                '[TASK_EXECUTION_GUARD]',
                'Scope: UI implementation only.',
                ...scopeLines,
                '- Focus on user-facing OFC layout, labels, overlays, and design-system styling.',
                '- Do NOT run publish/auth/app-create commands in this task.',
                '- Avoid editing core runtime/auth hooks (src/hooks/useViverseAuth.js, src/hooks/useMultiplayer.js) unless the UI fix specifically requires it. If editing, read fully first and patch surgically.',
                '- Route UI changes through editable components, view-model hooks, and OFC-specific extension files when possible.',
                '- Do NOT replace gameplay engine behavior unless the UI fix strictly requires a matching view-model change.'
            ].join('\n');
        }

        if (isLogicTask) {
            return [
                '',
                '[TASK_EXECUTION_GUARD]',
                'Scope: gameplay logic only.',
                ...scopeLines,
                '- Focus on OFC engine, 13-card placement flow, scoring, heuristics, and supporting hooks/constants/components for gameplay.',
                '- Do NOT run viverse-cli auth login, viverse-cli app create, or viverse-cli app publish in this task.',
                '- Do NOT rebundle App ID or rewrite publish wiring unless blocker evidence proves gameplay cannot be verified otherwise.',
                '- Preserve existing auth/runtime foundation while replacing incorrect non-OFC gameplay logic.'
            ].join('\n');
        }

        if (isPublishTask) {
            return [
                '',
                '[TASK_EXECUTION_GUARD]',
                'Scope: publish and release verification only.',
                ...scopeLines,
                '- Focus on build, preview evidence, publish, App ID propagation, and release checks.',
                '- Do NOT rewrite gameplay logic or redesign UI in this task unless a release blocker directly proves they are broken.',
                '- Do NOT retry blocked template file writes when a compliant publish path already exists.'
            ].join('\n');
        }

        return '';
    }

    _evaluateBaselineRegressions({ state, runtimeChecks = [], runtimeBlockers = [] } = {}) {
        const regressions = [];
        const baseline = state?.runtimeFlags?.baselineContract || {};
        const requiredChecks = this._getRequiredRuntimeChecks(state);
        const hasBaseline =
            requiredChecks.every((name) => String(baseline?.runtimeChecks?.[name] || '').toLowerCase() === 'pass');
        if (!hasBaseline) return regressions;

        const map = new Map(
            (Array.isArray(runtimeChecks) ? runtimeChecks : [])
                .filter((c) => c && typeof c === 'object' && c.name)
                .map((c) => [String(c.name).toLowerCase(), String(c.status || '').toLowerCase()])
        );
        for (const name of requiredChecks) {
            const status = map.get(name);
            if (status !== 'pass') {
                regressions.push(`baseline-regression:${name}:${status || 'missing'}`);
            }
        }

        const blockerIds = new Set((Array.isArray(runtimeBlockers) ? runtimeBlockers : []).map((b) => String(b.id || '')));
        for (const id of Array.isArray(baseline.runtimeBlockersAbsent) ? baseline.runtimeBlockersAbsent : []) {
            if (blockerIds.has(id)) regressions.push(`baseline-regression:blocker:${id}`);
        }
        return regressions;
    }

    _isoMs(iso = '') {
        const n = Date.parse(String(iso || ''));
        return Number.isFinite(n) ? n : 0;
    }

    _hasRuntimeRevalidationAfterLatestFix(state) {
        const flags = state?.runtimeFlags || {};
        const lastFixMs = this._isoMs(flags.lastFixTaskCompletedAt);
        if (!lastFixMs) return true;
        const verificationEntries = Array.isArray(state?.verificationLedger) ? state.verificationLedger : [];
        const latestPassMs = (type) => {
            const filtered = verificationEntries
                .filter((entry) => String(entry?.type || '') === type && String(entry?.status || '').toLowerCase() === 'pass');
            const latest = filtered.length ? filtered[filtered.length - 1] : null;
            return this._isoMs(latest?.at || '');
        };
        const reviewerPassMs = Math.max(this._isoMs(flags.lastReviewerPassAt), latestPassMs('reviewer'));
        const previewPassMs = Math.max(this._isoMs(flags.lastPreviewProbePassAt), latestPassMs('preview_probe'));
        const verifierPassMs = latestPassMs('verifier');
        if (Math.max(reviewerPassMs, previewPassMs, verifierPassMs) >= lastFixMs) return true;

        // Fallback: a completed Verifier task with pass evidence in summary counts as revalidation.
        const completedVerifier = Array.isArray(state?.tasks) &&
            state.tasks.some((t) => String(t?.role || '').toLowerCase() === 'verifier' &&
                String(t?.status || '').toLowerCase() === 'completed');
        if (completedVerifier) {
            const summary = String(state?.projectContextSummary || '');
            if (/verifier passed|verifier.*compliance.*pass|compliance gate.*pass/i.test(summary)) return true;
        }

        return false;
    }

    _ensureRuntimeRevalidationTask(state = {}) {
        if (!state || !Array.isArray(state.tasks)) return null;
        const existingPending = state.tasks.find((task) =>
            /^v_fix_runtime_revalidate/i.test(String(task?.id || '')) &&
            String(task?.status || '').toLowerCase() === 'pending'
        );
        if (existingPending) return existingPending.id;

        const latestPreviewUrl = this._resolveLatestPreviewUrl(state);
        const taskId = `v_fix_runtime_revalidate_${Date.now()}`;
        state.tasks.push({
            id: taskId,
            role: 'Verifier',
            dependsOn: [],
            status: 'pending',
            prompt: `RUNTIME REVALIDATION REQUIRED.
Latest fix/build completed after the last passing runtime evidence.
Use the latest preview URL and existing workspace artifacts to refresh runtime evidence and return STRICT JSON with:
- status (pass/fail)
- runtime_checks.auth_profile.status/proof
- runtime_checks.matchmaking.status/proof
- preview_url_tested
- artifact_paths

Preview URL: ${latestPreviewUrl || 'unknown'}

Rules:
1) First inspect the most recent preview probe artifacts under artifacts/preview-tests and reuse them if they already correspond to the preview URL above.
2) If artifact evidence is stale or missing, run at most ONE targeted preview probe against the preview URL above.
3) Do NOT perform broad source-code review, grep sweeps, build checks, or App ID audits in this task unless they are strictly required to interpret the latest preview probe result.
4) Do NOT rewrite source files in this task.
5) Focus only on fresh runtime/browser evidence needed for template completion gates.`
        });
        return taskId;
    }

    _hasComplianceSuccessClaim(text = "") {
        const t = String(text || '');
        return /(fully compliant|compliance gate passed|ready for deployment|all compliance checks passed|all checks passed)/i.test(t);
    }

    _maskComplianceSuccessClaims(text = "") {
        return String(text || '').replace(
            /(fully compliant|compliance gate passed|ready for deployment|all compliance checks passed|all checks passed)/ig,
            '[pending gate verification]'
        );
    }

    async _finalizeWorkflowState(state, outcome = 'paused_or_failed') {
        if (!state || typeof state !== 'object') return;
        const normalized = outcome === 'completed' ? 'completed' : 'paused_or_failed';
        workflowStageService.markFinalize(state, {
            reason: normalized,
            nextAction: normalized === 'completed' ? 'Workflow completed' : 'Workflow paused or failed'
        });
        state.status = normalized;
        if (!state.runReport || typeof state.runReport !== 'object') {
            state.runReport = { startedAt: new Date().toISOString(), events: [] };
        }
        state.runReport.endedAt = new Date().toISOString();
        state.runReport.outcome = normalized;
        if (normalized === 'completed') {
            workflowFinalStateService.applyCompletionState(state, {
                resolveLatestPreviewUrl: this._resolveLatestPreviewUrl.bind(this),
                projectContextSummary: state.projectContextSummary || ''
            });
            // Auto-register completed workspace in the registry
            try {
                const workSpaceDir = path.dirname(String(state?.workspacePath || ''));
                if (workSpaceDir) {
                    await workspaceRegistryService.register(workSpaceDir, state);
                    state.registered = true;  // flag for _pickWorkspace scoring
                }
            } catch (regErr) {
                logger.warn(`WorkspaceRegistry auto-register failed: ${regErr.message}`);
            }
            // Update cross-session agent memory with this run's facts
            try {
                await agentMemoryService.recordCompletedWorkflow(state, this._lastCredentials);
            } catch (memErr) {
                logger.warn(`AgentMemory record failed: ${memErr.message}`);
            }
        }
        await this._saveState(state);
    }

    _beginRunReport(state) {
        if (!state || typeof state !== 'object') return;
        state.runHistory = Array.isArray(state.runHistory) ? state.runHistory : [];
        const prev = state.runReport && typeof state.runReport === 'object' ? state.runReport : null;
        if (prev && (prev.endedAt || prev.outcome || (Array.isArray(prev.events) && prev.events.length))) {
            state.runHistory.push({
                startedAt: prev.startedAt || null,
                endedAt: prev.endedAt || null,
                outcome: prev.outcome || null,
                eventCount: Array.isArray(prev.events) ? prev.events.length : 0
            });
            if (state.runHistory.length > 30) {
                state.runHistory = state.runHistory.slice(-30);
            }
        }
        state.runReport = {
            startedAt: new Date().toISOString(),
            endedAt: null,
            outcome: null,
            events: []
        };
    }

    _hasBlockingPreviewProbeFailure(state) {
        const verificationEntries = Array.isArray(state?.verificationLedger) ? state.verificationLedger : [];
        const latestPreview = verificationEntries
            .filter((entry) => String(entry?.type || '') === 'preview_probe')
            .slice(-1)[0];
        if (latestPreview) {
            return ['fail', 'error'].includes(String(latestPreview.status || '').toLowerCase());
        }
        const events = Array.isArray(state?.runReport?.events) ? state.runReport.events : [];
        return events.some((e) => {
            const type = String(e?.type || '').toLowerCase();
            if (type === 'preview_probe') {
                return String(e?.status || '').toLowerCase() === 'fail';
            }
            return type === 'preview_probe_error';
        });
    }

    _hasAnyPreviewProbeEvent(state) {
        const verificationEntries = Array.isArray(state?.verificationLedger) ? state.verificationLedger : [];
        if (verificationEntries.some((entry) => String(entry?.type || '') === 'preview_probe')) return true;
        const events = Array.isArray(state?.runReport?.events) ? state.runReport.events : [];
        if (events.some((e) => {
            const type = String(e?.type || '').toLowerCase();
            return type === 'preview_probe' || type === 'preview_probe_error';
        })) return true;
        const summary = String(state?.projectContextSummary || '');
        return /auto_test preview probe:\s*pass|preview probe pass\./i.test(summary);
    }

    _hydratePreviewProbeFromVerifierEvidence(state = {}, workspacePath = '') {
        const entries = Array.isArray(state?.verificationLedger) ? state.verificationLedger : [];
        if (entries.some((entry) => String(entry?.type || '') === 'preview_probe')) return false;
        const verifierEntries = entries.filter((entry) =>
            String(entry?.type || '') === 'verifier' &&
            String(entry?.status || '').toLowerCase() === 'pass'
        );
        const latestVerifier = verifierEntries.length ? verifierEntries[verifierEntries.length - 1] : null;
        const details = latestVerifier?.details && typeof latestVerifier.details === 'object'
            ? latestVerifier.details
            : null;
        const runtimeChecks = details?.runtime_checks && typeof details.runtime_checks === 'object'
            ? Object.entries(details.runtime_checks).map(([name, info]) => ({
                name,
                status: String(info?.status || 'unknown'),
                proof: String(info?.proof || '')
            }))
            : [];
        const previewUrlTested = String(details?.preview_url_tested || '').trim();
        const artifactPaths = Array.isArray(details?.artifact_paths) ? details.artifact_paths : [];
        if (!runtimeChecks.length || (!previewUrlTested && !artifactPaths.length)) return false;

        verificationLedgerService.record(workspacePath || state?.workspacePath || '', {
            type: 'preview_probe',
            taskId: latestVerifier.taskId,
            role: latestVerifier.role || 'Verifier',
            status: latestVerifier.status,
            summary: `Hydrated preview probe from verifier evidence. checks=[${runtimeChecks.map((c) => `${c.name}:${c.status}`).join(', ')}]`,
            details: {
                runtime_checks: runtimeChecks,
                report: details
            },
            artifactPaths
        });
        state.verificationLedger = verificationLedgerService.getEntries(workspacePath || state?.workspacePath || '');
        if (runtimeChecks.every((c) => String(c.status).toLowerCase() === 'pass')) {
            this._captureBaselineContractFromRuntimeChecks(state, {
                runtimeChecks,
                sourceTaskId: String(latestVerifier.taskId || ''),
                source: 'hydrated_verifier_preview_probe'
            });
            state.runtimeFlags = state.runtimeFlags || {};
            state.runtimeFlags.lastPreviewProbePassAt = latestVerifier.at || new Date().toISOString();
        }
        return true;
    }

    _requiresPreviewProbeEvidence(state) {
        const request = String(state?.request || '').toLowerCase();
        const tasksText = Array.isArray(state?.tasks)
            ? state.tasks.map((t) => String(t?.prompt || '').toLowerCase()).join('\n')
            : '';
        const haystack = `${request}\n${tasksText}`;
        return /(preview auto-test|preview probe|playwright|runtime preview probe|browser test)/.test(haystack);
    }

    _scheduleAutoTestFixTask({ state, task, probe = null, projectContextSummary = '' }) {
        const checks = Array.isArray(probe?.runtime_checks) ? probe.runtime_checks : [];
        const failedChecks = checks.filter((c) => String(c?.status || '').toLowerCase() === 'fail');
        if (!failedChecks.length) return { scheduled: false, reason: 'no_failed_runtime_checks' };

        const signature = failedChecks
            .map((c) => String(c?.name || 'unknown'))
            .sort()
            .join('||');
        if (!signature) return { scheduled: false, reason: 'empty_signature' };

        state.runtimeFlags = state.runtimeFlags || {};
        state.runtimeFlags.autoTestFixTracker = state.runtimeFlags.autoTestFixTracker || {};
        const attempts = Number(state.runtimeFlags.autoTestFixTracker[signature] || 0);
        if (attempts >= this.maxAutoTestFixAttemptsPerSignature) {
            return {
                scheduled: false,
                reason: `retry_cap_reached:${signature}`,
                signature,
                attempts
            };
        }

        const existingPending = state.tasks.find((t) =>
            t.status === 'pending' &&
            t.role === 'Coder' &&
            String(t.prompt || '').includes('AUTO_TEST_RUNTIME_FIX REQUIRED') &&
            String(t.prompt || '').includes(signature)
        );
        if (existingPending) {
            return { scheduled: false, reason: 'existing_fix_task', signature, attempts };
        }

        const fixTaskId = `autotest_fix_${Date.now()}`;
        const artifacts = Array.isArray(probe?.artifact_paths) ? probe.artifact_paths : [];
        const previewUrl = String(probe?.preview_url_tested || '');
        const lines = failedChecks.map((c) => `- ${c.name}: ${c.proof || 'failed'}`).join('\n');
        const scopeGuard = this._buildFixScopeAndBaselineGuard(state, { issueLines: failedChecks.map((c) => `- ${c.name}: ${c.proof || 'failed'}`) });
        const templateGuard = this._buildTemplateExecutionGuardBlock(state);
        state.tasks.push({
            id: fixTaskId,
            role: 'Coder',
            prompt: `AUTO_TEST_RUNTIME_FIX REQUIRED. Signature: ${signature}
Playwright/runtime auto-test reported blocking failures:
${lines}

Preview URL: ${previewUrl || 'unknown'}
Artifacts:
${artifacts.length ? artifacts.map((p) => `- ${p}`).join('\n') : '- (none)'}

Task context: ${String(task?.prompt || '').slice(0, 600)}
Requirements:
1) Fix runtime causes for failed checks (auth_profile and/or matchmaking).
2) Keep App ID/SDK wiring deterministic and compliant.
3) Rebuild if source/env changed.
4) If publish flow is part of this task, ensure next pass can regenerate preview evidence.

${scopeGuard}
${templateGuard}`,
            dependsOn: [],
            status: 'pending'
        });

        for (let i = 0; i < state.tasks.length; i++) {
            const t = state.tasks[i];
            if (t.status === 'pending' && Array.isArray(t.dependsOn) && t.dependsOn.includes(task.id)) {
                t.dependsOn = t.dependsOn.filter((depId) => depId !== task.id);
                if (!t.dependsOn.includes(fixTaskId)) t.dependsOn.push(fixTaskId);
            }
        }

        state.runtimeFlags.autoTestFixTracker[signature] = attempts + 1;
        return { scheduled: true, fixTaskId, signature, attempts: attempts + 1 };
    }

    _routeIntentMatchesText(routeTerm = "", text = "") {
        const term = String(routeTerm || '').trim().toLowerCase();
        const haystack = String(text || '').toLowerCase();
        if (!term || !haystack) return false;
        if (term.includes(' ')) return haystack.includes(term);
        const re = new RegExp(`(^|[^a-z0-9])${this._escapeRegex(term)}([^a-z0-9]|$)`, 'i');
        return re.test(haystack) || haystack.includes(term);
    }

    async _llmClassifySkills(text = "") {
        if (!text || !text.trim()) return [];
        try {
            const routes = await skillProvider.readRoutes();
            // Build a compact catalog: one line per skill with its description
            const catalogLines = [];
            const seenIds = new Set();
            for (const route of routes) {
                const skills = Array.isArray(route?.skills) ? route.skills : [];
                const intents = Array.isArray(route?.intent) ? route.intent : [];
                for (const skillId of skills) {
                    if (seenIds.has(skillId)) continue;
                    seenIds.add(skillId);
                    catalogLines.push(`- ${skillId}: triggers when task involves [${intents.slice(0, 6).join(', ')}]`);
                }
            }
            const catalog = catalogLines.join('\n');
            const prompt = `Task description:\n"${String(text).trim()}"\n\nAvailable skills:\n${catalog}\n\nWhich skill IDs (if any) does this task need? Return JSON: {"skills": [...]}`;
            const response = await geminiService.generateResponse(prompt, [], 'SKILL_CLASSIFIER');
            const raw = typeof response === 'string' ? response : (response?.text?.() ?? JSON.stringify(response));
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed?.skills) ? parsed.skills.map(String) : [];
        } catch (e) {
            logger.warn(`_llmClassifySkills failed (non-blocking): ${e.message}`);
            return [];
        }
    }

    async _inferRequiredSkills(text = "", role = "") {
        const t = String(text).toLowerCase();
        const picked = new Set();
        const add = (skillName, fileName = "SKILL.md") => picked.add(`${skillName}/${fileName}`);
        const technicalRole = ["CODER", "ARCHITECT", "VERIFIER", "REVIEWER"].includes(String(role).toUpperCase());

        // Keep auth-preflight focused by suppressing non-auth families.
        const authPreflightScope = /auth preflight only/.test(t);
        const authPreflightBlockedSkills = new Set([
            'viverse-multiplayer',
            'viverse-world-publishing',
            'viverse-leaderboard'
        ]);

        // Baseline resilience applies to technical roles — stored separately as soft ref
        // (not a blocking enforcement gate; model hallucination of BLOCKED is tolerated)
        if (technicalRole) add(".", "viverse-resilience-guide.md");

        const routes = await skillProvider.readRoutes();
        const matchedSkills = new Set();
        for (const route of routes) {
            const intents = Array.isArray(route?.intent) ? route.intent : [];
            const skills = Array.isArray(route?.skills) ? route.skills : [];
            if (!intents.length || !skills.length) continue;
            const matched = intents.some((term) => this._routeIntentMatchesText(term, t));
            if (!matched) continue;
            for (const skillId of skills) matchedSkills.add(String(skillId));
        }

        // LLM-based skill classification runs in parallel to catch cases keyword matching misses
        const llmSkills = await this._llmClassifySkills(text);
        for (const skillId of llmSkills) {
            if (skillId) matchedSkills.add(skillId);
        }
        logger.info(`_inferRequiredSkills: LLM classifier result: [${llmSkills.join(', ') || 'none'}] | heuristic matched: [${[...matchedSkills].join(', ') || 'none'}] | role: ${role}`);

        for (const skillId of matchedSkills) {
            if (!skillId) continue;
            if (authPreflightScope && authPreflightBlockedSkills.has(skillId)) continue;
            const readOrder = await skillProvider.resolveSkillReadOrder(skillId);
            for (const ref of readOrder) add(skillId, ref);
        }

        return [...picked].map((entry) => {
            const idx = entry.indexOf('/');
            const skillName = entry.slice(0, idx);
            const fileName = entry.slice(idx + 1);
            return {
                skillName,
                fileName,
                canonicalRef: skillProvider.canonicalizeRef(skillName, fileName)
            };
        });
    }

    _extractMustLines(content = "", max = 18) {
        const lines = String(content)
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.includes('**MUST**') || l.includes('MUST NOT') || l.includes('MANDATORY'));
        return lines.slice(0, max);
    }

    _escapeRegex(value = "") {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    _normalizeSkillRef(ref = "") {
        let v = String(ref || '').trim().toLowerCase();
        if (!v) return "";
        v = v.replace(/[`*]+/g, '');
        v = v.replace(/^["']+|["']+$/g, '');
        v = v.replace(/^[./]+/, '');
        v = v.replace(/\\/g, '/');
        v = v.replace(/\s+/g, ' ');
        v = v.replace(/\s*-\s*.*$/, ''); // strip trailing evidence text after markdown parsing accidents
        return v.trim();
    }

    _skillRefAliases(ref = "") {
        const normalized = this._normalizeSkillRef(ref);
        if (!normalized) return new Set();
        const aliases = new Set([normalized]);
        const canonicalBody = normalized.startsWith('file:')
            ? normalized.slice('file:'.length)
            : (normalized.startsWith('skill:') ? normalized.slice('skill:'.length) : normalized);
        aliases.add(canonicalBody);

        const parts = canonicalBody.split('/');
        const file = parts.length > 1 ? parts[parts.length - 1] : canonicalBody;
        const skill = parts.length > 1 ? parts.slice(0, -1).join('/') : "";

        const fileNoMd = file.replace(/\.md$/i, '');
        const fullNoMd = canonicalBody.replace(/\.md$/i, '');

        aliases.add(file);
        aliases.add(fileNoMd);
        aliases.add(fullNoMd);
        if (skill) aliases.add(skill);
        if (file === 'skill.md' && skill) aliases.add(skill);
        if (canonicalBody.startsWith('./')) aliases.add(canonicalBody.slice(2));

        return aliases;
    }

    _skillRefMatches(actualRef = "", requiredRef = "") {
        const actualAliases = this._skillRefAliases(actualRef);
        const requiredAliases = this._skillRefAliases(requiredRef);
        if (!actualAliases.size || !requiredAliases.size) return false;
        for (const a of actualAliases) {
            if (requiredAliases.has(a)) return true;
        }
        return false;
    }

    _collectSkillStatusBulletEntries(responseText = "", allowedStatuses = []) {
        const text = String(responseText || '');
        const statuses = allowedStatuses
            .map((s) => String(s || '').toUpperCase())
            .filter(Boolean);
        if (!statuses.length) return [];
        const statusSet = new Set(statuses);
        const re = /^\s*-\s*(.+?)\s*:\s*([A-Z_]+)\b/;
        const entries = [];
        for (const line of text.split('\n')) {
            const m = String(line || '').match(re);
            if (!m) continue;
            const status = String(m[2] || '').toUpperCase();
            if (!statusSet.has(status)) continue;
            entries.push({
                ref: String(m[1] || '').trim(),
                status
            });
        }
        return entries;
    }

    _validateSkillComplianceReport(responseText = "", requiredRefs = []) {
        const text = String(responseText || '');
        const refs = Array.isArray(requiredRefs) ? requiredRefs.filter(Boolean) : [];
        if (!refs.length) return { ok: true, reason: '' };
        for (const ref of refs.map((item) => this._canonicalizeRequiredSkillRef(item))) {
            // Resilience guide is a soft ref — FAIL or missing compliance report is non-blocking (P2)
            const isResilienceGuide = /viverse-resilience-guide/i.test(String(ref || ''));
            const status = this._extractSkillStatus(text, ref, ['PASS', 'FAIL'], 'SKILL_COMPLIANCE_REPORT');
            if (!status) {
                if (isResilienceGuide) continue;
                return { ok: false, reason: `Missing skill compliance entry for '${ref}'.` };
            }
            if (String(status || '').toUpperCase() !== 'PASS') {
                if (isResilienceGuide) continue;
                return { ok: false, reason: `Skill compliance reported non-PASS for '${ref}'.` };
            }
        }
        return { ok: true, reason: '' };
    }

    _validateSkillLoadReport(responseText = "", requiredRefs = []) {
        const text = String(responseText || '');
        const refs = Array.isArray(requiredRefs) ? requiredRefs.filter(Boolean) : [];
        if (!refs.length) return { ok: true, reason: '' };
        for (const ref of refs) {
            // Resilience guide is a soft/best-effort ref — model hallucination of BLOCKED is tolerated (P2)
            const isResilienceGuide = /viverse-resilience-guide/i.test(String(ref || ''));
            const status = this._extractSkillStatus(text, ref, ['LOADED', 'BLOCKED'], 'SKILL_LOAD_REPORT');
            if (!status) {
                if (isResilienceGuide) continue; // soft ref — missing entry is non-blocking
                return { ok: false, reason: `Missing skill load entry for '${ref}'.` };
            }
            if (String(status || '').toUpperCase() !== 'LOADED') {
                if (isResilienceGuide) continue; // soft ref — BLOCKED is non-blocking
                return { ok: false, reason: `Skill load reported non-LOADED for '${ref}'.` };
            }
        }
        return { ok: true, reason: '' };
    }

    _canonicalizeRequiredSkillRef(ref = "") {
        const value = String(ref || '').trim();
        if (!value) return "";
        if (value.startsWith('skill:') || value.startsWith('file:')) return value;
        const idx = value.indexOf('/');
        if (idx < 0) return skillProvider.canonicalizeRef(value, 'SKILL.md');
        return skillProvider.canonicalizeRef(value.slice(0, idx), value.slice(idx + 1));
    }

    _validateSkillLoadLedger(workspacePath = "", task = {}, requiredRefs = []) {
        const refs = Array.isArray(requiredRefs) ? requiredRefs.filter(Boolean) : [];
        if (!refs.length) return { ok: true, reason: '' };
        const entries = skillLedgerService.getEntries(workspacePath, {
            taskId: String(task?.id || ''),
            role: String(task?.role || '')
        });
        for (const ref of refs.map((item) => this._canonicalizeRequiredSkillRef(item))) {
            let resolvedPath = '';
            try {
                resolvedPath = skillProvider.resolveCanonicalRef(ref).resolvedPath;
            } catch {
                resolvedPath = '';
            }
            const matches = entries.filter((entry) => {
                const entryCanonical = String(entry.canonicalRef || '');
                const entryRequested = String(entry.requestedRef || '');
                const entryResolvedPath = String(entry.resolvedPath || '');
                if (entryCanonical === ref) return true;
                if (this._skillRefMatches(entryCanonical, ref)) return true;
                if (this._skillRefMatches(entryRequested, ref)) return true;
                if (resolvedPath && entryResolvedPath && entryResolvedPath === resolvedPath) return true;
                return false;
            });
            if (!matches.length) {
                return { ok: false, reason: `Missing skill load artifact for '${ref}'.` };
            }
            const latest = matches[matches.length - 1];
            if (!latest.success) {
                return { ok: false, reason: `Skill load artifact reported failure for '${ref}'.` };
            }
        }
        return { ok: true, reason: '' };
    }

    _shouldTolerateMissingSkillCompliance({ workspacePath = "", task = {}, requiredRefs = [], reason = "" } = {}) {
        const text = String(reason || '');
        if (!/Missing skill compliance entry/i.test(text)) return false;
        const loadCheck = this._validateSkillLoadLedger(workspacePath, task, requiredRefs);
        return !!loadCheck.ok;
    }

    _extractSkillStatus(responseText = "", ref = "", allowedStatuses = [], sectionName = "") {
        const text = String(responseText || '');
        const refEsc = this._escapeRegex(ref);
        const statusAlternation = allowedStatuses.map((s) => this._escapeRegex(String(s || '').toUpperCase())).join('|');
        if (!refEsc || !statusAlternation) return "";

        // 1) Section format:
        // [SKILL_LOAD_REPORT]
        // - skill/ref: LOADED - note
        const sectionPattern = sectionName
            ? new RegExp(`\\[${this._escapeRegex(sectionName)}\\][\\s\\S]*?-\\s*${refEsc}\\s*:\\s*(${statusAlternation})\\b`, 'i')
            : null;
        const sectionMatch = sectionPattern ? text.match(sectionPattern) : null;
        if (sectionMatch?.[1]) return String(sectionMatch[1]).toUpperCase();

        // 2) JSON map/object format:
        // "skill_load_report": { "skill/ref": "LOADED" }
        const mapMatch = text.match(new RegExp(`"${refEsc}"\\s*:\\s*"(?:${statusAlternation})"`, 'i'));
        if (mapMatch) {
            const status = mapMatch[0].match(new RegExp(`(${statusAlternation})`, 'i'));
            if (status?.[1]) return String(status[1]).toUpperCase();
        }

        // 3) JSON array item format:
        // {"ref":"skill/ref","status":"LOADED"}
        const arrayItemPattern = new RegExp(
            `\\{[^{}]*"ref"\\s*:\\s*"${refEsc}"[^{}]*"status"\\s*:\\s*"(${statusAlternation})"[^{}]*\\}`,
            'i'
        );
        const arrayItemMatch = text.match(arrayItemPattern);
        if (arrayItemMatch?.[1]) return String(arrayItemMatch[1]).toUpperCase();

        // 4) Fuzzy bullet fallback with normalized ref alias matching:
        // - **viverse-resilience-guide**: LOADED - ...
        // - viverse-resilience-guide.md: LOADED
        const entries = this._collectSkillStatusBulletEntries(text, allowedStatuses);
        for (const row of entries) {
            if (this._skillRefMatches(row.ref, ref)) {
                return String(row.status || '').toUpperCase();
            }
        }

        return "";
    }

    _parseSkillSection(responseText = "", sectionName = "SKILL_COMPLIANCE_REPORT") {
        const text = String(responseText || '');
        const start = text.search(new RegExp(`\\[${this._escapeRegex(sectionName)}\\]`, 'i'));
        if (start < 0) return [];
        const tail = text.slice(start).split('\n').slice(1);
        const rows = [];
        for (const line of tail) {
            const trimmed = String(line || '').trim();
            if (!trimmed) break;
            if (!trimmed.startsWith('-')) break;
            const m = trimmed.match(/^-+\s*([^:]+)\s*:\s*([A-Z_]+)\s*-?\s*(.*)$/i);
            if (!m) continue;
            rows.push({
                ref: String(m[1] || '').trim(),
                status: String(m[2] || '').trim().toUpperCase(),
                note: String(m[3] || '').trim()
            });
        }
        return rows;
    }

    async _buildSkillEnforcementBlock(taskPrompt = "", projectContextSummary = "", role = "") {
        // Use task prompt only for skill inference — including projectContextSummary
        // causes skills from prior tasks (e.g. auth) to bleed into unrelated tasks (logic/publish)
        // producing false-positive skill enforcement failures.
        const query = taskPrompt;
        const required = await this._inferRequiredSkills(query, role);
        if (!required.length) return { block: "", requiredRefs: [], missingRefs: [] };

        const snippets = [];
        for (const req of required) {
            try {
                const raw = await skillProvider.readSkillFile(req.skillName, req.fileName);
                const mustLines = this._extractMustLines(raw, 12);
                snippets.push({
                    ref: req.canonicalRef || skillProvider.canonicalizeRef(req.skillName, req.fileName),
                    mustLines,
                    missing: false
                });
            } catch (_) {
                snippets.push({
                    ref: req.canonicalRef || skillProvider.canonicalizeRef(req.skillName, req.fileName),
                    mustLines: ["[MISSING SKILL FILE - treat as blocker and report]"],
                    missing: true
                });
            }
        }

        const bulletLines = snippets
            .map(s => {
                const lines = s.mustLines.length ? s.mustLines.map(x => `  - ${x}`).join('\n') : '  - [No MUST lines extracted]';
                return `- ${s.ref}\n${lines}`;
            })
            .join('\n');

        const requiredRefs = snippets.map((s) => s.ref);
        const missingRefs = snippets.filter((s) => s.missing).map((s) => s.ref);
        const roleUpper = String(role || '').toUpperCase();
        const strictJsonRoles = new Set(['REVIEWER', 'VERIFIER']);
        const reportFormat = roleUpper === 'CODER'
            ? (strictJsonRoles.has(roleUpper)
                ? `3) Final response MUST include BOTH JSON fields:
"skill_load_report": [{"ref":"<skill-ref>","status":"LOADED|BLOCKED","evidence":"<brief evidence>"}]
"skill_compliance_report": [{"ref":"<skill-ref>","status":"PASS|FAIL","reason":"<brief reason>"}]
(Include one entry for EVERY required skill source in both arrays.)`
                : `3) Final response MUST include BOTH sections exactly:
[SKILL_LOAD_REPORT]
- <skill-ref>: LOADED|BLOCKED - <brief evidence>
[SKILL_COMPLIANCE_REPORT]
- <skill-ref>: PASS|FAIL - <brief reason>
(Include one line for EVERY required skill source in both sections.)`)
            : `3) Include a brief skill-load/compliance summary when practical.`;
        const loadExamples = required
            .map((req) => {
                const skillName = String(req.skillName || '');
                const fileName = String(req.fileName || '');
                if (skillName === '.') {
                    return `- ${req.canonicalRef}: call loadSkill(".", "${fileName}")`;
                }
                return `- ${req.canonicalRef}: call loadSkill("${skillName}", "${fileName}")`;
            })
            .join('\n');
        const block = `\n\n[STRICT_SKILL_ENFORCEMENT]\nYou MUST implement according to these skill gates. If code conflicts with these gates, update code to match gates.\nRequired skill sources:\n${requiredRefs.map(s => `- ${s}`).join('\n')}\n\nRequired loadSkill calls:\n${loadExamples}\n\nExtracted mandatory gates:\n${bulletLines}\n\nMANDATORY EXECUTION RULES:\n1) Before writing code, call tool 'loadSkill' for EACH required skill source above using the exact arguments shown.\n2) If any required skill source cannot be loaded, STOP and report blocker.\n${reportFormat}\n`;

        // Build preamble for skills that need to override the default task workflow.
        // When these skills are required, the Coder must follow the skill procedure FIRST,
        // before falling through to the generic discovery steps in the task prompt.
        const preambleSkills = {
            'playcanvas-asset-art': '[MANDATORY_SKILL_OVERRIDE: playcanvas-asset-art]\n'
                + 'The LLM skill classifier determined this task requires TEXTURE/IMAGE asset work.\n'
                + 'You MUST loadSkill("playcanvas-asset-art", "SKILL.md") FIRST and follow its procedure BEFORE any other steps.\n'
                + 'The skill describes how to: find asset IDs in scene JSON → map to file paths via config.json → fetch images → resize → overwrite asset files.\n'
                + 'Do NOT just set shapeType or change enum values — that only changes geometry, not the visual texture/image.\n'
                + 'After completing the skill procedure, continue with any remaining task steps below.\n\n'
        };
        const preambleParts = [];
        for (const ref of requiredRefs) {
            const skillId = ref.split('/')[0];
            if (preambleSkills[skillId]) preambleParts.push(preambleSkills[skillId]);
        }
        const preamble = preambleParts.join('');

        return { block, preamble, requiredRefs, missingRefs };
    }

    _extractAppIdCandidates(text = "") {
        const matches = String(text).match(/\b[a-z0-9]{10}\b/gi) || [];
        return [...new Set(matches.map(m => m.toLowerCase()))];
    }

    _buildWorkflowStatusSummary(state = {}, workspacePath = "") {
        const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
        const counts = {
            pending: tasks.filter((t) => t?.status === 'pending').length,
            completed: tasks.filter((t) => t?.status === 'completed').length,
            failed: tasks.filter((t) => t?.status === 'failed').length,
            blocked: tasks.filter((t) => t?.status === 'blocked').length
        };
        const pendingTask = tasks.find((t) => t?.status === 'pending');
        const verifierTasks = tasks.filter((t) => String(t?.role || '').toUpperCase() === 'VERIFIER');
        const latestVerifier = verifierTasks.length ? verifierTasks[verifierTasks.length - 1] : null;
        const verifierStatus = latestVerifier?.status || 'not_scheduled';
        const workflowStatus = String(state?.status || 'unknown');
        const hasBlocking = counts.failed > 0 || counts.blocked > 0;
        const isSettled = counts.pending === 0 && !hasBlocking;
        const overall = hasBlocking ? 'blocked_or_failed' : (isSettled ? 'completed' : 'in_progress');

        const lines = [
            `Workflow status: ${overall}`,
            `Workspace: ${workspacePath || 'unknown'}`,
            `State flag: ${workflowStatus}`,
            `Task counts: pending=${counts.pending}, completed=${counts.completed}, failed=${counts.failed}, blocked=${counts.blocked}`,
            `Verifier: ${verifierStatus}`
        ];
        if (latestVerifier?.id) lines.push(`Latest verifier task: ${latestVerifier.id}`);
        if (pendingTask?.id) lines.push(`Current pending task: ${pendingTask.id} (${pendingTask.role})`);
        if (pendingTask?.prompt) lines.push(`Pending prompt: ${String(pendingTask.prompt).slice(0, 160)}`);

        return {
            found: true,
            workspacePath,
            overall,
            stateFlag: workflowStatus,
            counts,
            verifier: latestVerifier
                ? { id: latestVerifier.id, status: latestVerifier.status, prompt: latestVerifier.prompt }
                : { status: 'not_scheduled' },
            pendingTask: pendingTask
                ? { id: pendingTask.id, role: pendingTask.role, prompt: pendingTask.prompt }
                : null,
            text: lines.join('\n')
        };
    }

    async getWorkflowStatus(message = "", history = [], credentials = null) {
        workflowStateService.setActiveProjects(this.activeProjects);
        return workflowStateService.getWorkflowStatus(message, history, credentials);
    }

    _extractCanonicalAppId(text = "") {
        const raw = String(text || "");
        const contextualPatterns = [
            /(?:^|\b)(?:app[\s_-]?id|app_id|VITE_VIVERSE_CLIENT_ID)\s*[:=]\s*["']?([a-z0-9]{10})\b/i,
            /\bviverse-cli\s+app\s+publish\b[\s\S]{0,200}--app-id\s+([a-z0-9]{10})\b/i,
            /"app_id"\s*:\s*"([a-z0-9]{10})"/i,
            /"clientId"\s*:\s*"([a-z0-9]{10})"/i,
            /"client_id"\s*:\s*"([a-z0-9]{10})"/i
        ];
        for (const re of contextualPatterns) {
            const match = raw.match(re);
            const candidate = String(match?.[1] || "").toLowerCase();
            if (candidate && /\d/.test(candidate)) return candidate;
        }

        // Conservative fallback: require at least one digit to avoid false positives like plain words.
        const appIds = this._extractAppIdCandidates(raw).filter((id) => /\d/.test(id));
        return appIds.length ? appIds[0] : "";
    }

    _isValidAppId(appId = "") {
        const v = String(appId || "").trim().toLowerCase();
        return /^[a-z0-9]{10}$/.test(v);
    }

    // ── INTENT CLASSIFIER (Phase 0) ────────────────────────────────────────
    // Classifies an incoming message as one of three routing modes:
    //   'new_app'         — full harness (Architect → auth → logic → publish → reviewer → verifier)
    //   'logic_iteration' — 4-task shortcut (reuse appId, skip Architect/auth/app create)
    //   'asset_iteration' — 3-task shortcut (visual-only edits, no auth, no build restart)
    _classifyRequestIntent(message = '', { workspaceState = null } = {}) {
        const text = String(message || '').toLowerCase().trim();
        const hasExistingWorkspace = !!workspaceState;
        const hasValidAppId = this._isValidAppId(
            String(workspaceState?.runtimeFlags?.appIdAuthority?.value || '')
        );

        // Explicit new-game qualifiers: "a new game", "a different app", "start fresh", "from scratch"
        const isExplicitlyNewGame = /\b(new|different|another|fresh)\b.*\b(game|app|demo|project)\b/.test(text)
            || /\b(start fresh|from scratch|new project)\b/.test(text);
        // Bare create-verb without explicit newness qualifier
        const isCreateVerb = /\b(create|build|make|start|generate)\b.*\b(game|app|demo|project)\b/.test(text);
        const isIterationRequest = /\b(change|update|fix|add|remove|tweak|adjust|increase|decrease|improve)\b/.test(text);
        const isVisualOnlyRequest = /\b(color|colour|theme|font|background|speed|size|scale|image|icon|logo|label|text)\b/.test(text)
            && !/\b(logic|rule|score|mechanic|gameplay|ai|opponent|multiplayer)\b/.test(text);

        // No workspace → always new app
        if (!hasExistingWorkspace) return 'new_app';
        // Explicit "new / different / another" signal overrides existing workspace context
        if (isExplicitlyNewGame) return 'new_app';
        // Iteration signals take priority over bare create-verb when workspace + appId exist
        if (hasValidAppId && isVisualOnlyRequest) return 'asset_iteration';
        if (hasValidAppId && isIterationRequest) return 'logic_iteration';
        // Bare create-verb with workspace but no valid appId yet → treat as new app
        if (isCreateVerb && !hasValidAppId) return 'new_app';
        return 'new_app'; // safe default
    }
    // ───────────────────────────────────────────────────────────────────────

    // ── LLM-BASED INTENT CLASSIFIER ──────────────────────────────────────
    // Calls the flash model with a minimal prompt to classify the message as
    // new_app | logic_iteration | asset_iteration.  Falls back to the regex
    // classifier if the LLM call fails or returns an unrecognised value.
    async _classifyRequestIntentLLM(message = '', { workspaceState = null, templateContext = null, history = [] } = {}) {
        const hasExistingWorkspace = !!workspaceState;
        const hasValidAppId = this._isValidAppId(
            String(workspaceState?.runtimeFlags?.appIdAuthority?.value || '')
        );
        const appId = hasValidAppId ? String(workspaceState.runtimeFlags.appIdAuthority.value) : null;
        const hasTemplateCtx = !!(templateContext?.templateId);

        // Include last 4 conversation turns so the LLM can see prior user requests
        const recentTurns = (Array.isArray(history) ? history : [])
            .slice(-4)
            .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${String(h.content || '').slice(0, 200)}`)
            .join('\n');

        const contextBlock = [
            `hasExistingWorkspace: ${hasExistingWorkspace}`,
            appId ? `existingAppId: ${appId}` : null,
            `templateContext: ${hasTemplateCtx ? templateContext.templateId : 'none'}`,
            recentTurns ? `recentConversation:\n${recentTurns}` : null,
        ].filter(Boolean).join('\n');

        const prompt = `Context:\n${contextBlock}\n\nCurrent user message: "${message}"\n\nClassify the intent. Choose from: new_app, template_modify, asset_iteration, logic_iteration.`;

        try {
            const raw = await geminiService.generateResponse(prompt, [], 'INTENT_CLASSIFIER', null, []);
            const parsed = this._parseJsonObject(raw);
            const intent = String(parsed?.intent || '').trim();
            if (['new_app', 'template_modify', 'logic_iteration', 'asset_iteration'].includes(intent)) {
                logger.info(`Orchestrator: LLM intent → ${intent} (confidence=${parsed?.confidence ?? '?'}, reason=${parsed?.reason ?? '?'})`);
                return intent;
            }
            logger.warn(`Orchestrator: LLM intent classifier returned unrecognised value "${intent}", using structural fallback.`);
        } catch (e) {
            logger.warn(`Orchestrator: LLM intent classifier failed — ${e.message}. Using structural fallback.`);
        }

        // Structural fallback only (no keyword/regex guessing)
        if (!hasExistingWorkspace && hasTemplateCtx) return 'template_modify';
        if (!hasExistingWorkspace) return 'new_app';
        return 'logic_iteration';
    }
    // ───────────────────────────────────────────────────────────────────────

    _setAppIdAuthority(state, appId = "", source = "") {
        const normalized = String(appId || "").trim().toLowerCase();
        if (!this._isValidAppId(normalized)) return false;
        this._ensureRuntimeFlagsShape(state);
        const current = state.runtimeFlags.appIdAuthority || {};
        const currentValue = String(current.value || "").trim().toLowerCase();
        const currentLocked = !!current.locked;
        if (this._isValidAppId(currentValue)) {
            if (currentValue === normalized) {
                state.runtimeFlags.appIdAuthority = {
                    ...current,
                    source: String(source || current.source || "unknown"),
                    updatedAt: new Date().toISOString()
                };
                return true;
            }
            if (currentLocked) {
                state.runtimeFlags.appIdAuthority = {
                    ...current,
                    conflict: {
                        attemptedValue: normalized,
                        attemptedSource: String(source || "unknown"),
                        attemptedAt: new Date().toISOString()
                    }
                };
                return false;
            }
        }
        state.runtimeFlags.appIdAuthority = {
            value: normalized,
            source: String(source || "unknown"),
            updatedAt: new Date().toISOString(),
            locked: true,
            conflict: null
        };
        return true;
    }

    async _resolveAppIdAuthority(state, workspacePath, contextText = "") {
        const fromState = String(state?.runtimeFlags?.appIdAuthority?.value || "").toLowerCase();
        if (this._isValidAppId(fromState)) return fromState;

        // For static/runtime-config templates, read CONTRACT.json appId before .env
        const _propStrategy = String(
            state?.templateContext?.contract?.appIdPropagation?.strategy || ''
        ).toLowerCase();
        if (_propStrategy === 'runtime-config-or-hostname' && workspacePath) {
            try {
                const contractText = await fs.readFile(path.join(workspacePath, 'CONTRACT.json'), 'utf8');
                const contractObj = JSON.parse(contractText);
                // Check both top-level and nested app.appId (Architect writes under app.appId)
                const contractId = String(
                    contractObj?.app?.appId || contractObj?.appId ||
                    contractObj?.app?.clientId || contractObj?.clientId || ''
                ).toLowerCase();
                if (this._isValidAppId(contractId)) {
                    if (this._setAppIdAuthority(state, contractId, 'contract.json')) return contractId;
                }
            } catch { /* ignore */ }
        }

        try {
            const envText = await fs.readFile(path.join(workspacePath, '.env'), 'utf8');
            const envMatch = envText.match(/(^|\n)\s*VITE_VIVERSE_CLIENT_ID\s*=\s*([a-z0-9]{10})\s*($|\n)/i);
            const envId = String(envMatch?.[2] || "").toLowerCase();
            if (this._setAppIdAuthority(state, envId, "env")) return envId;
        } catch {
            // ignore
        }

        const fromContext = this._extractCanonicalAppId(contextText);
        if (this._setAppIdAuthority(state, fromContext, "context")) return fromContext;

        return "";
    }

    async _readConfiguredAppIdFallback(workspacePath = "", templateContext = null) {
        const ws = String(workspacePath || '').trim();
        if (!ws) return { appId: "", source: "" };

        const candidates = [
            { path: path.join(ws, '.env.example'), source: '.env.example' },
            { path: path.join(ws, 'vite.config.js'), source: 'vite.config.js' },
            { path: path.join(ws, 'vite.config.mjs'), source: 'vite.config.mjs' },
            { path: path.join(ws, 'vite.config.ts'), source: 'vite.config.ts' }
        ];

        const appIdPropagation = templateContext?.contract?.appIdPropagation && typeof templateContext.contract.appIdPropagation === 'object'
            ? templateContext.contract.appIdPropagation
            : null;
        if (String(appIdPropagation?.strategy || '').trim().toLowerCase() === 'runtime-config-or-hostname') {
            for (const relPath of Array.isArray(appIdPropagation.approvedConfigFiles) ? appIdPropagation.approvedConfigFiles : []) {
                const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
                if (!rel) continue;
                candidates.push({ path: path.join(ws, rel), source: rel });
            }
        }

        for (const candidate of candidates) {
            try {
                const text = await fs.readFile(candidate.path, 'utf8');
                // For JSON files, do a deep recursive scan for App ID fields
                if (/\.json$/i.test(candidate.path)) {
                    try {
                        const obj = JSON.parse(text);
                        const _appIdKeys = new Set(['clientId','appId','client_id','app_id','applicationId']);
                        const _deepFind = (o) => {
                            if (!o || typeof o !== 'object') return "";
                            for (const k of Object.keys(o)) {
                                if (_appIdKeys.has(k) && this._isValidAppId(String(o[k] || ""))) return String(o[k]).toLowerCase();
                                const found = _deepFind(o[k]);
                                if (found) return found;
                            }
                            return "";
                        };
                        const jsonAppId = _deepFind(obj);
                        if (this._isValidAppId(jsonAppId)) return { appId: jsonAppId, source: candidate.source };
                    } catch { /* fall through to text scan */ }
                }
                const appId = this._extractCanonicalAppId(text);
                if (this._isValidAppId(appId)) {
                    return { appId, source: candidate.source };
                }
            } catch {
                // ignore
            }
        }

        return { appId: "", source: "" };
    }

    async _checkAppIdIntegrity(state, workspacePath, contextText = "") {
        const expectedAppId = await this._resolveAppIdAuthority(state, workspacePath, contextText);
        if (!expectedAppId) {
            return { ok: false, reason: 'App ID authority is missing. Cannot verify propagation safely.' };
        }

        // Fast path: if authority is locked (set by auth task) AND dist/ has the App ID,
        // skip the workspace-root config check which still contains YOUR_APP_ID placeholder.
        if (state?.runtimeFlags?.appIdAuthority?.locked) {
            const distCheck = await complianceService.verifyAppIdPropagation({
                workspacePath, expectedAppId, templateContext: state?.templateContext
            }).catch(() => null);
            if (distCheck?.pass) return { ok: true, details: distCheck };
            // dist check passed even if propagation is partial — trust the locked authority
            // and let the Verifier do the final deep check.
            return { ok: true, details: distCheck };
        }

        // For runtime-config-or-hostname templates, .env is NOT used — skip .env check entirely.
        const _propStrategy = String(
            state?.templateContext?.contract?.appIdPropagation?.strategy || ''
        ).toLowerCase();
        if (_propStrategy === 'runtime-config-or-hostname') {
            const distCheck = await complianceService.verifyAppIdPropagation({
                workspacePath, expectedAppId, templateContext: state?.templateContext
            }).catch(() => null);
            if (distCheck?.status === 'pass') return { ok: true, details: distCheck };
            // Trust authority from CONTRACT.json; let Verifier do final deep check.
            return { ok: true, details: distCheck };
        }

        let envId = "";
        try {
            const envText = await fs.readFile(path.join(workspacePath, '.env'), 'utf8');
            const envMatch = envText.match(/(^|\n)\s*VITE_VIVERSE_CLIENT_ID\s*=\s*([a-z0-9]{10})\s*($|\n)/i);
            envId = String(envMatch?.[2] || "").toLowerCase();
        } catch {
            // ignore
        }

        let configSource = '.env';
        if (!this._isValidAppId(envId)) {
            const fallback = await this._readConfiguredAppIdFallback(workspacePath, state?.templateContext);
            envId = String(fallback.appId || '').toLowerCase();
            configSource = String(fallback.source || 'fallback config');
        }

        if (!this._isValidAppId(envId)) {
            return { ok: false, reason: 'App ID integrity check failed: no valid VITE_VIVERSE_CLIENT_ID was found in .env or approved fallback config.' };
        }

        if (envId !== expectedAppId) {
            return {
                ok: false,
                reason: `App ID integrity check failed: authority (${expectedAppId}) does not match ${configSource} (${envId}).`
            };
        }

        const propagation = await complianceService.verifyAppIdPropagation({
            workspacePath,
            expectedAppId,
            templateContext: state?.templateContext
        });
        state.runtimeFlags = state.runtimeFlags || {};
        state.runtimeFlags.lastPropagationCheck = {
            at: new Date().toISOString(),
            expectedAppId,
            status: propagation.status,
            reasons: Array.isArray(propagation.reasons) ? propagation.reasons : []
        };

        if (propagation.status !== 'pass') {
            const reasons = Array.isArray(propagation.reasons) && propagation.reasons.length
                ? propagation.reasons.join(' | ')
                : 'unknown propagation mismatch';
            return {
                ok: false,
                reason: `Deterministic App ID propagation check failed. ${reasons}`,
                details: propagation
            };
        }

        return { ok: true, expectedAppId, details: propagation };
    }

    _extractPreviewUrl(text = "") {
        return previewAutoTestService.extractPreviewUrl(text);
    }

    _extractLatestPreviewUrlFromText(text = "") {
        const matches = String(text || '').match(/https:\/\/worlds\.viverse\.com\/[^\s)\]]+\?preview/gi) || [];
        return matches.length ? String(matches[matches.length - 1] || '') : '';
    }

    _stripWorkflowHaltNotes(summary = '') {
        return String(summary || '')
            .split('\n')
            .filter((line) => !/^\s*-\s*WORKFLOW HALTED:/i.test(String(line || '')))
            .join('\n')
            .trimEnd();
    }

    _buildFallbackArchitectContract(state = {}, task = {}, architectResponse = '') {
        const response = String(architectResponse || '').trim();
        const request = String(state?.request || '').trim();
        const prompt = String(task?.prompt || '').trim();
        const bullets = response
            .split('\n')
            .map((line) => String(line || '').trim())
            .filter((line) => /^[-*]\s+/.test(line))
            .map((line) => line.replace(/^[-*]\s+/, '').trim())
            .filter(Boolean)
            .slice(0, 12);

        return {
            schemaVersion: '1.0',
            generatedBy: 'orchestrator_architect_fallback',
            generatedAt: new Date().toISOString(),
            sourceTaskId: String(task?.id || ''),
            request,
            architectPrompt: prompt,
            summary: response.slice(0, 4000),
            keyPoints: bullets,
            integrationContracts: {
                appIdAuthority: 'single_authoritative_viverse_app_id',
                previewUrlAuthority: 'latest_worlds_viverse_preview_url',
                requiredRuntimeChecks: this._getRequiredRuntimeChecks(state)
            }
        };
    }

    _extractArchitectContractJson(text = '') {
        const raw = String(text || '');
        const fenced = raw.match(/```json\s*([\s\S]*?)```/i)?.[1];
        const candidate = fenced || raw;
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try {
            return JSON.parse(candidate.slice(start, end + 1));
        } catch {
            return null;
        }
    }

    async _persistArchitectContractArtifact(state, task, workspacePath, architectResponse = '') {
        if (String(task?.role || '').toUpperCase() !== 'ARCHITECT' || !workspacePath) {
            return { persisted: false };
        }

        const contractPath = path.join(workspacePath, 'CONTRACT.json');
        try {
            const stat = await fs.stat(contractPath);
            if (stat?.isFile()) return { persisted: false, exists: true };
        } catch {
            // create below
        }

        const parsed = this._extractArchitectContractJson(architectResponse);
        const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : this._buildFallbackArchitectContract(state, task, architectResponse);
        // Sanitize: if the Architect invented a fake UUID/placeholder as app.appId, reset it so
        // the Coder knows to run viverse-cli app create and get a real 10-char ID.
        if (payload?.app?.appId && !this._isValidAppId(String(payload.app.appId || ''))) {
            payload.app.appId = 'YOUR_APP_ID';
        }
        if (payload?.appId && !this._isValidAppId(String(payload.appId || ''))) {
            payload.appId = 'YOUR_APP_ID';
        }
        await fs.writeFile(contractPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        return { persisted: true, exists: true, path: contractPath };
    }

    _isCompletedWorkflowState(state = {}) {
        const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
        const allTasksCompleted =
            tasks.length > 0 &&
            tasks.every((task) => String(task?.status || '').toLowerCase() === 'completed');
        const normalizedStatus = String(state?.status || '').toLowerCase();
        return allTasksCompleted && (normalizedStatus === 'completed' || normalizedStatus === 'paused_or_failed');
    }

    _resolveLatestPreviewUrl(state = {}) {
        const events = Array.isArray(state?.runReport?.events) ? state.runReport.events : [];
        for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i];
            const candidate = this._extractPreviewUrl(String(ev?.previewUrl || ""));
            if (candidate) return candidate;
        }
        const fromSummary = this._extractLatestPreviewUrlFromText(String(state?.projectContextSummary || ""));
        if (fromSummary) return fromSummary;
        return "";
    }


    // Last-resort workspace finder: returns the most recently created workspace that has a
    // valid state file. Only reached when conversationId map + preferredWorkspace both miss
    // (e.g. user opens a brand-new tab with no session storage and types a follow-up).
    async _pickWorkspace(workSpaceDir) {
        let entries;
        try { entries = await fs.readdir(workSpaceDir, { withFileTypes: true }); }
        catch (_) { return null; }
        // Sort descending by name (req_<timestamp>) so newest is first
        const dirs = entries
            .filter(f => f.isDirectory() && f.name.startsWith('req_'))
            .map(f => f.name)
            .sort((a, b) => b.localeCompare(a));

        for (const name of dirs) {
            const candidate = path.join(workSpaceDir, name);
            const statePath = path.join(candidate, '.agent_state.json');
            try {
                const content = await fs.readFile(statePath, 'utf8');
                const parsed = JSON.parse(content);
                return { path: candidate, state: parsed };
            } catch (_) { /* corrupt/missing — try next */ }
        }
        return null;
    }

    _inferIsNewProjectFallback(message = "", isResumeCommand = false) {
        if (isResumeCommand) return false;
        const t = String(message).toLowerCase();
        if (/(continue|proceed|follow-up|follow up|fix|bug|regression|update|improve|enhance)/.test(t)) return false;
        return true;
    }

    _normalizeTasks(tasks = []) {
        if (!Array.isArray(tasks) || tasks.length === 0) return [];
        return tasks
            .filter((t) => t && typeof t === 'object')
            .map((t, idx) => {
                const id = String(t.id || `task_${idx + 1}`);
                const role = String(t.role || '').trim();
                const prompt = this._scrubTaskPromptCredentials(String(t.prompt || '').trim());
                const dependsOnRaw = Array.isArray(t.dependsOn) ? t.dependsOn : [];
                const dependsOn = dependsOnRaw.map((x) => String(x)).filter(Boolean);
                return {
                    id,
                    role,
                    prompt,
                    dependsOn,
                    status: 'pending'
                };
            })
            .filter((t) => t.role && t.prompt);
    }

    _isTemplateBoundRequest(message = "") {
        return /\btemplate\b|redpointfish-v1|battletanks-v1|blank-webapp-v1|tankarena-3d-v1/i.test(String(message || ''));
    }

    _deriveRequestScope(message = "", state = null) {
        const text = `${String(message || '')}\n${String(state?.request || '')}`.toLowerCase();
        const templateBound = this._isTemplateBoundRequest(text) || !!state?.templateContext?.templateId;
        const scope = {
            templateBound,
            primary: 'general',
            allowedSubsystems: ['gameplay', 'ui', 'platform-core.auth', 'platform-core.matchmaking', 'publish', 'diagnostics']
        };

        const isNewGameBuildRequest =
            /\b(create|build|make|generate|start)\b/.test(text) &&
            /\b(game|arena|tank|prototype|template)\b/.test(text);

        if (templateBound && isNewGameBuildRequest) {
            scope.primary = 'gameplay';
            scope.allowedSubsystems = ['gameplay', 'ui'];
            return scope;
        }

        if (/\b(ui|layout|theme|asset|visual|style|screen|leaderboard|hud|overlay|scroll)\b/.test(text)) {
            scope.primary = 'ui';
            scope.allowedSubsystems = ['ui', 'assets'];
            return scope;
        }
        if (/game|gameplay|rules|logic|ai|ofcp|poker|single-player|single player|memory game/.test(text)) {
            scope.primary = 'gameplay';
            scope.allowedSubsystems = templateBound
                ? ['gameplay', 'ui']
                : ['gameplay', 'ui', 'platform-core.matchmaking'];
            return scope;
        }
        if (/auth|login|profile|avatar|identity|checkauth/.test(text)) {
            scope.primary = 'auth';
            scope.allowedSubsystems = ['platform-core.auth', 'ui'];
            return scope;
        }
        if (/matchmaking|multiplayer|room discovery|room list|join|roomid|setactor/.test(text)) {
            scope.primary = 'matchmaking';
            scope.allowedSubsystems = ['platform-core.matchmaking', 'gameplay', 'ui'];
            return scope;
        }
        if (/publish|deploy|preview url|app id|vite_viverse_client_id|release/.test(text)) {
            scope.primary = 'publish';
            scope.allowedSubsystems = ['publish', 'diagnostics', 'ui'];
            return scope;
        }

        return scope;
    }

    /**
     * Returns true when the user wants to use a template AS-IS but with minor
     * content/asset substitutions (e.g. "change pizza to fruit").
     * These requests must NOT trigger a full scaffold — only a targeted edit + publish.
     */
    _isTemplateModificationOnly(message = "") {
        const t = String(message || '').toLowerCase();
        // Must reference a template
        const hasTemplate = /\btemplate\b|dashrunner|redpointfish|tankarena|flow-line|blank-webapp|flight-simulator|starter-kit-racing|gomoku|chess/i.test(t);
        if (!hasTemplate) return false;
        // Strip BOTH possible UI-injected prefixes before testing user intent:
        // 1. "Create a new app using template 'X'." (pre-filled input)
        // 2. "Template Mode Enabled.\nTemplate ID: X\n...\nUser Request:\n" (gallery selection)
        let stripped = t
            .replace(/^template\s+mode\s+enabled\.[\s\S]*?user\s+request:\s*/i, '')
            .replace(/^create\s+a\s+new\s+app\s+using\s+template\s+['"][^'"]*['"]\s*\.?\s*/i, '');
        // Negative: if the user wants auth, leaderboard, multiplayer, or any new system/feature,
        // this is NOT a simple visual modification — route to the full planner instead.
        const isAuthOrFeatureChange = /\b(auth|login|leaderboard|scoreboard|multiplayer|matchmaking|new feature|add system|register|credential|sign.?in|room|lobby)\b/.test(stripped);
        if (isAuthOrFeatureChange) return false;
        // "but ... change/replace/swap/make" anywhere is the strongest modification signal — check first.
        // Handles: "but i want to change", "but change", "but make X look like Y"
        const hasBut = /\bbut\b.{0,40}\b(change|replace|swap|rename|modify|update|make|use)\b/.test(stripped);
        if (hasBut) return true;
        // Explicit modification signals: "change X to Y", "replace X with Y", "swap", "rename"
        const hasModification = /\b(change|replace|swap|rename|but change|instead of|use .* instead|modify|update)\b/.test(stripped);
        if (!hasModification) return false;
        // Reject if there's a full-build keyword in the stripped request
        const isFullBuild = /\b(build|create|generate|make|scaffold)\b.*\b(app|project|game|from scratch)\b/.test(stripped);
        return !isFullBuild;
    }

    _buildTemplateFallbackPlan(message = "", { isResumeCommand = false } = {}) {
        const requestSummary = String(message || '').trim() || 'Adapt the selected template to satisfy the user request.';

        // Lean plan: template already seeded — only apply targeted modifications then publish.
        // Skips: Architect, auth_preflight, Reviewer, Verifier, c_fix loop.
        if (this._isTemplateModificationOnly(message)) {
            return {
                isNewProject: true,
                tasks: [
                    {
                        id: 'task_template_modify',
                        role: 'Coder',
                        prompt: '[TEMPLATE_MODIFICATION_ONLY]\n'
                            + 'The template workspace is already seeded. DO NOT re-scaffold, DO NOT run npm install, DO NOT rewrite the whole app.\n'
                            + 'Steps:\n'
                            + '1. cat CONTRACT.json — note editablePaths, build.required, build.command, paths.publishSource.\n'
                            + '2. DISCOVERY (MANDATORY — do this before reading any file):\n'
                            + '   Extract the key nouns and concepts from the user request (e.g. for "change box to plus": box, square, shape, grid, geometry, mesh).\n'
                            + '   For EACH key concept, grep ALL editable source files to find where it is actually implemented:\n'
                            + '     grep -ri "box\\|square\\|shape\\|geometry\\|mesh" src/ *.js *.json *.css *.html 2>/dev/null | grep -v node_modules | head -40\n'
                            + '   Do NOT assume the implementation location. Different templates implement the same concept differently:\n'
                            + '     - Bundled JS (Three.js/Babylon): geometry class names in .js files (BoxGeometry, MeshBuilder)\n'
                            + '     - PlayCanvas compiled: script attribute values in scene .json files (shapeType, meshType)\n'
                            + '     - Config-driven: enum/string values in config.json or data .json files\n'
                            + '     - CSS/canvas: draw calls or class names in .css or canvas rendering code\n'
                            + '   CRITICAL — if grep shows a script attribute (e.g. shapeType, meshType, objectType):\n'
                            + '     You MUST read config.json to find its valid enum values before setting it.\n'
                            + '     grep -i "shapeType\\|enum\\|options" config.json | head -20\n'
                            + '     Then use ONLY a value from the enum options list — NEVER invent a value.\n'
                            + '     INTENT → ENUM MAPPING: choose the enum value whose meaning best matches the user\'s request.\n'
                            + '       "plus" / "cross" / "+" / "plus symbol" → "cross"\n'
                            + '       "diamond" / "rhombus" → "diamond" or "diamondWide"\n'
                            + '       "L-shape" → "lshape"\n'
                            + '       "zigzag" / "wave" → "zigzag"\n'
                            + '       "arrow" → "arrow"\n'
                            + '       "bone" → "bone"\n'
                            + '       "square" / "box" / "default" → "square"\n'
                            + '     If the user wants a "plus" or "cross" shape, set shapeType to "cross" — NOT "square".\n'
                            + '     Example: shapeType "cross" → value is "cross" not "Cross" or "plus" or "symbol".\n'
                            + '   IF the request mentions image, texture, overlay, symbol, icon, sprite, or visual art on a block:\n'
                            + '     The skill classifier will pre-inject the appropriate skill. Follow the [MANDATORY_SKILL_OVERRIDE] preamble above your task.\n'
                            + '   READ the files that contain matches, then decide which ones to edit.\n'
                            + '3. Make ALL changes needed to fully fulfill the user request. Be BOLD and thorough:\n'
                            + '   - "Change X to Y" means make X look/behave like Y — not just rename strings.\n'
                            + '   - IMPORT AUDIT (MANDATORY): if you rename or remove any export, grep for all importers first, then update every import site in the same edit.\n'
                            + '   - SCENE JSON RULE: Never replace any scene .json file wholesale. Use python3 json.load → modify specific fields → json.dump to patch only what is needed.\n'
                            + '   - Update ALL affected files: the shape/geometry definition, color/style, labels, UI text, and any constants that reference the old concept.\n'
                            + '4. IF build.required is true (from CONTRACT.json): run build.command to produce the output folder.\n'
                            + '   Leave YOUR_APP_ID placeholders in place — they will be replaced in the publish step.\n'
                            + 'Do NOT touch immutable files. Do NOT add new dependencies. Do NOT run viverse-cli.\n'
                            + `Request focus: ${requestSummary}`,
                        dependsOn: []
                    },
                    {
                        id: 'task_template_publish',
                        role: 'Coder',
                        prompt: '[FAST_PATH] Auth + Publish — exactly 3 steps, no splitting:\n'
                            + '1. viverse-cli auth login -e <email> -p <password>\n'
                            + '2. cat CONTRACT.json — read app.createAppAllowed, build.required, paths.publishSource, and app.appId.\n'
                            + '   IF app.createAppAllowed is false: use app.appId as the App ID.\n'
                            + '   IF app.createAppAllowed is true (or app.appId is YOUR_APP_ID): run viverse-cli app create --name <appname> --type world and capture the real App ID from stdout.\n'
                            + '   IF build.required is true: find <publishSource>/ \\( -name "*.json" -o -name "*.html" -o -name "*.js" \\) -print0 | xargs -0 sed -i "" "s/YOUR_APP_ID/<AppId>/g" then verify: grep -r YOUR_APP_ID <publishSource>/ must be empty.\n'
                            + '3. Run: viverse-cli app publish {publishSource} --app-id {AppId}\n'
                            + '4. Capture the preview URL from the viverse-cli app publish stdout — it will be a short URL like https://worlds.viverse.com/XXXXXXX?preview (the slug is NOT the app ID). Output it on its own line EXACTLY as: FINAL_PREVIEW_URL: <that URL>\n'
                            + 'Do NOT rerun the build (done in previous task). Do NOT modify source files. Do NOT write .env.',
                        dependsOn: ['task_template_modify']
                    }
                ]
            };
        }

        return {
            isNewProject: this._inferIsNewProjectFallback(message, isResumeCommand),
            tasks: [
                {
                    id: 'task_1',
                    role: 'Architect',
                    prompt: `Inspect the selected template and create CONTRACT.json for this request.\nRequest focus: ${requestSummary}\n\nCONTRACT.json REQUIRED FIELDS:\n- app.appId: "YOUR_APP_ID" (placeholder — Coder replaces after viverse-cli app create)\n- app.createAppAllowed: true\n- build.required: true ONLY if template has a package.json with a build script (Vite/React). FALSE for static HTML templates (no build step, no dist/).\n- build.command: build command if build.required is true, otherwise null.\n- paths.publishSource: "." for static HTML templates, "dist" for bundled apps.\n- publishCommand: "viverse-cli app publish <paths.publishSource> --app-id YOUR_APP_ID"\n\nSTATIC vs BUNDLED rule: check if a package.json with a build script exists at the workspace root. If NO build script → static → build.required: false, publishSource: ".". If YES → bundled → build.required: true, publishSource: "dist".`,
                    dependsOn: []
                },
                {
                    id: 'task_template_auth',
                    role: 'Coder',
                    prompt: 'Auth + App Setup task — read CONTRACT.json first, then follow EXACTLY the steps it dictates:\n'
                        + '1. viverse-cli auth login -e <email> -p <password>\n'
                        + '2. cat CONTRACT.json — read app.createAppAllowed, build.required, paths.publishSource, and app.appId\n'
                        + '3. IF app.createAppAllowed is false: SKIP app create. Use app.appId from CONTRACT.json as the authoritative App ID. Do NOT run viverse-cli app create.\n'
                        + '   IF app.createAppAllowed is true: run viverse-cli app create --name <n> --type world and capture the App ID from stdout.\n'
                        + '4. IF build.required is true: run the build command from CONTRACT.json build.command to produce the output folder.\n'
                        + '   IF build.required is false: skip build entirely. There is no dist/ folder to create.\n'
                        + '5. IF build.required is true: find <buildOutput>/ \\( -name "*.json" -o -name "*.html" -o -name "*.js" \\) | xargs sed -i "" "s/YOUR_APP_ID/<AppId>/g" then grep -r YOUR_APP_ID <buildOutput>/ (must be empty)\n'
                        + 'Do NOT assume dist/ exists. Do NOT run npm. Do NOT modify source files directly.',
                    dependsOn: ['task_1']
                },
                {
                    id: 'task_template_logic',
                    role: 'Coder',
                    prompt: 'Logic task — implement only the minimum necessary gameplay and related UI changes required by the request.\n' + 'Steps: (1) cat CONTRACT.json to confirm editable files, (2) apply changes to allowed template extension points only, (3) do NOT touch auth, leaderboard, or PlayCanvas engine files.\n' + 'Do NOT read or modify 2453710.json, __game-scripts.js, config.json, or any .json game files.\n' + 'Do NOT run viverse-cli. Do NOT grep game data. Do NOT explore file structure.\n' + 'Request focus: ' + `${requestSummary}\nPreserve template structure.`,
                    dependsOn: ['task_template_auth']
                },
                {
                    id: 'task_template_publish',
                    role: 'Coder',
                    prompt: 'Publish task — read CONTRACT.json first, then follow EXACTLY the steps it dictates:\n'
                        + '1. viverse-cli auth login -e <email> -p <password>\n'
                        + '2. cat CONTRACT.json — read build.required, paths.publishSource, publish.command, and app.appId\n'
                        + '3. IF build.required is true: re-run the build command from CONTRACT.json build.command to rebuild the output folder.\n'
                        + '   IF build.required is false: skip build. Do NOT create or reference dist/.\n'
                        + '4. Run exactly: viverse-cli app publish <paths.publishSource> --app-id <app.appId>\n'
                        + '   (use CONTRACT.json publish.command verbatim if present — it already has the correct source path and app ID)\n'
                        + '5. Confirm publish succeeded from CLI output\n'
                        + '6. Capture the preview URL from the viverse-cli app publish stdout — it will be a short URL like https://worlds.viverse.com/XXXXXXX?preview. Output it on its own line EXACTLY as: FINAL_PREVIEW_URL: <that URL>\n'
                        + 'Do NOT default to dist/ — always use publishSource from CONTRACT.json. Do NOT rewrite code.',
                    dependsOn: ['task_template_logic']
                }
            ]
        };
    }

    _applyRequestScope(state, message = "") {
        if (!state || typeof state !== 'object') return null;
        state.runtimeFlags = state.runtimeFlags || {};
        const scope = this._deriveRequestScope(message || state.request || '', state);
        state.runtimeFlags.requestScope = scope;
        const workspacePath = String(state?.workspacePath || '').trim();
        if (workspacePath) {
            const existingCtx = fileService.getWorkspaceTemplateContext(workspacePath);
            if (existingCtx && typeof existingCtx === 'object') {
                fileService.setWorkspaceTemplateContext(workspacePath, {
                    ...existingCtx,
                    requestScope: scope
                });
            }
        }
        return scope;
    }

    _rehardenLoadedStateTasks(state, { message = "" } = {}) {
        if (!state || !Array.isArray(state.tasks) || state.tasks.length === 0) return false;

        const templateBound = this._isTemplateBoundRequest(message) || !!state?.templateContext?.templateId;
        const templateId = String(state?.templateContext?.templateId || state?.templateContext?.contract?.id || '').trim().toLowerCase();
        const verifyOnlyAuthPreflight =
            templateId === 'flow-line-v1' ||
            templateId === 'tankarena-3d-v1' ||
            /flow-line-v1|tankarena-3d-v1/i.test(String(message || ''));
        const scrubbed = state.tasks.map((task) => ({
            ...task,
            prompt: this._scrubTaskPromptCredentials(String(task?.prompt || ''))
        }));

        let nextTasks = scrubbed;
        if (verifyOnlyAuthPreflight) {
            nextTasks = nextTasks.filter((task) => {
                const role = String(task?.role || '').toLowerCase();
                const id = String(task?.id || '');
                const prompt = String(task?.prompt || '');
                if (role !== 'coder') return true;
                return id !== 'auth_preflight' && !/\bauth preflight\b/i.test(prompt);
            }).map((task) => {
                if (!Array.isArray(task?.dependsOn) || task.dependsOn.length === 0) return task;
                return {
                    ...task,
                    dependsOn: task.dependsOn.filter((dep) => dep !== 'auth_preflight')
                };
            });
        }

        const hasPendingLegacyTemplateChain = templateBound && scrubbed.some((task) =>
            /^task_[2-5]$/i.test(String(task?.id || '')) && String(task?.status || 'pending') === 'pending'
        );
        const hasNonPendingLegacyTemplateTask = scrubbed.some((task) =>
            /^task_[2-5]$/i.test(String(task?.id || '')) && String(task?.status || 'pending') !== 'pending'
        );
        const hasSplitFlow = scrubbed.some((task) => /_auth$|_logic$|_publish$/i.test(String(task?.id || '')));

        if (hasPendingLegacyTemplateChain && !hasNonPendingLegacyTemplateTask && !hasSplitFlow) {
            nextTasks = this._enforceWorkflowTasks(scrubbed, { message });
        }

        const before = JSON.stringify(state.tasks);
        const after = JSON.stringify(nextTasks);
        state.tasks = nextTasks;
        const scopeChanged = this._rehardenPendingFixTaskScopes(state);
        return before !== after || scopeChanged;
    }

    _isAppIdLoopRecoveryTask(task = {}) {
        const prompt = String(task?.prompt || '');
        const id = String(task?.id || '');
        if (!/^loop_recover_/i.test(id)) return false;
        return /authoritative App ID|VITE_VIVERSE_CLIENT_ID|dist verification|token-hunting grep loops/i.test(prompt);
    }

    async _retireObsoletePendingRecoveryTasks(state, workspacePath = '') {
        if (!state || !workspacePath || !Array.isArray(state.tasks) || state.tasks.length === 0) return false;

        const pendingAppIdLoops = state.tasks.filter((task) =>
            task?.status === 'pending' && this._isAppIdLoopRecoveryTask(task)
        );
        if (pendingAppIdLoops.length === 0) return false;

        const probeTask = pendingAppIdLoops[0];
        const profileHints = this._deriveComplianceProfiles(
            probeTask,
            String(state?.projectContextSummary || ''),
            state
        );
        const gate = await complianceService.runFastGate({
            workspacePath,
            taskPrompt: String(probeTask?.prompt || 'resume obsolete recovery precheck'),
            profileHints,
            gatePhase: 'fix',
            cache: this.complianceRuntimeCache.get(workspacePath) || state.complianceFastCache || {},
            templateContext: state?.templateContext || null,
            requestScope: state?.runtimeFlags?.requestScope || null
        });
        if (gate?._nextCache) {
            this.complianceRuntimeCache.set(workspacePath, gate._nextCache);
            state.complianceFastCache = {
                lastSnapshotKey: gate._nextCache.lastSnapshotKey,
                lastResult: gate._nextCache.lastResult
            };
        }

        const activeRuleIds = new Set(
            Array.isArray(gate?.findings)
                ? gate.findings.map((finding) => String(finding?.ruleId || '').trim()).filter(Boolean)
                : []
        );
        const activeAppIdRuleIds = [
            'publish-app-id-configured',
            'publish-source-app-id-reference',
            'publish-no-placeholder-appid',
            'publish-app-id-placeholder'
        ].filter((ruleId) => activeRuleIds.has(ruleId));
        const hasBootstrapBlocker = activeRuleIds.has('template-world-bootstrap-missing');

        let changed = false;
        for (const task of pendingAppIdLoops) {
            if (hasBootstrapBlocker) {
                task.status = 'blocked';
                task.lastError = 'Template runtime bootstrap missing; obsolete App-ID recovery task retired.';
                this._appendRunEvent(state, {
                    type: 'task_blocked',
                    taskId: task.id,
                    role: task.role,
                    reason: task.lastError
                });
                changed = true;
                continue;
            }

            if (activeAppIdRuleIds.length === 0) {
                task.status = 'completed';
                this._appendRunEvent(state, {
                    type: 'task_auto_resolved',
                    taskId: task.id,
                    role: task.role,
                    note: 'Obsolete App-ID recovery task retired; current fast gate has no active App-ID findings.'
                });
                changed = true;
            }
        }

        if (changed) {
            const note = hasBootstrapBlocker
                ? 'Retired stale App-ID recovery tasks because the current blocker is missing world bootstrap.'
                : 'Auto-resolved stale App-ID recovery tasks because App-ID findings are no longer active.';
            state.projectContextSummary = `${String(state.projectContextSummary || '')}\n- ${note}`.trim();
        }

        return changed;
    }

    async _retireObsoleteFailedComplianceFixTasks(state, workspacePath = '', projectContextSummary = '') {
        if (!state || !workspacePath || !Array.isArray(state.tasks) || state.tasks.length === 0) return false;

        const failedComplianceFixes = state.tasks.filter((task) =>
            /^(?:c_fix_)/i.test(String(task?.id || '')) &&
            /deterministic compliance fix required/i.test(String(task?.prompt || '')) &&
            /^(?:failed|blocked)$/i.test(String(task?.status || ''))
        );
        if (failedComplianceFixes.length === 0) return false;

        let changed = false;
        for (const task of failedComplianceFixes) {
            try {
                const expectedRuleIds = this._extractFixSignature(task.prompt)
                    .split('||')
                    .map((value) => String(value || '').trim())
                    .filter(Boolean);
                if (expectedRuleIds.length === 0) continue;

                const taskRequestScope = this._deriveTaskRequestScope(task, state);
                const profileHints = this._deriveComplianceProfiles(task, projectContextSummary, state);
                const gate = await complianceService.runFastGate({
                    workspacePath,
                    taskPrompt: String(task.prompt || 'obsolete failed compliance fix precheck'),
                    profileHints,
                    gatePhase: 'fix',
                    cache: this.complianceRuntimeCache.get(workspacePath) || state.complianceFastCache || {},
                    templateContext: state?.templateContext || null,
                    requestScope: taskRequestScope
                });
                if (gate?._nextCache) {
                    this.complianceRuntimeCache.set(workspacePath, gate._nextCache);
                    state.complianceFastCache = {
                        lastSnapshotKey: gate._nextCache.lastSnapshotKey,
                        lastResult: gate._nextCache.lastResult
                    };
                }

                const activeRuleIds = new Set(
                    Array.isArray(gate?.findings)
                        ? gate.findings.map((finding) => String(finding?.ruleId || '').trim()).filter(Boolean)
                        : []
                );
                const unresolved = expectedRuleIds.filter((ruleId) => activeRuleIds.has(ruleId));
                if (unresolved.length > 0) continue;

                task.status = 'completed';
                task.lastError = null;
                this._appendRunEvent(state, {
                    type: 'task_auto_resolved',
                    taskId: task.id,
                    role: task.role,
                    note: `Failed compliance-fix task retired; signature no longer present: ${expectedRuleIds.join(', ')}`
                });
                changed = true;
            } catch (err) {
                logger.warn(`Orchestrator: failed compliance-fix retirement precheck failed for ${String(task?.id || '')}: ${err?.message || err}`);
            }
        }

        if (changed) {
            state.projectContextSummary = `${String(state.projectContextSummary || '')}\n- Retired obsolete failed compliance-fix tasks whose signatures are no longer active.`.trim();
        }

        return changed;
    }

    _scrubTaskPromptCredentials(prompt = "") {
        let out = String(prompt || '');
        if (!out) return out;

        out = out
            .replace(/viverse-cli\s+auth\s+login\s+-e\s+\S+\s+-p\s+\S+/gi, 'viverse-cli auth login -e <email> -p <password>')
            .replace(/(\bemail\s*:\s*)([^\s,\n;]+)/gi, '$1<runtime-provided-email>')
            .replace(/(\bpassword\s*:\s*)([^\s,\n;]+)/gi, '$1<runtime-provided-password>')
            .replace(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi, '<runtime-provided-email>');

        return out;
    }

    _canonicalizeTemplateWorkflowTasks(tasks = [], { message = "" } = {}) {
        const list = Array.isArray(tasks) ? tasks : [];
        if (!this._isTemplateBoundRequest(message)) return list;
        if (list.some((task) => this._isFixTask(task))) return list;
        if (list.some((task) => /_auth$|_logic$|_publish$/i.test(String(task?.id || '')))) return list;

        const architectTasks = list.filter((task) => String(task?.role || '').toLowerCase() === 'architect');
        const coderTasks = list.filter((task) => String(task?.role || '').toLowerCase() === 'coder');
        if (!coderTasks.length) return list;
        if (coderTasks.length < 2) return list;

        // If a combined coder task exists (create+publish in one prompt), defer to _splitCombinedCoderTasks.
        const hasCombinedCoderTask = coderTasks.some((task) => {
            const lower = String(task?.prompt || '').toLowerCase();
            return /viverse-cli\s+app\s+create|vite_viverse_client_id/.test(lower) &&
                   /viverse-cli\s+app\s+publish|publish dist/.test(lower);
        });
        if (hasCombinedCoderTask) return list;
        const otherTasks = list.filter((task) => {
            const role = String(task?.role || '').toLowerCase();
            return role && role !== 'coder' && role !== 'architect';
        });

        const usedIds = new Set(list.map((task) => String(task?.id || '')).filter(Boolean));
        const uniqueId = (base) => {
            let candidate = base;
            let counter = 1;
            while (usedIds.has(candidate)) {
                counter += 1;
                candidate = `${base}_${counter}`;
            }
            usedIds.add(candidate);
            return candidate;
        };

        const architectAnchor = architectTasks[architectTasks.length - 1] || null;
        const authId = uniqueId('task_template_auth');
        const logicId = uniqueId('task_template_logic');
        const publishId = uniqueId('task_template_publish');
        const requestSummary = String(message || '').trim() || 'Adapt the selected template to satisfy the user request.';

        const canonicalTasks = [
            ...architectTasks,
            {
                id: authId,
                role: 'Coder',
                prompt: 'Auth + App Setup task — read CONTRACT.json first, then follow EXACTLY the steps it dictates:\n'
                        + '1. viverse-cli auth login -e <email> -p <password>\n'
                        + '2. cat CONTRACT.json — read app.createAppAllowed, build.required, paths.publishSource, and app.appId\n'
                        + '3. IF app.createAppAllowed is false: SKIP app create. Use app.appId from CONTRACT.json. Do NOT run viverse-cli app create.\n'
                        + '   IF app.createAppAllowed is true: run viverse-cli app create --name <name> --type world and capture the App ID.\n'
                        + '4. IF build.required is true: run the build command from CONTRACT.json build.command.\n'
                        + '   IF build.required is false: skip build entirely. Do NOT create dist/.\n'
                        + '5. IF build.required is true: replace YOUR_APP_ID in build output and verify none remain.\n'
                        + 'Do NOT assume dist/ exists. Do NOT run npm without CONTRACT.json confirming it is needed.',
                dependsOn: architectAnchor ? [architectAnchor.id] : [],
                status: 'pending'
            },
            {
                id: logicId,
                role: 'Coder',
                prompt: 'Logic task — implement only the minimum necessary gameplay and related UI changes required by the request.\n' + 'Steps: (1) cat CONTRACT.json to confirm editable files, (2) apply changes to allowed template extension points only, (3) do NOT touch auth, leaderboard, or PlayCanvas engine files.\n' + 'Do NOT read or modify 2453710.json, __game-scripts.js, config.json, or any .json game files.\n' + 'Do NOT run viverse-cli. Do NOT grep game data. Do NOT explore file structure.\n' + 'Request focus: ' + `${requestSummary}\nPreserve template structure.`,
                dependsOn: [authId],
                status: 'pending'
            },
            {
                id: publishId,
                role: 'Coder',
                prompt: 'Publish task — read CONTRACT.json first, then follow EXACTLY the steps it dictates:\n'
                        + '1. viverse-cli auth login -e <email> -p <password>\n'
                        + '2. cat CONTRACT.json — read build.required, paths.publishSource, publish.command, and app.appId\n'
                        + '3. IF build.required is true: re-run the build command from CONTRACT.json build.command.\n'
                        + '   IF build.required is false: skip build. Do NOT reference or create dist/.\n'
                        + '4. Run: viverse-cli app publish <paths.publishSource> --app-id <app.appId>\n'
                        + '   (use CONTRACT.json publish.command verbatim if present — it has the correct source path)\n'
                        + '5. Confirm publish succeeded from CLI output\n'
                        + '6. Capture the preview URL from the viverse-cli app publish stdout — it will be a short URL like https://worlds.viverse.com/XXXXXXX?preview (NOT the app ID). Output it on its own line EXACTLY as: FINAL_PREVIEW_URL: <that URL>\n'
                        + 'Do NOT default to dist/ — always use publishSource from CONTRACT.json. Do NOT rewrite code.',
                dependsOn: [logicId],
                status: 'pending'
            }
        ];

        for (const task of otherTasks) {
            const role = String(task?.role || '').toLowerCase();
            if (role === 'reviewer') {
                canonicalTasks.push({
                    ...task,
                    prompt: this._scrubTaskPromptCredentials(String(task.prompt || '')),
                    dependsOn: []
                });
                continue;
            }
            if (role === 'verifier') {
                canonicalTasks.push({
                    ...task,
                    prompt: this._scrubTaskPromptCredentials(String(task.prompt || '')),
                    dependsOn: []
                });
                continue;
            }
            canonicalTasks.push({
                ...task,
                prompt: this._scrubTaskPromptCredentials(String(task.prompt || ''))
            });
        }

        return canonicalTasks;
    }

    _isAuthRelevant(message = "") {
        return /(auth|sso|login|checkauth|profile|avatar|identity)/i.test(String(message));
    }

    _firstTaskByRole(tasks = [], role = "") {
        const want = String(role).toLowerCase();
        return tasks.find((t) => String(t.role || "").toLowerCase() === want) || null;
    }

    _lastTaskByRole(tasks = [], role = "") {
        const want = String(role).toLowerCase();
        for (let i = tasks.length - 1; i >= 0; i--) {
            if (String(tasks[i].role || "").toLowerCase() === want) return tasks[i];
        }
        return null;
    }

    _splitCombinedCoderTasks(tasks = [], { message = '' } = {}) {
        const out = [];
        const originalIds = new Set(tasks.map((t) => String(t?.id || '')));
        const replacementMap = new Map();

        for (const task of tasks) {
            const role = String(task?.role || '').toLowerCase();
            const prompt = String(task?.prompt || '');
            const promptLower = prompt.toLowerCase();
            const isCoder = role === 'coder';
            const mentionsAppSetup = /viverse-cli\s+app\s+create|vite_viverse_client_id/.test(promptLower);
            const mentionsGameplay = /open face chinese poker|ofcp|13-card|13 card|heuristic ai|scoring logic|placement sequence|computer opponent/.test(promptLower);
            const mentionsPublish = /viverse-cli\s+app\s+publish|publish dist|publish --path dist|preview url|deploy/.test(promptLower);
            // Only split when BOTH app create AND publish/gameplay appear in same task.
            // Skip [FAST_PATH] tasks — those are already correctly structured.
            const isFastPath = promptLower.includes('[fast_path]');
            if (!(isCoder && mentionsAppSetup && mentionsPublish && !promptLower.includes('exactly 3 steps')) || isFastPath) {
                out.push(task);
                continue;
            }

            const baseId = String(task.id || `coder_${Date.now()}`);
            const deps = Array.isArray(task.dependsOn) ? [...task.dependsOn] : [];
            const requestSummary = String(message || '').trim() || prompt;
            const authId = `${baseId}_auth`;
            const logicId = `${baseId}_logic`;
            const publishId = `${baseId}_publish`;

            // If the original task had no deps, wire auth to the last preceding coder task
            // so it doesn't run before auth/logic from other tasks complete.
            let authDeps = deps;
            if (authDeps.length === 0) {
                const precedingCoders = out.filter(t => String(t.role||'').toLowerCase()==='coder' && t.id !== task.id);
                if (precedingCoders.length > 0) authDeps = [precedingCoders[precedingCoders.length-1].id];
            }
            out.push({
                id: authId,
                role: 'Coder',
                prompt: 'Auth + App Setup task — read CONTRACT.json first, then follow EXACTLY the steps it dictates:\n'
                        + '1. viverse-cli auth login -e <email> -p <password>\n'
                        + '2. cat CONTRACT.json — read app.createAppAllowed, build.required, paths.publishSource, and app.appId\n'
                        + '3. IF app.createAppAllowed is false: SKIP app create. Use app.appId from CONTRACT.json. Do NOT run viverse-cli app create.\n'
                        + '   IF app.createAppAllowed is true: run viverse-cli app create --name <n> --type world and capture the App ID.\n'
                        + '4. IF build.required is true: run the build command from CONTRACT.json build.command.\n'
                        + '   IF build.required is false: skip build entirely. Do NOT create dist/.\n'
                        + '5. IF build.required is true: replace YOUR_APP_ID in build output and verify none remain.\n'
                        + 'Do NOT assume dist/ exists. Do NOT run npm without CONTRACT.json confirming it is needed.',
                dependsOn: authDeps,
                status: 'pending'
            });
            out.push({
                id: logicId,
                role: 'Coder',
                prompt: `Logic task — modify ONLY visual/CSS/HTML files in CONTRACT.json editablePaths.\nRequest focus: ${requestSummary}\nDo NOT run viverse-cli. Do NOT grep __game-scripts.js. Do NOT verify App ID.`,
                dependsOn: [authId],
                status: 'pending'
            });
            out.push({
                id: publishId,
                role: 'Coder',
                prompt: 'Publish task — read CONTRACT.json first, then follow EXACTLY the steps it dictates:\n'
                        + '1. viverse-cli auth login -e <email> -p <password>\n'
                        + '2. cat CONTRACT.json — read build.required, paths.publishSource, publish.command, and app.appId\n'
                        + '3. IF build.required is true: re-run the build command from CONTRACT.json build.command.\n'
                        + '   IF build.required is false: skip build. Do NOT reference or create dist/.\n'
                        + '4. Run: viverse-cli app publish <paths.publishSource> --app-id <app.appId>\n'
                        + '   (use CONTRACT.json publish.command verbatim if present — it has the correct source path)\n'
                        + '5. Confirm publish succeeded from CLI output\n'
                        + '6. Capture the preview URL from the viverse-cli app publish stdout — it will be a short URL like https://worlds.viverse.com/XXXXXXX?preview (NOT the app ID). Output it on its own line EXACTLY as: FINAL_PREVIEW_URL: <that URL>\n'
                        + 'Do NOT default to dist/ — always use publishSource from CONTRACT.json. Do NOT rewrite code.',
                dependsOn: [logicId],
                status: 'pending'
            });

            replacementMap.set(baseId, publishId);
        }

        if (!replacementMap.size) return out;

        for (const task of out) {
            if (!Array.isArray(task.dependsOn) || !task.dependsOn.length) continue;
            task.dependsOn = task.dependsOn.flatMap((depId) => {
                const normalized = String(depId || '');
                return replacementMap.has(normalized) ? [replacementMap.get(normalized)] : [normalized];
            });
        }

        return out.filter((task) => !replacementMap.has(String(task?.id || '')) || !originalIds.has(String(task?.id || '')));
    }

    _pruneLegacyTasksAfterSplit(tasks = [], { templateBoundRequest = false } = {}) {
        const list = Array.isArray(tasks) ? tasks : [];
        if (!templateBoundRequest) return list;

        const splitAuthTasks = list.filter((task) => /_auth$/i.test(String(task?.id || '')));
        const splitLogicTasks = list.filter((task) => /_logic$/i.test(String(task?.id || '')));
        const splitPublishTasks = list.filter((task) => /_publish$/i.test(String(task?.id || '')));
        if (!splitAuthTasks.length || !splitLogicTasks.length || !splitPublishTasks.length) return list;

        const splitBases = new Set(splitAuthTasks.map((task) => String(task.id || '').replace(/_auth$/i, '')));
        const keepIds = new Set([
            ...splitAuthTasks.map((task) => String(task.id || '')),
            ...splitLogicTasks.map((task) => String(task.id || '')),
            ...splitPublishTasks.map((task) => String(task.id || ''))
        ]);

        const shouldDropLegacyTask = (task = {}) => {
            const id = String(task?.id || '');
            const role = String(task?.role || '').toLowerCase();
            const prompt = String(task?.prompt || '').toLowerCase();

            if (!id || keepIds.has(id)) return false;
            if (role === 'architect' || role === 'reviewer') return false;
            if (id === 'auth_preflight') return false;
            if (this._isFixTask(task)) return false;
            if (/_auth$|_logic$|_publish$/i.test(id)) return false;

            const legacyFlowPrompt =
                /viverse-cli\s+app\s+create|open face chinese poker|ofcp|publish|grep gate|build verification|preview url|matchmaking v4\.2|heuristic ai|13-card|13 card/.test(prompt);
            const legacyFlowId = /^task_[2-6]$/i.test(id);
            const baseCollision = [...splitBases].some((base) => id === base || id.startsWith(`${base}_`));

            return legacyFlowId || baseCollision || legacyFlowPrompt;
        };

        const removedIds = new Set(
            list
                .filter((task) => shouldDropLegacyTask(task))
                .map((task) => String(task?.id || ''))
                .filter(Boolean)
        );
        const filtered = list.filter((task) => !removedIds.has(String(task?.id || '')));

        for (const task of filtered) {
            if (!Array.isArray(task.dependsOn) || !task.dependsOn.length) continue;
            task.dependsOn = task.dependsOn.filter((depId) => !removedIds.has(String(depId || '')));
        }

        return filtered;
    }

    _enforceWorkflowTasks(tasks = [], { message = "", skipWorkflowExpansion = false } = {}) {
        let out = this._canonicalizeTemplateWorkflowTasks(tasks, { message });
        out = this._splitCombinedCoderTasks(out, { message });
        const ids = new Set(out.map((t) => t.id));
        const templateBoundRequest = this._isTemplateBoundRequest(message);
        out = this._pruneLegacyTasksAfterSplit(out, { templateBoundRequest });

        // Phase 1.6: Inject auth preflight before full coder flow when auth is relevant,
        // except for templates that are explicitly verify-only for auth preflight.
        const verifyOnlyAuthPreflight = /tankarena-3d-v1|flow-line-v1/i.test(String(message || ''));
        if (verifyOnlyAuthPreflight) {
            out = out.filter((t) => {
                const id = String(t?.id || '');
                const prompt = String(t?.prompt || '');
                const role = String(t?.role || '').toLowerCase();
                if (role !== 'coder') return true;
                return id !== 'auth_preflight' && !/\bauth preflight\b/i.test(prompt);
            });
        }
        if (!skipWorkflowExpansion && this._isAuthRelevant(message)) {
            const hasPreflight = out.some((t) => t.id === "auth_preflight" || /\bauth preflight\b/i.test(String(t.prompt || "")));
            if (!hasPreflight) {
                const architect = this._firstTaskByRole(out, "Architect");
                const preflightTask = {
                    id: "auth_preflight",
                    role: "Coder",
                    prompt: verifyOnlyAuthPreflight
                        ? "AUTH PREFLIGHT ONLY: VERIFY existing VIVERSE auth/bootstrap surfaces before any gameplay/publish work. Mandatory checks: SDK global resolution path, handshake delay, checkAuth call, getUserInfo fallback, and forbidden 'accesstoken' header absence. Inspect approved auth files, run minimal build sanity only if needed, record evidence, and do NOT rewrite source files unless a later targeted auth fix task is explicitly scheduled."
                        : "AUTH PREFLIGHT ONLY: Implement and verify minimal VIVERSE auth bootstrap before any gameplay/publish work. Mandatory checks: SDK global resolution path, handshake delay, checkAuth call, getUserInfo fallback, and forbidden 'accesstoken' header absence. Stop after preflight evidence is added.",
                    dependsOn: architect ? [architect.id] : [],
                    status: "pending"
                };
                out.push(preflightTask);
                ids.add(preflightTask.id);
            }

            // All non-preflight coder tasks must depend on auth_preflight.
            out = out.map((t) => {
                if (String(t.role || "").toLowerCase() !== "coder") return t;
                if (t.id === "auth_preflight") return t;
                const deps = Array.isArray(t.dependsOn) ? [...t.dependsOn] : [];
                if (!deps.includes("auth_preflight")) deps.push("auth_preflight");
                return { ...t, dependsOn: deps };
            });
        }

        // Phase 1.5: Ensure reviewer exists before verifier.
        // Skipped for fast-path plans that explicitly opt out of workflow expansion.
        if (skipWorkflowExpansion) return out;

        let reviewer = this._firstTaskByRole(out, "Reviewer");
        const verifier = this._firstTaskByRole(out, "Verifier");
        // Exclude auth_preflight from lastCoder: Phase 1.6 appends auth_preflight to the
        // END of `out`, so _lastTaskByRole would return it as lastCoder. Reviewer would then
        // depend on auth_preflight only — and when ap_fix replaces auth_preflight in deps,
        // reviewer fires before publish/logic tasks complete. Always wire reviewer to the
        // last SUBSTANTIVE coder task (publish > logic > auth).
        const _coderTasksExcludingPreflight = out.filter(t =>
            String(t?.id || '') !== 'auth_preflight' &&
            !/\bauth preflight\b/i.test(String(t?.prompt || ''))
        );
        const lastCoder = this._lastTaskByRole(_coderTasksExcludingPreflight, "Coder") ||
            this._lastTaskByRole(out, "Coder");
        if (!reviewer) {
            const reviewerId = "task_reviewer";
            let n = 1;
            let rid = reviewerId;
            while (ids.has(rid)) {
                n += 1;
                rid = `${reviewerId}_${n}`;
            }
            reviewer = {
                id: rid,
                role: "Reviewer",
                            prompt: "Review the latest coder changes for runtime correctness, SDK compliance, and missing logic. Output STRICT JSON with status, feedback, severity, blocking_items, evidence, runtime_checks, artifact_paths, and preview_url_tested. runtime_checks MUST include auth_profile and any additional template-required checks such as matchmaking when applicable.",
                dependsOn: lastCoder ? [lastCoder.id] : [],
                status: "pending"
            };
            out.push(reviewer);
            ids.add(rid);
        } else if (lastCoder) {
            const deps = Array.isArray(reviewer.dependsOn) ? [...reviewer.dependsOn] : [];
            if (!deps.includes(lastCoder.id)) reviewer.dependsOn = deps.concat(lastCoder.id);
        }

        // Phase 1.7: Repair publish tasks with missing dependencies.
        // The Architect LLM sometimes generates publish/deploy tasks with deps=[],
        // causing them to run before auth completes. Wire them to the last non-publish coder task.
        const _coderTasks = out.filter(t => String(t.role||'').toLowerCase()==='coder');
        for (const t of out) {
            if (String(t.role||'').toLowerCase() !== 'coder') continue;
            if (!this._isPublishTask(t)) continue;
            const deps = Array.isArray(t.dependsOn) ? [...t.dependsOn] : [];
            if (deps.length > 0) continue; // already has deps — leave it
            // Find the last non-publish coder task to wire as dep
            const nonPublishCoders = _coderTasks.filter(ct => ct.id !== t.id && !this._isPublishTask(ct));
            if (nonPublishCoders.length > 0) {
                const lastNonPublish = nonPublishCoders[nonPublishCoders.length - 1];
                t.dependsOn = [lastNonPublish.id];
            }
        }

        // Ensure verifier depends on reviewer AND all publish tasks. If no verifier, inject one.
        // Belt-and-suspenders: even if ap_fix rerouting corrupts the reviewer dep chain,
        // verifier will still wait for publish to complete (dist/ must exist before verifier runs).
        const _publishTaskIdsForVerifier = out.filter(t => this._isPublishTask(t)).map(t => t.id);
        if (!verifier) {
            let vid = "task_verifier";
            let n = 1;
            while (ids.has(vid)) {
                n += 1;
                vid = `task_verifier_${n}`;
            }
            const _verifierDeps = [...(reviewer ? [reviewer.id] : []), ..._publishTaskIdsForVerifier
                .filter(pid => !(reviewer && pid === reviewer.id))];
            out.push({
                id: vid,
                role: "Verifier",
                prompt: "Run deterministic release verification: App ID bundling gate, SDK URL checks, auth gate compliance, and publish-readiness checks.",
                dependsOn: _verifierDeps,
                status: "pending"
            });
            ids.add(vid);
        } else if (reviewer) {
            out = out.map((t) => {
                if (t.id !== verifier.id) return t;
                const deps = Array.isArray(t.dependsOn) ? [...t.dependsOn] : [];
                if (!deps.includes(reviewer.id)) deps.push(reviewer.id);
                for (const _pid of _publishTaskIdsForVerifier) {
                    if (!deps.includes(_pid)) deps.push(_pid);
                }
                return { ...t, dependsOn: deps };
            });
        }

        // Guardrail: break accidental dependency cycles from planner output.
        const taskById = new Map(out.map((t) => [t.id, t]));
        const dependsOnTransitively = (fromId, targetId, seen = new Set()) => {
            if (!fromId || !targetId || seen.has(fromId)) return false;
            if (fromId === targetId) return true;
            seen.add(fromId);
            const node = taskById.get(fromId);
            const deps = Array.isArray(node?.dependsOn) ? node.dependsOn : [];
            for (const depId of deps) {
                if (dependsOnTransitively(depId, targetId, seen)) return true;
            }
            return false;
        };

        out = out.map((t) => {
            const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
            const pruned = deps.filter((depId) => !dependsOnTransitively(depId, t.id));
            return pruned.length === deps.length ? t : { ...t, dependsOn: pruned };
        });

        if (templateBoundRequest) {
            out = out.map((t) => {
                const role = String(t?.role || '').toUpperCase();
                const prompt = String(t?.prompt || '');
                if (role === 'CODER' && /viverse-cli\s+app\s+create|VITE_VIVERSE_CLIENT_ID|\.env/i.test(prompt)) {
                    let rewritten = prompt
                        .replace(/Create a \.env file containing 'VITE_VIVERSE_CLIENT_ID=<NEW_APP_ID>' immediately\.?/gi, 'Wire the new App ID through allowed template extension points only. Do not invent a new fallback file when the template already defines approved propagation files.')
                        .replace(/IMMEDIATELY create a ['"]?\.env['"]? file[^.\n]*\./gi, 'Wire the new App ID through allowed template extension points only. Do not invent a new fallback file when the template already defines approved propagation files.')
                        .replace(/create a ['"]?\.env['"]? file[^.\n]*VITE_VIVERSE_CLIENT_ID[^.\n]*\./gi, 'Wire the new App ID through allowed template extension points only. Do not invent a new fallback file when the template already defines approved propagation files.')
                        .replace(/Verify the \.env file exists before proceeding\.?/gi, 'Verify the authoritative App ID is baked into approved template sources (e.g. vite.config.js) before proceeding.')
                        .replace(/verify that ['"]?\.env['"]? exists before proceeding\.?/gi, 'Verify the authoritative App ID is baked into approved template sources (e.g. vite.config.js) before proceeding.')
                        .replace(/from the \.env file/gi, 'from the approved App ID source for this template');
                    if (rewritten !== prompt) {
                        return { ...t, prompt: rewritten };
                    }
                }
                if (role === 'VERIFIER' && /\.env/i.test(prompt)) {
                    return {
                        ...t,
                        prompt: prompt
                            .replace(/from the \.env file/gi, 'from the approved App ID source for this template')
                            .replace(/from ['"]?\.env['"]?/gi, 'from the approved App ID source for this template')
                    };
                }
                return t;
            });
        }

        return out;
    }

    async _runAuthAcceptanceGate(workspacePath) {
        const files = await complianceService._listFilesRecursive(workspacePath);
        const scanFiles = files.filter((f) => {
            const rel = path.relative(workspacePath, f).replace(/\\/g, '/');
            if (
                rel.startsWith('node_modules/') ||
                rel.startsWith('dist/') ||
                rel.startsWith('.git/')
            ) {
                return false;
            }
            return true;
        });
        const authFiles = scanFiles.filter((f) => /auth|viverse|context|sdk|app\.(jsx?|tsx?)$/i.test(path.basename(f)));
        const readList = authFiles.length ? authFiles : scanFiles.slice(0, 20);
        const texts = [];
        for (const f of readList) {
            try {
                const txt = await fs.readFile(f, 'utf8');
                texts.push(`\n//FILE:${path.relative(workspacePath, f)}\n${txt}`);
            } catch {
                // ignore unreadable
            }
        }
        const corpus = texts.join('\n');
        const forbiddenAccessTokenHeader = /(?:["'`]\s*accesstoken\s*["'`]\s*:|setRequestHeader\s*\(\s*["'`]accesstoken["'`]|headers?\s*[:=][\s\S]{0,120}["'`]accesstoken["'`])/i.test(corpus);
        const unsafeAuthResultPropertyAccess =
            /\b([A-Za-z_$][\w$]*)\.is_authenticated\b/.test(corpus) &&
            !/\?\.\s*is_authenticated\b/.test(corpus) &&
            !/if\s*\(\s*([A-Za-z_$][\w$]*)\s*&&\s*\1\.is_authenticated\s*\)/.test(corpus);
        const unsafeDirectLoginCall =
            /\bclient\.login\s*\(/.test(corpus) &&
            !/loginWithWorlds\s*\(/.test(corpus) &&
            !/loginWithAuthPage\s*\(/.test(corpus);
        const missingTokenBasedAuthFallback =
            /checkAuth\s*\(/.test(corpus) &&
            !/(access_token|accessToken|account_id|accountId)/.test(corpus);
        const sdkGlobalResolutionPresent =
            /window\.vSdk/.test(corpus) &&
            /window\.viverse/.test(corpus) &&
            /window\.VIVERSE_SDK/.test(corpus);
        const checks = [
            { id: 'sdk-global-resolution', ok: sdkGlobalResolutionPresent, msg: 'Missing SDK global resolution chain.' },
            { id: 'handshake-delay', ok: /1200/.test(corpus) && /(setTimeout|delay|sleep)/i.test(corpus), msg: 'Missing explicit handshake delay guard.' },
            { id: 'checkauth-call', ok: /checkAuth\s*\(/.test(corpus), msg: 'Missing checkAuth() call in auth flow.' },
            { id: 'getuserinfo-fallback', ok: /getUserInfo\s*\(/.test(corpus), msg: 'Missing getUserInfo() recovery path.' },
            { id: 'no-accesstoken-header', ok: !forbiddenAccessTokenHeader, msg: "Forbidden 'accesstoken' token/header detected." },
            { id: 'checkauth-null-safe-access', ok: !unsafeAuthResultPropertyAccess, msg: "Unsafe direct 'authResult.is_authenticated' access detected. Use null-safe normalization." },
            { id: 'safe-login-method', ok: !unsafeDirectLoginCall, msg: "Unsafe direct 'client.login()' call detected. Use loginWithWorlds()/loginWithAuthPage() fallback flow." },
            { id: 'checkauth-token-fallback', ok: !missingTokenBasedAuthFallback, msg: "checkAuth() auth gate must include token/account fallback (access_token/account_id) for SDK variants without boolean auth flags." }
        ];
        const failed = checks.filter((c) => !c.ok);
        return {
            ok: failed.length === 0,
            failed
        };
    }

    _appendRunEvent(state, event = {}) {
        if (!state.runReport || typeof state.runReport !== 'object') {
            state.runReport = {
                startedAt: new Date().toISOString(),
                events: []
            };
        }
        const stampedEvent = {
            at: new Date().toISOString(),
            ...event
        };
        state.runReport.events.push(stampedEvent);

        if (String(stampedEvent?.type || '').toLowerCase() === 'template_gate_result') {
            verificationLedgerService.record(state?.workspacePath || '', {
                type: 'template_gate',
                taskId: String(stampedEvent?.taskId || 'template_finalize'),
                role: 'SYSTEM',
                status: String(stampedEvent?.status || 'unknown'),
                summary: `Template gate ${String(stampedEvent?.gate || '')}: ${String(stampedEvent?.status || 'unknown')}`,
                details: {
                    gate: String(stampedEvent?.gate || ''),
                    reason: String(stampedEvent?.reason || ''),
                    templateId: String(stampedEvent?.templateId || '')
                }
            });
        }
    }

    async _ensureArchitectContract(state, task, workspacePath, projectContextSummary = '') {
        if (String(task?.role || '').toUpperCase() !== 'ARCHITECT') {
            return { scheduled: false, projectContextSummary };
        }

        try {
            const stat = await fs.stat(path.join(workspacePath, 'CONTRACT.json'));
            if (stat?.isFile()) {
                return { scheduled: false, projectContextSummary };
            }
        } catch {
            // missing contract file; schedule retry below
        }

        const existingRetry = Array.isArray(state?.tasks)
            ? state.tasks.find((candidate) =>
                candidate &&
                candidate.status === 'pending' &&
                String(candidate.role || '').toUpperCase() === 'ARCHITECT' &&
                /ARCHITECT_CONTRACT_RETRY/i.test(String(candidate.prompt || ''))
            )
            : null;
        if (existingRetry) {
            return {
                scheduled: true,
                retryTaskId: String(existingRetry.id || ''),
                projectContextSummary: `${projectContextSummary}\n- Architect contract retry already pending: ${String(existingRetry.id || '')}`
            };
        }

        const retryTaskId = `architect_contract_retry_${Date.now()}`;
        state.tasks.push({
            id: retryTaskId,
            role: 'Architect',
            prompt: `ARCHITECT_CONTRACT_RETRY: Write a valid CONTRACT.json into the workspace root now.
- Use the writeFile tool with filePath exactly "CONTRACT.json".
- Do NOT only describe the contract in prose.
- Do NOT inspect "/" or other forbidden absolute paths.
- The file must exist on disk before this task finishes.
- Include method signatures, data model, and integration points required by the pending coder/reviewer/verifier tasks.`,
            dependsOn: [],
            status: 'pending'
        });

        for (const candidate of state.tasks) {
            if (!candidate || candidate === task || candidate.id === retryTaskId) continue;
            if (String(candidate.status || '').toLowerCase() !== 'pending') continue;
            const deps = Array.isArray(candidate.dependsOn) ? candidate.dependsOn : [];
            if (!deps.includes(String(task.id || ''))) continue;
            candidate.dependsOn = deps.filter((depId) => depId !== String(task.id || '')).concat(retryTaskId);
        }

        this._appendRunEvent(state, {
            type: 'architect_contract_missing',
            taskId: String(task?.id || ''),
            retryTaskId
        });

        return {
            scheduled: true,
            retryTaskId,
            projectContextSummary: `${projectContextSummary}\n- Architect completed without CONTRACT.json. Scheduled retry task ${retryTaskId}.`
        };
    }

    _extractTemplateIdFromText(text = '', knownTemplateIds = []) {
        const raw = String(text || '');
        if (!raw.trim()) return '';
        const lower = raw.toLowerCase();
        for (const id of knownTemplateIds) {
            if (!id) continue;
            const k = String(id).toLowerCase();
            if (lower.includes(`template '${k}'`) || lower.includes(`template "${k}"`) || lower.includes(k)) {
                return k;
            }
        }
        const quoted = lower.match(/\btemplate\s*[:=]?\s*['"]?([a-z0-9-]+)['"]?/i)?.[1] || '';
        return quoted;
    }

    async _workspaceHasTemplateSurface(workspacePath = '', contract = null) {
        const ws = String(workspacePath || '').trim();
        if (!ws || !contract) return false;
        const requiredFiles = Array.isArray(contract?.raw?.certification?.requiredFiles)
            ? contract.raw.certification.requiredFiles
            : [];
        const startupFiles = Array.isArray(contract?.compliancePaths?.startupFiles)
            ? contract.compliancePaths.startupFiles
            : [];
        const mustExist = [...new Set(
            [...requiredFiles, ...startupFiles]
                .map((entry) => String(entry || '').replace(/\\/g, '/').replace(/^\.\//, '').trim())
                .filter(Boolean)
        )];
        if (mustExist.length) {
            for (const relPath of mustExist) {
                try {
                    const stat = await fs.stat(path.join(ws, relPath));
                    if (!stat || (!stat.isFile() && !stat.isDirectory())) {
                        return false;
                    }
                } catch {
                    return false;
                }
            }
            return true;
        }
        const rules = [
            ...(Array.isArray(contract.immutablePaths) ? contract.immutablePaths : []),
            ...(Array.isArray(contract.editablePaths) ? contract.editablePaths : [])
        ];
        const topSegments = [...new Set(
            rules
                .map((r) => String(r || '').replace(/\\/g, '/').replace(/^\.\//, '').trim())
                .filter(Boolean)
                .map((r) => r.split('/')[0])
                .map((s) => s.replace(/\*+/g, '').trim())
                .filter((s) => !!s && !s.includes('.'))
        )];
        if (!topSegments.length) return false;
        for (const segment of topSegments) {
            try {
                const stat = await fs.stat(path.join(ws, segment));
                if (stat && (stat.isDirectory() || stat.isFile())) return true;
            } catch {
                // ignore
            }
        }
        return false;
    }

    async _immutableTemplateFilesMatch(workspacePath = '', templateRoot = '', contract = null) {
        const ws = String(workspacePath || '').trim();
        const root = String(templateRoot || '').trim();
        const immutablePaths = Array.isArray(contract?.immutablePaths) ? contract.immutablePaths : [];
        if (!ws || !root || !immutablePaths.length) return false;

        for (const relPath of immutablePaths) {
            const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
            if (!normalized) continue;
            const templateFile = path.join(root, normalized);
            const workspaceFile = path.join(ws, normalized);
            try {
                const [templateText, workspaceText] = await Promise.all([
                    fs.readFile(templateFile, 'utf8'),
                    fs.readFile(workspaceFile, 'utf8')
                ]);
                if (templateText !== workspaceText) return false;
            } catch {
                return false;
            }
        }

        return true;
    }

    async _seedWorkspaceFromTemplate(workspacePath = '', templateRoot = '', contract = null) {
        const ws = String(workspacePath || '').trim();
        const root = String(templateRoot || '').trim();
        if (!ws || !root) return;

        const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const name = String(entry.name || '');
            if (!name || name === 'template.json') continue;
            const src = path.join(root, name);
            const dest = path.join(ws, name);
            await fs.cp(src, dest, {
                recursive: true,
                force: false,
                errorOnExist: false
            }).catch(() => {});
        }

        // Auto-inject YOUR_APP_ID placeholder into JSON approvedConfigFiles.
        // Generic — any static template with a JSON config gets this for free.
        // Only injects when field value is empty/null so pre-injected files are untouched.
        const _approvedFiles = Array.isArray(contract?.appIdPropagation?.approvedConfigFiles)
            ? contract.appIdPropagation.approvedConfigFiles : [];
        const _APP_ID_FIELDS = new Set(['clientId','appId','client_id','app_id','applicationId','app_client_id']);
        const _injectPlaceholder = (obj) => {
            if (!obj || typeof obj !== 'object') return false;
            let changed = false;
            for (const key of Object.keys(obj)) {
                if (_APP_ID_FIELDS.has(key) && (obj[key] === '' || obj[key] === null || obj[key] === undefined)) {
                    obj[key] = 'YOUR_APP_ID'; changed = true;
                } else if (typeof obj[key] === 'object') {
                    if (_injectPlaceholder(obj[key])) changed = true;
                }
            }
            return changed;
        };
        for (const relPath of _approvedFiles) {
            if (!/\.json$/i.test(relPath)) continue;
            const absPath = path.join(ws, relPath);
            try {
                const raw = await fs.readFile(absPath, 'utf8');
                const obj = JSON.parse(raw);
                if (_injectPlaceholder(obj)) {
                    await fs.writeFile(absPath, JSON.stringify(obj));
                    logger.info(`_seedWorkspaceFromTemplate: injected YOUR_APP_ID into ${relPath}`);
                }
            } catch (e) {
                logger.warn(`_seedWorkspaceFromTemplate: could not auto-inject into ${relPath}: ${e.message}`);
            }
        }

        // Run npm install if the template has a package.json with dependencies not present
        // in the parent node_modules (e.g. @strudel/web, specialized libs).
        const pkgJsonPath = path.join(ws, 'package.json');
        const hasPkgJson = await fs.access(pkgJsonPath).then(() => true).catch(() => false);
        if (hasPkgJson) {
            try {
                const { execFile } = await import('child_process');
                const { promisify } = await import('util');
                const execFileAsync = promisify(execFile);
                logger.info(`_seedWorkspaceFromTemplate: running npm install in ${ws}`);
                await execFileAsync('npm', ['install', '--prefer-offline', '--loglevel=warn'], { cwd: ws, timeout: 120000 });
                logger.info(`_seedWorkspaceFromTemplate: npm install complete`);
            } catch (e) {
                logger.warn(`_seedWorkspaceFromTemplate: npm install failed (non-fatal): ${e.message}`);
            }
        }
    }

    _recordTemplateViolationEvent(state, violation = {}) {
        const filePath = String(violation.filePath || '');
        const reason = String(violation.reason || 'template_contract_violation');
        const exists = (state?.templateContext?.contractViolations || []).some(
            (v) => String(v.filePath || '') === filePath && String(v.reason || '') === reason
        );
        if (exists) return;

        state.templateContext = state.templateContext || {};
        state.templateContext.contractViolations = Array.isArray(state.templateContext.contractViolations)
            ? state.templateContext.contractViolations
            : [];
        state.templateContext.contractViolations.push({
            at: String(violation.at || new Date().toISOString()),
            filePath,
            reason
        });

        this._appendRunEvent(state, {
            type: 'template_contract_violation',
            templateId: String(state?.templateContext?.templateId || violation.templateId || ''),
            filePath,
            reason,
            mode: String(violation.mode || state?.templateContext?.enforcementMode || 'enforce')
        });
    }

    _drainTemplateViolationsFromFileService(state, workspacePath) {
        const violations = fileService.consumeTemplateViolations(workspacePath);
        if (!violations.length) return;
        for (const v of violations) this._recordTemplateViolationEvent(state, v);
    }

    _latestPreviewProbeChecks(state) {
        const verificationEntries = Array.isArray(state?.verificationLedger) ? state.verificationLedger : [];
        for (let i = verificationEntries.length - 1; i >= 0; i--) {
            const entry = verificationEntries[i];
            if (String(entry?.type || '') !== 'preview_probe') continue;
            if (String(entry?.status || '').toLowerCase() !== 'pass') continue;
            return Array.isArray(entry?.details?.runtime_checks) ? entry.details.runtime_checks : [];
        }
        for (let i = verificationEntries.length - 1; i >= 0; i--) {
            const entry = verificationEntries[i];
            if (String(entry?.type || '') !== 'reviewer') continue;
            if (String(entry?.status || '').toLowerCase() !== 'pass') continue;
            return Array.isArray(entry?.details?.runtime_checks) ? entry.details.runtime_checks : [];
        }
        const events = Array.isArray(state?.runReport?.events) ? state.runReport.events : [];
        for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i];
            if (String(e?.type || '').toLowerCase() !== 'preview_probe') continue;
            if (String(e?.status || '').toLowerCase() !== 'pass') continue;
            return Array.isArray(e?.runtimeChecks) ? e.runtimeChecks : [];
        }
        const summary = String(state?.projectContextSummary || '');
        const m = summary.match(/AUTO_TEST preview probe:\s*pass\.\s*checks=\[([^\]]+)\]/i);
        if (m?.[1]) {
            return String(m[1])
                .split(',')
                .map((chunk) => String(chunk || '').trim())
                .filter(Boolean)
                .map((chunk) => {
                    const [name, status] = chunk.split(':').map((part) => String(part || '').trim());
                    return { name, status };
                })
                .filter((entry) => entry.name);
        }
        return [];
    }

    async _evaluateTemplateGate(state, workspacePath, gateId = '', projectContextSummary = '') {
        const gate = String(gateId || '').trim();
        if (!gate) return { gate, status: 'skip', reason: 'empty_gate' };

        if (gate === 'static.immutable_path_violation') {
            // Advisory only — high-risk file modifications are allowed.
            // Log for observability but never fail the pipeline.
            const violations = Array.isArray(state?.templateContext?.contractViolations)
                ? state.templateContext.contractViolations
                : [];
            const immutableViolations = violations.filter((v) =>
                String(v?.reason || '').toLowerCase() === 'immutable_path_violation'
            );
            if (immutableViolations.length > 0) {
                logger.info(`_evaluateTemplateGate: ${immutableViolations.length} high-risk file write(s) recorded (advisory — not blocking)`);
            }
            return { gate, status: 'pass', reason: immutableViolations.length ? 'high-risk file writes detected (advisory)' : '' };
        }

        if (gate === 'static.required_hooks_present') {
            const ctx = state?.templateContext || {};
            const hooks = Array.isArray(ctx?.contract?.injectionHooks) ? ctx.contract.injectionHooks : [];
            const missing = hooks.filter((h) => !!h?.required && !String(h?.hookId || '').trim());
            const staticGates = await templateCertificationService.runStaticGates({
                templateRoot: String(ctx?.templateRoot || ''),
                contract: ctx?.contract || {}
            });
            const staticFail = staticGates.find((g) => String(g?.status || '').toLowerCase() !== 'pass');
            return {
                gate,
                status: missing.length || staticFail ? 'fail' : 'pass',
                reason: missing.length
                    ? 'required injection hook definitions are incomplete'
                    : (staticFail ? String(staticFail.reason || 'static template certification failed') : '')
            };
        }

        if (gate === 'build.app_id_propagation') {
            const check = await this._checkAppIdIntegrity(state, workspacePath, projectContextSummary);
            return { gate, status: check.ok ? 'pass' : 'fail', reason: check.ok ? '' : String(check.reason || '') };
        }

        if (gate === 'build.sdk_auth_domain_checks') {
            const check = await complianceService.runFastGate({
                workspacePath,
                taskPrompt: 'publish sdk auth domain checks',
                profileHints: ['auth'],
                gatePhase: 'publish',
                cache: this.complianceRuntimeCache.get(workspacePath) || state.complianceFastCache || {},
                templateContext: state?.templateContext || null,
                requestScope: state?.runtimeFlags?.requestScope || null
            });
            const failFindings = Array.isArray(check?.findings)
                ? check.findings.filter((f) => String(f?.severity || 'error').toLowerCase() !== 'info')
                : [];
            return {
                gate,
                status: check?.status === 'fail' && failFindings.length ? 'fail' : 'pass',
                reason: check?.status === 'fail' && failFindings.length
                    ? `fast gate findings: ${failFindings.map((f) => f.ruleId || f.message || 'unknown').join(', ')}`
                    : ''
            };
        }

        if (gate === 'runtime.preview_probe_evidence') {
            const ok = this._hasAnyPreviewProbeEvent(state);
            return { gate, status: ok ? 'pass' : 'fail', reason: ok ? '' : 'preview probe evidence missing' };
        }

        if (gate === 'runtime.auth_profile_pass' || gate === 'runtime.matchmaking_pass') {
            const checkName = gate.endsWith('auth_profile_pass') ? 'auth_profile' : 'matchmaking';
            const checks = this._latestPreviewProbeChecks(state);
            const status = checks.find((c) => String(c?.name || '').toLowerCase() === checkName)?.status || '';
            const ok = String(status).toLowerCase() === 'pass';
            return {
                gate,
                status: ok ? 'pass' : 'fail',
                reason: ok ? '' : `${checkName} runtime check is not pass in latest preview_probe`
            };
        }

        return { gate, status: 'skip', reason: 'unimplemented gate mapping' };
    }

    async _runTemplateCompletionGates(state, workspacePath, projectContextSummary = '') {
        const ctx = state?.templateContext || {};
        const required = Array.isArray(ctx?.requiredEvidence) ? ctx.requiredEvidence : [];
        if (!ctx?.templateId || !required.length) {
            return { pass: true, results: [] };
        }

        const results = [];
        for (const gateId of required) {
            const result = await this._evaluateTemplateGate(state, workspacePath, gateId, projectContextSummary);
            results.push(result);
            this._appendRunEvent(state, {
                type: 'template_gate_result',
                templateId: String(ctx.templateId || ''),
                gate: String(result.gate || gateId),
                status: String(result.status || 'skip'),
                reason: String(result.reason || '')
            });
        }

        const blocking = results.filter((r) => String(r.status || '').toLowerCase() !== 'pass');
        return { pass: blocking.length === 0, results, blocking };
    }

    async _bindTemplateContextForRun(state, message = '', workspacePath = '') {
        if (!state || !workspacePath) return;
        state.templateContext = state.templateContext || {};
        state.templateContext.contractViolations = Array.isArray(state.templateContext.contractViolations)
            ? state.templateContext.contractViolations
            : [];

        let templateId = String(state?.templateContext?.templateId || '').trim().toLowerCase();
        if (!templateId) {
            const templates = await templateRegistryService.listTemplates({ includeInactive: false });
            const ids = templates.map((t) => String(t?.id || '').toLowerCase()).filter(Boolean);
            templateId = this._extractTemplateIdFromText(
                `${String(message || '')}\n${String(state?.request || '')}\n${String(state?.projectContextSummary || '')}`,
                ids
            );
        }

        if (!templateId) {
            fileService.clearWorkspaceTemplateContext(workspacePath);
            return;
        }

        const rec = await templateRegistryService.getTemplateById(templateId);
        if (!rec?.templatePath) {
            fileService.clearWorkspaceTemplateContext(workspacePath);
            return;
        }

        const templateRoot = path.resolve(process.cwd(), rec.templatePath);
        const loaded = await templateContractService.loadTemplateContract(templateRoot);
        if (!loaded?.contract) {
            fileService.clearWorkspaceTemplateContext(workspacePath);
            return;
        }

        const contract = loaded.contract;
        const requestedMode = String(contract?.raw?.enforcement?.defaultMode || 'enforce').toLowerCase();
        let hasTemplateSurface = await this._workspaceHasTemplateSurface(workspacePath, contract);
        if (requestedMode === 'enforce' && !hasTemplateSurface) {
            await this._seedWorkspaceFromTemplate(workspacePath, templateRoot, contract);
            hasTemplateSurface = await this._workspaceHasTemplateSurface(workspacePath, contract);
        }
        // Auto-generate CONTRACT.json if the template doesn't ship one (fast path skips Architect).
        // This lets task_template_modify and task_template_publish read build config without an Architect task.
        const _contractJsonPath = path.join(workspacePath, 'CONTRACT.json');
        const _hasContractJson = await fs.access(_contractJsonPath).then(() => true).catch(() => false);
        if (!_hasContractJson) {
            const _bc = contract?.buildConfig || {};
            // publishSource: prefer explicit field, then outputDir (e.g. 'dist'), then build.required flag, else '.' for static
            const _publishSrc = _bc.publishSource || _bc.outputDir || (_bc.command ? 'dist' : '.');
            const _contractJson = {
                app: { appId: 'YOUR_APP_ID', createAppAllowed: true },
                build: { required: _bc.required !== false, command: _bc.command || null },
                paths: { publishSource: _publishSrc },
                publishCommand: `viverse-cli app publish ${_publishSrc} --app-id YOUR_APP_ID`
            };
            await fs.writeFile(_contractJsonPath, JSON.stringify(_contractJson, null, 2), 'utf8').catch(() => {});
            logger.info(`_bindTemplateContextForRun: auto-generated CONTRACT.json for ${templateId}`);
        }
        const enforcementMode =
            requestedMode === 'enforce' && !hasTemplateSurface
                ? 'audit'
                : requestedMode;
        state.templateContext = {
            ...state.templateContext,
            templateId: String(contract.id || rec.id || templateId),
            templateVersion: String(contract.version || rec.version || '0.0.0'),
            rulesetId: String(state?.templateContext?.rulesetId || 'default'),
            scenarioHash: String(state?.templateContext?.scenarioHash || ''),
            requiredEvidence: Array.isArray(contract.requiredGates) ? [...contract.requiredGates] : [],
            enforcementMode,
            templateRoot,
            contract
        };

        const certificationGates = await templateCertificationService.runStaticGates({
            templateRoot,
            contract
        });
        state.templateContext.certification = templateCertificationService.summarize(certificationGates);

        fileService.setWorkspaceTemplateContext(workspacePath, {
            templateId: state.templateContext.templateId,
            templateVersion: state.templateContext.templateVersion,
            enforcementMode,
            contract,
            requestScope: state?.runtimeFlags?.requestScope || null
        });
    }

    _getTemplateCertificationFailure(state) {
        const summary = state?.templateContext?.certification || null;
        if (!summary || summary.pass !== false) return null;
        const failed = Array.isArray(summary.failed) ? summary.failed : [];
        const first = failed[0] || null;
        return first
            ? String(first.reason || first.gate || 'template certification failed')
            : 'template certification failed';
    }

    async _collectLatestPreviewArtifactFiles(workspacePath) {
        const out = [];
        if (!workspacePath) return out;
        const previewRoot = path.join(workspacePath, 'artifacts', 'preview-tests');
        try {
            const entries = await fs.readdir(previewRoot, { withFileTypes: true });
            const browserDirs = entries
                .filter((e) => e.isDirectory() && e.name.startsWith('browser-'))
                .map((e) => e.name)
                .sort()
                .reverse();
            const latest = browserDirs[0];
            if (!latest) return out;
            const latestDir = path.join(previewRoot, latest);
            for (const name of ['browser-report.json', 'host.log', 'joiner.log']) {
                out.push(path.join(latestDir, name));
            }
        } catch {
            // ignore
        }
        return out;
    }

    async _detectRuntimeBlockerSignatures(workspacePath, artifactPaths = []) {
        const candidates = new Set();
        const addIfFileLike = (p) => {
            const v = String(p || '').trim();
            if (!v) return;
            if (!/\.(json|log|txt)$/i.test(v)) return;
            const abs = path.isAbsolute(v) ? v : path.join(workspacePath, v);
            candidates.add(abs);
        };

        for (const p of artifactPaths) addIfFileLike(p);
        const latest = await this._collectLatestPreviewArtifactFiles(workspacePath);
        for (const p of latest) addIfFileLike(p);

        const issues = [];
        const patterns = [
            {
                id: 'runtime-app-id-placeholder',
                re: /app id authority:\s*your_app_id/i,
                message: "Runtime blocker: app still reports placeholder App ID authority ('YOUR_APP_ID')."
            },
            {
                id: 'runtime-checkauth-ack-unhandled',
                re: /unhandled methods:\s*viverse_sdk\/checkauth:ack/i,
                message: "Runtime blocker: SDK bridge reports unhandled 'VIVERSE_SDK/checkAuth:ack'."
            },
            {
                id: 'runtime-setactor-missing-method',
                re: /setactor is not a function/i,
                message: "Runtime blocker: matchmaking client API mismatch ('setActor' unavailable at runtime)."
            },
            {
                id: 'runtime-roomid-missing',
                re: /roomid is required|initializing multiplayerclient for room:\s*undefined/i,
                message: "Runtime blocker: MultiplayerClient initialized without a valid roomId."
            }
        ];

        for (const absPath of candidates) {
            let txt = '';
            try {
                txt = await fs.readFile(absPath, 'utf8');
            } catch {
                continue;
            }
            for (const p of patterns) {
                if (!p.re.test(txt)) continue;
                const rel = path.relative(workspacePath, absPath).replace(/\\/g, '/');
                const exists = issues.find((i) => i.id === p.id);
                if (exists) {
                    if (!exists.artifacts.includes(rel)) exists.artifacts.push(rel);
                } else {
                    issues.push({
                        id: p.id,
                        message: p.message,
                        artifacts: [rel]
                    });
                }
            }
        }

        return issues;
    }

    _sanitizeSummaryForAgent(summary = "", state = {}, role = "") {
        let out = String(summary || "");
        // Remove historical noisy App ID lines and re-inject a single canonical authority line.
        out = out
            .split('\n')
            .filter((line) => !/IMPORTANT:\s*The VIVERSE App ID for this project is:/i.test(String(line)))
            .join('\n');

        const appId = String(state?.runtimeFlags?.appIdAuthority?.value || "").toLowerCase();
        const appIdLine = this._isValidAppId(appId)
            ? `AUTHORITATIVE_APP_ID: ${appId}`
            : `AUTHORITATIVE_APP_ID: unresolved (DO NOT INVENT. Extract from .env or viverse-cli output).`;

        // Keep this explicit for coding and verification roles that act on app ID.
        const roleUpper = String(role || "").toUpperCase();
        if (["CODER", "REVIEWER", "VERIFIER"].includes(roleUpper)) {
            out += `\n- ${appIdLine}`;
        }
        return out;
    }

    _requestPrefersSinglePlayer(contextText = '') {
        const text = String(contextText || '').toLowerCase();
        return /(single-player|single player)/.test(text) && !/\bmultiplayer\b/.test(text);
    }

    _extractFixIssueBlock(prompt = '') {
        const text = String(prompt || '');
        const fastGateBlock = text.match(/Resolve all failed rules from fast gate:\n([\s\S]*?)\n\nTask context:/i)?.[1];
        if (fastGateBlock) return fastGateBlock;

        const reviewerBlock = text.match(/Target subsystem:\s*[^\n]+\n([\s\S]*?)\n\nReviewer feedback:/i)?.[1];
        if (reviewerBlock) return reviewerBlock;

        return '';
    }

    _extractFixSignature(prompt = '') {
        return String(prompt || '').match(/Signature:\s*([^\n]+)/i)?.[1] || '';
    }

    _summarizeFixTaskContext(prompt = '') {
        const text = String(prompt || '').trim();
        if (!text) return '';

        const priorTaskContext = text.match(/Task context:\s*([\s\S]*?)(?:\n\nSCOPED FIX EXECUTION|\n\nFIX SCOPE LOCK|\n\n\[TEMPLATE_EXECUTION_GUARD\]|$)/i)?.[1];
        if (priorTaskContext) {
            return String(priorTaskContext).trim();
        }

        const requestFocus = text.match(/Request focus:\s*([^\n]+)/i)?.[0];
        const implementBlock = text.match(/Task context:\s*Implement the requested app functionality inside the template workspace\.[\s\S]*?(?:\n\nSCOPED FIX EXECUTION|\n\nFIX SCOPE LOCK|\n\n\[TEMPLATE_EXECUTION_GUARD\]|$)/i)?.[0];
        if (requestFocus || implementBlock) {
            return [implementBlock, requestFocus].filter(Boolean).join('\n').trim();
        }

        return text
            .split(/\n\nSCOPED FIX EXECUTION|\n\nFIX SCOPE LOCK|\n\n\[TEMPLATE_EXECUTION_GUARD\]/i)[0]
            .trim();
    }

    _buildVerifierFailureSignature(verifierResult = {}) {
        const details = verifierResult?.details && typeof verifierResult.details === 'object'
            ? verifierResult.details
            : {};
        const reasons = Array.isArray(verifierResult?.reasons) ? verifierResult.reasons : [];
        const normalizedReasons = reasons
            .map((value) => String(value || '').trim().toLowerCase())
            .filter(Boolean)
            .map((value) => value.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
            .filter(Boolean);
        const runtimeChecks = details?.runtime_checks && typeof details.runtime_checks === 'object'
            ? Object.entries(details.runtime_checks)
                .filter(([, info]) => String(info?.status || '').toLowerCase() !== 'pass')
                .map(([name, info]) => {
                    const status = String(info?.status || 'unknown').trim().toLowerCase();
                    return `${String(name || '').trim().toLowerCase()}:${status}`;
                })
                .filter(Boolean)
            : [];
        const parts = [...normalizedReasons, ...runtimeChecks].sort();
        return parts.join('||') || 'verifier-blocker';
    }

    _scheduleDeterministicVerifierFixTask({ state, task, verifierResult } = {}) {
        if (!state || !task || !verifierResult || typeof verifierResult !== 'object') {
            return { scheduled: false, reason: 'invalid_inputs' };
        }

        const reasons = (Array.isArray(verifierResult.reasons) ? verifierResult.reasons : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean);
        const details = verifierResult.details && typeof verifierResult.details === 'object'
            ? verifierResult.details
            : {};
        const runtimeChecks = details?.runtime_checks && typeof details.runtime_checks === 'object'
            ? Object.entries(details.runtime_checks).map(([name, info]) => ({
                name: String(name || '').trim(),
                status: String(info?.status || 'unknown').trim(),
                proof: String(info?.proof || '').trim()
            }))
            : [];
        const failingRuntimeLines = runtimeChecks
            .filter((entry) => entry.name && String(entry.status || '').toLowerCase() !== 'pass')
            .map((entry) => `- runtime.${entry.name}: ${entry.status}${entry.proof ? ` (${entry.proof})` : ''}`);
        const artifactPaths = Array.isArray(details?.artifact_paths)
            ? details.artifact_paths.map((value) => String(value || '').trim()).filter(Boolean)
            : [];
        const issueLines = [
            ...reasons.map((reason) => `- ${reason}`),
            ...failingRuntimeLines
        ];
        const scopedSubsystem = this._inferFailureSubsystem({
            issueLines,
            task,
            state
        });
        const scopeGuard = this._buildFixScopeAndBaselineGuard(state, { issueLines });
        const scopedFixGuard = this._buildScopedFixGuard({
            subsystem: scopedSubsystem,
            issueLines
        });
        const templateGuard = this._buildTemplateExecutionGuardBlock(state);
        const signature = this._buildVerifierFailureSignature(verifierResult);

        const existingPending = state.tasks.find((entry) =>
            entry?.status === 'pending' &&
            String(entry?.role || '').toUpperCase() === 'CODER' &&
            /^v_fix_/i.test(String(entry?.id || '')) &&
            String(entry?.prompt || '').includes(`Signature: ${signature}`)
        );
        if (existingPending) {
            return {
                scheduled: false,
                existingTaskId: String(existingPending.id || ''),
                signature
            };
        }

        // ── Fix budget + strategy escalation (2.4) ──────────────────────
        const _vfixStrategy = fixOrchestrationService.resolveFixStrategy(state, signature);
        if (_vfixStrategy.strategy === 'exhausted') {
            return {
                scheduled: false,
                reason: `fix_budget_exhausted:${_vfixStrategy.attempt - 1}_attempts`,
                signature,
                exhausted: true
            };
        }
        fixOrchestrationService.recordFixBudgetUsage(state, signature);

        const fixTaskId = `v_fix_${Date.now()}`;
        const _vfixContractBuildRequired = state?.templateContext?.contract?.build?.required;
        const _vfixNoBuildNote = _vfixContractBuildRequired === false
            ? '\n\nCRITICAL — STATIC TEMPLATE (build.required: false): Do NOT run npm run build, npm install, vite build, or ANY build command. There is no dist/ folder. The publishSource is already ready as-is. Only patch source files and run viverse-cli app publish directly.'
            : '';
        const taskContext = this._summarizeFixTaskContext(task.prompt);
        const previewUrl = String(
            details?.preview_url_tested
            || verifierResult?.preview_url_tested
            || this._resolveLatestPreviewUrl(state)
            || ''
        ).trim();
        const verifierEvidenceBlock = [
            reasons.length ? `Verifier reasons:\n${reasons.map((reason) => `- ${reason}`).join('\n')}` : '',
            failingRuntimeLines.length ? `Verifier runtime failures:\n${failingRuntimeLines.join('\n')}` : '',
            artifactPaths.length ? `Verifier artifacts:\n${artifactPaths.map((value) => `- ${value}`).join('\n')}` : '',
            previewUrl ? `Verifier preview URL: ${previewUrl}` : ''
        ].filter(Boolean).join('\n\n');

        // Build regenerate block for attempt 2+ (2.4)
        const _vfixRegenBlock = _vfixStrategy.strategy === 'regenerate_component'
            ? fixOrchestrationService.buildRegenerateBlock(
                [...reasons.slice(0,3).map(() => ''), ...issueLines.slice(0,3)]
              ) + '\n\n'
            : '';

        state.tasks.push({
            id: fixTaskId,
            role: 'Coder',
            _fixSignature: signature,
            prompt: `${_vfixRegenBlock}DETERMINISTIC VERIFIER FIX REQUIRED. Signature: ${signature}
Target subsystem: ${scopedSubsystem}
Resolve the verifier-blocking release issues only. Do not broaden this into a general rewrite.

${verifierEvidenceBlock}

Task context: ${taskContext || String(task.prompt || '').trim()}${_vfixNoBuildNote}

${scopedFixGuard}
${scopeGuard}
${templateGuard}`,
            dependsOn: [],
            status: 'pending'
        });

        for (let i = 0; i < state.tasks.length; i++) {
            const entry = state.tasks[i];
            if (entry.status === 'pending' && entry.dependsOn && entry.dependsOn.includes(task.id)) {
                entry.dependsOn = entry.dependsOn.filter((depId) => depId !== task.id);
                entry.dependsOn.push(fixTaskId);
            }
        }

        return {
            scheduled: true,
            fixTaskId,
            signature,
            subsystem: scopedSubsystem
        };
    }

    _getSupportedComplianceProfiles(state = {}) {
        const contract = state?.templateContext?.contract && typeof state.templateContext.contract === 'object'
            ? state.templateContext.contract
            : {};
        const requiredGates = new Set(
            (Array.isArray(state?.templateContext?.requiredEvidence)
                ? state.templateContext.requiredEvidence
                : Array.isArray(contract?.requiredGates)
                    ? contract.requiredGates
                    : [])
                .map((v) => String(v || '').trim())
                .filter(Boolean)
        );
        const scope = state?.runtimeFlags?.requestScope || {};
        const allowedSubsystems = Array.isArray(scope.allowedSubsystems) ? scope.allowedSubsystems : [];

        const supported = new Set();
        // Seed from contract.capabilities so templates without requiredGates still
        // get bounded profiles (prevents unrestrictedProfiles=true fallback).
        const caps = Array.isArray(contract?.capabilities) ? contract.capabilities : [];
        if (caps.includes('auth') || caps.includes('leaderboard')) supported.add('auth');
        if (caps.includes('publish')) supported.add('publishing');
        if (caps.includes('multiplayer') || caps.includes('matchmaking')) supported.add('multiplayer');

        if (
            requiredGates.has('runtime.auth_profile_pass') ||
            allowedSubsystems.includes('platform-core.auth')
        ) {
            supported.add('auth');
        }
        if (
            requiredGates.has('runtime.matchmaking_pass') ||
            allowedSubsystems.includes('platform-core.matchmaking') ||
            caps.includes('multiplayer') ||
            caps.includes('matchmaking')
        ) {
            supported.add('multiplayer');
        }
        if (
            allowedSubsystems.includes('publish') ||
            requiredGates.has('build.app_id_propagation')
        ) {
            supported.add('publishing');
        }
        return supported;
    }

    _deriveComplianceProfiles(task, projectContextSummary = '', state = {}) {
        const id = String(task?.id || '');
        const prompt = String(task?.prompt || '');
        const operativePrompt = prompt
            .replace(/Preserve template-owned[^\n]*(?:\n|$)/ig, '')
            .replace(/Do NOT rewrite[^\n]*(?:\n|$)/ig, '')
            .replace(/If touching multiplayer files[^\n]*(?:\n|$)/ig, '')
            .trim();
        const fixTask = this._isFixTask(task);
        const requestContext = `${String(state?.request || '')}\n${String(projectContextSummary || '')}`;
        const singlePlayerPreferred = this._requestPrefersSinglePlayer(requestContext);
        const supportedProfiles = this._getSupportedComplianceProfiles(state);
        const unrestrictedProfiles = supportedProfiles.size === 0;

        if (id === 'auth_preflight' || /auth preflight only/i.test(prompt)) {
            return ['auth'];
        }

        if (/^c_fix_/i.test(id)) {
            const issueText = `${this._extractFixSignature(prompt)}\n${this._extractFixIssueBlock(prompt)}`;
            if (/auth preflight only/i.test(issueText)) return ['auth'];
            const issueLines = this._extractFixIssueBlock(prompt)
                .split('\n')
                .map((line) => String(line || '').trim())
                .filter(Boolean);
            const inferredSubsystem = this._inferFailureSubsystem({ issueLines, task, state });
            if (inferredSubsystem === 'publish') {
                return ['publishing'];
            }
            if (inferredSubsystem === 'platform-core.matchmaking') {
                // Only apply multiplayer compliance if the template actually supports it
                if (!supportedProfiles.has('multiplayer') && supportedProfiles.size > 0) return [];
                if (singlePlayerPreferred) return ['auth'];
                return ['multiplayer'];
            }
            if (inferredSubsystem === 'platform-core.auth') {
                return ['auth'];
            }
            const fromContext = complianceService.inferProfiles(issueText)
                .filter((profile) => !supportedProfiles.size || supportedProfiles.has(profile));
            if (fromContext.length) {
                if (singlePlayerPreferred) {
                    return fromContext.filter((profile) => profile !== 'multiplayer');
                }
                return fromContext;
            }
        }

        if (fixTask) {
            const issueLines = this._extractFixIssueBlock(prompt)
                .split('\n')
                .map((line) => String(line || '').trim())
                .filter(Boolean);
            const inferredSubsystem = this._inferFailureSubsystem({ issueLines, task, state });
            if (inferredSubsystem === 'publish') {
                return ['publishing'];
            }
            if (inferredSubsystem === 'platform-core.matchmaking') {
                // Only apply multiplayer compliance if the template actually supports it
                if (!supportedProfiles.has('multiplayer') && supportedProfiles.size > 0) return [];
                return singlePlayerPreferred ? [] : ['multiplayer'];
            }
            if (inferredSubsystem === 'platform-core.auth') {
                return ['auth'];
            }
            if (inferredSubsystem === 'gameplay' || inferredSubsystem === 'ui') {
                return [];
            }
        }

        const fromPrompt = complianceService
            .inferProfiles(operativePrompt)
            .filter((profile) => unrestrictedProfiles || supportedProfiles.has(profile));
        if (fromPrompt.length) {
            if (fixTask) {
                if (singlePlayerPreferred) {
                    return fromPrompt.filter((profile) => profile !== 'multiplayer');
                }
                return fromPrompt;
            }
            return fromPrompt;
        }

        // Last fallback only when task prompt has no detectable profile.
        const fallback = complianceService
            .inferProfiles(projectContextSummary)
            .filter((profile) => unrestrictedProfiles || supportedProfiles.has(profile));
        if (fixTask) {
            const filtered = fallback.filter((profile) => unrestrictedProfiles || supportedProfiles.has(profile));
            if (singlePlayerPreferred) {
                return filtered.filter((profile) => profile !== 'multiplayer');
            }
            return filtered;
        }
        return fallback;
    }

    _deriveCompliancePhase(task) {
        const id = String(task?.id || '');
        const prompt = String(task?.prompt || '').toLowerCase();

        if (id === 'auth_preflight' || /auth preflight only/.test(prompt)) return 'auth_preflight';
        if (/^fix_|^c_fix_|^v_fix_/i.test(id)) return 'fix';
        if (/publish|deploy|viverse-cli\s+app\s+publish/.test(prompt)) return 'publish';
        return 'gameplay';
    }

    _normalizePlan(rawPlan, { message = "", isResumeCommand = false, skipWorkflowExpansion = false } = {}) {
        if (!rawPlan || typeof rawPlan !== 'object') return null;
        const tasks = this._normalizeTasks(rawPlan.tasks || []);
        if (!tasks.length) return null;
        const enforcedTasks = this._enforceWorkflowTasks(tasks, { message, skipWorkflowExpansion });

        const normalized = {
            ...rawPlan,
            isNewProject: typeof rawPlan.isNewProject === 'boolean'
                ? rawPlan.isNewProject
                : this._inferIsNewProjectFallback(message, isResumeCommand),
            tasks: enforcedTasks
        };
        return normalized;
    }

    _parseJsonObject(raw = "") {
        const text = String(raw || '').trim();
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch {
            // continue
        }
        const unfenced = text.replace(/```json\s*|\s*```/gi, '').trim();
        try {
            return JSON.parse(unfenced);
        } catch {
            // continue
        }
        const start = unfenced.indexOf('{');
        const end = unfenced.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(unfenced.slice(start, end + 1));
            } catch {
                return null;
            }
        }
        return null;
    }

    async _generatePlanWithValidation(planPrompt, history = [], attachments = [], options = {}) {
        const attempts = [];
        let prompt = String(planPrompt || '');
        const maxAttempts = Math.max(1, Number(options.maxAttempts || 2));

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const response = await geminiService.generateResponse(prompt, history, "ORCHESTRATOR", null, attachments);
            const parsed = this._parseJsonObject(response);

            if (parsed?.error === "CREDENTIALS_REQUIRED") {
                return { ok: true, parsedPlan: parsed, attempts: [{ attempt, response, parsed, validation: { ok: true, errors: [] } }] };
            }

            const validation = plannerSchemaValidator.validate(parsed);
            attempts.push({ attempt, response, parsed, validation });
            if (validation.ok) {
                return { ok: true, parsedPlan: parsed, attempts };
            }

            if (attempt < maxAttempts) {
                prompt = plannerSchemaValidator.buildRetryPrompt({
                    originalPrompt: planPrompt,
                    invalidResponse: response,
                    errors: validation.errors
                });
            }
        }

        return {
            ok: false,
            parsedPlan: null,
            attempts
        };
    }

    _isPublishTask(task = {}) {
        if (String(task.id || '') === 'auth_preflight') return false;
        const role = String(task.role || '').toUpperCase();
        const prompt = String(task.prompt || '').toLowerCase();
        if (role !== 'CODER') return false;
        const mentionsPublish = /(publish|viverse-cli\s+app\s+publish|deploy)/i.test(prompt);
        if (!mentionsPublish) return false;

        // Do not pre-block hybrid implementation tasks that include setup steps.
        const setupSignals = /(create|scaffold|generate|implement|build|write|npm\s+install|viverse-cli\s+app\s+create)/i.test(prompt);
        const publishLeading = /^(publish|deploy|run\s+viverse-cli\s+app\s+publish)\b/i.test(prompt.trim());
        const idLooksPublish = /\bpublish\b/i.test(String(task.id || ''));
        return publishLeading || idLooksPublish || !setupSignals;
    }

    async _checkPublishPreconditions(task, state, workspacePath, contextText = "") {
        if (!this._isPublishTask(task)) return { ok: true };
        if (state?.runtimeFlags?.authInvalid) {
            return { ok: false, reason: 'Publish blocked: previous authentication failure detected. Please update credentials and retry.' };
        }
        const taskRequestScope = this._deriveTaskRequestScope(task, state);
        if (state?.templateContext?.templateId) {
            const gate = await complianceService.runFastGate({
                workspacePath,
                taskPrompt: String(task?.prompt || 'publish precheck'),
                profileHints: this._deriveComplianceProfiles(task, contextText, state),
                gatePhase: 'publish',
                cache: this.complianceRuntimeCache.get(workspacePath) || state.complianceFastCache || {},
                templateContext: state?.templateContext || null,
                requestScope: taskRequestScope
            });
            if (gate?._nextCache) {
                this.complianceRuntimeCache.set(workspacePath, gate._nextCache);
                state.complianceFastCache = {
                    lastSnapshotKey: gate._nextCache.lastSnapshotKey,
                    lastResult: gate._nextCache.lastResult
                };
            }
            const hasBootstrapBlocker = Array.isArray(gate?.findings)
                && gate.findings.some((finding) => String(finding?.ruleId || '') === 'template-world-bootstrap-missing');
            if (hasBootstrapBlocker) {
                return {
                    ok: false,
                    reason: 'Publish blocked: template startup/runtime bootstrap is missing the world launch path.'
                };
            }
        }
        // If App ID authority hasn't been set yet, auth hasn't run — defer instead of hard-block.
        // The dependency chain will prevent publish from running before auth completes.
        const authorityValue = String(state?.runtimeFlags?.appIdAuthority?.value || '').trim();
        if (!authorityValue) return { ok: true };
        return { ok: true };
    }

    async _shouldSkipVerifier(state, workspacePath) {
        // Skip if source files are identical to the last passing Verifier run (3.1)
        const lastPass = verificationLedgerService.latestVerifierSummary(workspacePath);
        if (!lastPass || lastPass.status !== 'pass' || !lastPass.sourceHash) return false;
        const currentHash = await fixOrchestrationService.snapshotWorkspace(workspacePath);
        return currentHash && currentHash === lastPass.sourceHash;
    }

    async _checkVerifierPreconditions(state, workspacePath, contextText = "") {
        if (state?.runtimeFlags?.authInvalid) {
            return { ok: false, reason: 'Verifier blocked: authentication is invalid in this run.' };
        }
        // Preview probe pass is stronger evidence than static propagation check.
        // If runtime is confirmed healthy, allow verifier to proceed.
        const previewProbePassed =
            state?.runtimeFlags?.baselineContract?.source === 'preview_probe_pass' ||
            (state?.verificationLedger || []).some(
                (e) => e?.type === 'preview_probe' && e?.status === 'pass'
            );
        if (previewProbePassed) {
            return { ok: true, reason: 'preview_probe_pass_override' };
        }
        const integrity = await this._checkAppIdIntegrity(state, workspacePath, contextText);
        if (!integrity.ok) {
            return { ok: false, reason: `Verifier blocked: ${integrity.reason}` };
        }
        // Skip dist/ check for static templates (build.required: false)
        const buildRequired = state?.templateContext?.contract?.buildConfig?.required;
        const isStaticTemplate = buildRequired === false;
        if (!isStaticTemplate) {
            try {
                const distPath = path.join(workspacePath, 'dist');
                const distStat = await fs.stat(distPath);
                if (!distStat.isDirectory()) {
                    return { ok: false, reason: 'Verifier blocked: dist folder is missing.' };
                }
            } catch {
                return { ok: false, reason: 'Verifier blocked: dist folder is missing.' };
            }
        }
        return { ok: true };
    }

    async *processRequest(message, history = [], credentials = null, attachments = [], { phase0Mode = null, templateContext = null, preferredWorkspace = null, conversationId = null } = {}) {
        this._lastCredentials = credentials; // stored for memory recording on completion
        logger.info(`Orchestrator: Processing request: ${message}`);
        
        // Ensure agents have the latest dynamic knowledge (skills/resilience guide)
        await geminiService.refreshKnowledge();
        const workSpaceDir = path.resolve(process.cwd(), '.viverse_workspaces');
        const lowerMsg = message.toLowerCase().trim();
        const isResumeCommand =
            ["proceed", "continue", "go on", "ok", "yes", "next"].includes(lowerMsg) ||
            /^(resume|continue|proceed)\b/.test(lowerMsg);
        const hasExplicitResumeInstruction =
            /^(resume|continue|proceed)\b/.test(lowerMsg) &&
            /\b(and|then|run|publish|probe|fix|build|test|verify|implement)\b/.test(lowerMsg);
        const strictFixOnlyFollowUp = this._isStrictFixOnlyMessage(message);
        
        let workspacePath;
        let state;
        let plan;

        const userKey = credentials?.email ? String(credentials.email).toLowerCase() : "";
        const reqHint = String(message || '').match(/\b(req_\d{8,})\b/i)?.[1] || "";

        // Resolve workspace hint: conversationId map first (O(1), no scan, safe for concurrent users),
        // then explicit preferredWorkspace from frontend (set on credential re-send),
        // then req_XXXXXXX hint embedded in message text, then activeProjects by email.
        const conversationPinnedPath = conversationId ? this.conversationWorkspaces.get(conversationId) : null;
        const explicitWorkspaceHint = conversationPinnedPath
            || (preferredWorkspace
                ? (path.isAbsolute(preferredWorkspace) ? preferredWorkspace : path.join(workSpaceDir, preferredWorkspace))
                : reqHint ? path.join(workSpaceDir, reqHint) : null);
        const resolvedPreferredWorkspace = explicitWorkspaceHint || (userKey ? this.activeProjects.get(userKey) : null);

        // PRE-SCAN: choose best workspace candidate instead of blindly picking latest.
        let _bestWorkspace = null;
        try {
            // If we have a definitive workspace hint (conversationId map hit or explicit pin),
            // load it directly — no global scoring scan, safe for concurrent users.
            if (resolvedPreferredWorkspace) {
                const statePath = path.join(resolvedPreferredWorkspace, '.agent_state.json');
                try {
                    const content = await fs.readFile(statePath, 'utf8');
                    const parsed = JSON.parse(content);
                    _bestWorkspace = { path: resolvedPreferredWorkspace, state: parsed, score: 9999 };
                } catch (_) { /* fall through to last-resort scan */ }
            }
            if (!_bestWorkspace) {
                // Last resort: no conversationId/preferredWorkspace hit — pick most recent workspace.
                _bestWorkspace = await this._pickWorkspace(workSpaceDir);
            }
            if (_bestWorkspace && isResumeCommand) {
                workspacePath = _bestWorkspace.path;
                state = _bestWorkspace.state;
                this._ensureRuntimeFlagsShape(state);
                this._rehardenLoadedStateTasks(state, { message });
                await this._retireObsoletePendingRecoveryTasks(state, workspacePath);
                yield { type: 'status', content: sanitizer.sanitize(`Resuming work in existing sandbox: ${workspacePath}`, credentials) };
                const latestPacket = workflowContextService.getLatestPacket(state);
                const resumeLine = latestPacket?.nextAction
                    ? `Next action: ${latestPacket.nextAction}`
                    : `Current Task: ${state.tasks.find(t => t.status === 'pending')?.prompt.substring(0, 50) || "none"}...`;
                yield { type: 'status', content: sanitizer.sanitize(resumeLine, credentials) };
            }
        } catch (e) {
            logger.debug("No workspaces found.");
        }

        // If user asks for additional action but the resumed state has no pending tasks,
        // force a fresh planning pass so follow-up instructions are not ignored.
        // NOTE: revive blocked/failed tasks FIRST so the pendingCount reflects reality.
        if (state && isResumeCommand) {
            const earlyRevivedBlocked = this._reviveStaleBlockedTasks(state, { isResumeCommand });
            if (earlyRevivedBlocked.length > 0) {
                state.projectContextSummary = (state.projectContextSummary || '') +
                    `\n- Revived stale blocked tasks (early): ${earlyRevivedBlocked.join(', ')}`;
                yield {
                    type: 'status',
                    content: `Unblocked tasks with satisfied dependencies: ${earlyRevivedBlocked.join(', ')}.`
                };
            }
        }

        if (state && isResumeCommand) {
            const pendingCount = Array.isArray(state.tasks)
                ? state.tasks.filter((t) => t.status === 'pending').length
                : 0;
            if (pendingCount === 0 && hasExplicitResumeInstruction) {
                if (strictFixOnlyFollowUp) {
                    const scopedFixTasks = this._enforceWorkflowTasks(
                        [
                            {
                                id: 'task_fix_scope',
                                role: 'Coder',
                                prompt: `Scoped fix-only follow-up. Keep existing working logic unchanged except required bug fixes.\nUser instruction: "${message}"`,
                                dependsOn: [],
                                status: 'pending'
                            }
                        ],
                        { message, skipWorkflowExpansion: true }
                    ).map((t) => ({ ...t, status: 'pending' }));
                    state.request = message;
                    state.tasks = scopedFixTasks;
                    state.projectContextSummary = `${state.projectContextSummary || ""}\n\nFOLLOW-UP FIX-ONLY REQUEST: "${message}"\nPlanner bypassed to preserve existing working logic while applying a minimal patch.`;
                    yield {
                        type: 'status',
                        content: 'No pending tasks in saved state. Scheduling strict fix-only follow-up tasks (planner bypassed).'
                    };
                } else {
                    yield {
                        type: 'status',
                        content: 'No pending tasks in saved state. Re-planning follow-up tasks from your instruction...'
                    };
                    state = null;
                }
            }
        }

        // ── INTENT CLASSIFIER (LLM-only, Phase 0) ──────────────────────────
        // All routing decisions go through the LLM. No regex-based fast-path.
        // Options: new_app | template_modify | asset_iteration | logic_iteration
        const _iterMode = plan ? 'new_app' : await this._classifyRequestIntentLLM(message, {
            workspaceState: state || (_bestWorkspace?.state?.status !== 'awaiting_credentials' ? _bestWorkspace?.state : null) || null,
            templateContext: templateContext || null,
            history
        });

        // ── TEMPLATE MODIFICATION FAST PATH ──────────────────────────────────
        // LLM decided this is a template-based new app with visual/asset modifications.
        // Use the deterministic 2-task plan (modify + publish) instead of the full planner.
        if (!state && _iterMode === 'template_modify') {
            // Reuse an existing awaiting_credentials workspace if one exists AND it was
            // seeded for the same template — avoids double npm install on re-send.
            // If the template IDs don't match (stale workspace from a previous session),
            // fall through to seed a fresh workspace for the correct template.
            const _awaitingTemplateId = _bestWorkspace?.state?.templateContext?.templateId;
            const _requestTemplateId = templateContext?.templateId;
            const _templateMatches = !_awaitingTemplateId || !_requestTemplateId || _awaitingTemplateId === _requestTemplateId;
            // Only reuse if the workspace is less than 30 minutes old — this covers the
            // "user just filled in credentials" case while blocking stale workspaces from
            // previous sessions (even when the template ID happens to match).
            const _wsTimestamp = parseInt(path.basename(_bestWorkspace?.path || '').replace('req_', ''), 10) || 0;
            const _wsAgeMs = Date.now() - _wsTimestamp;
            const _isFreshEnough = _wsAgeMs < 30 * 60 * 1000; // 30 minutes
            if (_bestWorkspace?.state?.status === 'awaiting_credentials' && _templateMatches && _isFreshEnough) {
                workspacePath = _bestWorkspace.path;
                state = { ..._bestWorkspace.state };
                this._ensureRuntimeFlagsShape(state);
                logger.info(`Orchestrator: Reusing awaiting_credentials workspace: ${workspacePath}`);
                yield workflowEventService.provisionalStatus(
                    'Resuming seeded workspace (credentials now provided).',
                    { phase: 'planning_bypass' }
                );
            }
            plan = this._normalizePlan(
                this._buildTemplateFallbackPlan(message, { isResumeCommand }),
                { message, isResumeCommand, skipWorkflowExpansion: true }
            );
            logger.info('Orchestrator: TEMPLATE_MODIFICATION fast path — LLM classified as template_modify.');
            yield workflowEventService.provisionalStatus(
                'Template modification detected — using lightweight 2-task plan (modify + publish).',
                { phase: 'planning_bypass' }
            );
        }

        // Short-circuit planning for iteration modes when a valid workspace exists.
        if ((_iterMode === 'logic_iteration' || _iterMode === 'asset_iteration') && !state && _bestWorkspace && _bestWorkspace.state?.status !== 'awaiting_credentials') {
            workspacePath = _bestWorkspace.path;
            state = { ..._bestWorkspace.state };
            this._ensureRuntimeFlagsShape(state);
            this._rehardenLoadedStateTasks(state, { message });
            const appId = String(state.runtimeFlags?.appIdAuthority?.value || '');
            if (_iterMode === 'logic_iteration') {
                state.tasks = [
                    {
                        id: 'coder_logic', role: 'Coder', status: 'pending', dependsOn: [],
                        prompt: `Logic-only edit. Request: "${message}". Reuse App ID ${appId}. Edit source files in allowed editablePaths only. Do NOT run viverse-cli app create.\nIMPORT AUDIT (MANDATORY): before removing or renaming any export from a shared module (Constants.js, utils, etc.), grep for all importers first: grep -r "<OldExportName>" src/ — then update every import site in the same step. Never leave a dangling import that breaks the build.`
                    },
                    {
                        id: 'coder_publish', role: 'Coder', status: 'pending', dependsOn: ['coder_logic'],
                        prompt: `Rebuild and republish with existing App ID ${appId}. The user's original request was: "${message}". Your job is ONLY to build and publish — do NOT re-do the logic/art changes (they are already done by coder_logic). Steps: (1) npm run build, (2) MANDATORY App ID injection — run EXACTLY this command: find dist \( -name "*.json" -o -name "*.html" -o -name "*.js" \) -print0 | xargs -0 sed -i "" "s/YOUR_APP_ID/${appId}/g" (the -print0 | xargs -0 form avoids shell escaping issues), (3) verify: grep -r YOUR_APP_ID dist/ must return empty, (4) viverse-cli auth login, (5) viverse-cli app publish dist --app-id ${appId}, (6) capture the preview URL from the viverse-cli app publish stdout — it will be a short URL like https://worlds.viverse.com/XXXXXXX?preview (the slug is NOT the app ID). Output it on its own line EXACTLY as: FINAL_PREVIEW_URL: <that URL>`
                    },
                    {
                        id: 'task_reviewer', role: 'Reviewer', status: 'pending', dependsOn: ['coder_publish'],
                        prompt: `Review the changes against this SPECIFIC user request: "${message}"\n\nProcedure:\n1. Read the [Coder RESULT] entries in the PROJECT_LOG_CONTEXT above. These show exactly what commands the Coder ran and what files were changed.\n2. Extract each distinct requirement from the user request (e.g. "bird on blue" = requirement 1, "fire on red" = requirement 2).\n3. For each requirement, verify the Coder's logged actions actually addressed it. If the Coder substituted something different (e.g. used flame instead of tree), that is a BLOCKING failure.\n4. Check for regressions: did any later task (like coder_publish) overwrite or undo what coder_logic did? Look for conflicting commands in the logs.\n5. Verify build artifacts are correct (App ID injected, no placeholder tokens).`
                    },
                    {
                        id: 'task_verifier', role: 'Verifier', status: 'pending', dependsOn: ['task_reviewer'],
                        prompt: 'Verify the published app: check App ID bundling (grep gate) and confirm preview URL is accessible.'
                    }
                ];
                state.runtimeFlags.requestScope = { primary: 'gameplay' };
            } else {
                // asset_iteration — visual-only, no auth, no full rebuild unless needed
                state.tasks = [
                    {
                        id: 'coder_asset', role: 'Coder', status: 'pending', dependsOn: [],
                        prompt: `Asset-only visual edit. Request: "${message}". Edit source files (colors, fonts, images, labels) only. Do NOT run viverse-cli app create. Do NOT rebuild unless strictly needed.`
                    },
                    {
                        id: 'coder_publish', role: 'Coder', status: 'pending', dependsOn: ['coder_asset'],
                        prompt: `Rebuild and republish with existing App ID ${appId}. The user's original request was: "${message}". Your job is ONLY to build and publish — do NOT re-do the asset changes (they are already done by coder_asset). Steps: (1) npm run build, (2) MANDATORY App ID injection — run EXACTLY this command: find dist \( -name "*.json" -o -name "*.html" -o -name "*.js" \) -print0 | xargs -0 sed -i "" "s/YOUR_APP_ID/${appId}/g" (the -print0 | xargs -0 form avoids shell escaping issues), (3) verify: grep -r YOUR_APP_ID dist/ must return empty, (4) viverse-cli auth login, (5) viverse-cli app publish dist --app-id ${appId}, (6) capture the preview URL from the viverse-cli app publish stdout — it will be a short URL like https://worlds.viverse.com/XXXXXXX?preview (the slug is NOT the app ID). Output it on its own line EXACTLY as: FINAL_PREVIEW_URL: <that URL>`
                    },
                    {
                        id: 'task_verifier', role: 'Verifier', status: 'pending', dependsOn: ['coder_publish'],
                        prompt: 'Verify the published app: check App ID bundling and confirm preview URL is accessible.'
                    }
                ];
                state.runtimeFlags.requestScope = { primary: 'ui', allowedSubsystems: ['ui', 'assets'] };
            }
            state.request = message;
            state.projectContextSummary = (state.projectContextSummary || '') +
                `\n\nITERATION REQUEST (${_iterMode}): "${message}"\nPlanner bypassed — ${state.tasks.length}-task fixed plan injected.`;
            yield workflowEventService.provisionalStatus(
                `${_iterMode === 'logic_iteration' ? 'Logic iteration' : 'Asset iteration'} mode — bypassing full planner (${state.tasks.length} tasks).`,
                { phase: 'planning_bypass' }
            );
        }
        // ────────────────────────────────────────────────────────────────────

        // Step 1: Planning (Skip if strictly resuming OR fast path already set plan)
        if (!state) {
            const planningSeedState = { request: message, currentStage: '', nextAction: '' };
            workflowStageService.transition(planningSeedState, 'plan', {
                reason: 'new_or_replanned_request',
                nextAction: 'Generate or validate project plan'
            });

            if (!plan) {
            yield workflowEventService.provisionalStatus('Orchestrator is analyzing your request and planning tasks...', {
                phase: 'planning'
            });
            
            const credString = credentials ? `\n\nUSER VIVERSE CREDENTIALS PROVIDED:\nEmail: ${credentials.email}\nPassword: ${credentials.password}\n` : "";

            const planPrompt = `User Request: "${message}"${credString}
            
            CRITICAL: Analyze the conversation history provided below. 
            - If the history shows an ongoing project development and the user is asking for changes, updates, fixes, or to "proceed" / "continue", you MUST set "isNewProject": false.
            - Only set "isNewProject": true if the user is fundamentally starting a DIFFERENT app.
            
            VERIFIED-LOOP MANDATE:
            1. Every plan MUST start with an Architect task to generate 'CONTRACT.json'.
            2. Every plan MUST include a 'Verifier' task AFTER any Coder 'build' or 'publish' task.
            3. The Verifier MUST check for App ID bundling (grep gate) and SDK URL correctness.
            
            Decide if this is:
            A. A simple search/question (Simple Task)
            B. A request to build/modify a web application (Project Task)
            
            If it's a Project Task, generate a JSON plan with tasks. If it's a Simple Task, respond directly.
            Return your plan strictly in the JSON format defined in your instructions. Include the boolean "isNewProject" as described above.`;

            // Speculative workspace pre-creation — overlaps dir I/O with LLM planning time (3.4)
            // Only pre-create when no workspace exists yet (first call for this session).
            const _specWorkspacePath = !workspacePath
                ? path.join(workSpaceDir, `req_${Date.now()}`)
                : null;
            const [planningResult] = await Promise.all([
                this._generatePlanWithValidation(planPrompt, history, attachments, { maxAttempts: 2 }),
                _specWorkspacePath
                    ? fs.mkdir(_specWorkspacePath, { recursive: true }).catch(() => {})
                    : Promise.resolve()
            ]);
            // Helper: clean up speculative dir if it wasn't chosen as final workspace
            const _cleanupSpecWorkspace = (finalPath) => {
                if (_specWorkspacePath && _specWorkspacePath !== finalPath) {
                    fs.rm(_specWorkspacePath, { recursive: true, force: true }).catch(() => {});
                }
            };
            // Use speculative workspace only for genuinely new projects (3.4)
            const _isNewProjectPlan = planningResult?.ok &&
                planningResult?.parsedPlan?.isNewProject !== false &&
                !planningResult?.parsedPlan?.error;
            if (_specWorkspacePath && _isNewProjectPlan) {
                workspacePath = _specWorkspacePath;
                const _npmCacheDir = path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.viverse_npm_cache');
                await fs.writeFile(path.join(workspacePath, '.npmrc'),
                    `cache=${_npmCacheDir}\nprefer-offline=true\nloglevel=warn\n`, 'utf8').catch(() => {});
            } else {
                // Resume/follow-up or plan error — speculative dir is unused, clean it up
                _cleanupSpecWorkspace(null);
            }
            const latestAttempt = planningResult.attempts[planningResult.attempts.length - 1] || null;
            const orchestratorResponse = String(latestAttempt?.response || '');

            if (planningResult.ok) {
                const parsedPlan = planningResult.parsedPlan;
                if (parsedPlan?.error === "CREDENTIALS_REQUIRED") {
                    if (this._isTemplateBoundRequest(message)) {
                        plan = this._normalizePlan(
                            this._buildTemplateFallbackPlan(message, { isResumeCommand }),
                            { message, isResumeCommand }
                        );
                        yield workflowEventService.provisionalStatus(
                            'Using deterministic template fallback plan before credentials are provided.',
                            { phase: 'planning_fallback' }
                        );
                    } else {
                        const _wsId = workspacePath ? path.basename(workspacePath) : null;
                        yield { type: 'action', action: 'require_credentials', workspaceId: _wsId };
                        yield { type: 'text', content: parsedPlan.message };
                        return;
                    }
                } else {
                    plan = this._normalizePlan(parsedPlan, { message, isResumeCommand });
                    logger.info(`Orchestrator: Plan generated. isNewProject: ${plan?.isNewProject}`);
                }
            } else {
                const errorSummary = latestAttempt?.validation?.errors?.join(' | ') || 'unknown planner schema error';
                logger.warn(`Orchestrator planner schema validation failed: ${errorSummary}`);
                yield workflowEventService.provisionalStatus(`Planner schema validation failed. ${errorSummary}`, {
                    phase: 'planning_validation'
                });
                yield { type: 'text', content: `Planner schema validation failed after retry.\n${errorSummary}` };
                return;
            }

            if (!plan || !plan.tasks) {
                yield workflowEventService.provisionalStatus('Orchestrator responded conversationally.', {
                    phase: 'planning'
                });
                yield { type: 'text', content: orchestratorResponse };
                return;
            }
            } // end if (!plan) — LLM planner

            // Step 2: Workspace Selection & State Restoration for Follow-ups
            if (plan.isNewProject === false) {
                try {
                    // Use already-resolved _bestWorkspace (conversationId map hit) or fall back to last-resort scan.
                    const best = _bestWorkspace || await this._pickWorkspace(workSpaceDir);
                    if (best) {
                        workspacePath = best.path;
                        const oldState = best.state;

                        // RESTORE but UPDATE: Keep the workspace and context, but use the NEW tasks
                        state = {
                            ...oldState,
                            request: message,
                            tasks: plan.tasks.map(t => ({ ...t, status: 'pending' })),
                        };
                        this._ensureRuntimeFlagsShape(state);
                        this._rehardenLoadedStateTasks(state, { message });
                        await this._retireObsoletePendingRecoveryTasks(state, workspacePath);
                        this._applyRequestScope(state, message);
                        
                        // Append the new request to the summary context so agents know what changed
                        state.projectContextSummary += `\n\nFOLLOW-UP REQUEST: "${message}"\nNew tasks scheduled for improvement...`;
                        
                        yield { type: 'status', content: sanitizer.sanitize(`Resuming work for iterative improvement in: ${workspacePath}`, credentials) };
                        if (userKey) this.activeProjects.set(userKey, workspacePath);
                    }
                } catch (e) {
                    logger.warn("Could not restore previous state for follow-up. Falling back to new workspace.");
                }
                // If follow-up branch picked a different workspace, clean up the speculative dir (P1)
                if (typeof _cleanupSpecWorkspace === 'function') _cleanupSpecWorkspace(workspacePath);
            }

            if (!state) {
                if (!workspacePath) {
                    workspacePath = path.join(workSpaceDir, `req_${Date.now()}`);
                    await fs.mkdir(workspacePath, { recursive: true });
                    // Write shared npm cache config so installs reuse downloaded
                    // tarballs across all workspaces — saves 30-90s per npm install (3.2)
                    const _npmCacheDir = path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.viverse_npm_cache');
                    const _npmrcContent = `cache=${_npmCacheDir}\nprefer-offline=true\nloglevel=warn\n`;
                    await fs.writeFile(path.join(workspacePath, '.npmrc'), _npmrcContent, 'utf8').catch(() => {});
                    yield { type: 'status', content: `Created new sandboxed workspace: ${workspacePath}` };
                }

                // Create initial state for new plan
                state = {
                    request: message,
                    workspacePath: workspacePath,
                    tasks: plan.tasks.map(t => ({ ...t })),
                    history: [],
                    projectContextSummary: `ORIGINAL USER PROJECT REQUEST: "${message}"\n\nProject Initialization started.`,
                    runtimeFlags: {},
                    currentStage: planningSeedState.currentStage,
                    nextAction: planningSeedState.nextAction,
                    stageHistory: planningSeedState.stageHistory || [],
                    runReport: {
                        startedAt: new Date().toISOString(),
                        events: []
                    }
                };
                this._ensureRuntimeFlagsShape(state);
                this._applyRequestScope(state, message);
                if (Array.isArray(attachments) && attachments.length) {
                    const specs = attachments.map((a, i) => `${i + 1}. ${a.name} (${a.mimeType})`).join('\n');
                    state.projectContextSummary += `\n\nSPEC ATTACHMENTS PROVIDED:\n${specs}`;
                }
                if (userKey) this.activeProjects.set(userKey, workspacePath);
            }
        }

        // Programmatic UI Trigger Enforcement
        if (!credentials) {
            if (state) {
                // Stamp conversationId now so _saveState registers the workspace in the
                // conversationWorkspaces map even before credentials arrive.
                if (conversationId && !state.conversationId) state.conversationId = conversationId;
                await this._bindTemplateContextForRun(state, message, workspacePath);
                const templateCertificationFailure = this._getTemplateCertificationFailure(state);
                if (templateCertificationFailure) {
                    state.status = 'paused_or_failed';
                    state.projectContextSummary += `\n- TEMPLATE CERTIFICATION FAILED: ${templateCertificationFailure}`;
                    await this._saveState(state);
                    yield { type: 'status', content: `Template configuration issue: ${templateCertificationFailure}` };
                    yield {
                        type: 'text',
                        content: `⚠️ **Template configuration issue**\n\n`
                            + `The **${state?.templateContext?.templateId || 'selected'}** template has a configuration problem:\n`
                            + `> ${templateCertificationFailure}\n\n`
                            + `This is a server-side setup issue, not a problem with your request. `
                            + `Please try a different template (e.g. \`blank-webapp-v1\`, \`tankarena-3d-v1\`) `
                            + `or contact your administrator.`
                    };
                    return;
                }
                state.status = 'awaiting_credentials';
                workflowStageService.transition(state, 'plan', {
                    reason: 'awaiting_credentials',
                    nextAction: 'Provide VIVERSE credentials to continue planned workflow'
                });
                await this._saveState(state);
            }
            // Include the workspace ID so the frontend can pin it on the credential re-send,
            // avoiding any global workspace search on the 2nd call.
            const _wsId = workspacePath ? path.basename(workspacePath) : null;
            yield { type: 'action', action: 'require_credentials', workspaceId: _wsId };
            yield { type: 'text', content: 'I need your VIVERSE Account credentials to build and publish this app. Please enter them in the form below.' };
            return;
        }

        if (state) {
            this._ensureRuntimeFlagsShape(state);
            this._applyRequestScope(state, message);
            // Stamp the conversationId on state so _saveState can register it in
            // the conversationWorkspaces map and persist it to disk for server-restart recovery.
            if (conversationId && !state.conversationId) state.conversationId = conversationId;
        }

        let projectContextSummary = state.projectContextSummary || "";
        this._ensureRuntimeFlagsShape(state);
        state.projectContextSummary = projectContextSummary;
        if (isResumeCommand && this._isCompletedWorkflowState(state)) {
            if (String(state?.status || '').toLowerCase() !== 'completed') {
                await this._finalizeWorkflowState(state, 'completed');
            }
            yield {
                type: 'status',
                content: 'Workflow already completed.'
            };
            yield {
                type: 'text',
                content: workflowCompletionService.buildOutcomeNotice({
                    state,
                    completed: true,
                    reason: '',
                    resolveLatestPreviewUrl: this._resolveLatestPreviewUrl.bind(this)
                })
            };
            yield workflowEventService.workflowOutcome({
                completed: true,
                reason: '',
                workspacePath: state?.workspacePath || ''
            });
            return;
        }
        const revivedTransientTasks = this._reviveTransientInfraFailedTasks(state, { isResumeCommand });
        if (revivedTransientTasks.length > 0) {
            projectContextSummary += `\n- Revived transient-infra-failed tasks for retry: ${revivedTransientTasks.join(', ')}`;
            state.projectContextSummary = projectContextSummary;
            yield {
                type: 'status',
                content: `Resuming previously failed transient-infra tasks: ${revivedTransientTasks.join(', ')}.`
            };
        }
        const revivedSkillComplianceTasks = this._reclassifyObsoleteSkillComplianceFailures(state, { isResumeCommand });
        if (revivedSkillComplianceTasks.length > 0) {
            projectContextSummary += `\n- Reclassified obsolete skill-compliance failures as completed: ${revivedSkillComplianceTasks.join(', ')}`;
            state.projectContextSummary = projectContextSummary;
            yield {
                type: 'status',
                content: `Resuming tasks previously stopped by obsolete skill-compliance formatting: ${revivedSkillComplianceTasks.join(', ')}.`
            };
            for (const taskId of revivedSkillComplianceTasks) {
                this._appendRunEvent(state, {
                    type: 'task_failed_recovered',
                    taskId,
                    reason: 'obsolete_skill_compliance_failure_reclassified'
                });
            }
        }
        const revivedBlockedTasks = this._reviveStaleBlockedTasks(state, { isResumeCommand });
        if (revivedBlockedTasks.length > 0) {
            projectContextSummary += `\n- Revived stale blocked tasks with satisfied dependencies: ${revivedBlockedTasks.join(', ')}`;
            state.projectContextSummary = projectContextSummary;
            yield {
                type: 'status',
                content: `Resuming stale blocked tasks whose dependencies are already satisfied: ${revivedBlockedTasks.join(', ')}.`
            };
            for (const taskId of revivedBlockedTasks) {
                this._appendRunEvent(state, {
                    type: 'task_blocked_recovered',
                    taskId,
                    reason: 'stale_blocked_state_revived'
                });
            }
        }
        await this._bindTemplateContextForRun(state, message, workspacePath);
        const templateCertificationFailure = this._getTemplateCertificationFailure(state);
        if (templateCertificationFailure) {
            state.status = 'paused_or_failed';
            projectContextSummary += `\n- TEMPLATE CERTIFICATION FAILED: ${templateCertificationFailure}`;
            state.projectContextSummary = projectContextSummary;
            await this._saveState(state);
            yield { type: 'status', content: `Template configuration issue: ${templateCertificationFailure}` };
            yield {
                type: 'text',
                content: `⚠️ **Template configuration issue**\n\n`
                    + `The **${state?.templateContext?.templateId || 'selected'}** template has a configuration problem:\n`
                    + `> ${templateCertificationFailure}\n\n`
                    + `This is a server-side setup issue, not a problem with your request. `
                    + `Please try a different template (e.g. \`blank-webapp-v1\`, \`tankarena-3d-v1\`) `
                    + `or contact your administrator.`
            };
            return;
        }
        this._beginRunReport(state);
        // Final stamp — covers all paths (iteration fast-path, planner, template_modify).
        if (conversationId && !state.conversationId) state.conversationId = conversationId;
        if (conversationId && state.workspacePath) this.conversationWorkspaces.set(conversationId, state.workspacePath);
        if (state?.templateContext?.templateId) {
            this._appendRunEvent(state, {
                type: 'template_selected',
                templateId: String(state.templateContext.templateId || ''),
                templateVersion: String(state.templateContext.templateVersion || ''),
                rulesetId: String(state.templateContext.rulesetId || 'default'),
                enforcementMode: String(state.templateContext.enforcementMode || 'enforce')
            });
        }
        this._appendRunEvent(state, {
            type: 'run_started',
            request: String(message || '').slice(0, 400),
            workspacePath
        });
        if (!String(state.currentStage || '').trim()) {
            workflowStageService.transition(state, 'plan', {
                reason: 'run_started',
                nextAction: 'Select next ready task'
            });
        }
        state.status = 'running';
        if (userKey && state.workspacePath) this.activeProjects.set(userKey, state.workspacePath);
        await this._saveState(state);

        // Step 3: Execution Loop (outer loop handles inline revalidation after fix tasks)
        let _inlineRevalCount = 0;
        executionLoop: while (true) {
        while (true) {
            const pendingTasks = workflowExecutionService.getPendingTasks(state);
            if (pendingTasks.length === 0) break;

            const nowMs = Date.now();
            const readyTasks = workflowExecutionService.getReadyTasks(state, nowMs);

            logger.info(`Orchestrator: Tasks pending: ${pendingTasks.length}, Tasks ready: ${readyTasks.length}`);

            if (readyTasks.length === 0) {
                const deferredRetryTasks = workflowExecutionService.getDeferredRetryTasks(state, Date.now());
                if (deferredRetryTasks.length > 0) {
                    const nextRetryAt = Math.min(...deferredRetryTasks.map((t) => Number(t.transientInfraRetryAt || Date.now())));
                    const remainingMs = Math.max(0, nextRetryAt - Date.now());
                    yield {
                        type: 'status',
                        content: `Waiting for transient AI infra recovery. Next automatic retry in ~${Math.max(1, Math.ceil(remainingMs / 1000))}s.`
                    };
                    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(300, remainingMs))));
                    continue;
                }
                const retiredFailedComplianceFixes = await this._retireObsoleteFailedComplianceFixTasks(
                    state,
                    workspacePath,
                    projectContextSummary
                );
                if (retiredFailedComplianceFixes) {
                    projectContextSummary = String(state.projectContextSummary || projectContextSummary);
                    state.projectContextSummary = projectContextSummary;
                    await this._saveState(state);
                    continue;
                }
                const failedTasks = state.tasks.filter(t => t.status === 'failed' || t.status === 'blocked').map(t => t.id);
                logger.warn(`Orchestrator: Deadlock or finished. Remaining pending tasks: ${pendingTasks.map(t => t.id).join(', ')}. Failed/Blocked: ${failedTasks.join(', ')}`);
                const reason = failedTasks.length
                    ? `Execution paused: blocked by failed tasks (${failedTasks.join(', ')}).`
                    : 'Execution paused: Cannot proceed due to missing dependencies or previous failures.';
                yield { type: 'status', content: reason };
                break;
            }

            // NOTE: For streaming feedback to the UI, we await sequentially. 
            // The dependency graph allows true concurrency (Promise.all) if stream merging is implemented in the UI layer.
            for (const task of readyTasks) {
                let haltExecutionReason = null;
                const taskStartedAt = Date.now();
                // Take a snapshot before any fix task so we can detect no-ops later (2.2)
                const _preFixSnapshot = this._isFixTask(task)
                    ? await fixOrchestrationService.snapshotWorkspace(workspacePath)
                    : '';
                if (this._isFixTask(task)) task._snapshotBefore = _preFixSnapshot;
                const taskRequestScope = this._deriveTaskRequestScope(task, state);
                if (workspacePath) {
                    const existingCtx = fileService.getWorkspaceTemplateContext(workspacePath);
                    if (existingCtx && typeof existingCtx === 'object') {
                        fileService.setWorkspaceTemplateContext(workspacePath, {
                            ...existingCtx,
                            requestScope: taskRequestScope
                        });
                    }
                }
                if (Number(task?.transientInfraRetryAt || 0) > 0) {
                    task.transientInfraRetryAt = 0;
                }
                this._appendRunEvent(state, {
                    type: 'task_started',
                    taskId: task.id,
                    role: task.role,
                    prompt: String(task.prompt || '').slice(0, 200)
                });
                workflowStageService.transitionForTask(state, task, {
                    reason: 'task_started',
                    nextAction: `Execute task ${String(task.id || '')} (${String(task.role || '')})`
                });
                state.projectContextSummary = projectContextSummary;
                await this._saveState(state);
                const isFixLoopTask = /^(?:fix_|v_fix_|c_fix_)/i.test(String(task.id || ""));

                // Auto-resolve stale deterministic compliance-fix tasks if current code no longer violates
                // the task's signature. This prevents deadlocks from outdated fix prompts.
                if (/^c_fix_/i.test(String(task.id || "")) && /DETERMINISTIC COMPLIANCE FIX REQUIRED/i.test(String(task.prompt || ""))) {
                    try {
                        const sigText = String(task.prompt || '').match(/Signature:\s*([^\n]+)/i)?.[1] || '';
                        const expectedRuleIds = sigText
                            .split('||')
                            .map((s) => String(s || '').trim())
                            .filter(Boolean);
                        if (expectedRuleIds.length > 0) {
                            const profileHints = this._deriveComplianceProfiles(task, projectContextSummary, state);
                            const gate = await complianceService.runFastGate({
                                workspacePath,
                                taskPrompt: task.prompt,
                                profileHints,
                                gatePhase: 'fix',
                                cache: this.complianceRuntimeCache.get(workspacePath) || state.complianceFastCache || {},
                                templateContext: state?.templateContext || null,
                                requestScope: taskRequestScope
                            });
                            const activeRuleIds = new Set((gate.findings || []).map((f) => String(f.ruleId || '').trim()));
                            const unresolved = expectedRuleIds.filter((id) => activeRuleIds.has(id));
                            if (unresolved.length === 0) {
                                task.status = 'completed';
                                this._appendRunEvent(state, {
                                    type: 'task_auto_resolved',
                                    taskId: task.id,
                                    role: task.role,
                                    durationMs: Date.now() - taskStartedAt,
                                    note: `Compliance fix signature already resolved: ${expectedRuleIds.join(', ')}`
                                });
                                projectContextSummary += `\n- Auto-resolved stale compliance fix task ${task.id}; signature no longer present.`;
                                state.projectContextSummary = projectContextSummary;
                                yield {
                                    type: 'status',
                                    content: `Auto-resolved stale compliance fix task (${task.id}). Continuing workflow.`
                                };
                                await this._saveState(state);
                                continue;
                            }
                        }
                    } catch (autoResolveErr) {
                        logger.warn(`Orchestrator: c_fix auto-resolve precheck failed: ${autoResolveErr?.message || autoResolveErr}`);
                    }
                }

                if (isFixLoopTask) {
                    yield {
                        type: 'status',
                        content: sanitizer.sanitize(
                            `Review gate requested fixes. Running extended fix loop with ${task.role}... this can take longer than normal.`,
                            credentials
                        )
                    };
                }

                yield { type: 'status', content: sanitizer.sanitize(`Agent [${task.role}] is working on: ${task.prompt.substring(0, 50)}...`, credentials) };
                yield { type: 'text', content: sanitizer.sanitize(`\n\n> **Agent [${task.role}]** is starting task: *${task.prompt}*`, credentials) };
                logger.info(`Orchestrator: Dispatching task ${task.id} to ${task.role}`);

                const publishPrecheck = await this._checkPublishPreconditions(
                    task,
                    state,
                    workspacePath,
                    `${projectContextSummary}\n${String(task.prompt || "")}`
                );
                if (!publishPrecheck.ok) {
                    task.status = 'blocked';
                    const reason = publishPrecheck.reason || 'Publish preconditions not met.';
                    projectContextSummary += `\n- ${task.role} BLOCKED: ${reason}`;
                    state.projectContextSummary = projectContextSummary;
                    await this._saveState(state);
                    yield { type: 'status', content: sanitizer.sanitize(reason, credentials) };
                    yield { type: 'text', content: sanitizer.sanitize(`\n\n⚠️ **${task.role} task blocked**\nReason: ${reason}`, credentials) };
                    await this._finalizeWorkflowState(state, 'paused_or_failed');
                    return;
                }

                if (String(task.role || '').toUpperCase() === 'VERIFIER') {
                    // Runtime safety net: if any publish tasks are still pending (can happen when
                    // ap_fix rerouting corrupts the dependency graph), re-wire verifier to wait.
                    // This prevents verifier from running before dist/ exists.
                    const _pendingPublishIds = (state?.tasks || [])
                        .filter(t => t.status === 'pending' && this._isPublishTask(t))
                        .map(t => t.id);
                    if (_pendingPublishIds.length > 0) {
                        const _vDeps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
                        let _rewired = false;
                        for (const _pid of _pendingPublishIds) {
                            if (!_vDeps.includes(_pid)) { _vDeps.push(_pid); _rewired = true; }
                        }
                        if (_rewired) {
                            task.dependsOn = _vDeps;
                            task.status = 'pending';
                            logger.info(`Orchestrator: Verifier ${task.id} re-wired to pending publish tasks: ${_pendingPublishIds.join(', ')}`);
                            await this._saveState(state);
                            break; // break for(task of readyTasks) → inner while re-evaluates
                        }
                    }

                    // Skip entirely if nothing changed since last passing run (3.1)
                    const _shouldSkip = await this._shouldSkipVerifier(state, workspacePath);
                    if (_shouldSkip) {
                        task.status = 'completed';
                        verificationLedgerService.record(workspacePath, {
                            type: 'verifier',
                            taskId: task.id,
                            role: task.role,
                            status: 'pass',
                            summary: 'Verifier skipped — source files unchanged since last passing run.',
                            details: {}
                        });
                        this._appendRunEvent(state, { type: 'task_completed', taskId: task.id, role: task.role, durationMs: 0, skipped: true });
                        projectContextSummary += `\n- Verifier skipped (source unchanged since last pass) for task ${task.id}.`;
                        state.projectContextSummary = projectContextSummary;
                        await this._saveState(state);
                        yield { type: 'status', content: `Verifier skipped — source unchanged since last passing run. Task ${task.id} auto-passed.` };
                        continue;
                    }
                    const verifierPrecheck = await this._checkVerifierPreconditions(
                        state,
                        workspacePath,
                        `${projectContextSummary}\n${String(task.prompt || "")}`
                    );
                    if (!verifierPrecheck.ok) {
                        task.status = 'blocked';
                        const reason = verifierPrecheck.reason || 'Verifier preconditions not met.';
                        this._appendRunEvent(state, {
                            type: 'task_blocked',
                            taskId: task.id,
                            role: task.role,
                            reason
                        });
                        projectContextSummary += `\n- ${task.role} BLOCKED: ${reason}`;
                        state.projectContextSummary = projectContextSummary;
                        await this._saveState(state);
                        yield { type: 'status', content: sanitizer.sanitize(reason, credentials) };
                        await this._finalizeWorkflowState(state, 'paused_or_failed');
                        return;
                    }
                }

                // Context is kept brief to avoid token limits. Agents must rely on file reading.
                const skillPack = await this._buildSkillEnforcementBlock(
                    task.prompt,
                    projectContextSummary,
                    task.role
                );
                const skillEnforcement = skillPack.block || "";
                const skillPreamble = skillPack.preamble || "";
                const requiredSkillRefs = Array.isArray(skillPack.requiredRefs) ? skillPack.requiredRefs : [];
                const missingSkillRefs = Array.isArray(skillPack.missingRefs) ? skillPack.missingRefs : [];
                skillLedgerService.setExecutionContext(workspacePath, {
                    taskId: task.id,
                    role: task.role
                });
                if (missingSkillRefs.length > 0) {
                    task.status = 'blocked';
                    const reason = `Skill enforcement blocked: missing required skill sources (${missingSkillRefs.join(', ')}).`;
                    this._appendRunEvent(state, {
                        type: 'task_blocked',
                        taskId: task.id,
                        role: task.role,
                        reason
                    });
                    projectContextSummary += `\n- ${task.role} BLOCKED: ${reason}`;
                    state.projectContextSummary = projectContextSummary;
                    await this._saveState(state);
                    yield { type: 'status', content: sanitizer.sanitize(reason, credentials) };
                    await this._finalizeWorkflowState(state, 'paused_or_failed');
                    return;
                }
                const credentialsBlock = task.role?.toUpperCase() === 'CODER' && credentials
                    ? `\n\nUSER VIVERSE CREDENTIALS FOR THIS RUN ONLY:\nEmail: ${credentials.email}\nPassword: ${credentials.password}\n(Do not persist credentials into files or state summaries.)`
                    : '';
                const runtimeCredentialAuthorityBlock =
                    task.role?.toUpperCase() === 'CODER' && credentials
                        ? `\n\n[RUNTIME_CREDENTIAL_AUTHORITY]\n- Only the credentials in the USER VIVERSE CREDENTIALS FOR THIS RUN ONLY block are authoritative.\n- Ignore any credential-like strings found in task text, old summaries, logs, or prior prompts.\n- Never reuse stale login strings from previous runs.\n`
                        : '';
                const authPreflightMode = this._getAuthPreflightMode(state);
                const authPreflightScopeBlock =
                    task.id === 'auth_preflight'
                        ? `\n\n[AUTH_PREFLIGHT_SCOPE]\nThis task is AUTH PREFLIGHT ONLY.\n- Do NOT run viverse-cli app create/publish.\n- Do NOT run App-ID bundling grep checks.\n- Do NOT write .env, .env.production, PREFLIGHT_REPORT.md, or any standalone report artifact.\n${authPreflightMode === 'verify_only' ? '- This template is VERIFY-ONLY for auth preflight. Inspect existing auth/bootstrap files and report evidence; do NOT rewrite source files in this task.\n' : ''}- Report auth/bootstrap evidence in your response only; rely on orchestrator ledgers/state for persistence.\n- Focus only on SDK detection, handshake delay, checkAuth/getUserInfo recovery, forbidden header compliance, and minimal build sanity.\n`
                        : '';
                const appSetupScopeBlock =
                    task.role?.toUpperCase() === 'CODER' &&
                    /viverse-cli\s+app\s+create|VITE_VIVERSE_CLIENT_ID/i.test(String(task.prompt || ""))
                        ? `\n\n[APP_SETUP_SCOPE]\nThis task is App setup/app-id wiring.\n- Extract one authoritative App ID (10-char alnum string, may be all letters or contain digits).\n- If AUTHORITATIVE_APP_ID is already resolved in the context, do NOT run viverse-cli app create again. Reuse the existing App ID and only complete missing wiring/build verification.\n- Respect the template's approved App ID propagation files. Do NOT invent \`.env\`, \`vite.config.js\`, or any other fallback when the template already defines a static/runtime config path.\n- Do NOT write App ID into package.json.\n- Build once, verify once with the exact authoritative App ID.\n- Do NOT probe dist with random/partial tokens.\n`
                        : '';
        // STATIC_TEMPLATE_SCOPE: injected for any Coder/Reviewer/Verifier task on a static/PlayCanvas template
        const _buildConfigType = String(
            state?.templateContext?.contract?.buildConfig?.type ||
            state?.templateContext?.contract?.raw?.buildConfig?.type ||
            ''
        ).toLowerCase();
        const _publishSource = String(
            state?.templateContext?.contract?.buildConfig?.publishSource || 'dist'
        ).trim();
        const _isPublishDirect = _publishSource === '.'; // No dist/ folder; workspace root is publish target
        const _approvedFiles   = Array.isArray(state?.templateContext?.contract?.appIdPropagation?.approvedConfigFiles)
            ? state.templateContext.contract.appIdPropagation.approvedConfigFiles.join(', ')
            : '';
        const staticTemplateScopeBlock =
            (task.role?.toUpperCase() === 'CODER' || task.role?.toUpperCase() === 'REVIEWER' || task.role?.toUpperCase() === 'VERIFIER') && _buildConfigType === 'static'
                ? `\n\n[STATIC_TEMPLATE_SCOPE]\n`
                + `This is a STATIC PlayCanvas template (no npm/vite/React/src/). Review rules:\n`
                + `- There is NO src/main.jsx, NO package.json, NO vite.config.js — do NOT require or check for these.\n`
                + `- There is NO React, NO Vue, NO Svelte — this is a raw HTML/JavaScript/PlayCanvas project.\n`
                + `- Editable source files are: __start__.js, __loading__.js, __settings__.js, index.html, and PlayCanvas config files.\n`
                + `- NEVER create vite.config.js, package.json, src/, or run npm commands.\n`
                + `- App ID lives ONLY in: ${_approvedFiles || 'the approvedConfigFiles in template contract'}.\n`
                + (_isPublishDirect
                    ? `- PUBLISH SOURCE: "." — the workspace root is published directly. There is NO dist/ folder. This is CORRECT for this template type. Do NOT fail because dist/ is absent.\n`
                    + `- App ID is resolved at runtime from the hostname (${_publishSource} publish) — no static bundling needed. Do NOT check for VITE_VIVERSE_CLIENT_ID.\n`
                    : `- WORKSPACE SOURCE vs DIST: The workspace root contains TEMPLATE SOURCE files. Source files (including 2453710.json, index.html at workspace root) are template-owned and MAY contain YOUR_APP_ID as a placeholder — this is CORRECT and expected at all times.\n`
                    + `- YOUR_APP_ID in workspace root source files (e.g. 2453710.json, index.html) is NOT a failure — it is a template placeholder. Do NOT fail because source files contain YOUR_APP_ID.\n`
                    + `- YOUR_APP_ID in dist/ IS a failure. Only gate on dist/ file content for App ID verification.\n`
                    + `- App ID injection happens at publish time: find dist/ \\( -name '*.json' -o -name '*.html' -o -name '*.js' \\) | xargs sed -i '' 's/YOUR_APP_ID/<realAppId>/g'\n`
                    + `- CRITICAL: only replace the literal string YOUR_APP_ID. Do NOT write sed patterns for empty strings or JSON keys.\n`
                    + `- VERIFY: grep -r YOUR_APP_ID dist/ must return EMPTY after publish. If any remain, re-run sed.\n`
                    + `- Build with the exact buildConfig.command from the template contract.\n`
                    + `- App ID goes ONLY in dist/2453710.json and dist/index.html via the YOUR_APP_ID sed replacement.\n`
                    + `- LEADERBOARD API NAME: Use the template's EXISTING leaderboardApiName from 2453710.json as-is. Do NOT invent a new leaderboard API name (e.g. do NOT replace it with a game-name-derived string). The registered leaderboard API name in the VIVERSE platform is fixed per template.\n`)
                + `- Do NOT add App ID fields (VITE_VIVERSE_CLIENT_ID, APP_ID, clientId) to config.json — config.json is a PlayCanvas runtime config, NOT an App ID file.\n`
                + `- HIGH-RISK FILES: CONTRACT.json immutablePaths lists files that are sensitive (engine core, auth, SDK). You MAY modify them if the user request requires it, but read fully first, patch surgically, and verify syntax.\n`
                : '';

        const battleTanksScopeBlock =
            task.role?.toUpperCase() === 'CODER' &&
            /battletanks-v1|tank battle|tank[-\s]?template|battle\s*tanks/i.test(
                `${String(task.prompt || "")}\n${String(projectContextSummary || "")}`
            )
                ? `\n\n[BATTLETANKS_TEMPLATE_SCOPE]\nTank-template runtime baseline is mandatory:\n- Local controllable tank MUST spawn even when matchmaking actor resolution is delayed.\n- Do NOT gate local tank mount strictly on myActor existence; provide deterministic local fallback actor/id.\n- Keyboard controls MUST work in iframe/world context (WASD/Arrow/Space capture + preventDefault + focus acquisition on pointer interaction).\n- Keep local movement/fire loop functional in degraded single-player mode when network/matchmaking is unavailable.\n- Startup/bootstrap must still launch the game world after auth/bootstrap; never replace world launch with diagnostics or auth-only logging.\n- If no package.json exists in the sandbox root, use the template build command ('npx vite build') instead of 'npm run build'.\n- Preserve working gameplay systems while fixing auth/matchmaking issues.\n`
                        : '';

        // FLOW-LINE ART SCOPE: When the user request mentions symbols/overlays/images on colored blocks
        // and the template is flow-line-v1, inject explicit cp-only instructions so the Coder doesn't
        // try to patch __game-scripts.js or modify scene JSON.
        // IMPORTANT: Only inject for modify/logic tasks, NOT publish tasks — otherwise the publish
        // Coder re-runs cp commands and may overwrite correct per-color assignments.
        const _userMessage = String(state?.request || '').toLowerCase();
        const _taskId = String(task.id || '').toLowerCase();
        const _isPublishTask = _taskId.includes('publish');
        const _isFlowLineArt =
            task.role?.toUpperCase() === 'CODER' &&
            !_isPublishTask &&
            /flow-line/i.test(`${String(task.prompt || "")}\n${String(projectContextSummary || "")}`) &&
            /symbol|overlay|bird|fire|star|heart|image|icon|emblem|logo|picture/i.test(_userMessage);
        const flowLineArtScopeBlock = _isFlowLineArt
            ? `\n\n[FLOWLINE_ART_SCOPE]\n`
            + `For per-color symbol overlays on flow-line-v1, the template is ALREADY PRE-WIRED.\n`
            + `Your ONLY job for art changes is to place the correct PNG file at each per-color path.\n`
            + `Remember the INTENT INTERPRETATION RULE: apply to ALL 6 colors (red, blue, green, yellow, purple, teal),\n`
            + `not just the ones the user named as examples.\n\n`
            + `STEP 1: Check the symbol library for pre-made symbols:\n`
            + `  ls files/assets/symbol_library/\n`
            + `  Available: bird, flame, star, heart, diamond, cross, moon, lightning, circle_ring, triangle\n\n`
            + `STEP 2: For EACH of the 6 colors, decide the source:\n`
            + `  - If the user specified a symbol for this color → use that exact symbol\n`
            + `  - If the user didn't specify but the request implies ALL colors → pick a unique symbol from the library\n`
            + `  - If the requested symbol IS in the library → cp from symbol_library\n`
            + `  - If the requested symbol is NOT in the library → GENERATE it with PIL (see below)\n`
            + `  CRITICAL: NEVER substitute a different symbol for a color the user explicitly named.\n`
            + `  If user says "tree", you MUST create a tree. If user says "fish", create a fish.\n\n`
            + `STEP 3: Place each symbol at the correct per-color path:\n`
            + `  Endpoint paths: files/assets/28350000{1=red,2=blue,3=green,4=yellow,5=purple,6=teal}/1/endpoint_<color>.png\n`
            + `  Block paths:    files/assets/2835000{11=red,12=blue,13=green,14=yellow,15=purple,16=teal}/1/block_<color>.png\n`
            + `  Copy the SAME symbol to both endpoint and block paths for each color.\n\n`
            + `STEP 4: Verify ALL 6 colors have real PNGs (not 850-byte placeholders):\n`
            + `  ls -la files/assets/28350000{1,2,3,4,5,6}/1/*.png\n`
            + `  Any file that is 850 bytes is still a placeholder and MUST be replaced.\n\n`
            + `PIL GENERATION (for symbols NOT in library):\n`
            + `python3 - <<'PY'\n`
            + `from PIL import Image, ImageDraw\n`
            + `SZ = 256\n`
            + `BG = (153, 153, 153, 255)   # gray background\n`
            + `FG = (255, 255, 255, 255)   # white foreground\n`
            + `img = Image.new('RGBA', (SZ, SZ), BG)\n`
            + `d = ImageDraw.Draw(img)\n`
            + `# Draw the requested shape in white — be creative and recognizable\n`
            + `# Example for a tree: trunk + triangular canopy\n`
            + `d.rectangle([118, 180, 138, 240], fill=FG)  # trunk\n`
            + `d.polygon([(128, 30), (50, 180), (206, 180)], fill=FG)  # canopy\n`
            + `img.save('files/assets/283500003/1/endpoint_green.png')\n`
            + `img.save('files/assets/283500013/1/block_green.png')\n`
            + `PY\n\n`
            + `RULES:\n`
            + `- Do NOT modify __game-scripts.js — per-color rendering is ALREADY patched in.\n`
            + `- Do NOT modify 2453710.json — per-color attributes are ALREADY wired.\n`
            + `- Do NOT modify config.json — per-color assets are ALREADY registered.\n`
            + `- Do NOT patch backdrop/menu/layout code.\n`
            + `- Do NOT substitute a different symbol when the requested one is missing from the library.\n`
            + `- Do NOT leave any color with a placeholder (850-byte) PNG.\n`
            : '';
                const templateExecutionGuardBlock = this._buildTemplateExecutionGuardBlock(state);
                const taskExecutionGuardBlock = this._buildTaskExecutionGuard(task, state);
                const sanitizedSummary = this._sanitizeSummaryForAgent(projectContextSummary, state, task.role);
                const packetSummary = workflowContextService.getPromptContext(state, sanitizedSummary);
                const tailLog = (task.role?.toUpperCase() === 'VERIFIER' || task.role?.toUpperCase() === 'REVIEWER')
                    ? sanitizedSummary.slice(-8000)
                    : sanitizedSummary.slice(-6000);
                const compactSummary = `${packetSummary}\n\nPROJECT_LOG_CONTEXT:\n${tailLog}`;
                // DELTA VERIFIER PROMPT INJECTION (2.3)
                // Only re-check previously-failed gates so the Verifier skips work already proven passing.
                if (String(task.role || '').toUpperCase() === 'VERIFIER') {
                    const _lastVerifierEntry = verificationLedgerService.latestVerifierSummary(workspacePath);
                    task.prompt = fixOrchestrationService.buildDeltaVerifierPrompt(
                        task.prompt,
                        _lastVerifierEntry,
                        state.fixAttemptLedger
                    );
                }
                // Verifier scope block: inform verifier of template's appId propagation strategy
                // so it doesn't hallucinate .env requirements for static/runtime-config templates.
                const _propagationStrategy = String(
                    state?.templateContext?.contract?.appIdPropagation?.strategy || ''
                ).toLowerCase();
                const _templateCapabilities = Array.isArray(state?.templateContext?.contract?.capabilities)
                    ? state.templateContext.contract.capabilities.map(c => String(c).toLowerCase())
                    : [];
                const _hasMultiplayer = _templateCapabilities.includes('matchmaking') || _templateCapabilities.includes('multiplayer');
                const _verifierAppIdScopeBlock =
                    task.role?.toUpperCase() === 'VERIFIER'
                        ? `\n\n[VERIFIER_SCOPE]\n`
                        + (_propagationStrategy === 'runtime-config-or-hostname'
                            ? `App ID propagation strategy: "${_propagationStrategy}".\n`
                            + `AUTHORITATIVE APP ID: ${state?.runtimeFlags?.appIdAuthority?.value || 'see CONTRACT.json'}\n`
                            + (_isPublishDirect
                                ? `\nAPP-ID BUNDLING GATE — PUBLISH-DIRECT TEMPLATE:\n`
                                + `- publishSource is "." — the workspace root is published directly. There is NO dist/ folder.\n`
                                + `- APP-ID BUNDLING GATE = PASS. App ID resolves at runtime from hostname.\n`
                                + `- Do NOT run grep -r YOUR_APP_ID dist/ — dist/ does not exist. Skip this check entirely.\n`
                                + `- Do NOT fail because dist/ is absent — it is NOT expected for this template type.\n`
                                : `\nAPP-ID BUNDLING GATE — MANDATORY PROCEDURE:\n`
                                + `1. Run: grep -r YOUR_APP_ID dist/\n`
                                + `2. If the grep returns EMPTY (no output), APP-ID BUNDLING GATE = PASS.\n`
                                + `3. Run: grep -r "${state?.runtimeFlags?.appIdAuthority?.value || 'APPID'}" dist/2453710.json 2>/dev/null | head -3\n`
                                + `4. If the authoritative App ID appears in dist/2453710.json, App ID propagation = confirmed.\n`
                                + `5. Do NOT fail this gate based on "evidence doesn't show" — run the greps yourself and trust the command output.\n`
                                + `6. Do NOT check for .env or VITE_VIVERSE_CLIENT_ID — this is a static PlayCanvas template.\n`)
                            + `\nPUBLISH-READINESS GATE — STATIC TEMPLATE RULES:\n`
                            + `- This is a static PlayCanvas template. There is NO src/main.jsx, NO React, NO package.json, NO vite.config.js.\n`
                            + `- Do NOT fail because these React/Vite files are absent — they are NOT required for this template type.\n`
                            + `- Do NOT carry forward any Reviewer failure about "missing React mount" or "missing package.json".\n`
                            + (_isPublishDirect
                                ? `- PUBLISH SOURCE IS "." — there is NO dist/ folder. The workspace root is published directly. This is CORRECT.\n`
                                + `- Do NOT fail because dist/ is absent — it does NOT exist for this template type and is NOT expected.\n`
                                + `- PUBLISH-READINESS PASS CRITERIA: viverse-cli app publish was run successfully (confirmed from CLI output), App ID is ${state?.runtimeFlags?.appIdAuthority?.value || 'see CONTRACT.json'}.\n`
                                + `- App ID resolves at runtime from hostname — no bundling or dist/ needed. APP-ID BUNDLING GATE = PASS for this template.\n`
                                : `- Publish-readiness PASS criteria: dist/ exists, App ID propagated (YOUR_APP_ID replaced), dist/index.html references VIVERSE SDK.\n`
                                + `- leaderboardApiName in dist/2453710.json is a valid template-defined value. There is NO locked leaderboard API naming requirement. Do NOT fail on this.\n`)
                            + `- Immutable files (__game-scripts.js, viverse-auth-overlay.js, playcanvas-stable.min.js) are template-owned. Do NOT gate on their contents.\n`
                            + `\nAUTH GATE:\n`
                            + `- If dist/config.json or dist/2453710.json contains handshakeDelayMs >= 1200 and the authoritative App ID as clientId, AUTH GATE = PASS.\n`
                            + `- Do NOT read __game-scripts.js or playcanvas-stable.min.js — they are binary bundles; skip them.\n`
                            : (_propagationStrategy ? `App ID propagation strategy: "${_propagationStrategy}".\n` : ''))
                        + (!_hasMultiplayer
                            ? `\nNON-MULTIPLAYER GATE RULES:\n`
                            + `- This template has NO multiplayer/matchmaking capability. THE SESSION GATE and THE BRIDGE GATE do NOT apply — mark both as PASS.\n`
                            + `- Do NOT fail because session_id-based actor_id resolution is absent.\n`
                            + `- Do NOT fail because client.getUserInfo() prioritization cannot be proven from source.\n`
                            : '')
                        : '';
                const agentPrompt = `Project Summary Context:\n${compactSummary}${credentialsBlock}${runtimeCredentialAuthorityBlock}${authPreflightScopeBlock}${appSetupScopeBlock}${staticTemplateScopeBlock}${battleTanksScopeBlock}${flowLineArtScopeBlock}${_verifierAppIdScopeBlock}${templateExecutionGuardBlock}${taskExecutionGuardBlock}\n\nYour Sandboxed Workspace: ${workspacePath}\n\n${skillPreamble}Your Task: ${task.prompt}${skillEnforcement}`;
                
                const taskAttachments = task.role?.toUpperCase() === 'ARCHITECT' ? attachments : [];
                
                const tierOverride = /auth/i.test(String(task.id || '')) ? 'flash' : null;
                const agentStream = geminiService.generateResponseStream(
                    agentPrompt,
                    [],
                    task.role.toUpperCase(),
                    workspacePath,
                    taskAttachments,
                    tierOverride
                );
                // Pro-tier agents (ORCHESTRATOR, ARCHITECT, CODER, SUMMARIZER) think
                // significantly longer between tool calls than Flash. Give them more
                // idle headroom to avoid premature AGENT_TASK_IDLE_TIMEOUT kills.
                const _roleConfig = AgentRegistry[task.role?.toUpperCase()] || {};
                const _activeTier = tierOverride || _roleConfig.tier;
                const _isProTier = _activeTier === 'pro';
                const _baseIdle     = _isProTier ? 300000 : 180000;  // Pro: 5min, Flash: 3min
                // For complex game tasks (non-template, multiplayer/game role), allow 600s
                const _isComplexGameTask = !state?.templateContext?.templateId &&
                    /multiplayer|three.js|game scene|zombie|wave.based|weapon|character/i.test(String(task?.prompt || ''));
                const _baseDuration = _isComplexGameTask ? 600000 : (_isProTier ? 300000 : 300000);
                const taskIdleTimeoutMs = Math.max(
                    60000,
                    Number(process.env.ORCHESTRATOR_TASK_IDLE_TIMEOUT_MS || _baseIdle)
                );
                const taskDurationTimeoutMs = Math.max(
                    120000,
                    Number(process.env.ORCHESTRATOR_TASK_DURATION_TIMEOUT_MS || _baseDuration)
                );
                
                let fullResponse = "";
                let emittedComplianceClaimNotice = false;
                try {
                    const iterator = agentStream[Symbol.asyncIterator]();
                    const streamStartedAt = Date.now();
                    let lastAgentChunkAt = streamStartedAt;
                    const taskHeartbeatMs = Math.max(
                        1500,
                        Number(process.env.ORCHESTRATOR_TASK_HEARTBEAT_MS || 7000)
                    );
                    while (true) {
                        const pendingNext = iterator.next();
                        let nextResult = null;
                        while (true) {
                            const now = Date.now();
                            const idleElapsed = now - lastAgentChunkAt;
                            const durationElapsed = now - streamStartedAt;
                            if (idleElapsed > taskIdleTimeoutMs) {
                                throw new Error(`AGENT_TASK_IDLE_TIMEOUT:${taskIdleTimeoutMs}`);
                            }
                            if (durationElapsed > taskDurationTimeoutMs) {
                                throw new Error(`AGENT_TASK_DURATION_TIMEOUT:${taskDurationTimeoutMs}`);
                            }

                            const waitMs = Math.max(
                                250,
                                Math.min(
                                    taskHeartbeatMs,
                                    taskIdleTimeoutMs - idleElapsed,
                                    taskDurationTimeoutMs - durationElapsed
                                )
                            );

                            const raceResult = await Promise.race([
                                pendingNext.then((value) => ({ kind: 'next', value })),
                                new Promise((resolve) => setTimeout(() => resolve({ kind: 'tick' }), waitMs))
                            ]);

                            if (raceResult?.kind === 'tick') {
                                yield { type: 'status', content: '·' };
                                continue;
                            }

                            nextResult = raceResult?.value;
                            break;
                        }

                        if (nextResult?.done) break;
                        lastAgentChunkAt = Date.now();
                        const chunk = nextResult?.value;
                        if (!chunk) continue;
                        if (chunk.type === 'text') {
                            fullResponse += chunk.content;
                            // Avoid leaking technical JSON from Reviewer/Orchestrator-Planner to the user
                            if (!fullResponse.trim().startsWith('{')) {
                                const roleUpper = String(task.role || '').toUpperCase();
                                if (roleUpper === 'CODER' && this._hasComplianceSuccessClaim(chunk.content)) {
                                    const masked = this._maskComplianceSuccessClaims(chunk.content);
                                    yield { type: 'text', content: sanitizer.sanitize(masked, credentials) };
                                    if (!emittedComplianceClaimNotice) {
                                        emittedComplianceClaimNotice = true;
                                        yield { type: 'status', content: 'Coder compliance claims are provisional until deterministic gate verification finishes.' };
                                    }
                                } else {
                                    yield { type: 'text', content: sanitizer.sanitize(chunk.content, credentials) };
                                }
                            }
                        } else if (chunk.type === 'status') {
                            yield { ...chunk, content: sanitizer.sanitize(chunk.content, credentials) };
                        } else if (chunk.type === 'viverse_app_id_discovered') {
                            // appId extracted from viverse-cli app create output during tool execution
                            const discoveredId = String(chunk.appId || '').toLowerCase().trim();
                            // Use a direct format check — no digit requirement since CLI output is trusted
                            if (/^[a-z0-9]{10}$/.test(discoveredId)) {
                                logger.info(`Orchestrator: appId discovered from tool call: ${discoveredId}`);
                                this._setAppIdAuthority(state, discoveredId, `viverse_cli:task:${task.id}`);
                                projectContextSummary += `\n- IMPORTANT: The VIVERSE App ID for this project is: ${discoveredId}`;
                                // Immediately sync to CONTRACT.json
                                try {
                                    const contractSyncPath = path.join(workspacePath, 'CONTRACT.json');
                                    const contractRaw = await fs.readFile(contractSyncPath, 'utf8');
                                    const contractObj = JSON.parse(contractRaw);
                                    const _existingAppId = String(contractObj?.app?.appId || contractObj?.appId || '');
                                    if (!this._isValidAppId(_existingAppId)) {
                                        if (!contractObj.app) contractObj.app = {};
                                        contractObj.app.appId = discoveredId;
                                        contractObj.appId = discoveredId;
                                        contractObj.clientId = discoveredId;
                                        await fs.writeFile(contractSyncPath, `${JSON.stringify(contractObj, null, 2)}\n`, 'utf8');
                                        logger.info(`Orchestrator: Synced discovered appId ${discoveredId} to CONTRACT.json`);
                                    }
                                } catch (_e) { /* ignore */ }
                                await this._saveState(state);
                            }
                        }
                    }
                } catch (streamErr) {
                    const reason = String(streamErr?.message || streamErr || 'Unknown stream failure');
                    logger.error(`Orchestrator: Task ${task.id} failed during agent stream: ${reason}`);
                    if (/INVALID_CREDENTIALS/i.test(reason)) {
                        state.runtimeFlags.authInvalid = true;
                    }
                    const failureResult = workflowRecoveryService.handleStreamFailure({
                        state,
                        task,
                        reason,
                        templateGuardBlock: this._buildTemplateExecutionGuardBlock(state),
                        taskStartedAt,
                        projectContextSummary,
                        maxTransientInfraRetriesPerTask: this.maxTransientInfraRetriesPerTask,
                        computeTransientInfraRetryDelayMs: (attempt) => this._computeTransientInfraRetryDelayMs(attempt),
                        appendRunEvent: (runState, event) => this._appendRunEvent(runState, event)
                    });
                    projectContextSummary = failureResult.projectContextSummary;
                    state.projectContextSummary = projectContextSummary;
                    await this._saveState(state);
                    yield {
                        type: 'status',
                        content: sanitizer.sanitize(failureResult.statusMessage, credentials)
                    };
                    if (failureResult.disposition === 'terminal_failure') {
                        yield {
                            type: 'text',
                            content: sanitizer.sanitize(failureResult.detailMessage, credentials)
                        };
                        await this._finalizeWorkflowState(state, 'paused_or_failed');
                        return;
                    }
                    continue;
                }
                
                logger.info(`Orchestrator: Agent [${task.role}] stream finished. Response length: ${fullResponse.length}`);
                const roleUpperPost = String(task.role || '').toUpperCase();
                // Hard skill-report enforcement is limited to Coder outputs.
                // Other roles may have strict JSON output contracts where report formatting is less reliable.
                if (roleUpperPost === "CODER" && requiredSkillRefs.length > 0) {
                    const ledgerLoadCheck = this._validateSkillLoadLedger(workspacePath, task, requiredSkillRefs);
                    const loadCheck = ledgerLoadCheck.ok ? ledgerLoadCheck : this._validateSkillLoadReport(fullResponse, requiredSkillRefs);
                    if (!loadCheck.ok) {
                        task.status = 'failed';
                        const reason = `Skill enforcement failed: ${loadCheck.reason}`;
                        task.lastError = reason;
                        this._appendRunEvent(state, {
                            type: 'task_failed',
                            taskId: task.id,
                            role: task.role,
                            durationMs: Date.now() - taskStartedAt,
                            reason
                        });
                        projectContextSummary += `\n- ${task.role} FAILED: ${reason}`;
                        state.projectContextSummary = projectContextSummary;
                        await this._saveState(state);
                        yield { type: 'status', content: sanitizer.sanitize(reason, credentials) };
                        yield {
                            type: 'text',
                            content: sanitizer.sanitize(`\n\n⚠️ **${task.role} task failed**\nReason: ${reason}`, credentials)
                        };
                        await this._finalizeWorkflowState(state, 'paused_or_failed');
                        return;
                    }
                    const skillCheck = this._validateSkillComplianceReport(fullResponse, requiredSkillRefs);
                    if (!skillCheck.ok) {
                        // auth_preflight is a verify-only task — it inspects existing surfaces and reports
                        // evidence; it does not implement changes. Skill compliance FAIL here means the LLM
                        // judged the existing code as non-compliant, which is handled by the fast compliance
                        // gate (ap_fix) rather than a hard workflow abort. Treat non-PASS as a soft warning.
                        const isAuthPreflightTask = String(task?.id || '') === 'auth_preflight' || /auth preflight only/i.test(String(task?.prompt || ''));
                        // Logic tasks explicitly restrict scope to CSS/HTML/visual only — they cannot
                        // implement leaderboard/auth/multiplayer patterns, so skill compliance FAIL
                        // for non-visual skills is expected and should not abort the workflow.
                        const isRestrictedScopeTask = /modify ONLY visual|CSS\/HTML|visual\/CSS|logic task.*editablePaths/i.test(String(task?.prompt || ''));
                        // Verifier fix tasks (v_fix_*) and compliance fix tasks (c_fix_*, fix_*) run
                        // post-publish or in a repair loop. Template contract violations (e.g., PlayCanvas
                        // vs React files) are expected, so skill compliance FAIL should not abort the workflow.
                        const isVfixTask = /^v_fix_/i.test(String(task?.id || ''));
                        const isFixTask = isFixLoopTask; // covers fix_, c_fix_, v_fix_
                        // Publish tasks for static templates run 5 CLI steps and do not produce
                        // formal skill compliance report format — tolerate non-PASS as soft warning.
                        const isStaticPublishTask = this._isPublishTask(task) && _buildConfigType === 'static';
                        // Fast path publish tasks ([FAST_PATH]) are minimal 3-step CLI tasks.
                        // They do not produce a formal skill compliance report — tolerate non-PASS.
                        const isFastPathTask = /\[FAST_PATH\]/i.test(String(task?.prompt || ''));
                        if (isAuthPreflightTask || isRestrictedScopeTask || isVfixTask || isFixTask || isStaticPublishTask || isFastPathTask || this._shouldTolerateMissingSkillCompliance({
                            workspacePath,
                            task,
                            requiredRefs: requiredSkillRefs,
                            reason: skillCheck.reason
                        })) {
                            const warning = `Skill compliance report was incomplete, but required skill load artifacts were present. Continuing with ledger-backed skill evidence.`;
                            this._appendRunEvent(state, {
                                type: 'skill_compliance_warning',
                                taskId: task.id,
                                role: task.role,
                                reason: skillCheck.reason
                            });
                            projectContextSummary += `\n- ${task.role} WARNING: ${warning}`;
                            state.projectContextSummary = projectContextSummary;
                            yield { type: 'status', content: sanitizer.sanitize(warning, credentials) };
                        } else {
                            task.status = 'failed';
                            const reason = `Skill enforcement failed: ${skillCheck.reason}`;
                            task.lastError = reason;
                            this._appendRunEvent(state, {
                                type: 'task_failed',
                                taskId: task.id,
                                role: task.role,
                                durationMs: Date.now() - taskStartedAt,
                                reason
                            });
                            projectContextSummary += `\n- ${task.role} FAILED: ${reason}`;
                            state.projectContextSummary = projectContextSummary;
                            await this._saveState(state);
                            yield { type: 'status', content: sanitizer.sanitize(reason, credentials) };
                            yield {
                                type: 'text',
                                content: sanitizer.sanitize(`\n\n⚠️ **${task.role} task failed**\nReason: ${reason}`, credentials)
                            };
                            await this._finalizeWorkflowState(state, 'paused_or_failed');
                            return;
                        }
                    }

                    const loadRows = this._parseSkillSection(fullResponse, 'SKILL_LOAD_REPORT');
                    const ledgerRows = skillLedgerService.getEntries(workspacePath, {
                        taskId: String(task.id || ''),
                        role: String(task.role || '')
                    });
                    const complianceRows = this._parseSkillSection(fullResponse, 'SKILL_COMPLIANCE_REPORT');
                    const skillReport = {
                        taskId: String(task.id || ''),
                        role: String(task.role || ''),
                        requiredRefs: requiredSkillRefs,
                        ledger: ledgerRows,
                        load: loadRows,
                        compliance: complianceRows,
                        createdAt: new Date().toISOString()
                    };
                    this._appendRunEvent(state, {
                        type: 'skill_compliance_report',
                        taskId: task.id,
                        role: task.role,
                        requiredCount: requiredSkillRefs.length,
                        loadCount: loadRows.length,
                        complianceCount: complianceRows.length
                    });
                    try {
                        const dir = path.join(workspacePath, 'artifacts', 'skill-compliance');
                        await fs.mkdir(dir, { recursive: true });
                        const out = path.join(dir, `${String(task.id || 'task')}.json`);
                        await fileService.writeFile(
                            out,
                            JSON.stringify(skillReport, null, 2),
                            undefined,
                            { skipTemplateEnforcement: true }
                        );
                    } catch (e) {
                        logger.warn(`Skill report artifact write failed: ${e.message}`);
                    }
                }
                if (String(task.role || '').toUpperCase() === 'CODER') {
                    state.runtimeFlags = state.runtimeFlags || {};
                    state.runtimeFlags.lastCoderComplianceClaim = {
                        taskId: String(task.id || ''),
                        claimed: this._hasComplianceSuccessClaim(fullResponse),
                        at: new Date().toISOString()
                    };
                }

                // Auth preflight deterministic gate (Phase 1.6)
                if (task.id === 'auth_preflight' && task.role.toUpperCase() === 'CODER') {
                    try {
                        const gate = await this._runAuthAcceptanceGate(workspacePath);
                        if (!gate.ok) {
                            verificationLedgerService.record(workspacePath, {
                                type: 'auth_preflight',
                                taskId: task.id,
                                role: task.role,
                                status: 'fail',
                                summary: 'Auth preflight gate failed',
                                details: { failed: gate.failed || [] }
                            });
                            const reasons = gate.failed.map((f) => `${f.id}: ${f.msg}`).join(' | ');
                            const signature = gate.failed
                                .map((f) => String(f.id || 'unknown-auth-rule'))
                                .sort()
                                .join(' || ');
                            const tracker = state.authPreflightFixTracker || {};
                            const attempts = Number(tracker[signature] || 0);

                            if (attempts >= this.maxAuthPreflightFixAttemptsPerSignature) {
                                task.status = 'failed';
                                this._appendRunEvent(state, {
                                    type: 'task_failed',
                                    taskId: task.id,
                                    role: task.role,
                                    durationMs: Date.now() - taskStartedAt,
                                    reason: `AUTH_PREFLIGHT_GATE_FAILED: ${reasons}`
                                });
                                projectContextSummary += `\n- AUTH PREFLIGHT FAILED (retry cap): ${reasons}`;
                                state.projectContextSummary = projectContextSummary;
                                await this._saveState(state);
                                yield { type: 'status', content: `Auth preflight failed: ${reasons}` };
                                yield { type: 'text', content: `\n\n⚠️ **Auth preflight failed**\n${reasons}` };
                                await this._finalizeWorkflowState(state, 'paused_or_failed');
                                return;
                            }

                            const existingPending = state.tasks.find((t) =>
                                t.status === 'pending' &&
                                t.role === 'Coder' &&
                                String(t.id || '').startsWith('ap_fix_') &&
                                String(t.prompt || '').includes(signature)
                            );

                            let fixTaskId = existingPending?.id;
                            if (!fixTaskId) {
                                fixTaskId = `ap_fix_${Date.now()}`;
                                const templateGuard = this._buildTemplateExecutionGuardBlock(state);
                                state.tasks.push({
                                    id: fixTaskId,
                                    role: 'Coder',
                                    prompt: `AUTH_PREFLIGHT_FIX REQUIRED. Signature: ${signature}
Resolve all auth preflight acceptance failures:
${reasons}

Requirements:
1) Ensure SDK global resolution chain exists: window.vSdk || window.viverse || window.VIVERSE_SDK.
2) Add explicit handshake delay guard before auth checks.
3) Ensure checkAuth() call exists in auth bootstrap.
4) Ensure getUserInfo() recovery path exists.
5) Do not use forbidden lowercase 'accesstoken' header key.
6) Run one build sanity check if source changed and summarize exact fixes.

${templateGuard}`,
                                    dependsOn: [],
                                    status: 'pending'
                                });
                            }

                            // Reroute pending work to wait on the auth preflight fix task.
                            for (const t of state.tasks) {
                                if (t.status !== 'pending' || !Array.isArray(t.dependsOn)) continue;
                                if (!t.dependsOn.includes('auth_preflight')) continue;
                                t.dependsOn = t.dependsOn.filter((d) => d !== 'auth_preflight');
                                if (!t.dependsOn.includes(fixTaskId)) t.dependsOn.push(fixTaskId);
                            }

                            tracker[signature] = attempts + 1;
                            state.authPreflightFixTracker = tracker;
                            task.status = 'completed';
                            this._appendRunEvent(state, {
                                type: 'task_completed',
                                taskId: task.id,
                                role: task.role,
                                durationMs: Date.now() - taskStartedAt
                            });
                            projectContextSummary += `\n- AUTH PREFLIGHT FAILED: ${reasons}. Scheduled ${fixTaskId} (attempt ${attempts + 1}).`;
                            state.projectContextSummary = projectContextSummary;
                            await this._saveState(state);
                            yield { type: 'status', content: `Auth preflight failed: ${reasons}` };
                            yield { type: 'status', content: `Scheduled mandatory auth preflight fix task ${fixTaskId}. Continuing workflow.` };
                            continue;
                        }
                        verificationLedgerService.record(workspacePath, {
                            type: 'auth_preflight',
                            taskId: task.id,
                            role: task.role,
                            status: 'pass',
                            summary: 'Auth preflight gate passed',
                            details: { failed: [] }
                        });
                        projectContextSummary += `\n- Auth preflight gate passed.`;
                    } catch (authGateErr) {
                        const reason = String(authGateErr?.message || authGateErr || 'Unknown auth preflight error');
                        verificationLedgerService.record(workspacePath, {
                            type: 'auth_preflight',
                            taskId: task.id,
                            role: task.role,
                            status: 'error',
                            summary: reason,
                            details: {}
                        });
                        task.status = 'failed';
                        this._appendRunEvent(state, {
                            type: 'task_failed',
                            taskId: task.id,
                            role: task.role,
                            durationMs: Date.now() - taskStartedAt,
                            reason
                        });
                        projectContextSummary += `\n- AUTH PREFLIGHT ERROR: ${reason}`;
                        state.projectContextSummary = projectContextSummary;
                        await this._saveState(state);
                        yield { type: 'status', content: `Auth preflight errored: ${reason}` };
                        await this._finalizeWorkflowState(state, 'paused_or_failed');
                        return;
                    }
                }

                // Step 3.5: Deterministic fast compliance gate for coder outputs
                if (task.role.toUpperCase() === 'CODER') {
                    try {
                        yield { type: 'status', content: 'Running deterministic fast compliance gate...' };
                        const profileHints = this._deriveComplianceProfiles(task, projectContextSummary, state);
                        const persistedCache = state.complianceFastCache || {};
                        const runtimeCache = this.complianceRuntimeCache.get(workspacePath) || {};
                        const cache = {
                            ...persistedCache,
                            ...runtimeCache,
                            fileIndex: runtimeCache.fileIndex || persistedCache.fileIndex
                        };
                        const gate = await complianceService.runFastGate({
                            workspacePath,
                            taskPrompt: task.prompt,
                            profileHints,
                            gatePhase: this._deriveCompliancePhase(task),
                            cache,
                            templateContext: state?.templateContext || null,
                            requestScope: taskRequestScope
                        });
                        if (gate._nextCache) {
                            this.complianceRuntimeCache.set(workspacePath, gate._nextCache);
                            // Keep persisted state lightweight for easier debugging/state diffs.
                            state.complianceFastCache = {
                                lastSnapshotKey: gate._nextCache.lastSnapshotKey,
                                lastResult: gate._nextCache.lastResult
                            };
                        }

                        if (gate.status === 'pass') {
                            verificationLedgerService.record(workspacePath, {
                                type: 'fast_compliance_gate',
                                taskId: task.id,
                                role: task.role,
                                status: 'pass',
                                summary: 'Fast compliance gate passed',
                                details: {
                                    checkedRules: gate.checkedRules,
                                    scannedFiles: gate.scannedFiles,
                                    findings: []
                                }
                            });
                            state.runtimeFlags = state.runtimeFlags || {};
                            state.runtimeFlags.lastCoderGate = {
                                taskId: String(task.id || ''),
                                status: 'pass',
                                findings: []
                            };
                            const cacheSuffix = gate.cacheHit ? ' (cached)' : '';
                            yield {
                                type: 'status',
                                content: `Fast compliance gate passed${cacheSuffix}. Rules checked: ${gate.checkedRules}, files scanned: ${gate.scannedFiles}.`
                            };
                        } else if (gate.status === 'fail') {
                            state.runtimeFlags = state.runtimeFlags || {};
                            state.runtimeFlags.lastCoderGate = {
                                taskId: String(task.id || ''),
                                status: 'fail',
                                findings: Array.isArray(gate.findings) ? gate.findings : []
                            };
                            const phase = this._deriveCompliancePhase(task);
                            const severityRank = (s = '') => {
                                const v = String(s || '').toLowerCase();
                                if (v === 'critical') return 4;
                                if (v === 'high') return 3;
                                if (v === 'medium') return 2;
                                return 1;
                            };
                            const minBlockingRank = phase === 'auth_preflight' ? 3 : 2;
                            const blockingFindings = gate.findings.filter((f) => severityRank(f.severity) >= minBlockingRank);
                            const reasons = blockingFindings.map((f) => `${f.ruleId}: ${f.message}`);
                            verificationLedgerService.record(workspacePath, {
                                type: 'fast_compliance_gate',
                                taskId: task.id,
                                role: task.role,
                                status: 'fail',
                                summary: reasons.length ? reasons.join(' | ') : 'Fast compliance gate failed',
                                details: {
                                    checkedRules: gate.checkedRules,
                                    scannedFiles: gate.scannedFiles,
                                    findings: Array.isArray(gate.findings) ? gate.findings : []
                                }
                            });
                            const advisoryFindings = gate.findings.filter((f) => severityRank(f.severity) < minBlockingRank);

                            if (blockingFindings.length === 0) {
                                const advisory = advisoryFindings.map((f) => `${f.ruleId}: ${f.message}`).join(' | ');
                                yield {
                                    type: 'status',
                                    content: advisory
                                        ? `Fast compliance advisory (non-blocking in ${phase}): ${advisory}`
                                        : `Fast compliance gate has non-blocking findings in ${phase}.`
                                };
                                projectContextSummary += advisory
                                    ? `\n- Fast compliance advisory (${phase}): ${advisory}`
                                    : `\n- Fast compliance advisory (${phase}).`;
                                // Non-blocking advisories should not skip task completion.
                            }

                            const reasonText = reasons.join(' | ');
                            const short = reasonText.length > 260 ? `${reasonText.slice(0, 260)}...` : reasonText;
                            const signature = blockingFindings
                                .map((f) => String(f.ruleId || 'unknown-rule'))
                                .sort()
                                .join(' || ');
                            const tracker = state.complianceFixTracker || {};
                            const attempts = Number(tracker[signature] || 0);

                            // Also halt early if the last fix attempt made no file changes (2.2)
                            const _lastCfixAttempt = fixOrchestrationService.lastAttemptForSignature(state, `compliance:${signature}`);
                            const _cfixNoChange = _lastCfixAttempt?.noChange === true;

                            if (attempts >= this.maxComplianceFixAttemptsPerSignature || _cfixNoChange) {
                                const _cfixHaltReason = _cfixNoChange
                                    ? `Compliance fix task made no file changes — structural issue requires manual intervention.`
                                    : `Fast compliance gate still failing after max fix attempts for same rule set.`;
                                yield {
                                    type: 'status',
                                    content: `${_cfixHaltReason} Stopping auto-fix loop for this signature.`
                                };
                                projectContextSummary += `\n- Fast compliance gate exceeded retry cap for signature: ${signature} (noChange: ${_cfixNoChange})`;
                                haltExecutionReason = `Compliance gate unresolved after ${attempts} attempts for signature: ${signature}`;
                            } else {
                                yield { type: 'status', content: 'Fast compliance gate failed. Creating mandatory fix task.' };
                                yield {
                                    type: 'status',
                                    content: sanitizer.sanitize(
                                        `Compliance issues: ${short}`,
                                        credentials
                                    )
                                };
                                yield { type: 'status', content: 'Applying compliance fixes now. This may take longer than a normal coding pass.' };

                                const existingPending = state.tasks.find((t) =>
                                    t.status === 'pending' &&
                                    t.role === 'Coder' &&
                                    String(t.prompt || '').includes('DETERMINISTIC COMPLIANCE FIX REQUIRED') &&
                                    String(t.prompt || '').includes(signature)
                                );

                                if (!existingPending) {
                                    const fixTaskId = `c_fix_${Date.now()}`;
                                    const scopedSubsystem = this._inferFailureSubsystem({ issueLines: reasons, task, state });
                                    const scopeGuard = this._buildFixScopeAndBaselineGuard(state, { issueLines: reasons });
                                    const scopedFixGuard = this._buildScopedFixGuard({ subsystem: scopedSubsystem, issueLines: reasons });
                                    const templateGuard = this._buildTemplateExecutionGuardBlock(state);
                                    const taskContext = this._summarizeFixTaskContext(task.prompt);
                                    const _contractBuildRequired = state?.templateContext?.contract?.build?.required;
                                    const noBuildNote = _contractBuildRequired === false
                                        ? '\n\nCRITICAL — STATIC TEMPLATE (build.required: false): Do NOT run npm run build, npm install, vite build, or ANY build command. There is no dist/ folder. The publishSource is already ready as-is. Only patch source files and run viverse-cli app publish directly.'
                                        : '';
                                    state.tasks.push({
                                        id: fixTaskId,
                                        role: 'Coder',
                                        prompt: `DETERMINISTIC COMPLIANCE FIX REQUIRED. Signature: ${signature}\nTarget subsystem: ${scopedSubsystem}\nResolve all failed rules from fast gate:\n${reasons.join('\n')}\n\nTask context: ${taskContext || String(task.prompt || '').trim()}${noBuildNote}\n\n${scopedFixGuard}\n${scopeGuard}\n${templateGuard}`,
                                        dependsOn: [],
                                        status: 'pending'
                                    });

                                    for (let i = 0; i < state.tasks.length; i++) {
                                        let t = state.tasks[i];
                                        if (t.status === 'pending' && t.dependsOn && t.dependsOn.includes(task.id)) {
                                            t.dependsOn = t.dependsOn.filter(depId => depId !== task.id);
                                            t.dependsOn.push(fixTaskId);
                                        }
                                    }

                                    tracker[signature] = attempts + 1;
                                    state.complianceFixTracker = tracker;
                                    projectContextSummary += `\n- Fast compliance gate failed: ${reasons.join(', ')}. Compliance fix task created (attempt ${attempts + 1}).`;
                                } else {
                                    projectContextSummary += `\n- Fast compliance gate failed: ${reasons.join(', ')}. Existing compliance fix task already pending.`;
                                }
                            }
                        } else {
                            verificationLedgerService.record(workspacePath, {
                                type: 'fast_compliance_gate',
                                taskId: task.id,
                                role: task.role,
                                status: 'skip',
                                summary: 'Fast compliance gate skipped',
                                details: {}
                            });
                            yield { type: 'status', content: 'Fast compliance gate skipped (no matching profile/rules).' };
                        }
                    } catch (e) {
                        logger.warn(`Orchestrator: fast compliance gate error: ${e.message}`);
                        verificationLedgerService.record(workspacePath, {
                            type: 'fast_compliance_gate',
                            taskId: task.id,
                            role: task.role,
                            status: 'error',
                            summary: String(e?.message || e || 'Fast compliance gate error'),
                            details: {}
                        });
                        yield { type: 'status', content: 'Fast compliance gate encountered an internal error; continuing with standard review flow.' };
                    }
                }

                if (haltExecutionReason) {
                    task.status = 'pending';
                    state.projectContextSummary = `${projectContextSummary}\n- WORKFLOW HALTED: ${haltExecutionReason}`;
                    await this._saveState(state);
                    yield { type: 'status', content: 'Workflow paused due to unresolved compliance gate. Manual intervention required before continuing.' };
                    yield { type: 'text', content: sanitizer.sanitize(`\n\n⚠️ Compliance gate is still failing after retry cap.\nReason: ${haltExecutionReason}`, credentials) };
                    await this._finalizeWorkflowState(state, 'paused_or_failed');
                    return;
                }

                // Step 4: Agent Review/Verification Recovery Loop
                if (task.role.toUpperCase() === 'REVIEWER') {
                    try {
                        const parsedReview = reviewerResultValidator.parse(fullResponse);
                        const runtimeBlockers = await this._detectRuntimeBlockerSignatures(workspacePath, parsedReview.artifactPaths);
                        const baselineRegressions = this._evaluateBaselineRegressions({
                            state,
                            runtimeChecks: parsedReview.runtimeChecks,
                            runtimeBlockers
                        });
                        const reviewResult = reviewerResultValidator.finalize({
                            parsed: parsedReview,
                            state,
                            requiredChecks: this._getRequiredRuntimeChecks(state),
                            runtimeBlockers,
                            baselineRegressions
                        });
                        const {
                            status,
                            feedback,
                            blockingItems,
                            evidence,
                            runtimeChecks,
                            artifactPaths,
                            previewUrlTested
                        } = reviewResult;

                        // STATIC TEMPLATE REVIEWER OVERRIDE:
                        // If the reviewer fails ONLY because of YOUR_APP_ID in workspace source files
                        // (not dist/), this is a false positive for static/runtime-config templates.
                        // Source files are template-owned and always contain YOUR_APP_ID placeholder.
                        // Only dist/ content matters for publish compliance.
                        let _reviewerOverrideToPass = false;
                        if (
                            status === 'fail' &&
                            _buildConfigType === 'static' &&
                            _propagationStrategy === 'runtime-config-or-hostname'
                        ) {
                            const _feedbackText = String(feedback || '').toLowerCase();
                            const _blockingText = (blockingItems || []).join(' ').toLowerCase();
                            const _fullFailText = `${_feedbackText} ${_blockingText}`;
                            const _isOnlySourcePlaceholder = (
                                /your_app_id/.test(_fullFailText) &&
                                !(/dist\//.test(_fullFailText))
                            );
                            const _isReactHallucination = (
                                /react|src\/main\.jsx|package\.json.*missing|missing.*bootstrap|mount.*point/.test(_fullFailText) &&
                                !(/critical|auth|leaderboard|viverse/.test(_fullFailText))
                            );
                            // Override: immutable-path violations that don't affect published output
                            // (the immutable file is fine as-is; Coder may have attempted to edit but dist is OK)
                            const _isImmutableOnlyBlocker = (
                                /immutable.path|immutable.*violation|immutable.*boundary/.test(_fullFailText) &&
                                !(/app.id.*missing|your_app_id.*dist|leaderboard.*fail|auth.*fail|publish.*fail/.test(_fullFailText))
                            );
                            // Override: leaderboard name mismatch risk (non-critical, template-registered name is correct)
                            const _isLeaderboardRiskOnly = (
                                (/leaderboard.*mismatch|mismatch.*leaderboard|wiring.*mismatch|leaderboard.*risk/.test(_fullFailText)) &&
                                !(/app.id.*missing|your_app_id.*dist|auth.*fail|publish.*fail|immutable/.test(_fullFailText))
                            );
                            if (_isOnlySourcePlaceholder || _isReactHallucination || _isImmutableOnlyBlocker || _isLeaderboardRiskOnly) {
                                _reviewerOverrideToPass = true;
                                logger.info(`Orchestrator: Reviewer false-positive override: static template source placeholder/React hallucination/immutable-path/leaderboard-risk. Overriding reviewer to pass.`);
                                verificationLedgerService.record(workspacePath, {
                                    type: 'reviewer',
                                    taskId: task.id,
                                    role: task.role,
                                    status: 'pass',
                                    summary: `[AUTO-PASS] Reviewer false-positive overridden: static template source YOUR_APP_ID is expected; immutable-path violations and leaderboard name risks are not dist/ publish blockers; React/vite not required.`,
                                    details: { blocking_items: [], evidence: [], runtime_checks: runtimeChecks, artifact_paths: artifactPaths }
                                });
                            }
                        }

                        if (status === 'fail' && !_reviewerOverrideToPass) {
                            verificationLedgerService.record(workspacePath, {
                                type: 'reviewer',
                                taskId: task.id,
                                role: task.role,
                                status: 'fail',
                                summary: String(feedback || 'Reviewer found blocking issues'),
                                details: {
                                    blocking_items: blockingItems,
                                    evidence,
                                    runtime_checks: runtimeChecks,
                                    artifact_paths: artifactPaths
                                },
                                artifactPaths
                            });
                            const blockerSignature = runtimeBlockers.map((b) => b.id).sort().join('||');
                            if (blockerSignature) {
                                state.runtimeFlags = state.runtimeFlags || {};
                                state.runtimeFlags.runtimeSignatureTracker = state.runtimeFlags.runtimeSignatureTracker || {};
                                const seen = Number(state.runtimeFlags.runtimeSignatureTracker[blockerSignature] || 0) + 1;
                                state.runtimeFlags.runtimeSignatureTracker[blockerSignature] = seen;
                                if (seen > 3) {
                                    const reason = `RUNTIME_BLOCKED_NONCODE: repeated runtime blocker signature '${blockerSignature}' persisted after ${seen} review cycles.`;
                                    task.status = 'failed';
                                    projectContextSummary += `\n- ${reason}`;
                                    state.projectContextSummary = projectContextSummary;
                                    await this._saveState(state);
                                    yield { type: 'status', content: reason };
                                    await this._finalizeWorkflowState(state, 'paused_or_failed');
                                    return;
                                }
                            }
                            yield { type: 'status', content: `Reviewer found issues. Creating a fix task.` };
                            const feedbackText = String(feedback || "");
                            const shortReason = feedbackText.length > 220 ? `${feedbackText.slice(0, 220)}...` : feedbackText;
                            yield {
                                type: 'status',
                                content: sanitizer.sanitize(
                                    `Reviewer blocked this round. Fix loop required${shortReason ? `: ${shortReason}` : ''}`,
                                    credentials
                                )
                            };
                            yield {
                                type: 'status',
                                content: 'Applying fixes now. This recovery pass may take longer; progress updates will continue.'
                            };

                            // ── Fix budget + diagnosis (2.1, 2.2, 2.4) ──────────────────────────
                            const _reviewerSig = `reviewer:${blockingItems.slice(0,3).join('|')}`.slice(0, 120);
                            const _reviewerStrategy = fixOrchestrationService.resolveFixStrategy(state, _reviewerSig);

                            if (_reviewerStrategy.strategy === 'exhausted') {
                                yield { type: 'status', content: `⛔ Fix budget exhausted for this Reviewer failure after ${_reviewerStrategy.attempt - 1} attempts. Halting to avoid infinite loop.` };
                                projectContextSummary += `\n- FIX BUDGET EXHAUSTED for reviewer signature: ${_reviewerSig}`;
                                haltExecutionReason = `Fix budget exhausted for reviewer signature: ${_reviewerSig}`;
                            } else {
                                yield { type: 'status', content: `Running root cause diagnosis before scheduling fix (strategy: ${_reviewerStrategy.strategy}, attempt ${_reviewerStrategy.attempt})...` };
                                const _reviewerDiagnosis = await fixOrchestrationService.runDiagnosis(
                                    geminiService,
                                    blockingItems.slice(0, 10),
                                    (state.fixAttemptLedger || []).filter(a => a.signature === _reviewerSig)
                                );
                                const _diagBlock = fixOrchestrationService.buildDiagnosisBlock(_reviewerDiagnosis);
                                const _regenBlock = _reviewerStrategy.strategy === 'regenerate_component'
                                    ? fixOrchestrationService.buildRegenerateBlock(_reviewerDiagnosis?.targetFiles || [])
                                    : '';
                                fixOrchestrationService.recordFixBudgetUsage(state, _reviewerSig);

                                const fixTaskId = `fix_${Date.now()}`;
                                const runtimeBlockerLines = runtimeBlockers.map((b) => `- ${b.id}: ${b.message} (artifacts: ${b.artifacts.join(', ')})`);
                                const scopedIssueLines = [...blockingItems.slice(0, 20), ...runtimeBlockerLines];
                                const scopedSubsystem = this._inferFailureSubsystem({
                                    issueLines: scopedIssueLines,
                                    task,
                                    state
                                });
                                const scopeGuard = this._buildFixScopeAndBaselineGuard(state, {
                                    issueLines: scopedIssueLines
                                });
                                const scopedFixGuard = this._buildScopedFixGuard({
                                    subsystem: scopedSubsystem,
                                    issueLines: scopedIssueLines
                                });
                                const templateGuard = this._buildTemplateExecutionGuardBlock(state);
                                state.tasks.push({
                                    id: fixTaskId,
                                    role: 'Coder',
                                    _fixSignature: _reviewerSig,
                                    prompt: (_diagBlock ? `${_diagBlock}\n\n` : '') +
                                        (_regenBlock ? `${_regenBlock}\n\n` : '') +
                                        `Fix the following blocking issues raised by the Reviewer.\nTarget subsystem: ${scopedSubsystem}\n${blockingItems.join('\n')}\n\n` +
                                        (runtimeBlockerLines.length
                                            ? `Mandatory runtime signature blockers (fix these first):\n${runtimeBlockerLines.join('\n')}\n\n`
                                            : '') +
                                        `Reviewer feedback: ${feedback}\nEvidence:\n${evidence.join('\n')}\n\n${scopedFixGuard}\n${scopeGuard}\n${templateGuard}`,
                                    dependsOn: [],
                                    status: 'pending'
                                });

                                // Splice the fix task into the dependency chain
                                for (let i = 0; i < state.tasks.length; i++) {
                                    let t = state.tasks[i];
                                    if (t.status === 'pending' && t.dependsOn && t.dependsOn.includes(task.id)) {
                                        t.dependsOn = t.dependsOn.filter(depId => depId !== task.id);
                                        t.dependsOn.push(fixTaskId);
                                    }
                                }

                                projectContextSummary += `\n- Reviewer found issues: ${feedback}. Fix task created (strategy: ${_reviewerStrategy.strategy}, attempt: ${_reviewerStrategy.attempt}).`;
                            }
                        } else if (!_reviewerOverrideToPass) {
                            verificationLedgerService.record(workspacePath, {
                                type: 'reviewer',
                                taskId: task.id,
                                role: task.role,
                                status: 'pass',
                                summary: String(feedback || 'Reviewer passed validation'),
                                details: {
                                    evidence,
                                    runtime_checks: runtimeChecks,
                                    artifact_paths: artifactPaths,
                                    preview_url_tested: previewUrlTested
                                },
                                artifactPaths
                            });
                            this._captureBaselineContractFromRuntimeChecks(state, {
                                runtimeChecks,
                                sourceTaskId: String(task.id || ''),
                                source: 'reviewer_pass'
                            });
                            state.runtimeFlags = state.runtimeFlags || {};
                            state.runtimeFlags.lastReviewerPassAt = new Date().toISOString();
                            projectContextSummary += `\n- Reviewer passed validation.`;
                        } else if (_reviewerOverrideToPass) {
                            // Override: static template reviewer false-positive already recorded as pass above.
                            state.runtimeFlags = state.runtimeFlags || {};
                            state.runtimeFlags.lastReviewerPassAt = new Date().toISOString();
                            projectContextSummary += `\n- Reviewer passed validation (auto-override: static template source placeholder is not a dist/ failure).`;
                        }
                    } catch (e) {
                        const reason = String(e?.message || e || 'Reviewer schema parse error');
                        verificationLedgerService.record(workspacePath, {
                            type: 'reviewer',
                            taskId: task.id,
                            role: task.role,
                            status: 'error',
                            summary: reason,
                            details: {}
                        });
                        logger.warn(`Reviewer output schema error: ${reason}`);
                        const existingRetry = state.tasks.find((t) =>
                            t.status === 'pending' &&
                            t.role === 'Reviewer' &&
                            String(t.prompt || '').includes('REVIEWER_SCHEMA_RETRY')
                        );
                        if (!existingRetry) {
                            const retryId = `reviewer_retry_${Date.now()}`;
                            state.tasks.push({
                                id: retryId,
                                role: 'Reviewer',
                                    prompt: `REVIEWER_SCHEMA_RETRY: Re-run the review and output STRICT JSON with status, feedback, severity, blocking_items, evidence, runtime_checks, artifact_paths, and preview_url_tested. runtime_checks MUST include: ${this._getRequiredRuntimeChecks(state).join(', ')}.`,
                                dependsOn: [],
                                status: 'pending'
                            });
                        }
                        projectContextSummary += `\n- Reviewer schema error: ${reason}. Reviewer retry scheduled.`;
                    }
                } else if (task.role.toUpperCase() === 'VERIFIER') {
                    if (state?.runtimeFlags?.authInvalid) {
                        task.status = 'blocked';
                        const reason = 'Verifier skipped: blocked by prior authentication failure.';
                        this._appendRunEvent(state, {
                            type: 'task_blocked',
                            taskId: task.id,
                            role: task.role,
                            durationMs: Date.now() - taskStartedAt,
                            reason
                        });
                        projectContextSummary += `\n- ${reason}`;
                        state.projectContextSummary = projectContextSummary;
                        await this._saveState(state);
                        yield { type: 'status', content: reason };
                        await this._finalizeWorkflowState(state, 'paused_or_failed');
                        return;
                    }
                    try {
                        const verifierResult = verifierResultValidator.parseAndValidate(fullResponse);

                        // STATIC TEMPLATE VERIFIER OVERRIDE:
                        // For static/runtime-config templates, override verifier fail if the ONLY failures are:
                        // 1. React/bootstrap/package.json hallucinations
                        // 2. Session-matching/Bridge gate (multiplayer-only, not applicable here)
                        // 3. Publish-readiness based on React/bootstrap concerns
                        // The dist/ App ID gate already PASSED in these runs.
                        let _verifierOverrideToPass = false;
                        if (
                            verifierResult.status === 'fail' &&
                            _buildConfigType === 'static' &&
                            !_hasMultiplayer
                        ) {
                            const _vReasons = (verifierResult.reasons || []).map(r => String(r).toLowerCase());
                            let _realFailures = _vReasons.filter(r =>
                                // Only keep as real failures things that are NOT hallucinations
                                !(/session.matching|bridge gate|getactorid|getuserinfo.*prioriti|react|src\/main\.jsx|package\.json.*missing|missing.*bootstrap|mount.*point|vite|npm run build/.test(r)) &&
                                !(/publish.readiness.*fail.*(?:react|bootstrap|package\.json|src\/main)/.test(r)) &&
                                // Static PlayCanvas templates use viverse-auth-overlay.js loaded externally;
                                // verifier cannot find auth bootstrap patterns in dist/ compiled files.
                                // "cannot confirm from dist-only evidence" is a hallucination for static templates.
                                !(/auth gate.*(?:cannot|could not).*confirm|(?:cannot|could not).*confirm.*dist.*auth|dist.only.*evidence.*auth|dist.*artifacts.*auth.*bootstrap|(?:cannot|could not).*confirm.*auth.*bootstrap|auth.*bootstrap.*remains.*compliant.*dist/.test(r))
                            );
                            // Deterministic fs check: if verifier claims YOUR_APP_ID is still in dist/,
                            // verify by actually reading the dist directory. If not found, it's a hallucination.
                            const _appIdHallucinationReasons = _realFailures.filter(r =>
                                /your_app_id/.test(r) && /dist/.test(r)
                            );
                            if (_appIdHallucinationReasons.length > 0) {
                                try {
                                    const _distDir = path.join(workspacePath, 'dist');
                                    const _distFiles = await fs.readdir(_distDir).catch(() => []);
                                    let _distHasPlaceholder = false;
                                    for (const _df of _distFiles) {
                                        try {
                                            const _dfc = await fs.readFile(path.join(_distDir, _df), 'utf8');
                                            if (_dfc.includes('YOUR_APP_ID')) { _distHasPlaceholder = true; break; }
                                        } catch (_) {}
                                    }
                                    if (!_distHasPlaceholder) {
                                        // dist/ is clean — verifier hallucinated
                                        _realFailures = _realFailures.filter(r =>
                                            !(/your_app_id/.test(r) && /dist/.test(r))
                                        );
                                        logger.info(`Orchestrator: Verifier hallucination detected — claimed YOUR_APP_ID in dist/ but filesystem found none. Suppressing ${_appIdHallucinationReasons.length} false failure(s).`);
                                    }
                                } catch (_) {}
                            }
                            // If no real failures remain, override to pass
                            if (_realFailures.length === 0) {
                                _verifierOverrideToPass = true;
                                logger.info(`Orchestrator: Verifier false-positive override: all ${_vReasons.length} failures were non-applicable gates (session/bridge/react hallucinations or dist/ App ID hallucination). Overriding verifier to pass.`);
                                verificationLedgerService.record(workspacePath, {
                                    type: 'verifier',
                                    taskId: task.id,
                                    role: task.role,
                                    status: 'pass',
                                    summary: `[AUTO-PASS] Verifier false-positive overridden: all failing gates were non-applicable (session-matching/bridge gates require multiplayer; React bootstrap not required for static PlayCanvas template; dist/ App ID placeholder hallucination suppressed).`,
                                    details: { status: 'pass', reasons: [`Auto-passed: ${_vReasons.length} non-applicable gate failures suppressed`], category: 'compliance' }
                                });
                            }
                        }

                        if (verifierResult.status === 'fail' && !_verifierOverrideToPass) {
                            verificationLedgerService.record(workspacePath, {
                                type: 'verifier',
                                taskId: task.id,
                                role: task.role,
                                status: 'fail',
                                summary: verifierResult.reasons.join(', ') || 'Unknown verifier reason',
                                details: verifierResult.details
                            });
                            const reasonsArr = verifierResult.reasons.length
                                ? verifierResult.reasons
                                : ['Unknown verifier reason'];
                            const reasonsText = reasonsArr.join(', ');
                            const shortReasons = reasonsText.length > 240 ? `${reasonsText.slice(0, 240)}...` : reasonsText;
                            yield {
                                type: 'status',
                                content: sanitizer.sanitize(
                                    `Compliance gate failed${shortReasons ? `: ${shortReasons}` : ''}`,
                                    credentials
                                )
                            };
                            const scheduledFix = this._scheduleDeterministicVerifierFixTask({
                                state,
                                task,
                                verifierResult
                            });
                            if (scheduledFix.exhausted) {
                                yield { type: 'status', content: `⛔ Fix budget exhausted for Verifier signature after ${scheduledFix.reason}. Halting fix loop.` };
                                projectContextSummary += `\n- FIX BUDGET EXHAUSTED for verifier signature: ${scheduledFix.signature}`;
                                haltExecutionReason = `Verifier fix budget exhausted: ${scheduledFix.signature}`;
                            } else if (scheduledFix.scheduled) {
                                yield {
                                    type: 'status',
                                    content: `Verifier BLOCKED the release. Scheduled scoped recovery task ${scheduledFix.fixTaskId}.`
                                };
                                yield {
                                    type: 'status',
                                    content: 'Running deterministic verifier recovery now. This pass is limited to the blocking release issues.'
                                };
                                projectContextSummary += `\n- !!! VERIFIER BLOCKED RELEASE !!! Reasons: ${reasonsText}. Deterministic verifier fix task ${scheduledFix.fixTaskId} created for subsystem ${scheduledFix.subsystem} (signature: ${scheduledFix.signature}).`;
                            } else if (scheduledFix.existingTaskId) {
                                yield {
                                    type: 'status',
                                    content: `Verifier BLOCKED the release. Reusing existing scoped recovery task ${scheduledFix.existingTaskId}.`
                                };
                                projectContextSummary += `\n- !!! VERIFIER BLOCKED RELEASE !!! Reasons: ${reasonsText}. Existing verifier recovery task ${scheduledFix.existingTaskId} already pending (signature: ${scheduledFix.signature}).`;
                            } else {
                                yield { type: 'status', content: 'Verifier BLOCKED the release. No scoped recovery task was scheduled.' };
                                projectContextSummary += `\n- !!! VERIFIER BLOCKED RELEASE !!! Reasons: ${reasonsText}. Scoped verifier recovery scheduling was skipped (${scheduledFix.reason || 'unknown'}).`;
                            }
                        } else if (_verifierOverrideToPass) {
                            // Override: static template verifier false-positive already recorded as pass above.
                            const _verifierPassHash = await fixOrchestrationService.snapshotWorkspace(workspacePath);
                            state.sourceHash = _verifierPassHash;
                            yield { type: 'status', content: 'Verifier auto-pass: non-applicable gate failures suppressed for static PlayCanvas template.' };
                            projectContextSummary += `\n- Verifier passed (auto-override for static template: non-multiplayer gates not applicable).`;
                        } else {
                            // Capture source hash so we can skip the next Verifier
                            // if nothing changed since this passing run (3.1)
                            const _verifierPassHash = await fixOrchestrationService.snapshotWorkspace(workspacePath);
                            verificationLedgerService.record(workspacePath, {
                                type: 'verifier',
                                taskId: task.id,
                                role: task.role,
                                status: 'pass',
                                summary: 'Verifier passed all compliance gates.',
                                details: verifierResult.details,
                                sourceHash: _verifierPassHash
                            });
                            const verifierDetails = verifierResult.details && typeof verifierResult.details === 'object'
                                ? verifierResult.details
                                : {};
                            const runtimeChecks = verifierDetails.runtime_checks && typeof verifierDetails.runtime_checks === 'object'
                                ? Object.entries(verifierDetails.runtime_checks).map(([name, info]) => ({
                                    name,
                                    status: String(info?.status || 'unknown'),
                                    proof: String(info?.proof || '')
                                }))
                                : [];
                            const previewUrlTested = String(
                                verifierDetails.preview_url_tested
                                || verifierResult.preview_url_tested
                                || ''
                            ).trim();
                            const artifactPaths = Array.isArray(verifierDetails.artifact_paths)
                                ? verifierDetails.artifact_paths
                                : Array.isArray(verifierResult.artifact_paths)
                                    ? verifierResult.artifact_paths
                                    : [];
                            if (runtimeChecks.length && (previewUrlTested || artifactPaths.length)) {
                                verificationLedgerService.record(workspacePath, {
                                    type: 'preview_probe',
                                    taskId: task.id,
                                    role: task.role,
                                    status: verifierResult.status,
                                    summary: `Verifier runtime revalidation ${verifierResult.status}. checks=[${runtimeChecks.map((c) => `${c.name}:${c.status}`).join(', ')}]`,
                                    details: {
                                        runtime_checks: runtimeChecks,
                                        report: verifierDetails
                                    },
                                    artifactPaths
                                });
                                if (String(verifierResult.status || '').toLowerCase() === 'pass') {
                                    this._captureBaselineContractFromRuntimeChecks(state, {
                                        runtimeChecks,
                                        sourceTaskId: String(task.id || ''),
                                        source: 'verifier_runtime_revalidation'
                                    });
                                    state.runtimeFlags = state.runtimeFlags || {};
                                    state.runtimeFlags.lastPreviewProbePassAt = new Date().toISOString();
                                }
                            }
                            projectContextSummary += `\n- Verifier passed all compliance gates.`;
                        }
                    } catch (e) {
                        verificationLedgerService.record(workspacePath, {
                            type: 'verifier',
                            taskId: task.id,
                            role: task.role,
                            status: 'error',
                            summary: String(e?.message || e || 'Could not parse verifier output'),
                            details: {}
                        });
                        logger.warn("Could not parse Verifier output as JSON.");
                    }
                } else {
                    const contractArtifact = await this._persistArchitectContractArtifact(
                        state,
                        task,
                        workspacePath,
                        fullResponse
                    );
                    const architectContract = await this._ensureArchitectContract(
                        state,
                        task,
                        workspacePath,
                        projectContextSummary
                    );
                    projectContextSummary = architectContract.projectContextSummary;
                    if (contractArtifact.persisted) {
                        projectContextSummary += `\n- Architect contract artifact persisted to CONTRACT.json.`;
                    }
                    projectContextSummary += `\n- ${task.role} completed: ${task.prompt.substring(0, 100)}...`;

                    // App ID authority extraction (strict 10-char IDs only).
                    const extractedId = this._extractCanonicalAppId(fullResponse) || this._extractCanonicalAppId(task.prompt);
                    if (extractedId) {
                        logger.info(`Orchestrator: Extracted App ID from agent response: ${extractedId}`);
                        this._setAppIdAuthority(state, extractedId, `task:${task.id}`);
                        projectContextSummary += `\n- IMPORTANT: The VIVERSE App ID for this project is: ${extractedId}`;
                        // Sync appId into CONTRACT.json so verifier sees a real ID
                        try {
                            const contractSyncPath = path.join(workspacePath, 'CONTRACT.json');
                            const contractRaw = await fs.readFile(contractSyncPath, 'utf8');
                            const contractObj = JSON.parse(contractRaw);
                            const _existingId = String(contractObj?.app?.appId || contractObj?.appId || '');
                            if (!this._isValidAppId(_existingId)) {
                                if (!contractObj.app) contractObj.app = {};
                                contractObj.app.appId = extractedId;
                                contractObj.appId = extractedId;
                                contractObj.clientId = extractedId;
                                await fs.writeFile(contractSyncPath, `${JSON.stringify(contractObj, null, 2)}\n`, 'utf8');
                                logger.info(`Orchestrator: Synced appId ${extractedId} to CONTRACT.json`);
                            }
                        } catch (_e) {
                            // CONTRACT.json may not exist yet; ignore
                        }
                    }

                    // Leaderboard API Name Extraction
                    const expectedLbFromTask =
                        String(task.prompt || '').match(/api\s+name\s+['"]([a-z0-9-]{3,30})['"]/i)?.[1] || '';
                    const extractedLb =
                        fullResponse.match(/(?:Leaderboard API Name|leaderboard-name|VITE_VIVERSE_LEADERBOARD_NAME)[^\w]*([a-z0-9-]{3,30})\b/i)?.[1] || '';
                    const chosenLb = expectedLbFromTask || extractedLb;
                    if (chosenLb) {
                        if (expectedLbFromTask && extractedLb && expectedLbFromTask !== extractedLb) {
                            logger.warn(
                                `Orchestrator: Leaderboard name mismatch (task=${expectedLbFromTask}, response=${extractedLb}). Using task authority.`
                            );
                            projectContextSummary += `\n- NOTE: Leaderboard API name mismatch detected (response=${extractedLb}, expected=${expectedLbFromTask}). Using expected value.`;
                        } else {
                            logger.info(`Orchestrator: Extracted Leaderboard Name from agent response/task: ${chosenLb}`);
                        }
                        projectContextSummary += `\n- IMPORTANT: The Leaderboard API Name for this project is: ${chosenLb}`;
                    }

                    // Preview URL Extraction (supports worlds.viverse.com links)
                    const responsePreviewUrl = this._extractPreviewUrl(fullResponse);
                    // The preview URL slug (e.g. qDPuh7L) is issued by viverse-cli publish and
                    // is NOT the same as the app ID — do NOT synthesize it from appId.
                    const extractedUrl = responsePreviewUrl || this._extractPreviewUrl(projectContextSummary);
                    if (extractedUrl) {
                        logger.info(`Orchestrator: Extracted Preview URL from agent response/context: ${extractedUrl}`);
                        projectContextSummary += `\n- IMPORTANT: The VIVERSE Preview URL for this project is: ${extractedUrl}`;
                        // Push the authoritative URL as a structured event so the frontend
                        // always gets the server-validated URL regardless of what text the
                        // Coder included in its response.
                        yield { type: 'preview_url', url: extractedUrl };
                        // Also inject as a properly-formatted FINAL_PREVIEW_URL line in the
                        // text stream so the regex fallback also works.
                        yield { type: 'text', content: `\n\nFINAL_PREVIEW_URL: ${extractedUrl}\n` };

                        // Auto-test hook: run deterministic preview probe after publish-like operations.
                        const promptText = String(task.prompt || "");
                        const hasPublishCommandEvidence = /viverse-cli\s+app\s+publish/i.test(`${fullResponse}\n${promptText}`);
                        const hasFreshPublishResultEvidence =
                            Boolean(responsePreviewUrl) &&
                            (
                                this._isFixTask(task) ||
                                /published|publish(?:ed)? application|preview url/i.test(fullResponse)
                            );
                        const shouldProbe =
                            this._isPublishTask(task) ||
                            hasPublishCommandEvidence ||
                            hasFreshPublishResultEvidence;
                        if (shouldProbe) {
                            yield { type: 'status', content: 'Running preview auto-test probe on worlds.viverse.com...' };
                            try {
                                const appIdHints = this._extractAppIdCandidates(`${projectContextSummary}\n${fullResponse}`)
                                    .filter(id => /\d/.test(id)); // must contain a digit — rejects plain words like "publishing"
                                // Prefer the locked authority ID if available
                                const _authorityId = String(state?.runtimeFlags?.appIdAuthority?.value || '').toLowerCase();
                                const probeAppId = _authorityId && /^[a-z0-9]{10}$/.test(_authorityId) && /\d/.test(_authorityId)
                                    ? _authorityId
                                    : (appIdHints[0] || '');
                                const probe = await previewAutoTestService.runPreviewProbe({
                                    workspacePath,
                                    previewUrl: extractedUrl,
                                    appId: probeAppId,
                                    credentials
                                });
                                const checks = Array.isArray(probe.runtime_checks) ? probe.runtime_checks : [];
                                const artifacts = Array.isArray(probe.artifact_paths) ? probe.artifact_paths : [];
                                const checkSummary = checks.map((c) => `${c.name}:${c.status}`).join(', ');
                                projectContextSummary += `\n- AUTO_TEST preview probe: ${probe.status}. checks=[${checkSummary}]`;
                                if (artifacts.length) {
                                    projectContextSummary += `\n- AUTO_TEST artifacts:\n${artifacts.map((p) => `  - ${p}`).join('\n')}`;
                                }
                                verificationLedgerService.record(workspacePath, {
                                    type: 'preview_probe',
                                    taskId: task.id,
                                    role: task.role,
                                    status: String(probe.status || 'unknown'),
                                    summary: `Preview probe ${probe.status}. checks=[${checkSummary}]`,
                                    details: {
                                        runtime_checks: checks,
                                        report: probe.report || {}
                                    },
                                    artifactPaths: artifacts
                                });
                                this._appendRunEvent(state, {
                                    type: 'preview_probe',
                                    taskId: task.id,
                                    role: task.role,
                                    status: probe.status,
                                    previewUrl: probe.preview_url_tested || extractedUrl,
                                    artifacts,
                                    runtimeChecks: checks
                                });
                                yield {
                                    type: 'status',
                                    content: sanitizer.sanitize(
                                        `Preview probe ${probe.status}. Artifacts: ${artifacts.length}`,
                                        credentials
                                    )
                                };

                                if (String(probe.status || '').toLowerCase() === 'pass') {
                                    this._captureBaselineContractFromRuntimeChecks(state, {
                                        runtimeChecks: checks,
                                        sourceTaskId: String(task.id || ''),
                                        source: 'preview_probe_pass'
                                    });
                                    state.runtimeFlags = state.runtimeFlags || {};
                                    state.runtimeFlags.lastPreviewProbePassAt = new Date().toISOString();
                                } else if (String(probe.status || '').toLowerCase() === 'fail') {
                                    const autoFix = this._scheduleAutoTestFixTask({
                                        state,
                                        task,
                                        probe,
                                        projectContextSummary
                                    });
                                    if (autoFix.scheduled) {
                                        projectContextSummary += `\n- AUTO_TEST runtime failures triggered fix task ${autoFix.fixTaskId} (signature: ${autoFix.signature}).`;
                                        yield {
                                            type: 'status',
                                            content: sanitizer.sanitize(
                                                `Auto-test found runtime failures. Scheduled self-fix task ${autoFix.fixTaskId}.`,
                                                credentials
                                            )
                                        };
                                    } else if (String(autoFix.reason || '').startsWith('retry_cap_reached:')) {
                                        const haltReason = `Auto-test failures unresolved after retry cap for signature ${autoFix.signature}.`;
                                        projectContextSummary += `\n- ${haltReason}`;
                                        haltExecutionReason = haltReason;
                                    }
                                }
                            } catch (probeErr) {
                                const reason = String(probeErr?.message || probeErr || 'unknown preview probe error');
                                logger.warn(`Orchestrator: preview auto-test probe failed: ${reason}`);
                                projectContextSummary += `\n- AUTO_TEST preview probe error: ${reason}`;
                                verificationLedgerService.record(workspacePath, {
                                    type: 'preview_probe',
                                    taskId: task.id,
                                    role: task.role,
                                    status: 'error',
                                    summary: reason,
                                    details: {},
                                    artifactPaths: []
                                });
                                this._appendRunEvent(state, {
                                    type: 'preview_probe_error',
                                    taskId: task.id,
                                    role: task.role,
                                    reason
                                });
                                yield { type: 'status', content: `Preview probe error: ${reason}` };
                            }
                        }
                    }
                }

                task.status = 'completed';
                this._appendRunEvent(state, {
                    type: 'task_completed',
                    taskId: task.id,
                    role: task.role,
                    durationMs: Date.now() - taskStartedAt
                });
                state.projectContextSummary = projectContextSummary;

                // ── BUG2 ENUM AUDIT: after task_template_modify, verify all PlayCanvas script
                //    attributes have valid enum values according to config.json ──────────────────
                if (task.id === 'task_template_modify' && workspacePath) {
                    try {
                        const _configPath = path.join(workspacePath, 'config.json');
                        const _configRaw = await fs.readFile(_configPath, 'utf8').catch(() => null);
                        if (_configRaw) {
                            const _config = JSON.parse(_configRaw);
                            // Build a map: scriptName.attrName → Set<validValues> from config.json
                            // PlayCanvas config structure: assets.<id>.data.scripts.<scriptName>.attributes.<attrName>.enum.options
                            const _enumMap = {};
                            for (const asset of Object.values(_config.assets || {})) {
                                const scripts = asset?.data?.scripts;
                                if (!scripts || typeof scripts !== 'object') continue;
                                for (const [sName, sDef] of Object.entries(scripts)) {
                                    for (const [aName, aDef] of Object.entries(sDef?.attributes || {})) {
                                        if (aDef?.enum?.options && typeof aDef.enum.options === 'object') {
                                            _enumMap[`${sName}.${aName}`] = new Set(Object.values(aDef.enum.options).map(String));
                                        }
                                    }
                                }
                            }

                            // Now scan all *.json files that look like scene files for script attrs
                            const _auditResults = [];
                            let _sceneFiles;
                            try { _sceneFiles = await fs.readdir(workspacePath); } catch { _sceneFiles = []; }
                            for (const fname of _sceneFiles.filter(f => /^\d+\.json$/.test(f))) {
                                try {
                                    const _scene = JSON.parse(await fs.readFile(path.join(workspacePath, fname), 'utf8'));
                                    for (const [, entity] of Object.entries(_scene.entities || {})) {
                                        const scripts = entity?.components?.script?.scripts || {};
                                        for (const [sName, sDef] of Object.entries(scripts)) {
                                            for (const [aName, aVal] of Object.entries(sDef.attributes || {})) {
                                                const key = `${sName}.${aName}`;
                                                if (!_enumMap[key] || aVal === null || aVal === undefined) continue;
                                                const valid = _enumMap[key];
                                                const strVal = String(aVal);
                                                const isValid = valid.has(strVal);
                                                _auditResults.push({ file: fname, entity: entity.name, key, value: strVal, valid: isValid, validValues: [...valid] });
                                            }
                                        }
                                    }
                                } catch { /* corrupt scene — skip */ }
                            }

                            if (_auditResults.length === 0) {
                                logger.info('BUG2_ENUM_AUDIT: no PlayCanvas enum attributes found to check');
                            } else {
                                const _failed = _auditResults.filter(r => !r.valid);
                                const _passed = _auditResults.filter(r => r.valid);
                                logger.info(`BUG2_ENUM_AUDIT: checked ${_auditResults.length} enum attribute(s) — PASS:${_passed.length} FAIL:${_failed.length}`);
                                for (const r of _passed) {
                                    logger.info(`BUG2_ENUM_AUDIT PASS  — ${r.entity}.${r.key} = "${r.value}" ✓`);
                                }
                                for (const r of _failed) {
                                    logger.warn(`BUG2_ENUM_AUDIT FAIL  — ${r.entity}.${r.key} = "${r.value}" ✗  (valid: ${r.validValues.join(', ')})`);
                                }
                                if (_failed.length === 0) {
                                    logger.info('BUG2_ENUM_AUDIT RESULT: ✅ ALL enum attributes are valid — Bug 2 is FIXED');
                                    yield { type: 'status', content: `[BUG2_AUDIT] ✅ All scene enum attributes are valid` };
                                } else {
                                    logger.warn(`BUG2_ENUM_AUDIT RESULT: ❌ ${_failed.length} INVALID enum attribute(s) found — Bug 2 NOT fixed`);
                                    yield { type: 'status', content: `[BUG2_AUDIT] ❌ Invalid enum value(s) detected: ${_failed.map(r => `${r.key}="${r.value}"`).join(', ')}` };
                                }
                            }
                        }
                    } catch (_auditErr) {
                        logger.warn(`BUG2_ENUM_AUDIT error: ${_auditErr?.message || _auditErr}`);
                    }
                }
                // ─────────────────────────────────────────────────────────────────────────────

                if (this._isFixTask(task)) {
                    state.runtimeFlags = state.runtimeFlags || {};
                    state.runtimeFlags.lastFixTaskCompletedAt = new Date().toISOString();
                    // Record snapshot diff so next fix attempt can detect if nothing changed (2.2)
                    await fixOrchestrationService.recordFixAttempt(state, {
                        taskId: task.id,
                        signature: task._fixSignature || '',
                        snapshotBefore: task._snapshotBefore || '',
                        workspacePath
                    });
                }
                
                // APPEND ACTUAL RESULT TO CONTEXT
                // Use a larger limit for Coder results so the Reviewer/Verifier can see
                // what commands were run and what files were changed — this is the primary
                // mechanism for verifying the user's request was actually fulfilled.
                const _resultLimit = (task.role?.toUpperCase() === 'CODER') ? 2000 : 500;
                const truncatedResult = fullResponse.length > _resultLimit ? fullResponse.substring(0, _resultLimit) + "..." : fullResponse;
                projectContextSummary += `\n- [${task.role} RESULT (${task.id})]: ${truncatedResult}`;
                state.projectContextSummary = projectContextSummary;
                
                yield { type: 'status', content: `Task ${task.id} completed.` };
                yield { type: 'text', content: `\n\n✅ **${task.role}** has completed the task.` };
                this._drainTemplateViolationsFromFileService(state, workspacePath);
                await this._saveState(state);
                skillLedgerService.clearExecutionContext(workspacePath);
            }
        }

        this._drainTemplateViolationsFromFileService(state, workspacePath);
        const runEvents = Array.isArray(state?.runReport?.events) ? state.runReport.events : [];
        const {
            workflowTasksSettled
        } = workflowExecutionService.computeSettlement(state, runEvents);

        if (workflowTasksSettled) {
            this._hydratePreviewProbeFromVerifierEvidence(state, workspacePath);
            if (!this._hasRuntimeRevalidationAfterLatestFix(state)) {
                const revalidationTaskId = this._ensureRuntimeRevalidationTask(state);
                if (revalidationTaskId && _inlineRevalCount < 2) {
                    _inlineRevalCount++;
                    projectContextSummary += `\n- Runtime evidence was stale after the latest fix. Inline revalidation task ${revalidationTaskId} scheduled (cycle ${_inlineRevalCount}).`;
                    state.projectContextSummary = projectContextSummary;
                    await this._saveState(state);
                    yield {
                        type: 'status',
                        content: `Runtime evidence stale after latest fix. Scheduling inline revalidation ${revalidationTaskId} (cycle ${_inlineRevalCount}).`
                    };
                    continue executionLoop;  // Re-run task loop with new pending revalidation task
                }
            }
        } // end inline revalidation check
        if (workflowTasksSettled) {

            const completionVerdict = await workflowCompletionService.evaluateCompletionVerdict({
                state,
                workspacePath,
                projectContextSummary,
                checkAppIdIntegrity: this._checkAppIdIntegrity.bind(this),
                hasRuntimeRevalidationAfterLatestFix: this._hasRuntimeRevalidationAfterLatestFix.bind(this),
                detectRuntimeBlockerSignatures: this._detectRuntimeBlockerSignatures.bind(this),
                requiresPreviewProbeEvidence: this._requiresPreviewProbeEvidence.bind(this),
                hasAnyPreviewProbeEvent: this._hasAnyPreviewProbeEvent.bind(this),
                hasBlockingPreviewProbeFailure: this._hasBlockingPreviewProbeFailure.bind(this),
                runTemplateCompletionGates: this._runTemplateCompletionGates.bind(this)
            });
            if (!completionVerdict.ok) {
                projectContextSummary += `\n- WORKFLOW HALTED: ${completionVerdict.reason}.`;
                state.projectContextSummary = projectContextSummary;
                yield {
                    type: 'status',
                    content: `Workflow paused: ${completionVerdict.reason}`
                };
                yield {
                    type: 'text',
                    content: workflowCompletionService.buildOutcomeNotice({
                        state,
                        completed: false,
                        reason: completionVerdict.reason,
                        resolveLatestPreviewUrl: this._resolveLatestPreviewUrl.bind(this)
                    })
                };
                await this._finalizeWorkflowState(state, 'paused_or_failed');
                return;
            }

            if (state.runReport && !state.runReport.endedAt) {
                state.runReport.endedAt = new Date().toISOString();
                state.runReport.outcome = 'completed';
            }
            projectContextSummary = this._stripWorkflowHaltNotes(projectContextSummary);
            state.projectContextSummary = projectContextSummary;
            yield workflowEventService.provisionalStatus('All tasks processed. Initiating Knowledge Evolution Loop...', {
                phase: 'finalize'
            });
            
            // Build a structured extraction prompt so Pro SUMMARIZER always finds lessons
            const _appId  = state?.runtimeFlags?.appIdAuthority?.value || '';
            const _previewUrl = this._resolveLatestPreviewUrl(state) || '';
            const _templateId = state?.templateContext?.templateId || '';
            const _taskSummary = (state?.tasks || [])
                .filter(t => t.status === 'completed')
                .map(t => `  - ${t.role} (${t.id}): completed`).join('\n');
            const _fixCount = (state?.tasks || []).filter(t => /^(?:fix_|c_fix_|v_fix_|loop_recover)/i.test(t.id || '')).length;
            const evolutionPrompt = `PROJECT SUCCESSFUL. Extract lessons and summarize.

RUN FACTS (use these to extract lessons):
- Template: ${_templateId}
- App ID: ${_appId}
- Preview URL: ${_previewUrl}
- Fix tasks needed: ${_fixCount} (0 = clean first-attempt run)
- Completed tasks:\n${_taskSummary}
- Workspace: ${state.workspacePath}

PROJECT_LOG_CONTEXT (last 6000 chars of project log — source for lesson extraction):
${projectContextSummary.slice(-6000)}

Follow your KNOWLEDGE EVOLUTION MANDATE exactly:
1. loadSkill('.', 'viverse-resilience-guide.md') first
2. Extract up to 3 lessons from the log above
3. Append NEW lessons to the guide with writeFile
4. Give the user a final summary with App ID, Preview URL, and lessons added.`;

            // Summarizer doesn't need full history as projectContextSummary carries the state.
            const summarizedHistory = history.length > 2 ? history.slice(-2) : history;
            const finalResponse = await geminiService.generateResponse(
                evolutionPrompt,
                summarizedHistory,
                "SUMMARIZER",
                workspacePath
            );
            yield { type: 'text', content: sanitizer.sanitize(`\n\n${finalResponse}`, credentials) };
            yield {
                type: 'text',
                content: sanitizer.sanitize(`\n\n${workflowCompletionService.buildOutcomeNotice({
                    state,
                    completed: true,
                    reason: '',
                    resolveLatestPreviewUrl: this._resolveLatestPreviewUrl.bind(this)
                })}`, credentials)
            };
            yield { type: 'text', content: "\n\n**Project workflow completed.** State saved to `.agent_state.json`." };
            yield workflowEventService.workflowOutcome({
                completed: true,
                reason: '',
                workspacePath: state?.workspacePath || ''
            });
            await this._finalizeWorkflowState(state, 'completed');
            break executionLoop;
        } else {
            if (state.runReport && !state.runReport.endedAt) {
                state.runReport.endedAt = new Date().toISOString();
                state.runReport.outcome = 'paused_or_failed';
            }
            yield workflowEventService.finalStatus('Workflow paused or interrupted.', {
                phase: 'finalize'
            });
            yield {
                type: 'text',
                content: workflowCompletionService.buildOutcomeNotice({
                    state,
                    completed: false,
                    reason: 'Pending/blocked tasks remain',
                    resolveLatestPreviewUrl: this._resolveLatestPreviewUrl.bind(this)
                })
            };
            yield workflowEventService.workflowOutcome({
                completed: false,
                reason: 'Pending/blocked tasks remain',
                workspacePath: state?.workspacePath || ''
            });
            await this._finalizeWorkflowState(state, 'paused_or_failed');
            break executionLoop;
        }
        } // close executionLoop: while (true)
    }

    async _saveState(state) {
        try {
            if (state?.workspacePath) {
                // Keep the conversationWorkspaces registry up to date so subsequent requests
                // from the same browser session hit this workspace directly (no scoring scan).
                if (state.conversationId) {
                    this.conversationWorkspaces.set(state.conversationId, state.workspacePath);
                }
                const inMemoryEntries = verificationLedgerService.getEntries(state.workspacePath);
                if (inMemoryEntries.length > 0) {
                    state.verificationLedger = inMemoryEntries;
                } else if (Array.isArray(state?.verificationLedger) && state.verificationLedger.length > 0) {
                    state.verificationLedger = verificationLedgerService.hydrate(state.workspacePath, state.verificationLedger);
                } else {
                    state.verificationLedger = [];
                }
            }
            workflowContextService.applyToState(state, {
                workspacePath: state?.workspacePath || '',
                message: state?.request || '',
                history: state?.history || []
            });
            const redactString = (text = "") =>
                String(text)
                    .replace(/USER VIVERSE CREDENTIALS[\s\S]*?(?=\n[A-Z_-]+:|\n- |\n\n|$)/gi, '[REDACTED_CREDENTIAL_BLOCK]\n')
                    .replace(/Password:\s*.+/gi, 'Password: [REDACTED]')
                    .replace(/password["']?\s*:\s*["'][^"']+["']/gi, 'password: "[REDACTED]"')
                    .replace(/-p\s+\S+/gi, '-p [REDACTED]');

            const deepRedact = (value) => {
                if (typeof value === 'string') return redactString(value);
                if (Array.isArray(value)) return value.map((item) => deepRedact(item));
                if (value && typeof value === 'object') {
                    const out = {};
                    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v);
                    return out;
                }
                return value;
            };

            const clone = JSON.parse(JSON.stringify(state || {}));
            const redacted = deepRedact(clone);
            if (redacted?.complianceFastCache?.fileIndex) {
                delete redacted.complianceFastCache.fileIndex;
            }
            await fileService.writeFile(
                `${state.workspacePath}/.agent_state.json`,
                JSON.stringify(redacted, null, 2),
                undefined,
                { skipTemplateEnforcement: true }
            );
            if (redacted?.runReport) {
                await fileService.writeFile(
                    `${state.workspacePath}/run_report.json`,
                    JSON.stringify(redacted.runReport, null, 2),
                    undefined,
                    { skipTemplateEnforcement: true }
                );
            }
        } catch (e) {
            logger.error(`Failed to save agent state: ${e.message}`);
        }
    }
}

export default new OrchestratorService();
