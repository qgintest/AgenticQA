#!/bin/sh
set -e
cd /server/apps/storefront

if [ -z "${NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY}" ]; then
  echo "[aut] NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY is not set."
  echo "[aut] Run ./scripts/get-publishable-key.sh from aut/, then: docker compose up -d storefront"
  exit 1
fi

echo "[aut] Starting Next.js storefront development server..."
exec pnpm dev
