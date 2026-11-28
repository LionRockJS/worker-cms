#!/bin/sh
# Serve the CMS on plain workerd (CMS_RUNTIME=workerd; see entrypoint.sh).
#
# server-workerd.mjs has already written config.capnp. This script stays as the
# container's main process and keeps workerd running without Miniflare's Node
# process beside it (server.mjs keeps ~220 MiB of Node resident). It:
#   - starts workerd and exits with workerd's status if workerd exits;
#   - with RESIZE_PORT set, runs docker/resize.mjs, the small thumbnail service
#     behind the IMAGE_RESIZER binding, and restarts it if it exits;
#   - POSTs to workerd's cron socket every CRON_SECONDS (default 300, aligned
#     to the clock like the "*/5 * * * *" trigger), running the scheduled jobs;
#   - on SIGUSR2, restarts workerd in place (docker/memory-check.sh sends it);
#   - on SIGTERM or SIGINT, stops workerd and exits.
set -eu

resize_port=${RESIZE_PORT:-}
cron_port=${CRON_PORT:-8788}
cron_seconds=${CRON_SECONDS:-300}
workerd=$(node -p "require('workerd').default")

wpid=""
cpid=""
rpid=""
action=""
trap 'action=restart; kill -TERM "$wpid" 2>/dev/null || true' USR2
trap 'action=stop; kill -TERM "$wpid" 2>/dev/null || true' TERM INT

start_workerd() {
  "$workerd" serve --experimental config.capnp &
  wpid=$!
}

# The jobs run inside workerd; node only makes the request and exits.
(
  while :; do
    sleep $(( cron_seconds - $(date +%s) % cron_seconds ))
    node -e "fetch('http://127.0.0.1:$cron_port/', { method: 'POST' })
      .then((r) => console.log('[cron] scheduled jobs', r.ok ? 'ok' : 'HTTP ' + r.status))
      .catch((e) => console.error('[cron] scheduled jobs failed:', e.message))" || true
  done
) &
cpid=$!

if [ -n "$resize_port" ]; then
  (
    trap 'kill "$node_pid" 2>/dev/null || true; exit 0' TERM
    while :; do
      RESIZE_PORT=$resize_port node docker/resize.mjs &
      node_pid=$!
      code=0
      wait "$node_pid" || code=$?
      echo "Thumbnail service exited (status $code); restarting" >&2
      sleep 1
    done
  ) &
  rpid=$!
fi

start_workerd
echo "0xCMS serving on workerd (pid $wpid), served as ${CANONICAL_ORIGIN}; scheduled jobs every ${cron_seconds}s"

while :; do
  # A trapped signal interrupts wait; wait again for workerd to finish exiting.
  status=0
  wait "$wpid" || status=$?
  if [ -n "$action" ]; then
    wait "$wpid" 2>/dev/null || true
  fi
  case $action in
    restart)
      action=""
      start_workerd
      echo "Restarted the workerd runtime (pid $wpid)"
      ;;
    stop)
      kill "$cpid" $rpid 2>/dev/null || true
      exit 0
      ;;
    *)
      echo "workerd exited with status $status" >&2
      kill "$cpid" $rpid 2>/dev/null || true
      exit "$status"
      ;;
  esac
done
