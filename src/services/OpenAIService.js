/**
 * OpenAIService.js
 *
 * Drop-in replacement for GeminiService. Exposes the same public interface:
 *   generateResponse(message, history, roleKey, workspacePath, attachments)
 *   generateResponseStream(message, history, roleKey, workspacePath, attachments)
 *   refreshKnowledge()
 *   getModelForRole(roleKey)
 *
 * Configure via .env:
 *   OPENAI_API_KEY=sk-...
 *   OPENAI_MODEL_PRO=codex-1          (or gpt-4.1)
 *   OPENAI_MODEL_FLASH=gpt-4.1-mini
 */

import OpenAI from 'openai';
import { AzureOpenAI } from 'openai';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import fileService from './FileService.js';
import searchService from './SearchService.js';
import AgentRegistry from './AgentRegistry.js';
import agentMemoryService from './AgentMemoryService.js';
import skillProvider from './SkillProvider.js';
import skillLedgerService from './SkillLedgerService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert Gemini-style UPPER_CASE type strings to JSON Schema lowercase. */
function _normalizeType(t = '') {
    return String(t).toLowerCase();
}

/** Recursively normalise a Gemini parameter schema to JSON Schema. */
function _normalizeSchema(schema = {}) {
    if (!schema || typeof schema !== 'object') return schema;
    const out = { ...schema };
    if (out.type) out.type = _normalizeType(out.type);
    if (out.properties) {
        const props = {};
        for (const [k, v] of Object.entries(out.properties)) {
            props[k] = _normalizeSchema(v);
        }
        out.properties = props;
    }
    if (out.items) out.items = _normalizeSchema(out.items);
    return out;
}

/** Convert the allToolDeclarations map to the OpenAI tools array format. */
function _toOpenAITools(declarations = []) {
    return declarations.map((decl) => ({
        type: 'function',
        function: {
            name: decl.name,
            description: decl.description || '',
            parameters: decl.parameters ? _normalizeSchema(decl.parameters) : { type: 'object', properties: {} }
        }
    }));
}

// ---------------------------------------------------------------------------
// OpenAIService
// ---------------------------------------------------------------------------

class OpenAIService {
    constructor() {
        // --- Auth mode detection (priority order) ---
        // 1. Flat AZURE_OPENAI_* vars (preferred — works with Azure portal format)
        // 2. OPENAI_API_KEY as JSON string (legacy single-model format)
        // 3. OPENAI_API_KEY as plain sk-... string (standard OpenAI)

        const azureEndpoint   = process.env.AZURE_OPENAI_ENDPOINT || '';
        const azureKey        = process.env.AZURE_OPENAI_KEY || '';
        const azureVersion    = process.env.AZURE_OPENAI_VERSION || '2025-04-01-preview';

        if (azureEndpoint && azureKey) {
            // Mode 1: flat Azure vars — deployment resolved per-role at call time
            this.client = new AzureOpenAI({
                apiKey: azureKey,
                endpoint: azureEndpoint,
                apiVersion: azureVersion
            });
            this.azureMode = true;
            logger.info('OpenAIService: Initialized in Azure OpenAI mode (flat env vars).');
        } else {
            const rawKey = process.env.OPENAI_API_KEY || '';
            let azureConfig = null;
            if (rawKey.trim().startsWith('{')) {
                try {
                    azureConfig = JSON.parse(rawKey);
                } catch {
                    logger.warn('OpenAIService: OPENAI_API_KEY looks like JSON but failed to parse — treating as plain key.');
                }
            }

            if (azureConfig) {
                // Mode 2: legacy JSON format with flat fields
                const { api_key, endpoint, deployment, api_version } = azureConfig;
                if (!api_key || !endpoint) {
                    logger.error('OpenAIService: Azure JSON key is missing required fields: api_key, endpoint');
                }
                this.client = (api_key && endpoint)
                    ? new AzureOpenAI({ apiKey: api_key, endpoint, apiVersion: api_version || '2024-02-01', deployment })
                    : null;
                this.azureMode = true;
                logger.info('OpenAIService: Initialized in Azure OpenAI mode (JSON key).');
            } else {
                // Mode 3: standard OpenAI
                if (!rawKey) logger.error('OpenAIService: OPENAI_API_KEY is not defined in environment variables');
                this.client = rawKey ? new OpenAI({ apiKey: rawKey }) : null;
                this.azureMode = false;
                logger.info('OpenAIService: Initialized.');
            }
        }

        this.skillsSummary = '';
        this.memoryBlock = '';
        this.models = {};
        this.commandConvergence = new Map();

        // Knowledge base context (same as GeminiService)
        this.viverseKnowledge = `VIVERSE PLATFORM CONTEXT:
- SDK Pattern: The VIVERSE SDK is UMD-based and resides in 'window.viverse' or 'window.VIVERSE_SDK'. It is NOT in npm.
- Docs: Use 'readDoc' to fetch technical details if you are unsure of an API signature.

Available Documentation (Use 'readDoc' to read):
- viverse_sdk_docs.md: Comprehensive guide to the UMD namespace, featuring API blueprints for Auth, Avatar, Matchmaking, and Leaderboards.
- developer_tools.md: High-level map of SDK components and their corresponding roles in a project.
- skills-guide.md: Instructions for leveraging pre-built patterns and custom knowledge modules.
- usage.md: Server-level documentation for running and prompts for the Antigravity agent.`;

        // Tool declarations (identical to GeminiService, types normalised at call time)
        this.allToolDeclarations = {
            readFile: {
                name: 'readFile',
                description: 'Read the content of a file from the workspace.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        filePath: { type: 'STRING', description: "Path to the file relative to the project root (e.g., 'voxel_landmark/src/App.jsx')" }
                    },
                    required: ['filePath']
                }
            },
            writeFile: {
                name: 'writeFile',
                description: 'Write content to a file in the workspace.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        filePath: { type: 'STRING', description: 'Path to the file relative to the project root' },
                        content: { type: 'STRING', description: 'The content to write to the file' }
                    },
                    required: ['filePath', 'content']
                }
            },
            listFiles: {
                name: 'listFiles',
                description: 'List files and directories in a given path.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        dirPath: { type: 'STRING', description: "Directory path relative to project root (default: '.')" }
                    }
                }
            },
            discoverProject: {
                name: 'discoverProject',
                description: 'Search for important project files (like App.jsx, package.json) to understand project type.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        projectName: { type: 'STRING', description: "The name of the project folder to search in (e.g., 'voxel_landmark')" }
                    },
                    required: ['projectName']
                }
            },
            runCommand: {
                name: 'runCommand',
                description: 'Execute a shell command in the project workspace.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        command: { type: 'STRING', description: 'The shell command to execute.' },
                        cwd: { type: 'STRING', description: 'The directory to run the command in (relative to project root).' }
                    },
                    required: ['command']
                }
            },
            runBackgroundCommand: {
                name: 'runBackgroundCommand',
                description: 'Execute a long-running shell command in the background and return a job ID.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        command: { type: 'STRING', description: 'The shell command to execute in background.' },
                        cwd: { type: 'STRING', description: 'The directory to run the command in.' }
                    },
                    required: ['command']
                }
            },
            checkCommandStatus: {
                name: 'checkCommandStatus',
                description: 'Check the status and output of a background command by job ID.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        jobId: { type: 'STRING', description: 'The job ID returned by runBackgroundCommand.' },
                        cwd: { type: 'STRING', description: 'The working directory.' }
                    },
                    required: ['jobId']
                }
            },
            searchRooms: {
                name: 'searchRooms',
                description: 'Search for rooms, worlds, or spaces in VIVERSE by keyword, tags, or popularity.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        q: { type: 'STRING', description: "The search keyword (Optional: defaults to 'world' if omitted or empty)." },
                        sort: { type: 'STRING', description: "Sort criteria: 'most_viewed', 'most_liked', 'create_date', 'first_public_date'." },
                        tag: { type: 'STRING', description: "Filter by tags (comma-separated, e.g., 'art,hangout')." },
                        device: { type: 'STRING', description: "Filter by device: 'desktop', 'mobile', or 'vr'." },
                        limit: { type: 'NUMBER', description: 'Number of results to return (default: 10).' }
                    }
                }
            },
            showRooms: {
                name: 'showRooms',
                description: 'Display a filtered list of VIVERSE rooms in the gallery UI. Call this after searchRooms with ONLY the rooms genuinely relevant to the user request.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        rooms: {
                            type: 'ARRAY',
                            description: 'The relevant rooms to display.',
                            items: {
                                type: 'OBJECT',
                                properties: {
                                    hub_sid: { type: 'STRING', description: 'Room hub_sid (URL slug).' },
                                    title: { type: 'STRING', description: 'Room title.' },
                                    image: { type: 'STRING', description: 'Thumbnail image URL.' },
                                    description: { type: 'STRING', description: 'Room description.' }
                                },
                                required: ['hub_sid', 'title']
                            }
                        },
                        query: { type: 'STRING', description: 'The original search query for display.' }
                    },
                    required: ['rooms']
                }
            },
            readDoc: {
                name: 'readDoc',
                description: 'Read a documentation file from the VIVERSE knowledge base.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        fileName: { type: 'STRING', description: "Name of the markdown file (e.g., 'viverse_sdk_docs.md')" }
                    },
                    required: ['fileName']
                }
            },
            loadSkill: {
                name: 'loadSkill',
                description: 'Load a specific pattern or example file from a VIVERSE skill.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        skillName: { type: 'STRING', description: 'Name of the skill folder' },
                        fileName: { type: 'STRING', description: 'Relative path within the skill' }
                    },
                    required: ['skillName', 'fileName']
                }
            },
            addLesson: {
                name: 'addLesson',
                description: "Record a learned lesson into the project's persistent memory to avoid repeating mistakes.",
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        lesson: { type: 'STRING', description: 'The concise lesson describing the fix or best practice (max 200 chars).' }
                    },
                    required: ['lesson']
                }
            }
        };

        this.refreshKnowledge();
        logger.info('OpenAIService: Initialized.');
    }

    // -------------------------------------------------------------------------
    // Convergence guards (identical logic to GeminiService)
    // -------------------------------------------------------------------------

    _workspaceConvergenceState(workspacePath = null) {
        const key = workspacePath || '__global__';
        if (!this.commandConvergence.has(key)) {
            this.commandConvergence.set(key, {
                mutationVersion: 0,
                byClass: {},
                byToolArg: {},
                addLessonCount: 0,
                runCommandCount: 0,
                runCommandCountThisMutation: 0,
                lastRunCommandMutationVersion: -1,
                distGrepCount: 0,
                lastDistGrepMutationVersion: -1
            });
        }
        return this.commandConvergence.get(key);
    }

    _resetTurnCounters(workspacePath = null) {
        const state = this._workspaceConvergenceState(workspacePath);
        state.addLessonCount = 0;
        state.runCommandCount = 0;
        state.distGrepCount = 0;
        state.runCommandCountThisMutation = 0;
    }

    _normalizeToolArgSignature(name = '', args = {}) {
        if (name === 'readFile') return String(args?.filePath || '');
        if (name === 'listFiles') return String(args?.dirPath || '.');
        if (name === 'runCommand') return `${String(args?.cwd || '.')}\n${String(args?.command || '')}`;
        return '';
    }

    _hitRepeatedToolArgGuard(workspacePath, name, args, maxRepeats = 8) {
        const argSig = this._normalizeToolArgSignature(name, args);
        if (!argSig) return { blocked: false, repeats: 0 };
        const state = this._workspaceConvergenceState(workspacePath);
        const key = `${name}::${argSig}`;
        const mv = Number(state.mutationVersion || 0);
        const rec = state.byToolArg[key] || { repeats: 0, lastMutationVersion: -1 };
        if (rec.lastMutationVersion === mv) rec.repeats += 1;
        else rec.repeats = 1;
        rec.lastMutationVersion = mv;
        state.byToolArg[key] = rec;
        return { blocked: rec.repeats > maxRepeats, repeats: rec.repeats };
    }

    _bumpMutationVersion(workspacePath = null) {
        this._workspaceConvergenceState(workspacePath).mutationVersion += 1;
    }

    _classifyCommand(command = '') {
        const cmd = String(command || '').toLowerCase();
        if (!cmd.trim()) return '';
        if (/(^|\s)grep(\s|$)/.test(cmd) && /\bdist\b/.test(cmd)) return 'dist_appid_check';
        if (/npm\s+run\s+build/.test(cmd)) return 'build';
        return '';
    }

    _outputSignature(toolResult) {
        if (!toolResult || typeof toolResult !== 'object') return String(toolResult || '');
        return JSON.stringify({
            error: String(toolResult.error || ''),
            stdout: String(toolResult.stdout || '').slice(0, 400),
            stderr: String(toolResult.stderr || '').slice(0, 400)
        });
    }

    _truncateText(value = '', maxChars = 16000) {
        const text = String(value ?? '');
        if (text.length <= maxChars) return text;
        return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
    }

    _sanitizeToolResultForModel(toolName = '', toolResult = null) {
        const MAX_TEXT = 16000;
        const MAX_JSON = 120000;
        let out = toolResult;
        if (typeof out === 'string') {
            out = this._truncateText(out, MAX_TEXT);
        } else if (Array.isArray(out)) {
            out = out.slice(0, 200);
        } else if (out && typeof out === 'object') {
            const copy = { ...out };
            if (typeof copy.stdout === 'string') copy.stdout = this._truncateText(copy.stdout, MAX_TEXT);
            if (typeof copy.stderr === 'string') copy.stderr = this._truncateText(copy.stderr, MAX_TEXT);
            if (typeof copy.error === 'string') copy.error = this._truncateText(copy.error, 4000);
            out = copy;
        }
        if (['readFile', 'readDoc', 'loadSkill'].includes(toolName)) {
            if (typeof out === 'string') out = this._truncateText(out, 24000);
            else if (out && typeof out === 'object') {
                for (const k of Object.keys(out)) {
                    if (typeof out[k] === 'string') out[k] = this._truncateText(out[k], 24000);
                }
            }
        }
        try {
            const encoded = JSON.stringify(out);
            if (encoded && encoded.length > MAX_JSON) {
                return { truncated: true, tool: toolName, note: `Tool result exceeded ${MAX_JSON} chars and was compacted.`, preview: this._truncateText(encoded, 24000) };
            }
        } catch (_) {
            return this._truncateText(String(out ?? ''), 24000);
        }
        return out;
    }

    // -------------------------------------------------------------------------
    // Rate-limit / transient error handling
    // -------------------------------------------------------------------------

    _isRateLimitError(error) {
        const msg = String(error?.message || error || '');
        const code = error?.status || error?.code;
        return code === 429 || msg.includes('429') || msg.toLowerCase().includes('quota exceeded') || msg.toLowerCase().includes('too many requests');
    }

    _isTransientInfraError(error) {
        const msg = String(error?.message || error || '').toLowerCase();
        const code = Number(error?.status || error?.code || 0);
        if (code >= 500 && code <= 599) return true;
        return (
            msg.includes('service unavailable') ||
            msg.includes('upstream connect error') ||
            msg.includes('gateway timeout') ||
            msg.includes('bad gateway') ||
            msg.includes('etimedout') ||
            msg.includes('econnreset') ||
            msg.includes('socket hang up') ||
            msg.includes('fetch failed') ||
            msg.includes('network error') ||
            msg.includes('temporarily unavailable')
        );
    }

    _isRetryable(error) {
        return this._isRateLimitError(error) || this._isTransientInfraError(error);
    }

    _retryDelayMs(error, attempt = 1) {
        const msg = String(error?.message || error || '');
        const fromRetryAfter = msg.match(/retry after (\d+)/i);
        if (fromRetryAfter) return Number(fromRetryAfter[1]) * 1000 + 250;
        const isRate = this._isRateLimitError(error);
        const base = isRate ? Math.min(120000, 15000 * attempt) : Math.min(30000, 2000 * Math.pow(2, Math.max(0, attempt - 1)));
        return base + Math.floor(Math.random() * 500);
    }

    async _withRetry(fn, label = 'openai_call', maxRetries = 5) {
        let attempt = 0;
        while (true) {
            attempt += 1;
            try {
                return await fn();
            } catch (error) {
                if (!this._isRetryable(error) || attempt > maxRetries) throw error;
                const delay = this._retryDelayMs(error, attempt);
                const kind = this._isRateLimitError(error) ? 'rate limit' : 'transient error';
                logger.warn(`OpenAIService: ${label} hit ${kind} (attempt ${attempt}). Retrying in ${delay}ms`);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }

    // -------------------------------------------------------------------------
    // Knowledge / skill refresh
    // -------------------------------------------------------------------------

    async refreshKnowledge() {
        logger.info('OpenAIService: Refreshing dynamic knowledge base...');
        try {
            const skillsDir = skillProvider.getSkillsDir();
            const items = await fs.promises.readdir(skillsDir, { withFileTypes: true });
            let summary = "Available Skills (Use 'loadSkill' to read full details):\n";
            for (const item of items) {
                if (item.isDirectory()) {
                    const skillPath = path.join(skillsDir, item.name, 'SKILL.md');
                    if (fs.existsSync(skillPath)) {
                        let description = '';
                        try {
                            const raw = fs.readFileSync(skillPath, 'utf8');
                            const fmDesc = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim();
                            const body = raw.split('\n').filter((l) => {
                                const t = l.trim();
                                return t && !t.startsWith('#') && !t.startsWith('---') &&
                                    !t.startsWith('name:') && !t.startsWith('version:') &&
                                    !t.startsWith('description:') && !t.startsWith('tags:');
                            });
                            description = fmDesc || (body[0] || '').slice(0, 110);
                        } catch { /* skip */ }
                        summary += description ? `- ${item.name}: ${description}\n` : `- ${item.name}\n`;
                    }
                }
            }
            const guidePath = path.join(skillsDir, 'viverse-resilience-guide.md');
            if (fs.existsSync(guidePath)) {
                summary += `\n[MANDATORY RESILIENCE GATES - v2.0 Hardened]\n${fs.readFileSync(guidePath, 'utf8')}\n`;
            }
            this.skillsSummary = summary;
            this.models = {};
            try {
                this.memoryBlock = await agentMemoryService.getSystemPromptBlock();
            } catch (e) {
                this.memoryBlock = '';
                logger.warn(`OpenAIService: memory load failed: ${e.message}`);
            }
            logger.info('OpenAIService: Knowledge refreshed.');
        } catch (e) {
            logger.error(`OpenAIService: Failed to refresh knowledge: ${e.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // Model / role config
    // -------------------------------------------------------------------------

    getModelForRole(roleKey = 'ORCHESTRATOR') {
        if (this.models[roleKey]) return this.models[roleKey];
        const config = AgentRegistry[roleKey] || AgentRegistry.ORCHESTRATOR;
        const MODEL_PRO   = process.env.OPENAI_MODEL_PRO   || 'gpt-5.4';
        const MODEL_FLASH = process.env.OPENAI_MODEL_FLASH || 'gpt-5.4-mini';
        // In Azure mode, OPENAI_MODEL_PRO/FLASH are used as the deployment names
        const modelName = config.tier === 'pro' ? MODEL_PRO : MODEL_FLASH;
        const roleToolDecls = config.tools.map((t) => this.allToolDeclarations[t]).filter(Boolean);
        // PHASE0_ROUTER and GENERAL are lightweight roles — skip skills/memory bloat
        // to keep token count minimal and avoid TPM rate limits.
        const isLightweightRole = roleKey === 'PHASE0_ROUTER' || roleKey === 'GENERAL';
        const systemPrompt = isLightweightRole
            ? config.systemInstruction
            : `${config.systemInstruction}\n\n[RESILIENCE_GATES]\n${this.skillsSummary}` +
              (this.memoryBlock ? `\n\n${this.memoryBlock}` : '');
        const cached = { modelName, tools: _toOpenAITools(roleToolDecls), systemPrompt, roleKey };
        this.models[roleKey] = cached;
        return cached;
    }

    // -------------------------------------------------------------------------
    // History normalisation  (Gemini format → OpenAI messages)
    // -------------------------------------------------------------------------

    _normalizeHistory(history = []) {
        if (!Array.isArray(history)) return [];
        const MAX_TURNS = 50;
        const recent = history.length > MAX_TURNS ? history.slice(-MAX_TURNS) : history;
        const messages = [];
        for (const turn of recent) {
            const role = ['model', 'assistant'].includes(turn.role) ? 'assistant' : 'user';
            // Extract plain text from Gemini-style parts
            const parts = turn.parts || [];
            const text = parts
                .filter((p) => typeof p?.text === 'string')
                .map((p) => p.text)
                .join('');
            if (text) messages.push({ role, content: text });
        }
        return messages;
    }

    /** Build user message content array, including any attachments. */
    _buildUserContent(message, attachments = []) {
        const textPart = { type: 'text', text: String(message || '') };
        const content = [textPart];
        for (const file of (attachments || [])) {
            const mime = String(file?.mimeType || file?.type || '').toLowerCase();
            const data = String(file?.dataBase64 || '');
            if (!mime || !data) continue;
            if (mime.startsWith('image/')) {
                content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } });
            } else {
                // Text/doc attachments — inline as text
                try {
                    const text = Buffer.from(data, 'base64').toString('utf8');
                    const trimmed = text.length > 50000 ? `${text.slice(0, 50000)}\n...[truncated]` : text;
                    content.push({ type: 'text', text: `\n[ATTACHED: ${file.name || mime}]\n${trimmed}\n[END ATTACHED]\n` });
                } catch (_) { /* skip undecodable */ }
            }
        }
        return content;
    }

    // -------------------------------------------------------------------------
    // Tool execution (shared between streaming and non-streaming loops)
    // -------------------------------------------------------------------------

    async _executeToolCall(toolCall, workspacePath) {
        const name = toolCall.function.name;
        let args;
        try {
            args = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
            args = {};
        }

        logger.info(`OpenAIService: Executing tool ${name} (ID: ${toolCall.id})`);

        let toolResult;
        try {
            const repRead  = name === 'readFile'   ? this._hitRepeatedToolArgGuard(workspacePath, name, args, 10) : { blocked: false };
            const repList  = name === 'listFiles'  ? this._hitRepeatedToolArgGuard(workspacePath, name, args, 12) : { blocked: false };
            const repCmd   = name === 'runCommand' ? this._hitRepeatedToolArgGuard(workspacePath, name, args,  6) : { blocked: false };

            if (repRead.blocked || repList.blocked || repCmd.blocked) {
                const repeats = repRead.repeats || repList.repeats || repCmd.repeats || 0;
                toolResult = {
                    error: `CONVERGENCE_GUARD: repeated ${name} with same arguments (${repeats} times) without meaningful code-state change. Stop repeating identical tool calls and continue with a deterministic next step.`,
                    retriable: false, convergenceGuard: true
                };
            } else if (name === 'readFile') {
                toolResult = await fileService.readFile(args.filePath, workspacePath);
            } else if (name === 'writeFile') {
                toolResult = await fileService.writeFile(args.filePath, args.content, workspacePath);
                this._bumpMutationVersion(workspacePath);
            } else if (name === 'listFiles') {
                toolResult = await fileService.listFiles(args.dirPath, workspacePath);
            } else if (name === 'runCommand') {
                const wsState = this._workspaceConvergenceState(workspacePath);
                wsState.runCommandCount = Number(wsState.runCommandCount || 0) + 1;
                if (Number(wsState.lastRunCommandMutationVersion) !== Number(wsState.mutationVersion)) {
                    wsState.lastRunCommandMutationVersion = Number(wsState.mutationVersion || 0);
                    wsState.runCommandCountThisMutation = 0;
                }
                wsState.runCommandCountThisMutation = Number(wsState.runCommandCountThisMutation || 0) + 1;
                if (wsState.runCommandCountThisMutation > 14) {
                    toolResult = {
                        error: `CONVERGENCE_GUARD: excessive runCommand loops without code-state mutation (${wsState.runCommandCountThisMutation} commands at mutationVersion=${wsState.mutationVersion}). Stop command churn and switch to a deterministic minimal fix.`,
                        retriable: false, convergenceGuard: true
                    };
                } else {
                    toolResult = await fileService.runCommand(args.command, args.cwd, workspacePath);
                    if (this._classifyCommand(args.command) === 'build') this._bumpMutationVersion(workspacePath);
                }
            } else if (name === 'runBackgroundCommand') {
                toolResult = await fileService.runBackgroundCommand(args.command, args.cwd, workspacePath);
            } else if (name === 'checkCommandStatus') {
                toolResult = await fileService.checkCommandStatus(args.jobId, args.cwd, workspacePath);
            } else if (name === 'discoverProject') {
                toolResult = { root: await fileService.listFiles(args.projectName, workspacePath) };
            } else if (name === 'searchRooms') {
                toolResult = await searchService.searchRooms(args);
            } else if (name === 'showRooms') {
                toolResult = { ok: true, displayed: (args.rooms || []).length };
            } else if (name === 'readDoc') {
                const docPath = path.resolve(process.cwd(), 'docs', args.fileName);
                toolResult = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : { error: 'Doc not found' };
            } else if (name === 'loadSkill') {
                try {
                    const loaded = await skillProvider.loadSkill(args.skillName, args.fileName);
                    skillLedgerService.record(workspacePath, {
                        requestedRef: `${args.skillName}/${args.fileName}`,
                        canonicalRef: loaded.canonicalRef,
                        resolvedPath: loaded.resolvedPath,
                        success: true
                    });
                    toolResult = loaded.content;
                } catch (e) {
                    skillLedgerService.record(workspacePath, {
                        requestedRef: `${args.skillName}/${args.fileName}`,
                        canonicalRef: '',
                        resolvedPath: '',
                        success: false,
                        error: String(e?.message || 'Skill not found')
                    });
                    toolResult = { error: 'Skill not found' };
                }
            } else if (name === 'addLesson') {
                const wsState = this._workspaceConvergenceState(workspacePath);
                wsState.addLessonCount = Number(wsState.addLessonCount || 0) + 1;
                if (wsState.addLessonCount > 3) {
                    toolResult = {
                        error: 'CONVERGENCE_GUARD: addLesson call cap reached for this turn (max 3). Continue without adding more lessons.',
                        retriable: false, convergenceGuard: true
                    };
                } else {
                    toolResult = await fileService.addLesson(args.lesson, workspacePath);
                }
            } else {
                toolResult = { error: `Unknown tool: ${name}` };
            }
        } catch (error) {
            if (error?.fatalTool) throw error;
            toolResult = { error: error.message };
        }

        toolResult = this._sanitizeToolResultForModel(name, toolResult);

        if (toolResult && typeof toolResult === 'object' && toolResult.fatal === true) {
            const fatalErr = new Error(`FATAL_TOOL_ERROR:${toolResult.errorCode || 'UNKNOWN'}:${toolResult.error || 'Unknown fatal tool error'}`);
            fatalErr.fatalTool = true;
            fatalErr.toolName = name;
            fatalErr.toolResult = toolResult;
            throw fatalErr;
        }

        return {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
        };
    }

    // -------------------------------------------------------------------------
    // Public API — non-streaming
    // -------------------------------------------------------------------------

    async generateResponse(message, history = [], roleKey = 'ORCHESTRATOR', workspacePath = null, attachments = []) {
        this._resetTurnCounters(workspacePath);
        const { modelName, tools, systemPrompt } = this.getModelForRole(roleKey);

        const messages = [
            { role: 'system', content: systemPrompt },
            ...this._normalizeHistory(history)
        ];

        // Inject persistent workspace lessons
        if (workspacePath) {
            try {
                const lessonsPath = path.join(workspacePath, '.viverse_lessons.json');
                if (fs.existsSync(lessonsPath)) {
                    const lessons = JSON.parse(fs.readFileSync(lessonsPath, 'utf8'));
                    if (lessons?.length > 0) {
                        messages.push({ role: 'user', content: `MANDATORY WORKSPACE LESSONS (DO NOT REPEAT THESE ERRORS):\n${lessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}` });
                        messages.push({ role: 'assistant', content: 'Understood. I have loaded the workspace history and will strictly adhere to these previously learned lessons to avoid regressions.' });
                        logger.info(`OpenAIService: Injected ${lessons.length} lessons from ${lessonsPath}`);
                    }
                }
            } catch (e) {
                logger.warn(`OpenAIService: Failed to load lessons: ${e.message}`);
            }
        }

        messages.push({ role: 'user', content: this._buildUserContent(message, attachments) });

        const params = { model: modelName, messages };
        if (tools.length > 0) { params.tools = tools; params.tool_choice = 'auto'; }
        if (roleKey === 'ORCHESTRATOR' || roleKey === 'INTENT_CLASSIFIER' || roleKey === 'SKILL_CLASSIFIER') params.response_format = { type: 'json_object' };

        if (!this.client) throw new Error('OpenAIService: OPENAI_API_KEY is not configured.');
        let response = await this._withRetry(
            () => this.client.chat.completions.create(params),
            'chat.completions.create'
        );

        let toolIterations = 0;
        const MAX_TOOL_ITERATIONS = 40;

        while (response.choices[0].finish_reason === 'tool_calls') {
            toolIterations++;
            if (toolIterations > MAX_TOOL_ITERATIONS) {
                logger.error('OpenAIService: MAX_TOOL_ITERATIONS reached in generateResponse.');
                throw new Error('MAX_TOOL_ITERATIONS_REACHED');
            }

            const assistantMsg = response.choices[0].message;
            messages.push(assistantMsg);

            for (const toolCall of assistantMsg.tool_calls) {
                const toolMsg = await this._executeToolCall(toolCall, workspacePath);
                messages.push(toolMsg);
            }

            response = await this._withRetry(
                () => this.client.chat.completions.create({ ...params, messages }),
                'chat.completions.create(toolLoop)'
            );
        }

        return response.choices[0].message.content || '';
    }

    // -------------------------------------------------------------------------
    // Public API — streaming
    // -------------------------------------------------------------------------

    async *generateResponseStream(message, history = [], roleKey = 'ORCHESTRATOR', workspacePath = null, attachments = []) {
        this._resetTurnCounters(workspacePath);
        const { modelName, tools, systemPrompt } = this.getModelForRole(roleKey);

        const messages = [
            { role: 'system', content: systemPrompt },
            ...this._normalizeHistory(history)
        ];

        // Inject persistent workspace lessons
        if (workspacePath) {
            try {
                const lessonsPath = path.join(workspacePath, '.viverse_lessons.json');
                if (fs.existsSync(lessonsPath)) {
                    const lessons = JSON.parse(fs.readFileSync(lessonsPath, 'utf8'));
                    if (lessons?.length > 0) {
                        messages.push({ role: 'user', content: `MANDATORY WORKSPACE LESSONS (DO NOT REPEAT THESE ERRORS):\n${lessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}` });
                        messages.push({ role: 'assistant', content: 'Understood. I will strictly adhere to these lessons.' });
                    }
                }
            } catch (e) {
                logger.warn(`OpenAIService: Failed to load lessons: ${e.message}`);
            }
        }

        messages.push({ role: 'user', content: this._buildUserContent(message, attachments) });

        const params = { model: modelName, messages, stream: true };
        if (tools.length > 0) { params.tools = tools; params.tool_choice = 'auto'; }

        let toolIterations = 0;
        const MAX_TOOL_ITERATIONS = 40;

        while (true) {
            if (!this.client) throw new Error('OpenAIService: OPENAI_API_KEY is not configured.');
        const stream = await this._withRetry(
                () => this.client.chat.completions.create(params),
                'chat.completions.create(stream)'
            );

            // Collect stream chunks, yielding text as it arrives
            let accumulatedContent = '';
            const toolCallsMap = {}; // index → partial tool call

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;
                if (!delta) continue;

                if (delta.content) {
                    accumulatedContent += delta.content;
                    yield { type: 'text', content: delta.content };
                }

                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index;
                        if (!toolCallsMap[idx]) {
                            toolCallsMap[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                        }
                        if (tc.id) toolCallsMap[idx].id = tc.id;
                        if (tc.function?.name) toolCallsMap[idx].function.name += tc.function.name;
                        if (tc.function?.arguments) toolCallsMap[idx].function.arguments += tc.function.arguments;
                    }
                }
            }

            const toolCalls = Object.values(toolCallsMap);
            const hasToolCalls = toolCalls.length > 0;

            if (!hasToolCalls) break; // done

            toolIterations++;
            if (toolIterations > MAX_TOOL_ITERATIONS) {
                logger.error('OpenAIService: MAX_TOOL_ITERATIONS reached in generateResponseStream.');
                yield { type: 'text', content: '\n\n[SYSTEM ERROR]: Periodic maintenance loop detected. Automatically stabilizing agent...' };
                throw new Error('MAX_TOOL_ITERATIONS_REACHED');
            }

            // Add assistant message with tool calls, then execute each tool
            messages.push({ role: 'assistant', content: accumulatedContent || null, tool_calls: toolCalls });

            for (const toolCall of toolCalls) {
                yield { type: 'status', content: `[TOOL] Executing ${toolCall.function.name}...` };
                const toolMsg = await this._executeToolCall(toolCall, workspacePath);
                messages.push(toolMsg);
                // Detect appId from viverse-cli app create output and surface it for the orchestrator
                if (toolCall.function.name === 'runCommand') {
                    try {
                        const _args = JSON.parse(toolCall.function.arguments || '{}');
                        const _cmd = String(_args.command || '');
                        if (/viverse-cli\s+app\s+create/i.test(_cmd)) {
                            const _content = String(toolMsg.content || '');
                            // Match the canonical viverse-cli app create output format.
                            // Do NOT require a digit — some valid 10-char app IDs are all alpha.
                            const _appIdMatch =
                                _content.match(/App ID:\s*['"]?([a-z0-9]{10})['"]?/i) ||
                                _content.match(/--app-id\s+([a-z0-9]{10})\b/i);
                            const _appId = _appIdMatch?.[1] ? String(_appIdMatch[1]).toLowerCase() : '';
                            if (_appId && /^[a-z0-9]{10}$/.test(_appId)) {
                                logger.info(`OpenAIService: Detected appId from viverse-cli app create: ${_appId}`);
                                yield { type: 'viverse_app_id_discovered', appId: _appId };
                            }
                        }
                    } catch (_e) { /* ignore parse errors */ }
                }
                // Emit gallery_results when showRooms tool is called (LLM-filtered results)
                if (toolCall.function.name === 'showRooms') {
                    try {
                        const _args = JSON.parse(toolCall.function.arguments || '{}');
                        const rooms = (_args.rooms || []).map(r => ({
                            id:          r.hub_sid,
                            name:        r.title || r.name || 'Untitled',
                            description: r.description || '',
                            thumbnail:   r.image || null,
                            world_url:   r.hub_sid ? `https://worlds.viverse.com/${r.hub_sid}` : null,
                        }));
                        yield { type: 'gallery_results', rooms, query: _args.query || '' };
                    } catch (_e) { /* ignore parse errors */ }
                }
                yield { type: 'status', content: `[TOOL] ${toolCall.function.name} finished.` };
            }

            // Update params for next iteration with accumulated messages
            params.messages = messages;
        }
    }
}

export default new OpenAIService();
