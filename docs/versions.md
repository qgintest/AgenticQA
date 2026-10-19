# Pinned versions

Verified against the official Medusa docs on 2026-10-16.

| Component | Version | Where pinned | Notes |
|---|---|---|---|
| Medusa (`@medusajs/*`) | **2.21.2** | `aut/apps/*/package.json` (exact) | `latest` dist-tag at setup time |
| create-medusa-app | 2.21.2 | one-off scaffold | template: `medusajs/dtc-starter` |
| Next.js Starter Storefront | `@dtc/storefront` 1.0.3, Next 15.5.24, React 19.0.5 | `aut/apps/storefront/package.json` | |
| Node.js (containers) | 22.23.3 (`node:22.23.3-alpine3.24`) | `aut/Dockerfile` | Starter requires `>=22.22.0`; Node 20 is EOL |
| Node.js (host) | 24.x works | — | Storefront supports up to Node 24 |
| pnpm | **10.11.1** | `packageManager` in all `package.json` + Dockerfile | pnpm 11+/12 ignores `pnpm.overrides` in `package.json` and fails the frozen install of the starter lockfile |
| PostgreSQL | 15.14 (`postgres:15.14-alpine`) | `aut/docker-compose.yml` | Matches official Docker guide (15) |
| Redis | 7.4 (`redis:7.4-alpine`) | `aut/docker-compose.yml` | |
| Playwright (`@playwright/test`) | 1.63.0 (Chromium) | `automation/package.json` (exact) | 1.64.x was <2 weeks old at setup |
| TypeScript (automation) | 6.0.3 | `automation/package.json` | typecheck only; Playwright transpiles tests itself |
| Anthropic SDK (`@anthropic-ai/sdk`) | 0.131.0 | `agents/failure-triage/package.json` (exact) | failure-triage agent; newer releases were <2 weeks old |
| Claude model (triage) | `claude-opus-5-5` | `agents/failure-triage/src/config.ts` (override: `TRIAGE_MODEL`) | adaptive thinking, effort `high` |
| Docker Desktop / Compose | 29.8 / v5.5 | host | |

## Local modifications to upstream starter

- `apps/backend/medusa-config.ts`: SSL disabled for local Postgres, `redisUrl`, admin Vite server bound to `0.0.0.0` with HMR on 5173 (per official Docker guide).
- `apps/storefront/src/lib/config.ts`, `src/middleware.ts`: server-side code prefers `MEDUSA_BACKEND_URL`
  (compose network, `http://medusa:9000`); the browser keeps `NEXT_PUBLIC_MEDUSA_BACKEND_URL` (`http://localhost:9000`).
- `packageManager` changed from the scaffold-detected `pnpm@12.14.0` back to upstream's `pnpm@10.11.1`.

## Upgrading

1. Bump every `@medusajs/*` version in `aut/apps/backend/package.json` and `aut/apps/storefront/package.json` together.
2. `pnpm install` (from `aut/`), commit the lockfile.
3. `docker compose build && docker compose up -d` — migrations run on start.
