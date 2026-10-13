# Team Memory Control

Team Memory Control is a stateless team memory management console for managing teams, users, Agents, tasks, and their associated Skill, Wiki, Code Graph, and Chat Memory assets.

## Project Positioning

Control is responsible for:

- Providing a web management UI and a public Control API;
- Validating caller credentials and forwarding authorized requests;
- Aggregating metadata, memory assets, and knowledge assets;
- Managing asset assignment, binding, and display.

Control does not store server-side login sessions and does not maintain a local user database. Business data is persisted by external services configured at deployment time.

## Tech Stack

- Backend: Node.js 22+, TypeScript, Hono, tsx
- Frontend: React 18, Vite, TypeScript, Tailwind CSS, Zustand
- Testing: Vitest
- Package management: pnpm (backend) and npm (frontend)

## Directory Structure

```text
src/
├── index.ts                  # Service entry
└── panel/
    ├── config/               # Configuration and instance registry
    ├── domain/               # Domain rules
    ├── http/                 # Middleware and public routes
    ├── infra/                # Infrastructure such as logging
    ├── kernel/               # External service adapters
    └── startup/              # Startup tasks

web/                          # React management UI
config/                       # Instance registry examples and notes
docker/                       # Container build files
docs/api/                     # Public API contracts
scripts/                      # Generation, testing, and security-check scripts
tests/                        # Unit tests and E2E tests
```

## Local Development

### Prerequisites

- Node.js 22 or later
- pnpm
- npm
- An accessible Memory Gateway
- When using Wiki or Code Graph, an accessible Knowledge Service is required

### 1. Install dependencies

```bash
pnpm install
cd web
npm install
cd ..
```

### 2. Prepare configuration

```bash
cp .env.example .env
cp config/metadata-instances.example.json config/metadata-instances.json
```

Edit `config/metadata-instances.json` using the instance ID, Gateway address, and API Key provided by the deployment environment. This file contains credentials, is ignored by Git, and must not be committed.

For environment variable descriptions see `.env.example`; for instance registry field descriptions see `config/metadata-instances.README.md`.

### 3. Start the backend

```bash
pnpm dev
```

Listens on `http://127.0.0.1:8123` by default; the health check is `GET /health`.

### 4. Start the frontend

```bash
cd web
npm run dev
```

Open `http://127.0.0.1:5173` in a browser. The dev server forwards `/api/v1` and `/health` to the local Control by default.

## Common Commands

| Command | Description |
|------|------|
| `pnpm dev` | Start the backend dev server |
| `pnpm build` | Compile the backend to `dist/` |
| `pnpm typecheck` | Run TypeScript type checking |
| `pnpm test` | Run unit tests |
| `pnpm generate:meta-openapi` | Generate the Meta OpenAPI documentation |
| `pnpm test:panel:e2e` | Run Panel Meta E2E |
| `pnpm test:knowledge:e2e` | Run Knowledge E2E |
| `cd web && npm run dev` | Start the frontend dev server |
| `cd web && npm run build` | Build the frontend to `web/dist/` |
| `bash scripts/secret-scan.sh` | Scan for sensitive information |

## Public API

Control's public entry points all live under `/api/v1`:

- `/api/v1/meta/*`: instance, identity, and metadata management
- `/api/v1/skill/*`: Skill management
- `/api/v1/chat-memory/*`: Chat Memory management
- `/api/v1/knowledge/*`: Wiki and Code Graph management
- `/api/v1/agent-overview/*`: Agent asset aggregation
- `/api/v1/agent/*`: Agent lifecycle operations

When integrating, treat the public contracts under `docs/api/` and the route registrations in the source as authoritative. External service interfaces not listed in the public contracts are not part of Control's compatibility commitment.

## Container Deployment

This repository provides a single-service Control image, with the default port `8123`. For build and run instructions see `docker/README.md`.

At deployment, `metadata-instances.json` must be provided via a read-only mount; never write a real API Key into the image, example files, or the repository.

## Security Requirements

- `user_key` is a user credential and may only be passed via request headers; it must not be written to logs, documents, or frontend static assets.
- The `api_key` in the instance registry is only for the server to call external services and must not be returned to the browser.
- `.env`, the real instance registry, Smoke environment files, logs, and test reports must not be committed.
- Documents and examples may only use `example.com`, loopback addresses, and obvious placeholders.
- Run `bash scripts/secret-scan.sh --strict` before committing.

If a credential has ever entered Git history, rotate it immediately and clean the history before publishing the repository.

## Documentation

- Frontend development: `web/README.md`
- Meta API: `docs/api/meta-api.openapi.yaml`
- Knowledge API: `docs/api/knowledge-panel-api.md`
- Chat Memory API: `docs/api/chat-memory.md`
- Docker: `docker/README.md`
