#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "======================================"
echo "    Poultry DSS Deployment Script     "
echo "======================================"

# 1. Check dependencies
echo "[1/4] Checking dependencies..."

if ! command -v docker &> /dev/null; then
    echo "Error: docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v tailscale &> /dev/null; then
    echo "Warning: tailscale is not installed. Funnel setup will be skipped."
    TAILSCALE_INSTALLED=false
else
    TAILSCALE_INSTALLED=true
fi

# 2. Setup Data Directory
echo "[2/4] Setting up data directory..."
mkdir -p data
# Ensure correct permissions for the SQLite db to be writable by the container if necessary
chmod 777 data || true

# 3. Bring up Docker container
echo "[3/4] Starting Docker Compose stack..."
# Fallback to docker-compose if docker compose is not available
if docker compose version &> /dev/null; then
    docker compose up --build -d
else
    docker-compose up --build -d
fi

# 4. Configure Tailscale Funnel
echo "[4/4] Configuring Tailscale Funnel..."
if [ "$TAILSCALE_INSTALLED" = true ]; then
    echo "Setting up Tailscale to proxy traffic to port 8089..."
    
    # Check if tailscale is actually connected
    if tailscale status &> /dev/null; then
        # Serve the local port 8089 on the tailnet
        tailscale serve --bg --set-path / http://127.0.0.1:8089
        
        # Turn on funnel to expose it to the public internet
        tailscale funnel --bg on
        
        echo "Tailscale Funnel configured successfully."
        
        # Print the public URL
        HOSTNAME=$(tailscale status --json | grep -o '"Target": ".*"' | head -1 | cut -d'"' -f4)
        if [ ! -z "$HOSTNAME" ]; then
            echo ""
            echo "Your Poultry DSS is now publicly available at:"
            echo "https://$HOSTNAME"
            echo ""
        fi
    else
        echo "Warning: Tailscale is installed but not connected. Please run 'sudo tailscale up' first."
    fi
else
    echo "Skipped Tailscale funnel configuration."
    echo "Your application is running locally on http://127.0.0.1:8089"
fi

echo "======================================"
echo "        Deployment Complete!          "
echo "======================================"
