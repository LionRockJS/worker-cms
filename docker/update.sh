#!/bin/sh
# Update a self-hosted CMS to the newest published image.
#
#   sh ~/worker-cms/docker/update.sh
#
# Pulls this checkout (compose.yaml, the nginx site, tools), pulls the image
# compose.yaml names (ghcr.io/lionrockjs/0xcms:${CMS_TAG:-development}),
# recreates the container if the image changed, and waits until the CMS
# answers. Migrations run as the new container starts.
set -eu
cd "$(dirname "$0")/.."

# The commit an image was built from, as its short sha-<commit> tag uses it.
revision() {
  docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null | cut -c1-7
}

before=$(revision "$(docker compose config --images)")

git pull --ff-only
# compose.yaml or CMS_TAG in .env may have changed with the pull.
image=$(docker compose config --images)
docker compose pull
after=$(revision "$image")
docker compose up -d

address=$(docker compose port cms 8787)
tries=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' "http://$address/auth/login")" = 200 ]; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "The CMS did not answer within 2 minutes. Recent log:" >&2
    docker compose logs --tail 30 cms >&2
    if [ -n "$before" ] && [ "$before" != "$after" ]; then
      echo "To go back to the previous build: set CMS_TAG=sha-$before in .env, then run docker compose up -d" >&2
    fi
    exit 1
  fi
  sleep 2
done

# Images replaced by the pull are left untagged; remove them.
docker image prune -f >/dev/null

if [ "$before" = "$after" ]; then
  echo "Already up to date: $image (${after:-unknown commit})."
else
  echo "Updated $image: ${before:-unknown} -> $after. Serving."
fi
