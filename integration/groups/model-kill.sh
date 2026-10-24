# model-kill: SIGKILL the provider child mid-turn, once in planning and once
# in a work step. The step must retry without counting an
# error, and the Objective finish once.
model_kill_needs() { echo "drill repo + Project; default provider (codex: kills 'codex exec'; copilot/claude: their CLI child)"; }
model_kill_cost() { echo "~15-25 min; 1 Objective to completion, 2 killed model turns"; }
model_kill_minutes() { echo 25; }
model_kill_plan() {
  echo "model-kill.plan   kill the planner child 15 s into plan:*: outcome retry, retry count 0, planning completes"
  echo "model-kill.work   kill the worker child 8 s into item:*:work: same; Objective done once"
}
# The newest provider child under the serve, as "PID STARTTIME".
mk_child() {
  local f="$RUN_DIR/mk-desc"; : >"$f"; snap_desc "$(serve_pid)" "$f"
  local pid s best="" bs=0
  while read -r pid s; do
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qE "${MODEL_KILL_MATCH:-codex.*exec|copilot|claude}" || continue
    [ "$s" -gt "$bs" ] && { best="$pid $s"; bs=$s; }
  done <"$f"
  echo "$best"
}
mk_kill() { # N STEPGLOB DELAY CHECK
  local n=$1 glob=$2 delay=$3 name=$4 t0 c pid s
  t0=$(now)
  wait_for 2400 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' started $n '$glob') = 1 ]" || { record "$name" model-kill FAIL "#$n never started $glob" "$t0"; return; }
  sleep "$delay"
  c=$(mk_child); read -r pid s <<<"$c"
  if [ -z "$pid" ]; then record "$name" model-kill UNREACHABLE "no provider child under serve when $glob ran (MODEL_KILL_MATCH)" "$t0"; return; fi
  local before; before=$(st events "$n" event=outcome outcome=retry "step=$glob")
  kill_exact "$pid" "$s" KILL; log "killed provider child $pid during $glob"
  wait_for 300 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' events $n event=outcome outcome=retry 'step=$glob') -gt $before ]"
  local after cnt; after=$(st events "$n" event=outcome outcome=retry "step=$glob"); cnt=$(st retries "$n" "$glob")
  if [ "$after" -gt "$before" ] && [ "$cnt" = 0 ]; then MK_EVID+=("$name: killed $pid, outcome retry, count 0"); MK_OK+=("$name")
  else MK_EVID+=("$name: killed $pid, retries $before->$after, error count $cnt"); fi
}
model_kill_run() {
  local g=model-kill n t0 HOLD_POLICY="$HOLD_POLICY decide"
  t0=$(now); MK_EVID=(); MK_OK=()
  n=$(new_objective $g kill "model-kill" ID="$(uid)") || return
  serve_start || return
  mk_kill "$n" 'plan:*' 15 model-kill.plan
  mk_kill "$n" 'item:*:work' 8 model-kill.work
  wait_phase "$n" 'done|cancelled|failed' 2700 >/dev/null; sleep 20; serve_stop
  end_done "$n"; local ok=$? c
  for c in model-kill.plan model-kill.work; do
    local e; e=$(printf '%s\n' "${MK_EVID[@]}" | grep "^$c:")
    [ -z "$e" ] && continue
    if [ $ok = 0 ] && [[ " ${MK_OK[*]} " == *" $c "* ]]; then record "$c" $g PASS "$e; $EVID" "$t0"
    else record "$c" $g FAIL "$e; $EVID" "$t0"; fi
  done
}
