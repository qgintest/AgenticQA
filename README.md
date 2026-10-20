# AgenticQA

A locally hosted agentic QA automation platform (portfolio project).

| Directory | Purpose | Status |
|---|---|---|
| [`aut/`](aut) | Application Under Test: Medusa 2.21.2 backend + admin, Next.js storefront, Postgres, Redis (Docker Compose) | ✅ |
| [`automation/`](automation) | Playwright + TypeScript regression suite (UI + API), CI in `.github/workflows/regression.yml` | ✅ |
| [`agents/`](agents) | Agentic QA services. [`failure-triage/`](agents/failure-triage): AI triage of failed CI runs (Claude API), with a manually run [eval suite](agents/failure-triage/README.md#evaluation) | ✅ triage · self-healing planned |
| [`docs/`](docs) | Setup and version documentation | ✅ |

Automation and agents interact with the AUT only via its UI and HTTP APIs; they never import `aut/` code.

## Quick start

```bash
cd aut
sh scripts/init-env.sh
docker compose up --build -d postgres redis medusa
sh scripts/create-admin.sh        # credentials in aut/.env
sh scripts/get-publishable-key.sh
docker compose up -d storefront
```

- Storefront: http://localhost:8000
- Admin: http://localhost:9000/app
- API: http://localhost:9000

## Regression tests

```bash
cd automation
npm ci && npx playwright install chromium
npm test              # full suite; report: npm run report
```

More examples (single tests, tags, UI/debug mode, traces): [automation/README.md](automation/README.md#examples)

Full instructions: [docs/setup.md](docs/setup.md) · Versions: [docs/versions.md](docs/versions.md)
