# ── Build stage: install production deps only ──────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifest files first for layer caching
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Non-root user for security
RUN addgroup -S agent && adduser -S agent -G agent

WORKDIR /app

# Copy deps from build stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY src/       ./src/
COPY scripts/   ./scripts/
COPY skills/    ./skills/
COPY templates/ ./templates/
COPY package.json ./

# Skills / knowledge base (read-only at runtime)
COPY viverse-sdk-skills/ ./viverse-sdk-skills/ 2>/dev/null || true

# Workspace dir: use a mounted volume in production, not baked into the image.
# Create it here so the process can write to it even without a mount.
RUN mkdir -p .viverse_workspaces && chown -R agent:agent /app

USER agent

# Cloud Run injects PORT; default to 3000 for local/Docker use
ENV PORT=3000
ENV NODE_ENV=production
ENV HOST=0.0.0.0

EXPOSE 3000

# Healthcheck — Cloud Run uses this to know when the instance is ready
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/api/ai/health || exit 1

CMD ["node", "src/index.js"]
