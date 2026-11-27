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
exec node server.mjs "$@"
