# Poultry DSS — Kitale Modernization

Poultry DSS is a knowledge-based Decision Support System (DSS) designed to help poultry farmers model infrastructure, track financials, and manage bird health for sustainable farm growth. It provides a full lifecycle tracking system for ISA Brown commercial layers and broilers, specifically localized for the Kitale region.

## Features

- **Lifecycle Synchronization:** Tracks bird age against standard Kenchic lifecycle milestones. Generates early warning alerts for growth delays or skeletal readiness prior to Point of Lay.
- **Environmental Engineering:** Monitors seasonal logic (Dry/Long Rains) and alerts on coccidiosis/respiratory risks based on humidity. Warns when house curtains should be closed during cold nights.
- **Financial Projections:** Provides dynamic OPEX/CAPEX projections and "Pricing Assistant" tools based on ongoing operational inputs.
- **Persistent Local Database:** Robust SQLite database designed to withstand edge environments.
- **Biosecurity & Health:** Automated prompts for Kenchic vaccination schedules and litter replacement cycles.

## Tech Stack

- **Frontend:** HTML5, CSS3 (Vanilla), JavaScript
- **Backend:** Node.js, Express.js
- **Database:** SQLite
- **Deployment:** Docker & Docker Compose

## Quick Start

### Using Docker (Recommended)

1. Ensure Docker and Docker Compose are installed.
2. Clone the repository and navigate to the root directory.
3. Start the system:
   ```bash
   docker-compose up -d
   ```
4. Access the web interface at `http://localhost:3000` (or whatever port you mapped in the `docker-compose.yml`).

### Using Node.js directly

1. Ensure Node.js (v18+) is installed.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the backend server:
   ```bash
   npm start
   ```
4. Access the web interface at `http://localhost`.

## Project Structure

- `/css` — Decoupled CSS variables and grid structures.
- `/js` — Vanilla JavaScript controllers and DOM manipulation (`app.js`).
- `/assets` — Static icon libraries, image dependencies, and demonstrational media.
- `/docs` — Technical specifications, backlog, and handover documents.
- `server.js` & `db.js` — Node.js Express backend and SQLite database connection.

## Target Hardware
Designed to run efficiently on low-to-mid tier hardware:
- Target: HP EliteBook 840 G3 (i5-6200U, 16GB RAM) running Linux.

## License

All rights reserved.
