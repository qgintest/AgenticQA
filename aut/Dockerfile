# syntax=docker/dockerfile:1
# Development image for the AUT (Medusa backend + admin, Next.js storefront).
# Source is bind-mounted at runtime; dependencies are installed into the image
# and preserved via anonymous volumes (see docker-compose.yml).
FROM node:22.23.3-alpine3.24

WORKDIR /server

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm && corepack prepare pnpm@10.11.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/storefront/package.json ./apps/storefront/

# Keep the pnpm store out of the image layer (BuildKit cache mount)
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --package-import-method=copy

COPY . .

# Guard against CRLF line endings from Windows checkouts
RUN sed -i 's/\r$//' docker/*.sh && chmod +x docker/*.sh

EXPOSE 9000 5173 8000

ENTRYPOINT ["/bin/sh", "/server/docker/start-backend.sh"]
