# Serves, one installation each: start (optionally with a crash point, inside a
# network namespace, or with --take-over), stop, and the live serve's directory.
# Sourced; uses the installation globals (inst NAME).

SERVE_N=0
# serve_up [POINT] [OPTIONS]: OPTIONS is a word list: netns, takeover.
# Extra environment for the installation is in $RUN_DIR/inst/$INST/extra_env
# (KEY=VALUE per line, no spaces). Sets SERVE_DIR and the installation's serve_dir file.
serve_up() {
  local point=${1:-} opts=" ${2:-} " d end=$(( $(now) + 30 ))
  [ "$end" -le "$STOP_AT" ] || end=$STOP_AT
  [ "$(now)" -lt "$end" ] || return 124
  SERVE_N=$((SERVE_N + 1))
  d="$RUN_DIR/serve/$INST-$(date +%H%M%S)-$SERVE_N-${point:-clean}"; d=${d//\*/x}; d=${d//\#/_}
  mkdir -p "$d"; SERVE_DIR=$d
  local envs=("FACTORY_STATE_DIR=$STATE" "FACTORY_CONFIG=$CUR_CFG")
  local e; while read -r e; do [ -n "$e" ] && envs+=("$e"); done <"$RUN_DIR/inst/$INST/extra_env"
  [ -n "$point" ] && envs+=("FACTORY_CRASH_AT=$point")
  local args=""; [[ $opts == *" takeover "* ]] && args="--take-over"
  printf '%s\n' "${envs[@]}" >"$d/env"
  if [[ $opts == *" netns "* ]]; then
    (cd "$BUILD" && BUILD="$BUILD" REPO="$REPO" SERVE_ARGS="$args" EXTRA_ENV="${envs[*]}" \
      setsid bash "$SUITE/lib/netns-serve.sh" "$d" </dev/null >"$d/pasta.log" 2>&1 & echo $! >"$d/pasta.pid")
    echo netns >"$d/mode"
    track "$(cat "$d/pasta.pid")"
    # The namespace has its own PIDs: find the serve's host PID under pasta.
    local hp=""; while [ "$(now)" -lt "$end" ]; do
      hp=$(: >"$d/pasta.desc"; snap_desc "$(cat "$d/pasta.pid")" "$d/pasta.desc"; while read -r p _; do tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q 'cli.js serve' && { echo "$p"; break; }; done <"$d/pasta.desc")
      [ -n "$hp" ] && break; sleep 0.1; done
    [ -n "$hp" ] && echo "$hp" >"$d/hostpid"
  else
    (cd "$BUILD" && setsid env "${envs[@]}" bash -c \
      'node dist/cli.js serve --repo "$1" $3 >"$2/out.log" 2>&1 & echo $! >"$2/pid"; wait $!; echo $? >"$2/exit"' \
      _ "$REPO" "$d" "$args" </dev/null >/dev/null 2>&1 &)
  fi
  local pf="$d/pid"; [[ $opts == *" netns "* ]] && pf="$d/hostpid"
  while [ "$(now)" -lt "$end" ]; do [ -s "$pf" ] && break; sleep 0.1; done
  [ -s "$pf" ] || { log "serve did not start ($d)"; return 1; }
  SERVE_DIR=$d; track "$(serve_pid)"
  echo "$d" >"$RUN_DIR/inst/$INST/serve_dir"
  log "serve pid $(serve_pid) up${point:+ armed at $point}${args:+ $args}$([[ $opts == *" netns "* ]] && echo " (netns)")"
}
serve_pid() { cat "$SERVE_DIR/hostpid" 2>/dev/null || cat "$SERVE_DIR/pid" 2>/dev/null; }
serve_exited() { [ -s "$SERVE_DIR/exit" ]; }
serve_alive() { [ -n "$SERVE_DIR" ] && [ -s "$SERVE_DIR/pid" ] && ! serve_exited && kill -0 "$(serve_pid)" 2>/dev/null; }
serve_tick() { serve_alive && snap_desc "$(serve_pid)" "$SERVE_DIR/desc"; }
# serve_down [KILL]: SIGTERM (a clean stop) or SIGKILL by exact PID; wait for its exit.
serve_down() {
  [ -n "$SERVE_DIR" ] || return 0
  if serve_alive; then
    local p s; p=$(serve_pid); s=$(starttime "$p"); serve_tick
    kill_exact "$p" "$s" "${1:-TERM}"
    local end=$(( $(now) + 25 ))
    [ "$end" -le "$STOP_AT" ] || end=$STOP_AT
    while [ "$(now)" -lt "$end" ]; do serve_exited && break; sleep 1; done
    serve_exited || { log "serve $p did not stop before the deadline: SIGKILL"; kill_exact "$p" "$s" KILL; }
  fi
  kill_desc_survivors "$SERVE_DIR/desc"
  log "serve $(serve_pid) down (exit $(cat "$SERVE_DIR/exit" 2>/dev/null))"
}
# The netns serve's network cut (lib/netns-serve.sh): 0 once restored.
serve_cut() {
  [ "$(cat "$SERVE_DIR/mode" 2>/dev/null)" = netns ] || return 1
  local before; before=$(grep -c RESTORED "$SERVE_DIR/cuts.log" 2>/dev/null)
  touch "$SERVE_DIR/cut"; log "network cut ($1)"
  wait_for $(( ${CUT_SECS:-60} + 60 )) bash -c "[ \$(grep -c RESTORED '$SERVE_DIR/cuts.log' 2>/dev/null) -gt ${before:-0} ]"
}
