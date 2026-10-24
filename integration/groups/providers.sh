# providers: Copilot as planner and worker, provider frozen at admission
# across a config change and restarts, Copilot premium-request budget,
# and a Claude run (explicit --provider claude).
# COPILOT_PENDING=1 skips every Copilot step (UNREACHABLE) and checks the
# freeze with Claude instead: admitted on claude by `serve --provider claude`,
# then restarted on the codex default.
providers_needs() { echo "drill repo + Project; copilot CLI logged in (subscription, no API key) unless COPILOT_PENDING=1; Copilot premium budget COPILOT_BUDGET (default 12); claude login for the Claude run (PROVIDERS_CLAUDE=1, or always with COPILOT_PENDING=1)"; }
providers_cost() { echo "~25-40 min; 1 Copilot Objective (~9 premium requests) + 1 Claude Objective when enabled"; }
providers_minutes() { echo 60; }
COPILOT_BUDGET=${COPILOT_BUDGET:-12}
COPILOT_PENDING=${COPILOT_PENDING:-}
providers_plan_more() {
  echo "providers.switch         admitted on codex; codex removed from the config, restart: the provider step holds with switch; 'switch codex' (not a target) refused; 'switch codex-alt' moves it $(pre switch)"
  echo "providers.copilot-model  copilot with a model its list lacks: holds with retry before any billed session; 'retry' re-reads the list, still 0 sessions $( [ -n "$COPILOT_PENDING" ] && echo "[UNREACHABLE: COPILOT_PENDING]" || pre)"
  echo "providers.trace-crossfs  FACTORY_PROVIDER_TRACE on /dev/shm (another filesystem than the state): trace files written, no provider-trace-failed $(pre provider-trace)"
}
providers_plan() {
  providers_plan_more
  if [ -n "$COPILOT_PENDING" ]; then
    echo "providers.copilot*      UNREACHABLE (COPILOT_PENDING: Copilot budget pending)"
    echo "providers.claude        serve --provider claude: every planner/worker call provider claude; done"
    echo "providers.frozen        admitted claude, then restarted with no --provider (default codex): Objective stays claude"
    return
  fi
  echo "providers.copilot       copilot planner + worker: every model call (model-usage, or planner-call/worker-call) is provider copilot; done"
  echo "providers.frozen        defaultProvider flipped to codex + restart mid-run: Objective stays copilot"
  echo "providers.copilot-budget  copilot model calls <= COPILOT_BUDGET ($COPILOT_BUDGET)"
  [ -n "${PROVIDERS_CLAUDE:-}" ] && echo "providers.claude        serve --provider claude: every call provider claude; done"
}
providers_cfg() {
  if [ -n "$COPILOT_PENDING" ]; then
    cfg_patch "$CUR_CFG" 'c.setdefault("providers",{}); c["providers"].pop("copilot",None); c["providers"]["codex"]={"planner":"codex","worker":{"kind":"codex"}}; c["providers"]["claude"]={"planner":"claude","worker":{"kind":"claude"}}; c["defaultProvider"]="codex"'
  else
    cfg_patch "$CUR_CFG" \
      'c.setdefault("providers",{}); c["providers"]["codex"]={"planner":"codex","worker":{"kind":"codex"}}; c["providers"]["copilot"]={"planner":"copilot","worker":{"kind":"copilot"}}; c["defaultProvider"]="copilot"'
  fi
}
# Calls of N by provider: "ALL MATCHING".
# Model calls: one `model-usage` event each, or a planner-call/worker-call
# pair on older builds. Summing both works on either.
prov_calls() {
  echo "$(( $(st events "$1" event=planner-call) + $(st events "$1" event=worker-call) + $(st events "$1" event=model-usage) )) $(( $(st events "$1" event=planner-call "provider=$2") + $(st events "$1" event=worker-call "provider=$2") + $(st events "$1" event=model-usage "provider=$2") ))"
}

providers_claude_frozen() {
  local g=providers t0 n p adm calls cl
  t0=$(now)
  for c in providers.copilot providers.copilot-budget; do record "$c" $g UNREACHABLE "Copilot budget pending (COPILOT_PENDING is set)" "$t0"; done
  command -v claude >/dev/null || { record providers.claude $g UNREACHABLE "claude CLI not installed" "$t0"; record providers.frozen $g UNREACHABLE "same" "$t0"; return; }
  n=$(new_objective $g happy "providers claude" ID="$(uid)") || return
  SERVE_ARGS="--provider claude" serve_start || return
  # Restart on the default (codex) once claude planning has made a call.
  wait_for 1800 bash -c "[ \$(( \$(python3 '$SUITE/lib/st.py' '$ROOT' events $n event=planner-call) + \$(python3 '$SUITE/lib/st.py' '$ROOT' events $n event=model-usage role=planner) )) -ge 1 ]"
  adm=$(st provider "$n")
  serve_stop; serve_start || return
  p=$(wait_phase "$n" 'done|cancelled|failed' 3600); sleep 20; serve_stop
  read -r calls cl < <(prov_calls "$n" claude)
  local cx; cx=$(prov_calls "$n" codex | cut -d' ' -f2)
  end_done "$n"; local ok=$?
  [ $ok = 0 ] && [ "$calls" -gt 0 ] && [ "$cl" = "$calls" ] && record providers.claude $g PASS "$cl/$calls calls claude; $EVID" "$t0" \
    || record providers.claude $g FAIL "$cl/$calls calls claude ($cx codex); phase $p; $EVID" "$t0"
  [ "$adm" = claude ] && [ "$(st provider "$n")" = claude ] && [ "$cl" = "$calls" ] \
    && record providers.frozen $g PASS "admitted claude (--provider claude), still claude after a restart on the codex default; $cl/$calls calls claude" "$t0" \
    || record providers.frozen $g FAIL "admitted=$adm now=$(st provider "$n") calls $cl/$calls claude, $cx codex" "$t0"
}
providers_run() {
  local g=providers t0 n p
  [ -n "$COPILOT_PENDING" ] && { providers_claude_frozen; providers_more; return; }
  t0=$(now)
  if ! command -v copilot >/dev/null; then
    record providers.copilot $g UNREACHABLE "copilot CLI not installed" "$t0"
  else
    n=$(new_objective $g copilot "providers copilot" ID="$(uid)") || return
    serve_start || return
    wait_phase "$n" '^(planning|building)$' 900 >/dev/null
    local adm; adm=$(st provider "$n")
    cfg_patch "$CUR_CFG" 'c["defaultProvider"]="codex"'
    serve_stop; serve_start || return
    p=$(wait_phase "$n" 'done|cancelled|failed' 3600); sleep 20; serve_stop
    cfg_patch "$CUR_CFG" 'c["defaultProvider"]="copilot"'   # back to this group's scratch value
    local calls cop; read -r calls cop < <(prov_calls "$n" copilot)
    end_done "$n"; local ok=$?
    [ $ok = 0 ] && [ "$calls" -gt 0 ] && [ "$cop" = "$calls" ] && record providers.copilot $g PASS "$cop/$calls calls copilot; $EVID" "$t0" \
      || record providers.copilot $g FAIL "$cop/$calls calls copilot; $EVID" "$t0"
    [ "$adm" = copilot ] && [ "$(st provider "$n")" = copilot ] && [ "$cop" = "$calls" ] \
      && record providers.frozen $g PASS "admitted copilot, still copilot after default→codex + restart" "$t0" \
      || record providers.frozen $g FAIL "admitted=$adm now=$(st provider "$n") calls $cop/$calls copilot" "$t0"
    [ "$cop" -le "$COPILOT_BUDGET" ] && record providers.copilot-budget $g PASS "$cop copilot calls <= $COPILOT_BUDGET" "$t0" \
      || record providers.copilot-budget $g FAIL "$cop copilot calls > $COPILOT_BUDGET" "$t0"
  fi
  if [ -n "${PROVIDERS_CLAUDE:-}" ]; then
    t0=$(now)
    cfg_patch "$CUR_CFG" 'c["providers"]["claude"]={"planner":"claude","worker":{"kind":"claude"}}'
    n=$(new_objective $g happy "providers claude" ID="$(uid)") || return
    SERVE_ARGS="--provider claude" serve_start || return
    p=$(wait_phase "$n" 'done|cancelled|failed' 3600); sleep 20; serve_stop
    local calls cl; read -r calls cl < <(prov_calls "$n" claude)
    end_done "$n" && [ "$calls" -gt 0 ] && [ "$cl" = "$calls" ] && record providers.claude $g PASS "$cl/$calls calls claude; $EVID" "$t0" \
      || record providers.claude $g FAIL "$cl/$calls calls claude; $EVID" "$t0"
  fi
  providers_more
}

PROV_ONLY=${PROV_ONLY:-switch copilot-model trace-crossfs}
providers_more() {
  local t
  for t in $PROV_ONLY; do
    case $t in switch) prov_switch ;; copilot-model) prov_copilot_model ;; trace-crossfs) prov_trace ;; esac
    serve_stop
  done
}
# A config copy for one case: codex (and the given extra JSON providers), default codex.
prov_cfg() { # NAME [PY_EXPR...]
  local f="$RUN_DIR/config.providers-$1.json"; shift; cp "$BASE_CFG" "$f"
  cfg_patch "$f" 'c.setdefault("providers",{}); c["providers"]["codex"]={"planner":"codex","worker":{"kind":"codex"}}; c["defaultProvider"]="codex"' "$@"
  echo "$f"
}
prov_end() { cli_t 60 cancel "$1" >/dev/null 2>&1; wait_phase "$1" 'cancelled|done|failed' 900 >/dev/null; sleep 10; serve_stop; }

# an unavailable frozen provider offers `switch`, to exactly the targets the engine accepts.
prov_switch() {
  local g=providers t0 n keep=$CUR_CFG; t0=$(now)
  need providers.switch $g "$t0" switch || return
  CUR_CFG=$(prov_cfg switch 'c["providers"]["codex-alt"]={"planner":"codex","worker":{"kind":"codex"}}')
  n=$(new_objective $g hold "providers switch" ID="$(uid)") || { CUR_CFG=$keep; return; }
  serve_start || { CUR_CFG=$keep; return; }
  wait_for 1200 bash -c "[ \$(( \$(python3 '$SUITE/lib/st.py' '$ROOT' events $n event=planner-call) + \$(python3 '$SUITE/lib/st.py' '$ROOT' events $n event=model-usage role=planner) )) -ge 1 ]"
  local adm; adm=$(st provider "$n"); serve_stop
  cfg_patch "$CUR_CFG" 'c["providers"].pop("codex"); c["defaultProvider"]="codex-alt"'
  serve_start || { CUR_CFG=$keep; return; }
  local p hold; p=$(wait_phase "$n" '^hold:provider$|cancelled|failed' 600); hold=$(st hold "$n" provider)
  local hid ans; hid=$(hold_field "$hold" id); ans=$(hold_field "$hold" answers)
  if [[ ,$ans, != *,switch,* ]]; then record providers.switch $g FAIL "admitted $adm; after codex left the config: phase $p, hold [$ans]" "$t0"; prov_end "$n"; CUR_CFG=$keep; return; fi
  answer_t 60 "$n" switch --question "$hid" --text codex >/dev/null 2>&1; sleep 20
  local still; still=$(st holds "$n" | grep -c "\"$hid\"")
  answer_t 60 "$n" switch --question "$hid" --text codex-alt >/dev/null 2>&1
  wait_for 120 bash -c "! python3 '$SUITE/lib/st.py' '$ROOT' holds $n | grep -q '\"$hid\"'"
  local now_p by; now_p=$(st provider "$n"); by=$(st get "$n" provider.selectedBy | tr -d '"')
  local ev="admitted $adm; codex removed: hold [$ans]; 'switch codex' left it open=$still; 'switch codex-alt': provider $now_p (selectedBy $by), phase $(st phase "$n")"
  prov_end "$n"; CUR_CFG=$keep
  if [ "$adm" = codex ] && [ "$still" -ge 1 ] && [ "$now_p" = codex-alt ] && [ "$by" = switch ]; then record providers.switch $g PASS "$ev" "$t0"
  else record providers.switch $g FAIL "$ev" "$t0"; fi
}

# Copilot's model-list hold offers retry and bills nothing.
prov_copilot_model() {
  local g=providers t0 n keep=$CUR_CFG; t0=$(now)
  [ -n "$COPILOT_PENDING" ] && { record providers.copilot-model $g UNREACHABLE "Copilot budget pending (COPILOT_PENDING)" "$t0"; return; }
  command -v copilot >/dev/null || { record providers.copilot-model $g UNREACHABLE "copilot CLI not installed" "$t0"; return; }
  CUR_CFG=$(prov_cfg copilot-model 'm={"model":"drill-unlisted-model"}; c["providers"]["copilot"]={"planner":"copilot","models":{"planner":m,"reviewer":m},"worker":{"kind":"copilot","model":"drill-unlisted-model"}}; c["defaultProvider"]="copilot"')
  n=$(new_objective $g hold "providers copilot model list" ID="$(uid)") || { CUR_CFG=$keep; return; }
  serve_start || { CUR_CFG=$keep; return; }
  local p hold; p=$(wait_phase "$n" '^hold:|cancelled|failed' 900); hold=$(st hold "$n")
  local ans c0; ans=$(hold_field "$hold" answers); c0=$(prov_calls "$n" copilot | cut -d' ' -f2)
  if [ -s "$SERVE_DIR/exit" ]; then record providers.copilot-model $g FAIL "serve exited $(cat "$SERVE_DIR/exit") (config refused?): $(tail -c 300 "$SERVE_DIR/out.log")" "$t0"; CUR_CFG=$keep; return; fi
  answer_t 60 "$n" retry --question "$(hold_field "$hold" id)" >/dev/null 2>&1
  sleep 60; wait_phase "$n" '^hold:|cancelled|failed' 300 >/dev/null
  local ans2 c1; ans2=$(hold_field "$(st hold "$n")" answers); c1=$(prov_calls "$n" copilot | cut -d' ' -f2)
  prov_end "$n"; CUR_CFG=$keep
  local ev="hold at ${p#hold:} [$ans], copilot calls $c0; after retry: hold [$ans2], copilot calls $c1"
  if [[ ,$ans, == *,retry,* ]] && [ "$c0" = 0 ] && [ "$c1" = 0 ] && [[ ,$ans2, == *,retry,* ]]; then record providers.copilot-model $g PASS "$ev" "$t0"
  else record providers.copilot-model $g FAIL "$ev" "$t0"; fi
}

# the provider trace survives a trace directory on another filesystem.
prov_trace() {
  local g=providers t0 n keep=$CUR_CFG dir; t0=$(now)
  need providers.trace-crossfs $g "$t0" provider-trace || return
  dir=/dev/shm/factory-drill-trace-$RUN_ID; mkdir -p "$STATE" "$dir"
  if [ "$(stat -c %d "$dir")" = "$(stat -c %d "$STATE")" ]; then record providers.trace-crossfs $g UNREACHABLE "/dev/shm is on the state's filesystem here" "$t0"; rmdir "$dir"; return; fi
  CUR_CFG=$(prov_cfg trace)
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_PROVIDER_TRACE=$dir"
  n=$(new_objective $g hold "providers trace across filesystems" ID="$(uid)") || { CUR_CFG=$keep; return; }
  serve_start || { CUR_CFG=$keep; return; }
  wait_phase "$n" '^hold:|cancelled|failed' 1200 >/dev/null; sleep 10
  local files fails; files=$(find "$dir" -type f | wc -l); fails=$(st events "$n" event=provider-trace-failed)
  prov_end "$n"; CUR_CFG=$keep
  rm -rf "$dir"
  local ev="trace dir $dir (tmpfs; state on $(stat -f -c %T "$STATE")): $files files, provider-trace-failed $fails"
  [ "$files" -ge 1 ] && [ "$fails" = 0 ] && record providers.trace-crossfs $g PASS "$ev" "$t0" || record providers.trace-crossfs $g FAIL "$ev" "$t0"
}
