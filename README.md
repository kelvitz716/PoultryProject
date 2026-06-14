# Poultry DSS — Kitale Modernization

A knowledge-based **Decision Support System (DSS)** built for commercial poultry farmers in the Kitale region. It models infrastructure, tracks flock health and financials, and provides real-time environmental monitoring through IoT sensor integration.

---

## ✨ Features

| Feature | Description |
|---|---|
| **Flock Lifecycle Tracking** | Tracks bird age against Kenchic lifecycle milestones; generates early warnings for growth delays and Point-of-Lay readiness |
| **Environmental Monitoring** | Reads live temperature/humidity from a Tuya IoT sensor and auto-fills daily logs; 7-day historical backfill via cloud API |
| **Financial Projections** | Dynamic OPEX/CAPEX projections and a Pricing Assistant tool based on operational inputs |
| **Biosecurity & Health** | Automated prompts for Kenchic vaccination schedules, dewormers, and litter replacement cycles |
| **Persistent Local Database** | SQLite with WAL mode — designed for edge/rural environments with intermittent internet |
| **Offline-Ready PWA** | Service worker implements cache-first strategy; app functions fully without connectivity |
| **CI/CD Pipeline** | Every `git push` to `master` builds a multi-arch Docker image and deploys it automatically to OCI |

---

## 🏗️ Architecture

```
┌──────────────────────────────────────┐
│             Browser (PWA)            │
│  HTML/CSS/JS  ◄──►  Service Worker   │
└──────────────┬───────────────────────┘
               │ HTTP (LAN / Tailscale)
┌──────────────▼───────────────────────┐
│         Express.js Backend           │
│  ┌────────────┐  ┌─────────────────┐ │
│  │  REST API  │  │  Tuya Sync Loop │ │  ← every 15 min
│  └─────┬──────┘  └────────┬────────┘ │
│        │                  │           │
│  ┌─────▼──────────────────▼────────┐ │
│  │          SQLite (WAL)            │ │
│  └─────────────────────────────────┘ │
└──────────────────────────────────────┘
               │ Cloud API (HTTPS)
┌──────────────▼───────────────────────┐
│         Tuya Cloud  (openapi.tuyaeu) │
│   /v1.0/token  /v1.0/devices/status  │
│   /v1.0/devices/logs  (7-day history)│
└──────────────────────────────────────┘
```

See [`docs/`](./docs/) for full technical specifications.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, Vanilla CSS, Vanilla JavaScript |
| Backend | Node.js 20, Express.js |
| Database | SQLite 3 (WAL mode, `./data/poultry.db`) |
| IoT | Tuya Cloud OpenAPI (HMAC-SHA256 signed requests) |
| Containerisation | Docker, Docker Compose |
| CI/CD | GitHub Actions — build multi-arch image → push to ghcr.io → SSH deploy to OCI |
| VPN | Tailscale (GitHub Actions ↔ OCI connectivity) |
| Hosting | Oracle Cloud Infrastructure (OCI) Ampere A1 (ARM64) |

---

## 🚀 Quick Start

### Option 1 — Docker (Recommended for production)

```bash
# Pull the pre-built image and start the stack
docker compose up -d
```

Access the app at **http://localhost:8089**

> The `docker-compose.yml` references the pre-built `ghcr.io/kelvitz716/poultryproject:latest` image.
> For local development with live code changes, comment the `image:` line and uncomment `build:`.

### Option 2 — Node.js (Local development)

```bash
# Install dependencies
npm install

# Start the development server
npm start
```

Access the app at **http://localhost:80** (or set `PORT=8089` in your `.env`).

---

## ⚙️ Environment Variables

Create a `.env` file in the project root (never commit this file):

```ini
# Server
PORT=80

# Tuya IoT Sensor Integration (optional — app works without it)
TUYA_CLIENT_ID=your_client_id_here
TUYA_CLIENT_SECRET=your_client_secret_here
TUYA_DEVICE_ID=your_device_id_here
TUYA_REGION=eu          # eu | us | cn | in
```

---

## 📁 Project Structure

```
PoultryProject/
├── .github/
│   └── workflows/
│       └── deploy.yml      # CI/CD: build multi-arch image + deploy to OCI
├── assets/                 # Static icons, images, media
├── css/                    # Decoupled CSS variables and grid layouts
├── data/                   # SQLite database (gitignored, persisted via Docker volume)
├── docs/                   # Technical specs, backlog, handover documents
├── js/
│   ├── api.js              # Frontend API client — wraps all backend REST calls
│   └── app.js              # Main frontend controller and DOM logic
├── scripts/                # Utility/maintenance scripts
├── tests/
│   └── e2e.js              # Playwright end-to-end test suite (27 tests)
├── db.js                   # SQLite connection, WAL setup, schema definitions
├── docker-compose.yml      # Docker Compose stack definition
├── Dockerfile              # Multi-stage Node.js 20 Alpine container build
├── deploy.sh               # One-shot manual deployment script (Tailscale + Docker)
├── index.html              # Single-page application shell
├── manifest.json           # PWA web app manifest
├── package.json            # Node.js dependencies and scripts
├── server.js               # Express backend — all REST API routes + Tuya sync loop
└── service-worker.js       # PWA offline caching (cache-first for assets, bypass for /api/)
```

---

## 🌡️ Tuya IoT Integration

The system integrates with a Tuya-compatible temperature/humidity sensor to automatically populate daily logs.

**Live sync** — runs every 15 minutes on server startup:
```
GET /v1.0/token                  → fetch/cache access token
GET /v1.0/devices/{id}/status    → read live va_temperature / va_humidity
→ store in SQLite entities['live_sensors']
→ auto-fill today's log for the active batch (EAT / UTC+3)
```

**Historical backfill** — query up to 7 days back (Tuya free tier limit):
```
GET /api/sensors/tuya-history?date=YYYY-MM-DD
→ fetches paginated cloud logs for the given EAT day
→ returns { avg, min, max, count } for temperature and humidity
```

**Signature algorithm:** All requests use HMAC-SHA256 with alphabetically sorted query parameters, as required by the Tuya Cloud OpenAPI specification.

---

## 🔄 CI/CD Pipeline

Every push to `master` triggers the GitHub Actions workflow:

```
git push master
    │
    ▼
[build job]
  ├─ Checkout code
  ├─ Set up QEMU (ARM64 emulation)
  ├─ Set up Docker Buildx
  ├─ Log in to ghcr.io
  └─ Build & push linux/amd64 + linux/arm64 image
         → ghcr.io/kelvitz716/poultryproject:latest
         → ghcr.io/kelvitz716/poultryproject:<sha>
    │
    ▼
[deploy job]
  ├─ Connect to Tailscale VPN
  ├─ SCP docker-compose.yml → OCI
  └─ SSH into OCI:
       docker pull ghcr.io/kelvitz716/poultryproject:latest
       docker compose up -d --force-recreate poultry-dss
       docker image prune -f
```

**Required GitHub Secrets:**

| Secret | Description |
|---|---|
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID (tag: `tag:ci`) |
| `TS_OAUTH_SECRET` | Tailscale OAuth secret |
| `OCI_SSH_KEY` | Private SSH key for `opc@100.68.227.114` |

---

## 🧪 Testing

Run the full Playwright end-to-end test suite (requires the server to be running):

```bash
npm test
# or directly:
node tests/e2e.js
```

The suite covers 27 scenarios across proposals, batches, logs, transactions, health records, exports, and the Tuya sensor API.

---

## 🖥️ Target Hardware

- **Production:** Oracle Cloud Infrastructure Ampere A1 (ARM64, 4 OCPUs, 24 GB RAM) at `100.68.227.114`
- **Development:** HP EliteBook 840 G3 (i5-6200U, 16 GB RAM) running Linux

---

## 📜 License

All rights reserved © Kelvitz, 2026.
