# syntax=docker/dockerfile:1.7
# AisleForge images (one Dockerfile, three targets):
#   docker build --target api    -t aisleforge/api:<tag> .
#   docker build --target worker -t aisleforge/worker:<tag> .
#   docker build --target web    -t aisleforge/web:<tag> .
# Images run as non-root, carry no secrets (all configuration is injected at runtime) and include health checks.

# ---------- build: install the workspace, bundle the servers, build the PWA --------------------------------------
FROM node:22.12.0-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# Pinned pnpm via npm (the corepack bundled with Node 22.12 fails to verify current pnpm release signatures).
RUN npm install -g pnpm@10.34.9 --no-audit --no-fund
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/cache/package.json packages/cache/
COPY packages/database/package.json packages/database/
COPY packages/domain/package.json packages/domain/
COPY packages/events/package.json packages/events/
COPY packages/routing/package.json packages/routing/
COPY packages/shared/package.json packages/shared/
COPY packages/validation/package.json packages/validation/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY tools tools
COPY migrations migrations
RUN node tools/build/bundle.mjs && pnpm --filter @aisleforge/web build

# ---------- runtime base: only the native modules the bundles keep external ---------------------------------------
FROM node:22.12.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Security updates for the Debian base, then the two native modules, then REMOVE the package managers: the runtime
# never installs anything, and the npm CLI's own bundled dependencies (tar, glob, minimatch, cross-spawn, sigstore…)
# plus the stale base packages failed the CI Trivy gate (8 CRITICAL / 86 HIGH, Phase 10 final run).
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && printf '{"name":"aisleforge-runtime","private":true,"type":"module"}' > package.json \
 && npm install --omit=dev --no-audit --no-fund --no-save \
      @confluentinc/kafka-javascript@1.11.0 @node-rs/argon2@2.2.2 \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
      /root/.npm
COPY --from=build /src/migrations ./migrations
COPY audit/load-tests/invariants.sql ./invariants.sql
ENV MIGRATIONS_DIR=/app/migrations INVARIANTS_FILE=/app/invariants.sql
USER node

# ---------- api --------------------------------------------------------------------------------------------------
FROM runtime AS api
COPY --from=build --chown=node:node /src/dist/server/api.mjs /src/dist/server/init-db.mjs /src/dist/server/load-seed.mjs ./
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "api.mjs"]

# ---------- worker -----------------------------------------------------------------------------------------------
FROM runtime AS worker
COPY --from=build --chown=node:node /src/dist/server/worker.mjs /src/dist/server/init-db.mjs ./
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_STATUS_PORT||8081)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "worker.mjs"]

# ---------- web: static PWA + same-origin reverse proxy to the API ----------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.31.7-alpine AS web
# The 1.27.3 base carried 3 CRITICAL / 37 HIGH fixable CVEs (Trivy, 2026-11-22); stable 1.30.6 still had 4 CRITICAL in
# nginx itself (fixed in 1.30.7, not yet published). Mainline 1.31.7 (nginx.org's recommended branch) + Alpine
# security updates at build time. CI's Trivy gate fails the build on any fixable CRITICAL.
USER root
RUN apk upgrade --no-cache
USER 101
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
ENV API_UPSTREAM=api:8080 NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
