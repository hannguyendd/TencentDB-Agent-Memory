# Team Memory Control Web

The web management UI for Team Memory Control, which talks to the stateless Control service in the same repo.

## Tech Stack

- React 18
- TypeScript
- Vite
- React Router
- Zustand
- Tailwind CSS

## Local Development

First start Control from the repo root:

```bash
pnpm install
cp .env.example .env
cp config/metadata-instances.example.json config/metadata-instances.json
pnpm dev
```

Then start the frontend:

```bash
cd web
npm install
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173` in a browser.

## Dev Proxy

Defaults in `vite.config.ts`:

| Request prefix | Default target | Environment variable |
|----------|----------|----------|
| `/api/v1`, `/health` | `http://127.0.0.1:8123` | `VITE_TMC_BACKEND_URL` |
| `/v3` | `http://127.0.0.1:8420` | `VITE_SKILL_GATEWAY_URL` |

To connect to another development environment, use the actual addresses in the uncommitted `web/.env`. Do not put internal addresses, accounts or credentials in the README, source code or tracked env files.

## Build

```bash
npm run build
```

The output is generated into `web/dist/`. Control can serve these static files same-origin via `UI_DIST_DIR=./web/dist`.

## API Boundary

The frontend uses the following Control APIs:

- `/api/v1/meta/*`
- `/api/v1/skill/*`
- `/api/v1/chat-memory/*`
- `/api/v1/knowledge/*`
- `/api/v1/agent-overview/*`
- `/api/v1/agent/*`

Login credentials are stored in the browser `localStorage`, and business requests are sent with the `X-Tdai-Service-Id` and `X-Tdai-User-Key` headers. The frontend must not log, display or upload the full credentials.

API integration follows the public contracts under `docs/api/` in the repo; external service interfaces not listed in the public contracts are outside the scope of frontend integration.

## Common Commands

| Command | Description |
|------|------|
| `npm run dev` | Start the dev server |
| `npm run build` | Type-check and build |
| `npm run preview` | Preview the build output |
| `npm run lint:check` | Run ESLint checks |
| `npm run format:check` | Check formatting |
