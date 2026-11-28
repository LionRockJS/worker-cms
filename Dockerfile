# 0xCMS under Miniflare (server.mjs) in one container.
#
#   docker build -t worker-cms .
#   docker run -d -p 8787:8787 -v cms-state:/app/.wrangler/state \
#     -e BASE_URL=https://cms.example.com --env-file cms.env worker-cms
#
# BASE_URL is the origin browsers use. CANONICAL_ORIGIN and OAUTH_REDIRECT_URI
# are derived from it at start, so one image serves any host.
#
# Two stages: the build stage has the source and every dev dependency and
# produces dist/ (the Worker bundle and its static assets). The runtime stage
# keeps dist/, the config, the migrations and Wrangler, which brings Miniflare
# and workerd. No source code ships in the final image.

FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY assets-source/package.json assets-source/
RUN npm ci --no-audit --no-fund
# Wrangler's slice of package-lock.json, for the runtime stage's npm ci.
COPY docker/runtime-lock.mjs docker/
RUN node docker/runtime-lock.mjs /runtime

COPY . .
# Each clone's wrangler.toml is gitignored; fall back to the template.
RUN [ -f wrangler.toml ] || cp wrangler.example.toml wrangler.toml

# Optional: docker build --build-arg WORKERS_CI_COMMIT_SHA=$(git rev-parse HEAD)
ARG WORKERS_CI_COMMIT_SHA=""
ENV WRANGLER_SEND_METRICS=false
RUN WORKERS_CI_COMMIT_SHA="$WORKERS_CI_COMMIT_SHA" \
  node_modules/.bin/wrangler deploy --dry-run --outdir dist/worker --config wrangler.toml


FROM node:26-slim

# workerd verifies outbound TLS (OAuth token exchange) against the system store.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN chown node:node /app
USER node

# server.mjs runs the bundle through wrangler. Same versions and integrity
# hashes as the repo's lockfile; see docker/runtime-lock.mjs.
COPY --from=build --chown=node:node /runtime/package.json /runtime/package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/wrangler.toml /app/cms.features.json /app/server.mjs /app/server-workerd.mjs ./
COPY --from=build --chown=node:node /app/tools/local-plugin-views.mjs ./tools/
COPY --chown=node:node docker/entrypoint.sh docker/workerd.sh docker/resize.mjs docker/

ENV WRANGLER_SEND_METRICS=false
# Worker vars and secrets come from the container environment instead of .dev.vars.
ENV CLOUDFLARE_INCLUDE_PROCESS_ENV=true \
    HOST=0.0.0.0 \
    PORT=8787
EXPOSE 8787
# Created as node so a fresh named volume inherits node ownership.
RUN mkdir -p .wrangler/state
VOLUME /app/.wrangler/state
ENTRYPOINT ["sh", "docker/entrypoint.sh"]
