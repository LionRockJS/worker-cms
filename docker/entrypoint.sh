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

node tools/migrate-local.mjs
exec node server.mjs "$@"
