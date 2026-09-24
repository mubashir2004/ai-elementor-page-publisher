# ============================================================
# AI → Elementor Page Publisher — single-service production image.
#
# Stage 1 builds the React UI; stage 2 runs the Express backend which
# serves both the API and that built UI, so one container is the whole tool.
#
# Base image is Playwright's, because the website scanner needs a real
# Chromium with its system libraries — a plain node image cannot scan.
# ============================================================

# ---------- Stage 1: build the frontend ----------
FROM node:20-bookworm AS frontend
WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
# No VITE_BACKEND_URL: a production build calls its own origin, which is this
# same container.
RUN npm run build


# ---------- Stage 2: runtime ----------
# Must match the playwright version in backend/package.json (1.61.1).
FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV NODE_ENV=production \
    PORT=8787 \
    EAI_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Backend deps first so this layer caches across code changes.
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

# Application code. The backend resolves ../prompts and ../plugin relative to
# itself, so this layout must be preserved.
COPY backend/ ./backend/
COPY prompts/ ./prompts/
COPY plugin/ ./plugin/

# The UI built in stage 1 — backend/server.js serves it from here.
COPY --from=frontend /app/frontend/dist ./frontend/dist

# Page history, sessions, brands and components live here. Mount a volume at
# /data on the host/platform or everything resets on each redeploy.
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser

EXPOSE 8787

# Platform health checks hit /health, which needs no credentials.
CMD ["node", "backend/server.js"]
