#!/usr/bin/env sh
# Create local .env files from templates (never overwrites existing files).
# Replaces __GENERATE__ placeholders with random hex secrets.
set -e
cd "$(dirname "$0")/.."

gen() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"; }

init() {
  src="$1"; dst="$2"
  if [ -f "$dst" ]; then
    echo "skip   $dst (exists)"
    return
  fi
  tr -d '\r' < "$src" > "$dst"
  while grep -q '__GENERATE__' "$dst"; do
    sed -i "0,/__GENERATE__/s//$(gen 32)/" "$dst"
  done
  echo "create $dst"
}

init .env.example .env
init apps/backend/.env.template apps/backend/.env
init apps/storefront/.env.template apps/storefront/.env.local
