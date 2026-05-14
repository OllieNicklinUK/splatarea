# VIVERSE AI Agent

An orchestrated AI agent that generates, modifies, and publishes VIVERSE web apps from natural language prompts. It coordinates multiple agent roles (Architect → Coder → Reviewer → Verifier) to plan, implement, and verify changes in sandboxed workspaces, then publishes to VIVERSE Worlds via `viverse-cli`.

## 🚀 Features

- **Multi-Agent Orchestration**: Architect plans tasks, Coder implements, Reviewer cross-checks, Verifier validates the published result.
- **Template-Based Generation**: 8 bundled app templates spanning games, utilities, and interactive experiences.
- **Skill-Driven Intelligence**: Loads domain-specific skills from the external [`viverse-sdk-skills`](https://github.com/viverseofficial/viverse-sdk-skills) repository for grounded, accurate implementations.
- **Dual AI Provider Support**: Switch between Google Gemini and OpenAI/Azure OpenAI via environment config.
- **Session Auth**: Express-session login with per-user CLI credential isolation (no re-login per request).
- **Sandboxed Workspaces**: Each request runs in an isolated directory with its own `viverse-cli` credential scope.
- **Preview Auto-Test**: Optional Playwright-based browser probe to verify published apps load correctly.
- **Asset Generation**: PIL-based procedural art generation for game assets (symbols, textures, overlays).
- **Live Dashboard**: Browser UI with streaming status, iframe preview, and conversation history.

## 🛠️ Project Structure

```
src/
├── services/
│   ├── OrchestratorService.js   # Multi-agent task dispatch & coordination
│   ├── AgentRegistry.js         # Agent role definitions & system prompts
│   ├── OpenAIService.js         # OpenAI/Azure OpenAI provider
│   ├── GeminiService.js         # Google Gemini provider
│   ├── FileService.js           # Sandboxed command execution & file I/O
│   ├── SkillProvider.js         # External skill loading & routing
│   └── WorkspaceRegistryService.js  # Per-request workspace management
├── controllers/
│   ├── aiController.js          # Chat endpoint (streaming SSE)
│   └── authController.js        # Login/logout/session
├── routes/
│   ├── aiRoutes.js
│   └── authRoutes.js
templates/                       # Bundled app templates
├── registry.json
├── blank-webapp-v1/
├── flow-line-v1/
├── dashrunner-v1/
├── tankarena-3d-v1/
├── flight-simulator-v1/
├── starter-kit-racing-v1/
├── redpointfish-v1/
└── lambda-tool-v1/
public/                          # Dashboard frontend
docs/                            # Platform knowledge base
```

## 🧠 External Skills Repository

Skills are maintained separately at:
**https://github.com/viverseofficial/viverse-sdk-skills**

The agent auto-resolves `../viverse-sdk-skills/skills` when cloned side-by-side, or set `VIVERSE_SKILLS_REPO` to override.

## 🚦 Getting Started

### Prerequisites

- Node.js v20+
- Python 3 with Pillow (`pip install Pillow`) — for asset generation
- `viverse-cli` v0.9.5+ — for publishing (`npm i -g @nicecv/viverse-cli`)
- AI provider credentials (one of):
  - `GOOGLE_API_KEY` (Gemini)
  - `OPENAI_API_KEY` (OpenAI or Azure OpenAI JSON config)

### Installation

```bash
git clone https://github.com/viverseofficial/viverse-sdk-skills.git
git clone <this-repo> viverse-ai-agent

cd viverse-ai-agent
npm install
cp .env.example .env   # then fill in your API keys
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `AI_PROVIDER` | `gemini` or `openai` |
| `GOOGLE_API_KEY` | Gemini API key |
| `OPENAI_API_KEY` | OpenAI key or Azure JSON config |
| `VIVERSE_SKILLS_REPO` | Path to skills repo (default: `../viverse-sdk-skills`) |
| `VIVERSE_BROWSER_AUTOTEST` | Enable Playwright preview probe (`0`/`1`) |
| `SESSION_SECRET` | Express session secret (auto-generated if unset) |

See `.env.example` for the full list with documentation.

### Running

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

Open `http://localhost:3000` in your browser.

## ✅ Usage

### Via Dashboard

1. Open the dashboard and log in with your VIVERSE credentials.
2. Ask a task in natural language:
   - *"Create a new app using template flow-line-v1 with custom color symbols"*
   - *"Build an endless runner game with a space theme"*
   - *"Add leaderboard support to my existing app"*
3. Watch the orchestration progress in real-time (Architect → Coder → Publish → Verify).
4. Click the preview URL to test the published app on VIVERSE Worlds.

### Via API

```bash
curl -X POST http://localhost:3000/api/ai/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Create a new app using template blank-webapp-v1",
    "credentials": {"email": "you@example.com", "password": "..."}
  }'
```

The response is a Server-Sent Events (SSE) stream with status updates, text chunks, and a final `workflow_outcome` event containing the preview URL.

## 📦 Bundled Templates

| Template | Genre | Description |
|----------|-------|-------------|
| `blank-webapp-v1` | Utility | Mobile-first baseline for polls, widgets, tools |
| `flow-line-v1` | Puzzle | Color-matching flow puzzle with customizable assets |
| `dashrunner-v1` | Endless Runner | Side-scrolling runner game |
| `tankarena-3d-v1` | Arcade Action | 3D tank battle arena |
| `flight-simulator-v1` | Flight / Arcade | Flight simulator with terrain |
| `starter-kit-racing-v1` | Arcade Racing | Top-down racing game |
| `redpointfish-v1` | Card Strategy | Card-based strategy game |
| `lambda-tool-v1` | Utility | Serverless function template with Lambda |

## 🔒 Security

- Credentials are validated server-side via `viverse-cli` and stored only in the HTTP session (never persisted to disk).
- Each user's CLI commands run with an isolated `HOME` directory to prevent credential cross-contamination.
- `.env` is gitignored. Never commit API keys.
- External access is controlled via environment variable binding.
