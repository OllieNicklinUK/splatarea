document.addEventListener('DOMContentLoaded', () => {
    const chatMessages = document.getElementById('chat-messages');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const attachBtn = document.getElementById('attach-btn');
    const mediaInput = document.getElementById('media-input');
    const attachmentPreview = document.getElementById('attachment-preview');
    const attachmentCount = document.getElementById('attachment-count');
    const templateGallery = document.getElementById('template-gallery');
    const refreshTemplatesBtn = document.getElementById('refresh-templates-btn');
    const worldIframe = document.getElementById('world-iframe');
    const gamePlaceholder = document.getElementById('game-placeholder');
    const gameLoadingOverlay = document.getElementById('game-loading-overlay');
    const gamePanelTitle = document.getElementById('game-panel-title');
    const gamePanel = document.getElementById('main-content');
    const gameBackOverlay = document.getElementById('game-back-overlay');
    // Gallery search clear-pill elements
    const gallerySearchClear = document.getElementById('gallery-search-clear');
    // Run console elements
    const runConsole = document.getElementById('run-console');
    const runConsoleToggle = document.getElementById('run-console-toggle');
    const runConsoleState = document.getElementById('run-console-state');
    const runStage = document.getElementById('run-stage');
    const runTask = document.getElementById('run-task');
    const runBlocker = document.getElementById('run-blocker');
    const statusLogPanel = document.getElementById('status-log-panel');
    // Credentials
    const emailInput = document.getElementById('viverse-email');
    const passwordInput = document.getElementById('viverse-password');
    const saveCredsBtn = document.getElementById('save-credentials-btn');
    const credsStatus = document.getElementById('credentials-status');

    let chatHistory = [];
    let activeWorldUrl = '';
    let savedCredentials = null;
    let pendingMessage = '';
    let pendingWorkspaceId = null; // workspace pinned by require_credentials — sent back on credential re-send
    let awaitingCredentials = false;
    let _requestInFlight = false;
    let myApps = [];

    // Stable ID for this browser session — ties every request in this conversation to
    // the correct workspace on the server, regardless of how many concurrent users exist.
    const conversationId = (() => {
        const key = 'viverse_conversation_id';
        let id = sessionStorage.getItem(key);
        if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(key, id); }
        return id;
    })();

    (function restorePending() {
        const stored = sessionStorage.getItem('viverse_pending_msg');
        if (stored) pendingMessage = stored;
    })();
    let pendingAttachments = [];
    let templatesCatalog = [];
    let consoleCollapsed = true;
    let currentRunSummary = { state: 'idle', stage: 'Idle', task: 'None', blocker: 'None' };

    const MAX_ATTACHMENTS = 4;
    const MAX_FILE_SIZE = 12 * 1024 * 1024;
    const MAX_TOTAL_FILE_SIZE = 48 * 1024 * 1024;
    const ALLOWED_PREFIXES = ['image/', 'video/'];
    const DOC_MIME_BY_EXT = {
        pdf: 'application/pdf', doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv'
    };

    // Genre → badge colour lookup (uses full registry genre string, case-insensitive)
    const GENRE_COLORS = {
        'puzzle':         '#7c3aed',
        'endless runner': '#0084ff',
        'arcade racing':  '#f59e0b',
        'card strategy':  '#10b981',
        'arcade action':  '#ef4444',
        'utility':        '#64748b'
    };

    // ── Credential form ──────────────────────────────────────────────────────
    function appendInlineCredentialForm() {
        const existing = document.querySelector('.credential-prompt-bubble');
        if (existing) existing.remove();
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble assistant credential-prompt-bubble';
        bubble.innerHTML = `
            <div class="credential-prompt-inner">
                <p class="credential-prompt-title">🔐 I need your VIVERSE account to build and publish this app.</p>
                <input type="email" id="inline-cred-email" placeholder="Email address" autocomplete="email" class="inline-cred-input"/>
                <input type="password" id="inline-cred-password" placeholder="Password" autocomplete="current-password" class="inline-cred-input"/>
                <div class="inline-cred-actions">
                    <button class="inline-cred-btn" onclick="window._submitInlineCreds()">Continue →</button>
                    <span class="inline-cred-hint">Credentials are sent only to your VIVERSE agent server.</span>
                </div>
            </div>`;
        chatMessages.appendChild(bubble);
        scrollToBottom();
        setTimeout(() => { const el = document.getElementById('inline-cred-email'); if (el) el.focus(); }, 50);
        bubble.addEventListener('keydown', (e) => { if (e.key === 'Enter') window._submitInlineCreds(); });
    }

    window._submitInlineCreds = function () {
        const emailEl = document.getElementById('inline-cred-email');
        const passEl  = document.getElementById('inline-cred-password');
        if (!emailEl || !passEl) return;
        const email = emailEl.value.trim(), password = passEl.value;
        if (!email || !password) { emailEl.style.borderColor = 'var(--error-color, #ff4444)'; return; }
        savedCredentials = { email, password };
        document.getElementById('viverse-email').value = email;
        document.getElementById('viverse-password').value = password;
        document.getElementById('credentials-status').classList.remove('hidden');
        const formBubble = document.querySelector('.credential-prompt-bubble');
        if (formBubble) formBubble.remove();
        sessionStorage.removeItem('viverse_pending_msg');
        const msg = pendingMessage; pendingMessage = ''; awaitingCredentials = false;
        if (msg) sendMessage(msg, true);
    };

    // ── Scroll / message helpers ─────────────────────────────────────────────
    function scrollToBottom() {
        const threshold = 50;
        if (chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < threshold)
            chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function appendMessage(role, content = '') {
        const bubble = document.createElement('div');
        bubble.className = `message-bubble ${role}`;
        bubble.innerHTML = marked.parse(content || '');
        chatMessages.appendChild(bubble);
        scrollToBottom();
    }

    // ── Run console ──────────────────────────────────────────────────────────
    function renderRunSummary() {
        runConsoleState.textContent = currentRunSummary.state;
        runConsoleState.className = `run-console-state ${String(currentRunSummary.state || 'idle').toLowerCase()}`;
        runStage.textContent = currentRunSummary.stage || 'Idle';
        runTask.textContent = currentRunSummary.task || 'None';
        runBlocker.textContent = currentRunSummary.blocker || 'None';
    }

    function setRunSummary(next = {}) {
        currentRunSummary = { ...currentRunSummary, ...next };
        renderRunSummary();
    }

    function setConsoleCollapsed(collapsed) {
        consoleCollapsed = !!collapsed;
        runConsole.classList.toggle('collapsed', consoleCollapsed);
        runConsoleToggle.textContent = consoleCollapsed ? 'Show Console' : 'Hide Console';
    }

    function appendStatusLog(content = '', type = 'status', icon = '⚡') {
        const line = document.createElement('div');
        line.className = `status-line${type === 'error' ? ' error' : type === 'muted' ? ' muted' : ''}`;
        line.innerHTML = `<span class="status-icon">${icon}</span> ${content}`;
        statusLogPanel.appendChild(line);
        statusLogPanel.scrollTop = statusLogPanel.scrollHeight;
        if (consoleCollapsed) setConsoleCollapsed(false);
    }

    function resetRunConsole() {
        statusLogPanel.innerHTML = '<div class="status-line muted"><span class="status-icon">•</span> Waiting for the next run.</div>';
        setRunSummary({ state: 'idle', stage: 'Idle', task: 'None', blocker: 'None' });
        setConsoleCollapsed(true);
    }

    function updateRunSummaryFromStatus(content = '') {
        const text = String(content || '');
        if (!text) return;
        if (/workflow completed/i.test(text))                 setRunSummary({ state: 'completed', blocker: 'None' });
        else if (/blocked|failed|halted|retry cap|fatal/i.test(text)) setRunSummary({ state: 'blocked', blocker: text });
        else                                                   setRunSummary({ state: 'running' });
        const taskMatch =
            text.match(/Execute task\s+([A-Za-z0-9_:-]+)\s+\(([^)]+)\)/i) ||
            text.match(/Agent \[([^\]]+)\].*task:\s*(.+)$/i) ||
            text.match(/Current pending task:\s*([A-Za-z0-9_:-]+)\s+\(([^)]+)\)/i);
        if (taskMatch) setRunSummary({ task: taskMatch[2] ? `${taskMatch[1]} (${taskMatch[2]})` : taskMatch[1] });
        const stageMatch = text.match(/Current stage:\s*([A-Za-z0-9_:-]+)/i);
        if (stageMatch) { setRunSummary({ stage: stageMatch[1] }); return; }
        if (/planning/i.test(text))        return setRunSummary({ stage: 'plan' });
        if (/auth preflight/i.test(text))  return setRunSummary({ stage: 'auth_preflight' });
        if (/publish|preview url/i.test(text)) return setRunSummary({ stage: 'publish' });
        if (/verifier|reviewer/i.test(text))   return setRunSummary({ stage: 'verify' });
        if (/build/i.test(text))           return setRunSummary({ stage: 'build_verify' });
        if (/template|scaffold/i.test(text))   return setRunSummary({ stage: 'scaffold_preflight' });
        if (/implement|logic|ui/i.test(text))  return setRunSummary({ stage: 'implement' });
    }

    // ── Attachments ──────────────────────────────────────────────────────────
    function updateAttachmentUI() {
        attachmentPreview.innerHTML = '';
        if (!pendingAttachments.length) {
            attachmentPreview.classList.add('hidden');
            attachmentCount.classList.add('hidden');
            attachmentCount.textContent = '0 files';
            return;
        }
        attachmentPreview.classList.remove('hidden');
        attachmentCount.classList.remove('hidden');
        attachmentCount.textContent = `${pendingAttachments.length} file${pendingAttachments.length > 1 ? 's' : ''}`;
        pendingAttachments.forEach((file, index) => {
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'attachment-pill';
            pill.innerHTML = `<span class="attachment-pill-name">${file.name}</span><span class="attachment-pill-remove">×</span>`;
            pill.addEventListener('click', () => { pendingAttachments.splice(index, 1); updateAttachmentUI(); });
            attachmentPreview.appendChild(pill);
        });
    }

    function inferMimeType(file) {
        const original = (file.type || '').toLowerCase();
        if (original) return original;
        const ext = String(file.name || '').toLowerCase().split('.').pop();
        return DOC_MIME_BY_EXT[ext] || '';
    }

    function isSupportedMedia(file) {
        const mt = inferMimeType(file);
        if (!mt) return false;
        if (ALLOWED_PREFIXES.some(p => mt.startsWith(p))) return true;
        return Object.values(DOC_MIME_BY_EXT).includes(mt);
    }

    function totalPendingBytes() {
        return pendingAttachments.reduce((s, item) => s + Math.floor((String(item?.dataBase64 || '').length * 3) / 4), 0);
    }

    function toAttachment(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = String(reader.result || '');
                const idx = result.indexOf('base64,');
                if (idx === -1) { reject(new Error(`Failed to parse file: ${file.name}`)); return; }
                resolve({ name: file.name, mimeType: inferMimeType(file), dataBase64: result.slice(idx + 7) });
            };
            reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
            reader.readAsDataURL(file);
        });
    }

    function showTypingIndicator() {
        const el = document.createElement('div');
        el.className = 'typing-indicator'; el.id = 'typing-indicator';
        el.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
        chatMessages.appendChild(el); scrollToBottom();
    }

    function removeTypingIndicator() {
        const el = document.getElementById('typing-indicator');
        if (el) el.remove();
    }

    // ── Game panel ───────────────────────────────────────────────────────────
    function openGamePanel(url) {
        if (!url) return;
        activeWorldUrl = url;
        const finalUrl = url.includes('?') ? (url.includes('full3d=') ? url : url + '&full3d=') : url + '?full3d=';
        worldIframe.src = finalUrl;
        gamePlaceholder.classList.add('hidden');
        gameLoadingOverlay.classList.remove('hidden');
        gamePanelTitle.textContent = 'Loading…';
        // Expand to full-panel game view
        gamePanel.classList.add('game-view-active');
        gameBackOverlay.classList.remove('hidden');
    }

    function closeGamePanel() {
        worldIframe.src = 'about:blank';
        activeWorldUrl = '';
        gamePlaceholder.classList.remove('hidden');
        gameLoadingOverlay.classList.add('hidden');
        gamePanelTitle.textContent = '';
        // Return to gallery view
        gamePanel.classList.remove('game-view-active');
        gameBackOverlay.classList.add('hidden');
        if (window.innerWidth < 768) gamePanel.classList.add('game-panel--collapsed');
    }

    worldIframe.addEventListener('load', () => {
        gameLoadingOverlay.classList.add('hidden');
        gamePanelTitle.textContent = activeWorldUrl ? 'Game Preview' : '';
    });

    gameBackOverlay.addEventListener('click', closeGamePanel);

    // ── My Apps (created apps persisted in localStorage) ─────────────────────
    function _loadMyApps() {
        try { myApps = JSON.parse(localStorage.getItem('viverse_my_apps') || '[]'); } catch { myApps = []; }
    }

    function _persistMyApps() {
        localStorage.setItem('viverse_my_apps', JSON.stringify(myApps));
    }

    function _timeAgo(ts) {
        const diff = Date.now() - ts;
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return `${Math.floor(diff / 86400000)}d ago`;
    }

    function addMyApp({ name, templateId, previewUrl }) {
        const existingIdx = myApps.findIndex(a => a.previewUrl === previewUrl);
        if (existingIdx !== -1) {
            // Update existing entry and move it to the top
            const updated = { ...myApps[existingIdx], name: name || myApps[existingIdx].name, templateId: templateId || myApps[existingIdx].templateId, createdAt: Date.now() };
            myApps.splice(existingIdx, 1);
            myApps.unshift(updated);
        } else {
            const app = { id: String(Date.now()), name: name || 'My App', templateId: templateId || '', previewUrl, createdAt: Date.now() };
            myApps.unshift(app);
            if (myApps.length > 20) myApps = myApps.slice(0, 20);
        }
        _persistMyApps();
        gallerySearchClear.classList.add('hidden');
        renderTemplateGallery(templatesCatalog.filter(t => t.status !== 'disabled'));
    }

    function removeMyApp(id) {
        myApps = myApps.filter(a => a.id !== id);
        _persistMyApps();
        gallerySearchClear.classList.add('hidden');
        renderTemplateGallery(templatesCatalog.filter(t => t.status !== 'disabled'));
    }

    function _prependMyAppsCards(container) {
        if (!myApps.length) return;
        const label = document.createElement('div');
        label.className = 'gallery-section-label';
        label.textContent = `My Apps (${myApps.length})`;
        container.appendChild(label);
        myApps.forEach(app => {
            const card = document.createElement('div');
            card.className = 'template-card my-app-card';
            card.innerHTML = `
                <span class="card-type-label type-myapp">My App</span>
                <div class="template-card-name" title="${app.name}">${app.name}</div>
                <span class="genre-badge" style="background:#39d35322;color:#39d353;border:1px solid #39d35344">Built</span>
                <div class="template-card-desc">${app.templateId ? `Based on ${app.templateId}` : 'Custom build'} · ${_timeAgo(app.createdAt)}</div>
                <div class="card-actions">
                    <button class="card-play-btn my-app-preview-btn"><svg viewBox="0 0 24 24" width="13" height="13" style="margin-right:4px;vertical-align:-2px"><path fill="currentColor" d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>Preview</button>
                    <a class="card-use-btn" href="${app.previewUrl}" target="_blank" rel="noopener noreferrer">Open ↗</a>
                    <button class="card-remove-btn" title="Remove">×</button>
                </div>`;
            card.querySelector('.my-app-preview-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                openGamePanel(app.previewUrl);
            });
            card.querySelector('.card-remove-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                removeMyApp(app.id);
            });
            container.appendChild(card);
        });
        // Divider before templates
        const sep = document.createElement('div');
        sep.className = 'gallery-section-label';
        sep.textContent = 'Templates';
        container.appendChild(sep);
    }

    // ── Template gallery ─────────────────────────────────────────────────────
    function renderTemplateGallery(templates) {
        templateGallery.innerHTML = '';
        _prependMyAppsCards(templateGallery);
        if (!templates.length) return;

        templates.forEach(t => {
            const card = document.createElement('div');
            card.className = 'template-card';

            const genreKey = String(t.genre || '').toLowerCase();
            const badgeColor = GENRE_COLORS[genreKey] || '#64748b';
            const isUtility = t.cta === 'utility';

            const chips = Array.isArray(t.utilityCtaExamples) ? t.utilityCtaExamples : [];
            const hasPlayLink = !!t.demoPlayLink;

            const thumbHtml = t.thumbnail
                ? `<img class="card-thumb" src="${t.thumbnail}" alt="${t.name}" loading="lazy">`
                : `<div class="card-thumb card-thumb-placeholder"><span>${(t.name || '?')[0].toUpperCase()}</span></div>`;
            card.innerHTML = `
                ${thumbHtml}
                <span class="card-type-label">Template</span>
                <div class="template-card-name" title="${t.name}">${t.name}</div>
                <span class="genre-badge" style="background:${badgeColor}22;color:${badgeColor};border:1px solid ${badgeColor}44">${t.genre || 'Other'}</span>
                <div class="template-card-desc">${t.description || ''}</div>
                ${isUtility && chips.length ? `<div class="utility-chip-row">${chips.map(c => `<button class="utility-prompt-chip" data-chip="${encodeURIComponent(c)}">${c}</button>`).join('')}</div>` : ''}
                <div class="card-actions">
                    ${!isUtility ? `<button class="card-play-btn" ${!hasPlayLink ? 'disabled title="Demo not yet deployed"' : ''}><svg viewBox="0 0 24 24" width="13" height="13" style="margin-right:4px;vertical-align:-2px"><path fill="currentColor" d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>Preview</button>` : ''}
                    <button class="card-use-btn">Use</button>
                </div>`;

            // Play button
            if (!isUtility) {
                const playBtn = card.querySelector('.card-play-btn');
                if (hasPlayLink) {
                    playBtn.addEventListener('click', (e) => { e.stopPropagation(); openGamePanel(t.demoPlayLink); });
                }
            }

            // Use button — insert recommendedPrompt
            card.querySelector('.card-use-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                userInput.value = t.recommendedPrompt || `Create a new app using template '${t.id}'.`;
                userInput.dispatchEvent(new Event('input'));
                userInput.focus();
                _activeTemplateId = t.id;
            });

            // Utility chip clicks
            card.querySelectorAll('.utility-prompt-chip').forEach(chip => {
                chip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const text = decodeURIComponent(chip.dataset.chip || '');
                    userInput.value = text;
                    userInput.dispatchEvent(new Event('input'));
                    userInput.focus();
                    _activeTemplateId = t.id;
                });
            });

            templateGallery.appendChild(card);
        });
    }

    // ── Render search results into the gallery (called from stream parser) ───
    function renderSearchResults(rooms, query = '') {
        templateGallery.innerHTML = '';
        _prependMyAppsCards(templateGallery);

        const label = document.createElement('div');
        label.className = 'gallery-section-label';
        label.textContent = rooms.length
            ? `${rooms.length} results found${query ? ` for "${query}"` : ''}`
            : `No results found${query ? ` for "${query}"` : ''}`;
        templateGallery.appendChild(label);

        if (!rooms.length) {
            const empty = document.createElement('div');
            empty.className = 'gallery-empty-state';
            empty.textContent = 'Try a different search term in the chat.';
            templateGallery.appendChild(empty);
        }

        rooms.forEach(r => {
            const card = document.createElement('div');
            card.className = 'template-card';
            card.innerHTML = `
                ${r.thumbnail ? `<img class="card-thumb" src="${r.thumbnail}" alt="${r.name}" loading="lazy">` : ''}
                <span class="card-type-label type-viverse">Game / Content</span>
                <div class="template-card-name" title="${r.name}">${r.name}</div>
                <span class="genre-badge" style="background:#0084ff22;color:#0084ff;border:1px solid #0084ff44">VIVERSE</span>
                <div class="template-card-desc">${r.description || ''}</div>
                <div class="card-actions">
                    <button class="card-play-btn" ${!r.world_url ? 'disabled' : ''}>▶ Play</button>
                </div>`;
            if (r.world_url) {
                card.querySelector('.card-play-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    openGamePanel(r.world_url);
                });
            }
            templateGallery.appendChild(card);
        });

        // Show the "back to templates" pill
        if (gallerySearchClear) gallerySearchClear.classList.remove('hidden');
    }

    // ── Template sidebar quick-pick ──────────────────────────────────────────
    let _activeTemplateId = null;

    function selectedTemplate() {
        if (!_activeTemplateId) return null;
        return templatesCatalog.find(item => String(item.id) === _activeTemplateId) || null;
    }

    async function loadTemplates() {
        try {
            const res = await fetch('/api/ai/templates');
            const data = await res.json();
            templatesCatalog = Array.isArray(data?.templates) ? data.templates : [];
            renderTemplateGallery(templatesCatalog.filter(t => t.status !== 'disabled'));
        } catch (error) {
            console.warn('Failed to load templates:', error.message);
        }
    }

    // ── Gallery clear (back to templates) ───────────────────────────────────
    function clearGallerySearch() {
        gallerySearchClear.classList.add('hidden');
        renderTemplateGallery(templatesCatalog.filter(t => t.status !== 'disabled'));
    }

    gallerySearchClear.addEventListener('click', clearGallerySearch);



    // ── Sidebar resize ───────────────────────────────────────────────────────
    const sidebarEl = document.querySelector('.sidebar');
    const resizeHandle = document.querySelector('.sidebar-resize-handle');
    const SIDEBAR_MIN = 220, SIDEBAR_MAX = 480;
    let isResizing = false;

    if (resizeHandle && sidebarEl) {
        resizeHandle.addEventListener('pointerdown', (e) => {
            isResizing = true;
            resizeHandle.setPointerCapture(e.pointerId);
        });
        document.addEventListener('pointermove', (e) => {
            if (!isResizing) return;
            const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX));
            document.documentElement.style.setProperty('--sidebar-width', w + 'px');
        });
        document.addEventListener('pointerup', () => {
            if (!isResizing) return;
            isResizing = false;
            const w = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim();
            if (w) localStorage.setItem('viverse_sidebar_width', w);
        });
        // Restore saved width
        const savedW = localStorage.getItem('viverse_sidebar_width');
        if (savedW) document.documentElement.style.setProperty('--sidebar-width', savedW);
    }

    // ── Send message ─────────────────────────────────────────────────────────
    async function sendMessage(overrideMessage = null, isAutoSend = false) {
        if (_requestInFlight) return;
        const actualMessage = (overrideMessage && typeof overrideMessage === 'string') ? overrideMessage : userInput.value.trim();
        const requestMessageRaw = actualMessage || 'Please analyze the attached media.';
        const requestMessage = requestMessageRaw;
        if (!actualMessage && pendingAttachments.length === 0) return;
        _requestInFlight = true;

        if (!isAutoSend) {
            const attachmentLabel = pendingAttachments.length
                ? `\n\nAttached media:\n${pendingAttachments.map(a => `- ${a.name}`).join('\n')}`
                : '';
            const chosen = selectedTemplate();
            appendMessage('user', `${actualMessage || '(media only)'}${chosen ? `\n\nTemplate: ${chosen.id}` : ''}${attachmentLabel}`);
        }
        userInput.value = '';
        userInput.style.height = 'auto';

        showTypingIndicator();
        let localHeartbeat = null;
        statusLogPanel.innerHTML = '';
        setRunSummary({ state: 'running', stage: 'plan', task: 'Preparing request', blocker: 'None' });
        setConsoleCollapsed(false);
        appendStatusLog('Run started. Waiting for agent stream...', 'status', '⏳');

        // Reset auto-load flag for this request
        let _previewAutoLoaded = false;

        try {
            const payload = { message: requestMessage, history: chatHistory, conversationId };
            if (pendingAttachments.length) payload.attachments = [...pendingAttachments];
            if (savedCredentials) payload.credentials = savedCredentials;
            const chosen = selectedTemplate();
            if (chosen) payload.templateContext = { templateId: chosen.id, templateName: chosen.name };
            if (pendingWorkspaceId) { payload.preferredWorkspace = pendingWorkspaceId; pendingWorkspaceId = null; }
            pendingAttachments = [];
            updateAttachmentUI();

            const response = await fetch('/api/ai/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                removeTypingIndicator();
                appendMessage('system', `Error: ${response.statusText}`);
                return;
            }

            const bubble = document.createElement('div');
            bubble.className = 'message-bubble agent streaming';
            const textContainer = document.createElement('div');
            textContainer.className = 'agent-text';
            bubble.appendChild(textContainer);
            chatMessages.appendChild(bubble);

            let accumulatedText = '';
            let receivedFirstChunk = false;
            let localHeartbeatCount = 0;
            localHeartbeat = setInterval(() => {
                localHeartbeatCount++;
                appendStatusLog(`Still working... (${localHeartbeatCount * 8}s)`, 'status', '⏱️');
                scrollToBottom();
            }, 8000);

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let finalPreviewUrl = null;
            let sseBuffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                sseBuffer += decoder.decode(value, { stream: true });
                const lines = sseBuffer.split('\n');
                sseBuffer = lines.pop(); // keep incomplete last line in buffer
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    if (!receivedFirstChunk) { receivedFirstChunk = true; removeTypingIndicator(); }
                    const dataStr = line.substring(6).trim();
                    if (dataStr === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(dataStr);
                        if (parsed.type === 'status') {
                            appendStatusLog(parsed.content, 'status', '⚡');
                            updateRunSummaryFromStatus(parsed.content);
                            scrollToBottom();
                        } else if (parsed.type === 'preview_url' && parsed.url) {
                            // Server-authoritative URL — store it, but do NOT open the panel yet.
                            // The publish just completed; the viverse server needs a few seconds
                            // to propagate. We open after the full stream completes.
                            finalPreviewUrl = String(parsed.url).trim();
                            _previewAutoLoaded = true; // suppress text-scan fallback
                        } else if (parsed.type === 'text') {
                            accumulatedText += parsed.content;
                            textContainer.innerHTML = marked.parse(accumulatedText);
                            // Fallback scan: only if structured preview_url event not yet received
                            if (!_previewAutoLoaded) {
                                const m = accumulatedText.match(/FINAL_PREVIEW_URL:\s*(https?:\/\/[^\s<>]+)/);
                                if (m) {
                                    _previewAutoLoaded = true;
                                    finalPreviewUrl = m[1];
                                }
                            }
                            scrollToBottom();
                        } else if (parsed.type === 'error') {
                            appendStatusLog(`Error: ${parsed.content}`, 'error', '⚠️');
                            setRunSummary({ state: 'error', blocker: parsed.content });
                        } else if (parsed.type === 'gallery_results' && Array.isArray(parsed.rooms)) {
                            // Exit game-view-active so gallery is visible, then render results
                            if (gamePanel.classList.contains('game-view-active')) closeGamePanel();
                            renderSearchResults(parsed.rooms, parsed.query || '');
                            scrollToBottom();
                        } else if (parsed.type === 'action' && parsed.action === 'require_credentials') {
                            pendingMessage = requestMessage;
                            if (parsed.workspaceId) pendingWorkspaceId = parsed.workspaceId;
                            sessionStorage.setItem('viverse_pending_msg', requestMessage);
                            awaitingCredentials = true;
                            appendInlineCredentialForm();
                        }
                    } catch (e) {
                        console.warn('Failed to parse stream chunk:', dataStr);
                    }
                }
            }

            clearInterval(localHeartbeat);
            bubble.classList.remove('streaming');
            removeTypingIndicator();

            if (currentRunSummary.state === 'running')
                setRunSummary({ state: 'completed', blocker: 'None' });

            // Append post-run result card and open game panel after stream completes
            if (finalPreviewUrl) {
                const tpl = templatesCatalog.find(t => t.id === _activeTemplateId);
                const appName = tpl?.name || (_activeTemplateId ? _activeTemplateId : 'My App');
                addMyApp({ name: appName, templateId: _activeTemplateId || '', previewUrl: finalPreviewUrl });
                const card = document.createElement('div');
                card.className = 'run-result-card';
                const _safeUrl = String(finalPreviewUrl).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
                card.innerHTML = `✅ Build published &nbsp;
                    <a href="${_safeUrl}" class="result-url" target="_blank">${_safeUrl}</a>
                    <button class="view-in-panel-btn">View in Panel →</button>`;
                card.querySelector('.view-in-panel-btn').addEventListener('click', () => openGamePanel(finalPreviewUrl));
                bubble.appendChild(card);
                scrollToBottom();
                // Delay opening panel — viverse CDN takes ~15s to propagate after publish (HTTP 425 until ready)
                setTimeout(() => openGamePanel(finalPreviewUrl), 15000);
            }

            if (awaitingCredentials) {
                appendStatusLog('Waiting for credentials — fill in the form above to continue.', 'status', '🔐');
                setRunSummary({ state: 'waiting', blocker: 'Credentials required' });
            } else {
                appendStatusLog('Stream finished.', 'status', '✓');
                // Auto-collapse console 2s after successful completion
                setTimeout(() => setConsoleCollapsed(true), 2000);
            }
            awaitingCredentials = false;
            _requestInFlight = false;
            chatHistory.push({ role: 'user', content: requestMessage });
            chatHistory.push({ role: 'assistant', content: accumulatedText });

        } catch (error) {
            removeTypingIndicator();
            if (localHeartbeat) clearInterval(localHeartbeat);
            _requestInFlight = false;
            appendStatusLog(`Connection error: ${error.message}`, 'error', '⚠️');
            setRunSummary({ state: 'error', blocker: error.message });
            appendMessage('system', 'Connection error: ' + error.message);
        }
    }

    // ── Event listeners ──────────────────────────────────────────────────────
    sendBtn.addEventListener('click', sendMessage);
    attachBtn.addEventListener('click', () => mediaInput.click());
    refreshTemplatesBtn.addEventListener('click', loadTemplates);

    mediaInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        for (const file of files) {
            if (pendingAttachments.length >= MAX_ATTACHMENTS) {
                appendMessage('system', `Attachment limit reached (${MAX_ATTACHMENTS}).`); break;
            }
            if (!isSupportedMedia(file)) {
                appendMessage('system', `Unsupported file type: ${file.name}`); continue;
            }
            if (file.size > MAX_FILE_SIZE) {
                appendMessage('system', `File too large: ${file.name} (max 12MB).`); continue;
            }
            try {
                const attachment = await toAttachment(file);
                if (totalPendingBytes() + Math.floor((String(attachment.dataBase64 || '').length * 3) / 4) > MAX_TOTAL_FILE_SIZE) {
                    appendMessage('system', `Attachments total exceeds 48MB. Skip: ${file.name}`); continue;
                }
                pendingAttachments.push(attachment);
            } catch (err) {
                appendMessage('system', err.message || `Failed to attach ${file.name}`);
            }
        }
        mediaInput.value = '';
        updateAttachmentUI();
    });

    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    userInput.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = this.scrollHeight + 'px';
    });

    runConsoleToggle.addEventListener('click', () => setConsoleCollapsed(!consoleCollapsed));

    // Intercept world links → open in game panel instead of new tab
    document.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (link && link.href) {
            const isWorld = link.href.includes('worlds.viverse.com') || link.href.includes('/world/');
            if (isWorld) {
                e.preventDefault();
                const url = link.href;
                const finalUrl = url.includes('?') ? (url.includes('full3d=') ? url : `${url}&full3d=`) : `${url}?full3d=`;
                openGamePanel(finalUrl);
            } else {
                link.target = '_blank';
            }
        }
    });

    // Handle saving credentials
    saveCredsBtn.addEventListener('click', () => {
        const email = emailInput.value.trim();
        const password = passwordInput.value.trim();
        if (email && password) {
            savedCredentials = { email, password };
            saveCredsBtn.classList.add('saved');
            saveCredsBtn.textContent = 'Saved';
            credsStatus.classList.remove('hidden');
            if (pendingMessage) {
                setTimeout(() => {
                    const accountPanel = document.querySelector('.account-panel');
                    if (accountPanel) accountPanel.classList.remove('visible');
                    sendMessage(pendingMessage, true);
                    pendingMessage = '';
                }, 500);
            }
        } else {
            savedCredentials = null;
            saveCredsBtn.classList.remove('saved');
            saveCredsBtn.textContent = 'Save Credentials';
            credsStatus.classList.add('hidden');
        }
    });

    // ── Init ─────────────────────────────────────────────────────────────────
    userInput.focus();
    renderRunSummary();
    resetRunConsole();
    _loadMyApps();
    loadTemplates();
});
