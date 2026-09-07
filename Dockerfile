# ---- build ----------------------------------------------------------------
FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime --------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# No Playwright browser is installed on purpose: this image is the detector and
# notifier. Verizon's portal needs a human at a GUI browser, which a VM has not
# got, so the browser step runs on a workstation instead. Keeps the image small
# and removes a large attack surface.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    LOG_PRETTY=false \
    DRY_RUN=true \
    BROWSER_ENABLED=false

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Runs unprivileged. `node` (uid 1000) ships with the base image.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]

# Local-only check: database opens and the required credentials are present.
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
  CMD ["node", "dist/index.js", "health"]

# Polling watcher. Override the command for one-shot CLI use.
CMD ["node", "dist/index.js", "watch"]
