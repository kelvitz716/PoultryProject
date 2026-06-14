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
#   bash deploy.sh
#
# PREREQUISITES:
#   - Docker (required)
#   - Tailscale (optional — skipped gracefully if absent)
#   - A valid .env file with Tuya credentials (if sensor integration is needed)
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

# Tailscale is optional — if absent, skip funnel setup but continue the deploy.
if ! command -v tailscale &> /dev/null; then
    echo "Warning: tailscale is not installed. Funnel setup will be skipped."
    TAILSCALE_INSTALLED=false
else
    TAILSCALE_INSTALLED=true
fi

# ── Step 2: Prepare the SQLite data directory ──────────────────────────────
# The ./data directory is bind-mounted into the container as /app/data.
# chmod 777 ensures the Node.js process (running as a non-root user inside
# the container) can write to the SQLite database on the host filesystem.
echo "[2/4] Setting up data directory..."
mkdir -p data
chmod 777 data || true  # Ignore failure (already correct permissions)

# ── Step 3: Build and start the Docker Compose stack ──────────────────────
# Uses `--build` to rebuild the image from the local Dockerfile.
# In normal CI/CD deployments, the pre-built ghcr.io image is pulled instead.
# Supports both the new `docker compose` (plugin) and legacy `docker-compose` (standalone).
echo "[3/4] Starting Docker Compose stack..."
if docker compose version &> /dev/null; then
    docker compose up --build -d
else
    docker-compose up --build -d
fi

# ── Step 4: Configure Tailscale Funnel (optional) ─────────────────────────
# Tailscale Serve: exposes port 8089 on the tailnet (private VPN).
# Tailscale Funnel: additionally exposes it on the public internet via a
# stable *.ts.net HTTPS URL with automatic TLS — no reverse proxy needed.
echo "[4/4] Configuring Tailscale Funnel..."
if [ "$TAILSCALE_INSTALLED" = true ]; then
    echo "Setting up Tailscale to proxy traffic to port 8089..."

    # Only configure funnel if Tailscale is authenticated and connected.
    if tailscale status &> /dev/null; then
        # Serve the local port 8089 on the tailnet (background mode)
        tailscale serve --bg --set-path / http://127.0.0.1:8089

        # Expose the serve endpoint on the public internet
        tailscale funnel --bg on

        echo "Tailscale Funnel configured successfully."

        # Extract and print the public HTTPS URL for convenience
        HOSTNAME=$(tailscale status --json | grep -o '"Target": ".*"' | head -1 | cut -d'"' -f4)
        if [ ! -z "$HOSTNAME" ]; then
            echo ""
            echo "Your Poultry DSS is now publicly available at:"
            echo "https://$HOSTNAME"
            echo ""
        fi
    else
        echo "Warning: Tailscale is installed but not connected."
        echo "Run 'sudo tailscale up' first, then re-run this script."
    fi
else
    echo "Skipped Tailscale funnel configuration."
    echo "Your application is running locally on http://127.0.0.1:8089"
fi

echo "======================================"
echo "        Deployment Complete!          "
echo "======================================"
