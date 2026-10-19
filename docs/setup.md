# AUT setup (Medusa 2.21.2)

All commands run in **Git Bash** from `AgenticQA/aut/` unless noted.

## Prerequisites

- Docker Desktop (WSL2 backend), running, with ~10 GB free disk
- Node.js 22.22+ or 24.x and Git (only needed for editing / IDE support on the host)
- pnpm 10.11.1 via corepack. If `corepack enable` fails with EPERM (Node in `Program Files`):
  ```bash
  mkdir -p "$APPDATA/npm" && corepack enable pnpm --install-directory "$APPDATA\\npm"
  ```

## First-time setup

```bash
# 1. Create local env files from templates (generates secrets; never overwrites)
sh scripts/init-env.sh

# 2. Optional: host dependencies for IDE type-checking (containers install their own)
pnpm install --frozen-lockfile

# 3. Build and start Postgres, Redis and the Medusa backend
docker compose up --build -d postgres redis medusa

# 4. Wait for the backend to become healthy (migrations + seed run on first start)
docker compose logs -f medusa     # Ctrl+C once "Server is ready on port: 9000"

# 5. Create the admin user from ADMIN_EMAIL / ADMIN_PASSWORD in aut/.env (generated, gitignored)
sh scripts/create-admin.sh

# 6. Write the seeded publishable API key into the storefront env, then start it
sh scripts/get-publishable-key.sh
docker compose up -d storefront
```

## Local URLs

| Service | URL |
|---|---|
| Store/Admin REST API | http://localhost:9000 (`/store/*`, `/admin/*`) |
| Health check | http://localhost:9000/health |
| Admin dashboard | http://localhost:9000/app |
| Storefront | http://localhost:8000 (redirects to `/dk`) |
| PostgreSQL | `localhost:5432` (credentials in `aut/.env`) |
| Redis | `localhost:6379` |

## Regression tests

With the stack running:

```bash
cd ../automation
npm ci && npx playwright install chromium
npm test
```

See [automation/README.md](../automation/README.md) for commands, configuration, artifacts and CI.

## Daily use

```bash
docker compose up -d            # start everything
docker compose ps               # status / health
docker compose logs -f medusa   # follow backend logs
docker compose down             # stop (data preserved)
```

## Database

```bash
# Migrations (also run automatically on every backend start)
docker compose exec medusa sh -c "cd apps/backend && pnpm exec medusa db:migrate"

# Generate migrations for a custom module
docker compose exec medusa sh -c "cd apps/backend && pnpm exec medusa db:generate <module>"

# psql shell
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# Full reset (deletes all data), then repeat first-time steps 3–6
docker compose down -v
```

Seeding: the initial store/region/sales-channel/publishable-key data is created by
`apps/backend/src/migration-scripts/initial-data-seed.ts` on first migrate. 50 demo products
are added by `src/scripts/seed-demo-products.ts` on start when `SEED_DEMO_PRODUCTS=true` (idempotent).

## Dependency changes

After editing any `package.json`: `pnpm install` on the host (updates the lockfile), then
`docker compose build && docker compose up -d --renew-anon-volumes` so the containers'
`node_modules` volumes are recreated.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Container exits 127, `start-*.sh: not found` | CRLF line endings. Repo enforces LF via `.gitattributes`; the Dockerfile also strips `\r`. |
| `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` | Wrong pnpm major. Use 10.11.1 (`packageManager` field). |
| Storefront exits: publishable key not set | Run `sh scripts/get-publishable-key.sh` then `docker compose up -d storefront`. |
| Storefront 500 / "Error fetching regions" | Backend not healthy yet, or key invalid. Check `docker compose logs medusa`. |
| Code changes not picked up | Windows bind mounts need polling (`CHOKIDAR_USEPOLLING`, `WATCHPACK_POLLING` are set); restart the service if needed. |
| Build fails with I/O / read-only errors | Host disk full. Free space, restart Docker Desktop. |
| First boot logs `Search index "product" has no active version yet` after "Created 50/50 demo products" | Harmless ordering artifact: the demo seed runs before the server activates the search index; the server indexes all products on start. Does not recur on restart. |
| `An error occurred while processing product-option.created ... reading 'product_id'` | Bug in the upstream starter's search subscriber (`apps/backend/src/search/helpers/resolve-product-ids.ts`) for shared options. Non-fatal; products are created and indexed. |
| Port already in use | Change `POSTGRES_PORT` / `REDIS_PORT` in `aut/.env`; 9000/8000/5173 are fixed. |
