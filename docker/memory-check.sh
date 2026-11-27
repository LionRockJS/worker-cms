#!/bin/sh
# Restart the CMS cleanly once its memory use passes a threshold. Meant for
# cron; silent unless it restarts. compose.yaml's mem_limit is the hard
# backstop for growth between checks.
#
#   sh ~/worker-cms/docker/memory-check.sh [MiB]     (default 720)
#
# Every 5 minutes from cron:
#
#   */5 * * * * sh "$HOME/worker-cms/docker/memory-check.sh" >> "$HOME/cms-memory.log" 2>&1
set -eu
cd "$(dirname "$0")/.."

threshold=${1:-720}
# Do not restart again this soon after a start, so a CMS whose normal use sits
# above the threshold is not restarted every few minutes.
grace_seconds=900

container=$(docker compose ps -q cms)
[ -n "$container" ] || exit 0

id=$(docker inspect -f '{{.Id}}' "$container")
cgroup=""
for dir in "/sys/fs/cgroup/system.slice/docker-$id.scope" "/sys/fs/cgroup/docker/$id"; do
  if [ -r "$dir/memory.current" ]; then cgroup=$dir; break; fi
done
if [ -z "$cgroup" ]; then
  echo "$(date '+%F %T') Cannot read the CMS container's memory cgroup." >&2
  exit 1
fi

# What `docker stats` shows: memory in use, minus page cache the kernel can drop.
current=$(cat "$cgroup/memory.current")
inactive=$(awk '$1 == "inactive_file" { print $2 }' "$cgroup/memory.stat")
used=$(( (current - inactive) / 1048576 ))
[ "$used" -ge "$threshold" ] || exit 0

started=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$container")" +%s)
uptime=$(( $(date +%s) - started ))
if [ "$uptime" -lt "$grace_seconds" ]; then
  echo "$(date '+%F %T') CMS uses $used MiB (threshold $threshold MiB) but started $((uptime / 60)) min ago; not restarting yet."
  exit 0
fi

echo "$(date '+%F %T') CMS uses $used MiB (threshold $threshold MiB); restarting."
docker compose restart cms
