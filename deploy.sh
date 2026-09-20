#!/bin/bash
#
# deploy.sh — PoultryDSS Manual Bootstrap Script
#
# PURPOSE:
#   One-shot manual deployment helper for initial setup or emergency re-deployment
#   when the GitHub Actions CI/CD pipeline cannot be used.
#
# NORMAL WORKFLOW:
#   Under normal operation, deployments are handled automatically by the GitHub
#   Actions pipeline (.github/workflows/deploy.yml). This script is only needed
#   for first-time setup or manual intervention on the OCI host.
#
# USAGE:
#   ssh -i ~/Downloads/ssh-key.key opc@100.68.227.114
#   cd ~/data/poultryproject
#   IMAGE_REF=ghcr.io/kelvitz716/poultryproject@sha256:<digest> bash deploy.sh
#
# PREREQUISITES:
#   - Docker (required)
#   - Tailscale (required for private HTTPS access)
#   - A valid .env file with Tuya credentials (if sensor integration is needed)
#   - IMAGE_REF set to the immutable manifest digest from a successful CI build
#
# Exit immediately on any error so a failed step doesn't silently continue.
set -e

echo "======================================"
echo "    Poultry DSS Deployment Script     "
echo "======================================"

# ── Step 1: Verify required and optional dependencies ──────────────────────
echo "[1/4] Checking dependencies..."

if ! command -v docker &> /dev/null; then
    echo "Error: docker is not installed. Please install Docker first."
    exit 1
fi

# Tailscale Serve is mandatory: it provides the only HTTPS entry point.
if ! command -v tailscale &> /dev/null; then
    echo "Error: Tailscale is required for the private HTTPS deployment."
    exit 1
fi

if [ -z "${IMAGE_REF:-}" ]; then
    echo "Error: IMAGE_REF is required and must be an immutable image digest."
    exit 1
fi
case "$IMAGE_REF" in
    ghcr.io/kelvitz716/poultryproject@sha256:[0-9a-fA-F]*) ;;
    *)
        echo "Error: IMAGE_REF must be ghcr.io/kelvitz716/poultryproject@sha256:<digest>."
        exit 1
        ;;
esac
export IMAGE_REF

# ── Step 2: Prepare the SQLite data directory ──────────────────────────────
# The ./data directory is bind-mounted into the container as /app/data.
# chmod 777 ensures the Node.js process (running as a non-root user inside
# the container) can write to the SQLite database on the host filesystem.
echo "[2/4] Setting up data directory..."
mkdir -p data
chmod 777 data || true  # Ignore failure (already correct permissions)

# ── Step 3: Pull and start the pinned Docker Compose stack ─────────────────
# Never build from whatever source happens to exist on the host. The exact
# immutable image digest was selected before this script was invoked.
# Supports both the new `docker compose` (plugin) and legacy `docker-compose` (standalone).
echo "[3/4] Pulling and starting pinned Docker Compose stack..."
docker pull "$IMAGE_REF"
if docker compose version &> /dev/null; then
    docker compose up --no-build --pull never -d --force-recreate poultry-dss
else
    docker-compose up --no-build -d --force-recreate poultry-dss
fi

RUNNING_IMAGE=$(docker inspect --format '{{.Config.Image}}' poultry-dss)
if [ "$RUNNING_IMAGE" != "$IMAGE_REF" ]; then
    echo "Error: poultry-dss started with $RUNNING_IMAGE, expected $IMAGE_REF."
    exit 1
fi

# ── Step 4: Configure private Tailscale HTTPS Serve ────────────────────────
echo "[4/4] Configuring private Tailscale HTTPS Serve..."
if ! tailscale status &> /dev/null; then
    echo "Error: Tailscale is installed but not connected. Run 'sudo tailscale up' first."
    exit 1
fi

# The production host is private-only: discard every prior public Funnel route
# before creating the tailnet-only HTTPS proxy. The container remains
# loopback-only.
tailscale funnel reset
tailscale serve --bg --https=443 --set-path=/ http://127.0.0.1:8089
echo "Private Tailscale HTTPS Serve configured. This app is not publicly exposed."
tailscale serve status

echo "======================================"
echo "        Deployment Complete!          "
echo "======================================"
