#!/bin/sh
# Once the CMS's memory use passes a threshold, restart its workerd runtime in
# place: SIGUSR2 makes server.mjs replace the workerd process and keep its own,
# so the CMS serves again within seconds and the container keeps running.
# Meant for cron; silent unless it acts. compose.yaml's mem_limit is the hard
# backstop, for growth between checks or in the Node process itself.
#
#   sh ~/worker-cms/docker/memory-check.sh [MiB]     (default 720)
#
# Every 5 minutes from cron:
#
#   */5 * * * * sh "$HOME/worker-cms/docker/memory-check.sh" >> "$HOME/cms-memory.log" 2>&1
set -eu
cd "$(dirname "$0")/.."

threshold=${1:-720}
# Do not restart again this soon after the last start or restart, so a CMS
# whose normal use sits above the threshold is not restarted every few minutes.
grace_seconds=900
# When this script last restarted the runtime (the container start time does
# not change on an in-place restart).
state=${XDG_STATE_HOME:-$HOME/.local/state}/cms-memory-check.last

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
used_mib() {
  current=$(cat "$cgroup/memory.current")
  inactive=$(awk '$1 == "inactive_file" { print $2 }' "$cgroup/memory.stat")
  echo $(( (current - inactive) / 1048576 ))
}
used=$(used_mib)
[ "$used" -ge "$threshold" ] || exit 0

last=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$container")" +%s)
if [ -f "$state" ]; then
  restarted=$(date -r "$state" +%s)
  [ "$restarted" -gt "$last" ] && last=$restarted
fi
since=$(( $(date +%s) - last ))
if [ "$since" -lt "$grace_seconds" ]; then
  echo "$(date '+%F %T') CMS uses $used MiB (threshold $threshold MiB) but (re)started $((since / 60)) min ago; not restarting yet."
  exit 0
fi

echo "$(date '+%F %T') CMS uses $used MiB (threshold $threshold MiB); restarting the workerd runtime."
mkdir -p "$(dirname "$state")"
touch "$state"
docker compose kill -s SIGUSR2 cms >/dev/null 2>&1
sleep 10
echo "$(date '+%F %T') CMS now uses $(used_mib) MiB."
