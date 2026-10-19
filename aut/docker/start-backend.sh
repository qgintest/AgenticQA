#!/bin/sh
set -e
cd /server/apps/backend

echo "[aut] Running database migrations (includes initial data seed on first run)..."
pnpm exec medusa db:migrate

if [ "${SEED_DEMO_PRODUCTS:-true}" = "true" ]; then
  echo "[aut] Seeding demo products (idempotent)..."
  pnpm exec medusa exec ./src/scripts/seed-demo-products.ts || echo "[aut] Demo seed failed, continuing..."
fi

echo "[aut] Starting Medusa development server..."
exec pnpm dev
