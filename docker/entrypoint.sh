#!/bin/sh
# Derive the origin settings from BASE_URL, apply migrations, then serve.
set -eu

BASE_URL="${BASE_URL:-${CANONICAL_ORIGIN:-http://localhost:${PORT}}}"
export CANONICAL_ORIGIN="${BASE_URL%/}"
export OAUTH_REDIRECT_URI="$CANONICAL_ORIGIN/auth/callback"

if [ -z "${JWT_SECRET:-}" ]; then
  echo "JWT_SECRET is required (openssl rand -hex 32)." >&2
  exit 1
fi

# The image ships migrations already built from cms.features.json, so apply
# them directly (what tools/migrate-local.mjs does after rebuilding them).
node_modules/.bin/wrangler d1 migrations apply DB --local
if node -e "process.exit(JSON.parse(require('fs').readFileSync('cms.features.json', 'utf8')).features?.publish ? 0 : 1)"; then
  node_modules/.bin/wrangler d1 migrations apply PUBLISHED_DB --local
fi

# CMS_RUNTIME=workerd: Node only writes config.capnp, then exits, and workerd
# serves without Miniflare (about 220 MiB less memory). Media previews are
# resized by docker/resize.mjs on RESIZE_PORT (default 8789; 0 turns it off and
# previews fall back to the originals); see docker/workerd.sh. The default runs
# everything under Miniflare (server.mjs).
if [ "${CMS_RUNTIME:-miniflare}" = workerd ]; then
  RESIZE_PORT=${RESIZE_PORT:-8789}
  [ "$RESIZE_PORT" = 0 ] && RESIZE_PORT=""
  export RESIZE_PORT
  node server-workerd.mjs
  exec sh docker/workerd.sh
fi
exec node server.mjs "$@"
