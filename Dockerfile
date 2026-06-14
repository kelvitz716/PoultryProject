# ── Base image ──────────────────────────────────────────────────────────────
# node:20-alpine is ~60MB and matches the Node.js version used in development.
# It runs natively on both amd64 and arm64, which is required for the OCI
# Ampere A1 instance (ARM64). The multi-arch build in GitHub Actions ensures
# the correct layer is selected automatically at pull time.
FROM node:20-alpine

WORKDIR /app

# ── Install production dependencies ─────────────────────────────────────────
# Copy manifests first to exploit Docker's layer cache:
# if package.json hasn't changed, npm install is skipped on the next build.
COPY package*.json ./
RUN npm install --production

# ── Copy application source ──────────────────────────────────────────────────
# Copies everything not excluded by .dockerignore (node_modules, data/, .env,
# .git, tests/, docs/, and scratch/ are excluded to keep the image lean and
# to prevent secrets from being baked into the image).
COPY . .

# ── Persistent data directory ────────────────────────────────────────────────
# Creates the SQLite storage directory inside the image. The docker-compose.yml
# bind-mounts ./data:/app/data so the database survives container re-creations.
RUN mkdir -p data

# The Express server listens on port 80 inside the container.
# docker-compose.yml maps this to host port 8089: "8089:80".
EXPOSE 80

# Launch the Express backend directly via Node (no wrapper needed for Alpine).
CMD ["node", "server.js"]
