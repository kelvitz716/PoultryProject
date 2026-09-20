# ── Base image ──────────────────────────────────────────────────────────────
# node:20-alpine is ~60MB and matches the Node.js version used in development.
# It runs natively on both amd64 and arm64, which is required for the OCI
# Ampere A1 instance (ARM64). The multi-arch build in GitHub Actions ensures
# the correct layer is selected automatically at pull time.
FROM node:20-alpine

WORKDIR /app

# ── Install production dependencies ─────────────────────────────────────────
# Copy manifests first to exploit Docker's layer cache:
# if the manifest lock has not changed, npm ci is skipped on the next build.
COPY package*.json ./
# Install exactly the reviewed dependency graph captured in package-lock.json.
# sqlite3 v6 compiles when an Alpine prebuild is unavailable; retain only the
# resulting native binding, not its compiler toolchain, in the runtime image.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps

# ── Copy application source ──────────────────────────────────────────────────
# Copies everything not excluded by .dockerignore (node_modules, data/, .env,
# .git, tests/, docs/, and scratch/ are excluded to keep the image lean and
# to prevent secrets from being baked into the image).
COPY --chown=node:node . .

# ── Persistent data directory ────────────────────────────────────────────────
# Creates the SQLite storage directory inside the image. The docker-compose.yml
# bind-mounts ./data:/app/data so the database survives container re-creations.
# The runtime never needs root: its only writable location is that bind mount.
RUN mkdir -p data \
    && chown -R node:node /app

# An unprivileged process cannot safely bind a privileged port. Compose maps
# this internal port to the host's loopback-only 8089 endpoint.
EXPOSE 8080

USER node

# Launch the Express backend directly via Node (no wrapper needed for Alpine).
CMD ["node", "server.js"]
