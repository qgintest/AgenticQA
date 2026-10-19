#!/usr/bin/env sh
# Create the local admin user from ADMIN_EMAIL / ADMIN_PASSWORD in aut/.env.
# Run after the medusa service is healthy. Safe to re-run (reports if the user exists).
set -e
cd "$(dirname "$0")/.."
. ./.env
: "${ADMIN_EMAIL:?set ADMIN_EMAIL in aut/.env}"
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD in aut/.env}"

docker compose exec -T medusa sh -c \
  "cd /server/apps/backend && pnpm exec medusa user -e '$ADMIN_EMAIL' -p '$ADMIN_PASSWORD'"
echo "Admin user: $ADMIN_EMAIL (password in aut/.env)"
