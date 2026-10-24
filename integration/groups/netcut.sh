# netcut: serve in a rootless network namespace (pasta); cut its network for
# CUT_SECS during planning and during the CI wait.
netcut_needs() { echo "drill repo + Project; pasta and unshare on the host; default provider"; }
netcut_cost() { echo "~20-30 min; 1 Objective to completion, two 60 s cuts"; }
netcut_minutes() { echo 30; }
netcut_plan() {
  echo "netcut.plan-cut   cut during the plan step: no hold (planner questions excepted and answered), the planner turn or its retry completes"
  echo "netcut.ci-cut     cut during the CI wait: the step retries (no hold), Objective finishes done once"
}
NETCUT_CTL=""; NETCUT_PASTA=""
netcut_stop() {
  [ -n "$NETCUT_CTL" ] || return 0
  if [ ! -s "$NETCUT_CTL/exit" ]; then
    touch "$NETCUT_CTL/stop"
    local i; for i in $(seq 1 120); do [ -s "$NETCUT_CTL/exit" ] && break; sleep 1; done
  fi
  [ -n "$NETCUT_PASTA" ] && { read -r p s <<<"$NETCUT_PASTA"; sleep 2; kill_exact "$p" "$s" TERM; }
  [ -s "$NETCUT_CTL/desc" ] && kill_desc_survivors "$NETCUT_CTL/desc"
  NETCUT_CTL=""; NETCUT_PASTA=""
}
netcut_cut() { # LABEL
  local before; before=$(grep -c RESTORED "$NETCUT_CTL/cuts.log" 2>/dev/null)
  touch "$NETCUT_CTL/cut"; log "netcut: cut ($1)"
  wait_for $(( ${CUT_SECS:-60} + 60 )) bash -c "[ \$(grep -c RESTORED '$NETCUT_CTL/cuts.log') -gt $before ]"
}

netcut_run() {
  local g=netcut t0 n HOLD_POLICY="$HOLD_POLICY decide"
  t0=$(now)
  for tool in pasta unshare ip; do command -v $tool >/dev/null || { record netcut.plan-cut $g UNREACHABLE "$tool is not installed" "$t0"; record netcut.ci-cut $g UNREACHABLE "$tool is not installed" "$t0"; return; }; done
  guard_serve || return
  n=$(new_objective $g net "netcut" ID="$(uid)") || return
  NETCUT_CTL="$RUN_DIR/netns"; mkdir -p "$NETCUT_CTL"
  (BUILD="$BUILD" REPO="$REPO" FACTORY_STATE_DIR="$STATE" FACTORY_CONFIG="$CUR_CFG" \
    EXTRA_ENV="FACTORY_STATE_DIR=$STATE FACTORY_CONFIG=$CUR_CFG $SERVE_EXTRA_ENV" \
    setsid bash "$SUITE/lib/netns-serve.sh" "$NETCUT_CTL" </dev/null >"$NETCUT_CTL/pasta.log" 2>&1 & echo $! >"$NETCUT_CTL/pasta.pid")
  sleep 2; local pp; pp=$(cat "$NETCUT_CTL/pasta.pid"); track "$pp"; NETCUT_PASTA="$pp $(starttime "$pp")"
  wait_for 60 test -s "$NETCUT_CTL/pid" || { record netcut.plan-cut $g FAIL "serve did not start in the namespace (see $NETCUT_CTL)" "$t0"; netcut_stop; return; }
  # The cut-plan check: wait for the plan step to start, give the planner 15 s.
  local tick="snap_desc $pp $NETCUT_CTL/desc"
  wait_for 900 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' started $n 'plan:*') = 1 ]"
  sleep 15; local t1; t1=$(now); netcut_cut plan
  local p; p=$(wait_phase "$n" '^(building|finishing|done)$' 1800); $tick
  local h1; h1=$(( $(st events "$n" event=outcome outcome=hold) - $(st events "$n" event=outcome outcome=hold 'step=decide:*') ))
  if [[ $p != hold:* ]] && [ "$h1" = 0 ]; then record netcut.plan-cut $g PASS "planning went on to $p with no hold; $(tail -2 "$NETCUT_CTL/cuts.log" | paste -sd' ')" "$t1"
  else record netcut.plan-cut $g FAIL "phase=$p holds=$h1" "$t1"; fi
  # The CI-wait cut: wait for a CI step to start.
  wait_for 2400 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' started $n 'item:*:ci') = 1 ]"
  sleep 5; local t2; t2=$(now); netcut_cut ci
  p=$(wait_phase "$n" 'done|cancelled|failed' 2700); $tick
  sleep 20; netcut_stop
  local h2; h2=$(( $(st events "$n" event=outcome outcome=hold) - $(st events "$n" event=outcome outcome=hold 'step=decide:*') ))
  if end_done "$n" && [ "$h2" = 0 ]; then record netcut.ci-cut $g PASS "no hold from either cut; $EVID" "$t2"
  else record netcut.ci-cut $g FAIL "holds=$h2 phase=$p; $EVID" "$t2"; fi
}
