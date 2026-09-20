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
set -eu

IMAGE_REF_PATTERN='^ghcr.io/kelvitz716/poultryproject@sha256:[a-f0-9]{64}$'
PREVIOUS_IMAGE_REF=''
PREVIOUS_IMAGE_ID=''

compose_up() {
    if docker compose version &> /dev/null; then
        docker compose up --no-build --pull never -d --force-recreate poultry-dss
    else
        docker-compose up --no-build -d --force-recreate poultry-dss
    fi
}

wait_for_healthy() {
    attempt=1
    while [ "$attempt" -le 70 ]; do
        health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' poultry-dss 2>/dev/null || true)
        if [ "$health" = 'healthy' ]; then
            return 0
        fi
        if [ "$health" = 'unhealthy' ]; then
            echo "New container reported unhealthy."
            return 1
        fi
        sleep 2
        attempt=$((attempt + 1))
    done
    echo "Timed out waiting for the new container to become healthy."
    return 1
}

verify_running_image() {
    expected_image_id=$(docker image inspect --format '{{.Id}}' "$IMAGE_REF")
    running_image_id=$(docker inspect --format '{{.Image}}' poultry-dss)
    if [ "$running_image_id" != "$expected_image_id" ]; then
        echo "Image identity mismatch: running $running_image_id, expected $expected_image_id."
        return 1
    fi
}

rollback_previous() {
    if [ -z "$PREVIOUS_IMAGE_REF" ] || [ -z "$PREVIOUS_IMAGE_ID" ]; then
        echo "No prior running image was available for rollback. The new deployment was not accepted."
        return 1
    fi
    echo "Restoring the prior container image after failed deployment: $PREVIOUS_IMAGE_REF"
    if ! IMAGE_REF="$PREVIOUS_IMAGE_REF" compose_up; then
        echo "Automatic rollback could not start the prior image."
        return 1
    fi
    restored_image_id=$(docker inspect --format '{{.Image}}' poultry-dss 2>/dev/null || true)
    if [ "$restored_image_id" != "$PREVIOUS_IMAGE_ID" ]; then
        echo "Automatic rollback started an unexpected image."
        return 1
    fi
    if ! wait_for_healthy; then
        echo "Automatic rollback did not become healthy."
        return 1
    fi
    echo "Rollback complete; the prior service is healthy again."
}

echo "======================================"
echo "    Poultry DSS Deployment Script     "
echo "======================================"

# ── Step 1: Verify required and optional dependencies ──────────────────────
echo "[1/4] Checking dependencies..."

if [ -z "${IMAGE_REF:-}" ]; then
    echo "Error: IMAGE_REF is required and must be an immutable image digest."
    exit 1
fi
if ! printf '%s' "$IMAGE_REF" | grep -Eq "$IMAGE_REF_PATTERN"; then
    echo "Error: IMAGE_REF must be ghcr.io/kelvitz716/poultryproject@sha256:<64 lowercase hex characters>."
    exit 1
fi
export IMAGE_REF

if ! command -v docker &> /dev/null; then
    echo "Error: docker is not installed. Please install Docker first."
    exit 1
fi

# Tailscale Serve is mandatory: it provides the only HTTPS entry point.
if ! command -v tailscale &> /dev/null; then
    echo "Error: Tailscale is required for the private HTTPS deployment."
    exit 1
fi

# ── Step 2: Prepare the SQLite data directory ──────────────────────────────
# The ./data directory is bind-mounted into /app/data. It is private to the
# deployment account, and an ephemeral root helper repairs ownership for
# legacy files created by earlier root-running images.
echo "[2/4] Setting up data directory..."
umask 077
mkdir -p data
export PUID="$(id -u)"
export PGID="$(id -g)"

# ── Step 3: Back up, pull, and start the pinned Docker Compose stack ───────
# Never build from whatever source happens to exist on the host. The exact
# immutable image digest was selected before this script was invoked.
# Supports both the new `docker compose` (plugin) and legacy `docker-compose` (standalone).
echo "[3/4] Backing up, pulling, and starting pinned Docker Compose stack..."
docker pull "$IMAGE_REF"
# This one-shot migration has no network access and touches only ./data. The
# long-running application container remains non-root and capability-free.
if docker inspect --format '{{.State.Running}}' poultry-dss 2>/dev/null | grep -qx true; then
    PREVIOUS_IMAGE_REF=$(docker inspect --format '{{.Config.Image}}' poultry-dss)
    PREVIOUS_IMAGE_ID=$(docker inspect --format '{{.Image}}' poultry-dss)
    echo "Creating a consistent pre-deploy SQLite backup..."
    docker exec poultry-dss node scripts/admin.js db-backup
    docker stop poultry-dss
fi
if ! docker run --rm --network none --user 0:0 -v "$PWD/data:/app/data:Z" "$IMAGE_REF" \
    sh -ec "chown -R $PUID:$PGID /app/data && chmod -R go-rwx /app/data"; then
    rollback_previous || true
    exit 1
fi
if ! compose_up || ! verify_running_image || ! wait_for_healthy; then
    rollback_previous || true
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
