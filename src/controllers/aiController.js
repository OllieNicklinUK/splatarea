import geminiService from '../services/AIService.js';
import orchestratorService from '../services/OrchestratorService.js';
import searchService from '../services/SearchService.js';
import workspaceRegistryService from '../services/WorkspaceRegistryService.js';
import agentMemoryService from '../services/AgentMemoryService.js';
import fileService from '../services/FileService.js';
import templateRegistryService from '../services/templates/TemplateRegistryService.js';
import templateContractService from '../services/templates/TemplateContractService.js';
import phase0RoutingService from '../services/Phase0RoutingService.js';
import workflowStateService from '../services/WorkflowStateService.js';
import logger from '../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const APP_HISTORY_FILE = path.resolve(process.cwd(), '.viverse_app_history.json');
const WORKSPACE_DIR    = path.resolve(process.cwd(), '.viverse_workspaces');
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_SIZE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENTS_BYTES = 48 * 1024 * 1024;
const EXTRA_DOC_MIME_TYPES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
    'application/json',
    'text/csv'
]);
const TEMPLATE_CATALOG_FALLBACK = [
    {
        id: 'blank-webapp-v1',
        name: 'Blank Web App',
        version: '1.0.0',
        genre: 'Utility',
        description: 'Lightweight baseline for non-game app generation with VIVERSE integration hooks.',
        tags: ['app', 'blank', 'utility'],
        capabilities: ['auth', 'publish'],
        recommendedPrompt: "Create a new web app from template 'blank-webapp-v1' and implement the requested feature set."
    },
    {
        id: 'tankarena-3d-v1',
        name: 'TankArena 3D Template',
        version: '1.0.0',
        genre: 'Arcade Action',
        description: 'Fixed-camera 3D tank arena template with auth, leaderboard, room lifecycle, and random battlefield generation.',
        tags: ['game', 'tank', 'threejs', 'arcade', 'leaderboard', 'multiplayer'],
        capabilities: ['auth', 'leaderboard', 'matchmaking', 'publish'],
        recommendedPrompt: "Create a new 3D tank arena game using template 'tankarena-3d-v1'. Preserve auth, leaderboard, and room lifecycle stability while customizing gameplay, visuals, and weapons."
    }
];

const isExecutionIntent = (message = '') => {
    const text = String(message || '').toLowerCase();
    return /(resume|continue|proceed|fix|debug|error|bug|issue|retest|test|build|publish|run|req_\d+)/.test(text);
};

const isLatestAppQuery = (message = '') => {
    const text = String(message || '').toLowerCase().trim();
    if (!text) return false;
    if (isExecutionIntent(text)) return false;
    return (
        /\b(show|list|get)\s+(my\s+)?(latest\s+)?app ids?\b/.test(text) ||
        /\blatest\s+app\s+id\b/.test(text) ||
        /\bother\s+recent\s+app\s+ids?\b/.test(text)
    );
};

const emailKey = (email = '') =>
    crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');

const maskEmail = (email = '') => {
    const [name, domain] = String(email).split('@');
    if (!name || !domain) return 'unknown';
    const head = name.slice(0, 2);
    return `${head}***@${domain}`;
};

const upsertUserAppHistory = async (email, apps = []) => {
    if (!email) return;
    const key = emailKey(email);
    let existing = {};
    try {
        const content = await fs.readFile(APP_HISTORY_FILE, 'utf8');
        existing = JSON.parse(content);
    } catch (_) {
        existing = {};
    }

    existing[key] = {
        updatedAt: new Date().toISOString(),
        latestAppId: apps?.[0]?.appId || null,
        apps: apps.slice(0, 50)
    };

    await fs.writeFile(APP_HISTORY_FILE, JSON.stringify(existing, null, 2), 'utf8');
};

const normalizeAttachments = (items = []) => {
    if (!Array.isArray(items)) return [];
    let totalBytes = 0;
    return items
        .slice(0, MAX_ATTACHMENTS)
        .map((item) => {
            const mimeType = String(item?.mimeType || item?.type || '').toLowerCase().trim();
            const dataBase64 = typeof item?.dataBase64 === 'string' ? item.dataBase64.trim() : '';
            if (!mimeType || !dataBase64) return null;
            const isMedia = mimeType.startsWith('image/') || mimeType.startsWith('video/');
            const isDoc = EXTRA_DOC_MIME_TYPES.has(mimeType);
            if (!isMedia && !isDoc) return null;

            const bytes = Math.floor((dataBase64.length * 3) / 4);
            if (bytes > MAX_ATTACHMENT_SIZE_BYTES) {
                throw new Error(`Attachment too large: ${item?.name || 'file'} (${Math.round(bytes / (1024 * 1024))}MB)`);
            }
            totalBytes += bytes;
            if (totalBytes > MAX_TOTAL_ATTACHMENTS_BYTES) {
                throw new Error(`Attachments total size exceeded (${Math.round(totalBytes / (1024 * 1024))}MB). Max total is ${Math.round(MAX_TOTAL_ATTACHMENTS_BYTES / (1024 * 1024))}MB.`);
            }

            return {
                name: item?.name || 'attachment',
                mimeType,
                dataBase64
            };
        })
        .filter(Boolean);
};

const buildAttachmentSummary = (attachments = []) => {
    if (!attachments.length) return '';
    const lines = attachments.map((a, idx) => `- ${idx + 1}. ${a.name} (${a.mimeType})`);
    return `\n\nAttached files:\n${lines.join('\n')}\nUse attached media/spec context when answering.`;
};

const isAttachmentValidationError = (message = '') => {
    const m = String(message || '').toLowerCase();
    return (
        m.includes('attachment too large') ||
        m.includes('attachments total size exceeded') ||
        m.includes('unsupported attachment') ||
        m.includes('invalid attachment') ||
        m.includes('malformed attachment')
    );
};

export const chat = async (req, res) => {
    let heartbeatTimer = null;
    const stopHeartbeat = () => {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    };

    try {
        const { message, history, stream, credentials, attachments, templateContext, preferredWorkspace, conversationId } = req.body;
        const media = normalizeAttachments(attachments || []);
        const resolvePhase0 = async () => {
            const heuristic = phase0RoutingService.interpret({ message, history: history || [] });
            let llmDecision = null;
            let llmRaw = "";
            if (phase0RoutingService.needsLlmRouting(heuristic)) {
                try {
                    const prompt = phase0RoutingService.buildRouterPrompt({
                        message,
                        history: history || [],
                        heuristic
                    });
                    llmRaw = await geminiService.generateResponse(prompt, [], "PHASE0_ROUTER");
                    llmDecision = phase0RoutingService.parseLlmDecision(llmRaw);
                } catch (e) {
                    logger.warn(`Phase-0 LLM router failed, fallback to heuristic: ${e?.message || e}`);
                }
            }
            const decision = phase0RoutingService.resolveDecision(heuristic, llmDecision);
            decision.heuristic = heuristic;
            if (llmDecision) decision.llm = llmDecision;
            if (llmRaw && !llmDecision) decision.llmParseFailed = true;
            return decision;
        };

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        // If streaming is requested (Dashboard uses streaming)
        const useStream = stream !== false;
        if (useStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            let lastActivityAt = Date.now();
            const writeEvent = (payload = {}, { touch = true } = {}) => {
                if (res.writableEnded || res.destroyed) return;
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
                if (touch) lastActivityAt = Date.now();
            };
            const emitWorkingSignal = (state = 'busy', phase = 'processing', detail = '') => {
                writeEvent({
                    type: 'signal',
                    signal: 'agent_working',
                    state,
                    phase,
                    icon: state === 'busy' ? 'spinner' : 'check',
                    detail
                }, { touch: false });
            };

            emitWorkingSignal('busy', 'phase0', 'Routing request');
            heartbeatTimer = setInterval(() => {
                if (res.writableEnded || res.destroyed) return;
                const idleSec = Math.floor((Date.now() - lastActivityAt) / 1000);
                let content = 'Agent is still working...';
                if (idleSec >= 45) content = `Still working... no new output for ${idleSec}s`;
                if (idleSec >= 180) content = `Long-running task in progress (${idleSec}s). I will continue and report if stalled.`;
                writeEvent({ type: 'status', content }, { touch: false });
                emitWorkingSignal('busy', 'execution', `idle_seconds:${idleSec}`);
            }, 8000);

            if (isLatestAppQuery(message)) {
                if (!credentials?.email || !credentials?.password) {
                    writeEvent({ type: 'action', action: 'require_credentials' });
                    writeEvent({
                        type: 'text',
                        content: 'I need your VIVERSE account credentials to verify and list only your own app IDs.'
                    });
                    emitWorkingSignal('idle', 'done', 'credentials_required');
                    res.write('data: [DONE]\n\n');
                    stopHeartbeat();
                    return res.end();
                }

                writeEvent({ type: 'status', content: 'Verifying account and listing your apps...' });
                emitWorkingSignal('busy', 'account_lookup', 'listing_apps');
                lastActivityAt = Date.now();
                const result = await fileService.listUserApps(credentials, 50);
                await upsertUserAppHistory(credentials.email, result.apps);
                lastActivityAt = Date.now();

                if (!result.latest) {
                    writeEvent({
                        type: 'text',
                        content: `No apps found for ${maskEmail(credentials.email)}.`
                    });
                    emitWorkingSignal('idle', 'done', 'apps_lookup_completed');
                    res.write('data: [DONE]\n\n');
                    stopHeartbeat();
                    return res.end();
                }

                const lines = [
                    `Latest app for ${maskEmail(credentials.email)}:`,
                    `- App ID: \`${result.latest.appId}\``,
                    `- Title: ${result.latest.title}`,
                    `- State: ${result.latest.state}`,
                    `- URL: ${result.latest.url}`
                ];

                if (result.apps.length > 1) {
                    lines.push('', 'Other recent app IDs:');
                    for (const app of result.apps.slice(1, 6)) {
                        lines.push(`- \`${app.appId}\` (${app.title})`);
                    }
                }

                writeEvent({ type: 'text', content: lines.join('\n') });
                emitWorkingSignal('idle', 'done', 'apps_lookup_completed');
                res.write('data: [DONE]\n\n');
                stopHeartbeat();
                return res.end();
            }

            emitWorkingSignal('busy', 'phase0', 'heuristic_routing');
            const preliminary = phase0RoutingService.interpret({ message, history: history || [] });
            if (phase0RoutingService.needsLlmRouting(preliminary)) {
                writeEvent({ type: 'status', content: 'Phase-0 ambiguity detected. Running LLM router...' });
                emitWorkingSignal('busy', 'phase0_llm_router', 'resolving_ambiguity');
            }
            const phase0 = await resolvePhase0();
            const isGeneral = phase0.targetAgent === 'GENERAL' || phase0.route === 'GENERAL';
            writeEvent({
                type: 'status',
                content: `Phase-0 routed to ${phase0.targetAgent} (${phase0.phase0Mode}; intent=${phase0.intentType}; source=${phase0.decisionSource}; confidence=${Number(phase0.confidence || 0).toFixed(2)}; reason=${phase0.reason}).`
            });
            emitWorkingSignal('busy', 'phase0', `route:${phase0.route}|target:${phase0.targetAgent}`);

            if (phase0.intentType === 'STATUS_QUERY') {
                writeEvent({ type: 'status', content: 'Returning workflow status (read-only).' });
                emitWorkingSignal('busy', 'workflow_status', 'read_only_status_query');
                const status = await workflowStateService.getWorkflowStatus(message, history || [], credentials || null);
                writeEvent({ type: 'text', content: status.text });
                emitWorkingSignal('idle', 'done', 'status_query_completed');
                res.write('data: [DONE]\n\n');
                stopHeartbeat();
                return res.end();
            }

            let responseStream;
            if (isGeneral) {
                writeEvent({ type: 'status', content: 'Answering general question...' });
                emitWorkingSignal('busy', 'general_worker', 'responding');
                responseStream = geminiService.generateResponseStream(message, history || [], "GENERAL", null, media);
            } else {
                const enrichedMessage = `${message}${buildAttachmentSummary(media)}`;
                emitWorkingSignal('busy', 'orchestrator', phase0.phase0Mode);
                responseStream = orchestratorService.processRequest(enrichedMessage, history || [], credentials, media, { phase0Mode: phase0.phase0Mode, templateContext: templateContext || null, preferredWorkspace: preferredWorkspace || null, conversationId: conversationId || null });
            }

            for await (const chunk of responseStream) {
                writeEvent(chunk);
                lastActivityAt = Date.now();
            }

            emitWorkingSignal('idle', 'done', 'response_completed');
            res.write('data: [DONE]\n\n');
            stopHeartbeat();
            return res.end();
        }

        const phase0 = await resolvePhase0();
        if (phase0.intentType === 'STATUS_QUERY') {
            const status = await workflowStateService.getWorkflowStatus(message, history || [], credentials || null);
            return res.status(200).json({
                success: true,
                reply: status.text,
                response: status.text,
                phase0,
                workflowStatus: status
            });
        }
        const roleKey = phase0.targetAgent === 'GENERAL' ? 'GENERAL' : 'ORCHESTRATOR';
        const response = await geminiService.generateResponse(message, history || [], roleKey, null, media);

        res.status(200).json({
            success: true,
            reply: response,
            response: response,
            phase0
        });
    } catch (error) {
        stopHeartbeat();
        logger.error(`AI Controller Error: ${error.message}\n${error.stack}`);
        const msg = String(error?.message || '');
        const isAttachmentError = isAttachmentValidationError(msg);
        const isRateLimit = msg.includes('429') || msg.toLowerCase().includes('quota exceeded') || msg.toLowerCase().includes('too many requests');
        const retryHint = msg.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s?/i);
        const waitText = retryHint ? ` Please retry in about ${Math.ceil(Number(retryHint[1]))} seconds.` : '';
        const friendlyAttachmentError = msg || 'Invalid attachments payload.';
        
        if (!res.headersSent) {
            res.status(isAttachmentError ? 400 : 500).json({
                success: false,
                error: isAttachmentError
                    ? friendlyAttachmentError
                    : isRateLimit
                    ? `Gemini API quota/rate limit reached.${waitText}`
                    : 'An error occurred while processing your request'
            });
        } else {
            const content = isAttachmentError
                ? friendlyAttachmentError
                : isRateLimit
                ? `Gemini API quota/rate limit reached.${waitText}`
                : error.message;
            res.write(`data: ${JSON.stringify({ type: 'error', content })}\n\n`);
            res.end();
        }
    } finally {
        stopHeartbeat();
    }
};

export const healthCheck = (req, res) => {
    res.status(200).json({ status: 'AI Service is online' });
};

export const searchRooms = async (req, res) => {
    const q = String(req.query.q || '').trim();
    const sort = String(req.query.sort || 'most_viewed');
    const limit = Math.min(parseInt(req.query.limit) || 20, 40);
    if (!q) return res.status(400).json({ success: false, error: 'q is required' });
    try {
        const data = await searchService.searchRooms({ q, sort, limit });
        const rooms = (data?.results || []).map(r => ({
            id:          r.hub_sid || r.id,
            name:        r.name || r.title || 'Untitled',
            description: r.description || '',
            thumbnail:   r.thumbnail_url || r.thumbnail || null,
            world_url:   r.world_url || null,
            hub_sid:     r.hub_sid || null,
        }));
        res.json({ success: true, count: rooms.length, rooms, cursor: data?.cursor || null });
    } catch (error) {
        logger.error(`searchRooms failed: ${error.message}`);
        res.status(502).json({ success: false, error: error.message });
    }
};

export const listTemplates = async (req, res) => {
    try {
        let templates = await templateRegistryService.listTemplates();
        if (!templates.length) {
            templates = TEMPLATE_CATALOG_FALLBACK;
        }
        const normalized = templates.map((item) => ({
            id: item.id,
            name: item.name,
            version: item.version,
            genre: item.genre,
            description: item.description,
            tags: item.tags,
            capabilities: item.capabilities,
            status: item.status || 'active',
            thumbnail: item.thumbnail ?? null,
            demoPlayLink: item.demoPlayLink ?? null,
            demoAppId: item.demoAppId ?? null,
            ...(item.cta != null ? { cta: item.cta } : {}),
            ...(Array.isArray(item.utilityCtaExamples) ? { utilityCtaExamples: item.utilityCtaExamples } : {})
        }));

        res.status(200).json({
            success: true,
            count: normalized.length,
            templates: normalized,
            source: templates === TEMPLATE_CATALOG_FALLBACK ? 'fallback' : 'registry'
        });
    } catch (error) {
        logger.error(`listTemplates failed: ${error.message}`);
        res.status(500).json({ success: false, error: 'Failed to load templates' });
    }
};

export const getTemplateById = async (req, res) => {
    const templateId = String(req.params?.templateId || '').trim().toLowerCase();
    if (!templateId) {
        return res.status(400).json({ success: false, error: 'templateId is required' });
    }
    let found = await templateRegistryService.getTemplateById(templateId);
    if (!found) {
        found = TEMPLATE_CATALOG_FALLBACK.find((item) => item.id.toLowerCase() === templateId) || null;
    }
    if (!found) {
        return res.status(404).json({ success: false, error: `Template not found: ${templateId}` });
    }

    let contractSummary = null;
    if (found?.templatePath) {
        const absoluteTemplatePath = path.resolve(process.cwd(), found.templatePath);
        const loaded = await templateContractService.loadTemplateContract(absoluteTemplatePath);
        if (loaded?.contract) {
            const c = loaded.contract;
            contractSummary = {
                id: c.id,
                version: c.version,
                immutablePathsCount: c.immutablePaths.length,
                editablePathsCount: c.editablePaths.length,
                requiredGates: c.requiredGates
            };
        }
    }
    return res.status(200).json({ success: true, template: found, contractSummary });
};

// ── Workspace registry handlers ────────────────────────────────────────

export const listWorkspaces = async (req, res) => {
    try {
        const entries = await workspaceRegistryService.list(WORKSPACE_DIR);
        return res.status(200).json({ success: true, count: entries.length, workspaces: entries });
    } catch (err) {
        logger.error(`listWorkspaces failed: ${err.message}`);
        return res.status(500).json({ success: false, error: 'Failed to list workspaces' });
    }
};

export const getWorkspace = async (req, res) => {
    const reqId = String(req.params?.reqId || '').trim();
    if (!reqId) return res.status(400).json({ success: false, error: 'reqId is required' });
    try {
        const entry = await workspaceRegistryService.get(WORKSPACE_DIR, reqId);
        if (!entry) return res.status(404).json({ success: false, error: `Workspace not found: ${reqId}` });
        return res.status(200).json({ success: true, workspace: entry });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
};

export const saveWorkspace = async (req, res) => {
    // POST /api/ai/workspaces/:reqId/save  { label? }
    const reqId = String(req.params?.reqId || '').trim();
    const label = String(req.body?.label || '').trim();
    if (!reqId) return res.status(400).json({ success: false, error: 'reqId is required' });

    try {
        // If a label is provided, just relabel an existing entry
        const existing = await workspaceRegistryService.get(WORKSPACE_DIR, reqId);
        if (existing && label) {
            const updated = await workspaceRegistryService.relabel(WORKSPACE_DIR, reqId, label);
            return res.status(200).json({ success: true, workspace: updated });
        }

        // Otherwise load the state and register it
        const statePath = path.join(WORKSPACE_DIR, reqId, '.agent_state.json');
        let state;
        try {
            state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        } catch {
            return res.status(404).json({ success: false, error: `Workspace state not found: ${reqId}` });
        }
        const entry = await workspaceRegistryService.register(WORKSPACE_DIR, state, { label });
        if (!entry) return res.status(400).json({ success: false, error: 'Could not register workspace — invalid reqId format' });
        return res.status(200).json({ success: true, workspace: entry });
    } catch (err) {
        logger.error(`saveWorkspace failed: ${err.message}`);
        return res.status(500).json({ success: false, error: err.message });
    }
};

export const unsaveWorkspace = async (req, res) => {
    // DELETE /api/ai/workspaces/:reqId
    const reqId = String(req.params?.reqId || '').trim();
    if (!reqId) return res.status(400).json({ success: false, error: 'reqId is required' });
    try {
        const removed = await workspaceRegistryService.unregister(WORKSPACE_DIR, reqId);
        if (!removed) return res.status(404).json({ success: false, error: `Not in registry: ${reqId}` });
        return res.status(200).json({ success: true, removed });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
};

// ── Agent memory handlers ──────────────────────────────────────────────

export const getMemory = async (req, res) => {
    try {
        const data = await agentMemoryService.list();
        return res.status(200).json({ success: true, memory: data });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
};

export const addMemoryNote = async (req, res) => {
    const text   = String(req.body?.text   || '').trim();
    const target = String(req.body?.target || 'notes');
    if (!text) return res.status(400).json({ success: false, error: 'text is required' });
    try {
        if (target === 'profile') {
            await agentMemoryService.upsertProfile(text);
        } else {
            await agentMemoryService.addNote(text);
        }
        const data = await agentMemoryService.list();
        return res.status(200).json({ success: true, memory: data });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
};

export const clearMemory = async (req, res) => {
    const target = String(req.params?.target || 'all');
    if (!['all', 'notes', 'profile'].includes(target)) {
        return res.status(400).json({ success: false, error: 'target must be all, notes, or profile' });
    }
    try {
        await agentMemoryService.clear(target);
        return res.status(200).json({ success: true, cleared: target });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
};
