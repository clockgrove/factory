#!/bin/bash
# Run serve inside a rootless network namespace (pasta) so its network can be
# cut without touching the host. Build, repo, state and config are
# parameters.
#
#   netns-serve.sh CTL_DIR        start (from the host): pasta + control loop
#   touch CTL_DIR/cut             cut the namespace's network for CUT_SECS (60)
#   touch CTL_DIR/stop            SIGTERM serve (exact pid) and leave
#
# Env: BUILD REPO FACTORY_STATE_DIR FACTORY_CONFIG [EXTRA_ENV] [CUT_SECS].
# Writes CTL_DIR/pid (serve), CTL_DIR/exit and CTL_DIR/cuts.log (PDT and UTC).
set -u
CTL=${1:?ctl dir}
mkdir -p "$CTL"
if [ "${INSIDE:-}" != 1 ]; then
  exec env INSIDE=1 HOST_UID="$(id -u)" HOST_GID="$(id -g)" pasta --config-net -q -- bash "$0" "$CTL"
fi
log() { echo "$(TZ=America/Los_Angeles date '+%-I:%M:%S %p') $(date -u +%H:%M:%SZ) $*" >>"$CTL/cuts.log"; }
cd "$BUILD"
# pasta maps the caller to uid 0 and Factory refuses to plan as root: a nested
# user namespace maps back to the host uid for serve only.
unshare --user --map-user="$HOST_UID" --map-group="$HOST_GID" \
  env ${EXTRA_ENV:-} node dist/cli.js serve --repo "$REPO" >"$CTL/out.log" 2>&1 &
pid=$!
echo $pid >"$CTL/pid"
log "serve pid $pid started; default route: $(ip route show default)"
while kill -0 $pid 2>/dev/null; do
  if [ -e "$CTL/cut" ]; then
    rm -f "$CTL/cut"
    route=$(ip route show default)
    ip link set eth0 down
    log "CUT eth0 down (route saved: $route)"
    sleep "${CUT_SECS:-60}"
    ip link set eth0 up
    ip route add $route
    log "RESTORED eth0 up; route now: $(ip route show default)"
  fi
  if [ -e "$CTL/stop" ]; then rm -f "$CTL/stop"; kill -TERM $pid; log "stop requested; SIGTERM $pid"; fi
  sleep 1
done
wait $pid
echo $? >"$CTL/exit"
log "serve exited $(cat "$CTL/exit")"
