#!/bin/sh
# Snapshot the running CMS's D1 databases into a dated folder, then delete
# snapshot folders older than the retention period. Runs d1-snapshot.mjs in a
# throwaway container from the CMS's own image; the CMS keeps running.
#
#   sh ~/worker-cms/docker/d1-snapshot.sh [folder] [days-to-keep]
#
# Defaults: ~/cms-snapshots, 30 days. Each run adds <folder>/<YYYY-MM-DD_HHMM>/
# with cms.sqlite and cms-published.sqlite. Nightly at 03:00 from cron:
#
#   0 3 * * * sh "$HOME/worker-cms/docker/d1-snapshot.sh" >> "$HOME/cms-snapshots.log" 2>&1
set -eu
cd "$(dirname "$0")/.."

root=${1:-$HOME/cms-snapshots}
keep=${2:-30}

container=$(docker compose ps -q cms)
if [ -z "$container" ]; then
  echo "$(date '+%F %T') The CMS container is not running; nothing to snapshot." >&2
  exit 1
fi
image=$(docker inspect -f '{{.Config.Image}}' "$container")
volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/.wrangler/state"}}{{.Name}}{{end}}{{end}}' "$container")

out="$root/$(date +%Y-%m-%d_%H%M)"
mkdir -p "$out"
if ! docker run --rm -u "$(id -u):$(id -g)" \
  -v "$volume":/data -v "$out":/out -v "$PWD/docker":/tools:ro \
  --entrypoint node "$image" --no-warnings /tools/d1-snapshot.mjs >/dev/null; then
  rm -rf "$out"
  echo "$(date '+%F %T') Snapshot failed." >&2
  exit 1
fi

# Only folders this script names are ever deleted.
find "$root" -mindepth 1 -maxdepth 1 -type d -mtime +"$keep" \
  -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9][0-9][0-9]' \
  -exec rm -rf {} +

echo "$(date '+%F %T') Snapshot $out ($(du -sh "$out" | cut -f1)); $(ls "$root" | wc -l) kept."
