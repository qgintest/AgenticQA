#!/usr/bin/env sh
# Read the publishable API key created by the initial data seed and write it
# into apps/storefront/.env.local. Run after the medusa service is healthy.
set -e
cd "$(dirname "$0")/.."
. ./.env

KEY=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "select token from api_key where type = 'publishable' and revoked_at is null and deleted_at is null order by created_at limit 1;" | tr -d '\r[:space:]')

if [ -z "$KEY" ]; then
  echo "No publishable key found. Is the backend migrated/seeded?" >&2
  exit 1
fi

ENV_FILE=apps/storefront/.env.local
if grep -q '^NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=' "$ENV_FILE"; then
  sed -i "s|^NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=.*|NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=$KEY|" "$ENV_FILE"
else
  echo "NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=$KEY" >> "$ENV_FILE"
fi
echo "Publishable key written to $ENV_FILE"
echo "Now run: docker compose up -d storefront"
