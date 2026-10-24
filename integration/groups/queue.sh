# queue: admission, card edges and crashes in the queue and the check step
queue_needs() { echo "drill repo + Project; default provider (one planner call per crash round)"; }
queue_cost() { echo "~25-40 min; ~5 Objectives, 1 to completion (planner + worker + CI), the rest cancelled at their first plan question"; }
queue_minutes() { echo 45; }
QUEUE_POINTS=${QUEUE_POINTS:-engine:check:started engine:check:before-apply engine:check:applied}
queue_plan() {
  echo "queue.happy           one Objective (happy) queued, admitted and finished once"
  echo "queue.dequeue-clear   with maxActiveObjectives=1 and a running filler, clearing a waiting card withdraws it, and Factory doesn't rewrite the card"
  echo "queue.withdraw-cancel same, moving a waiting card to Cancelled withdraws it with no comment"
  local pt; for pt in $QUEUE_POINTS; do
    echo "queue.crash@$pt  hold Objective; crash, restart, reaches its plan question once (1 question comment), cancel by CLI [site: $(node "$SUITE/lib/crashpoints.mjs" "$BUILD" check "$pt" | cut -f2)]"
  done
  echo "queue.reorder              filler running, X and Y waiting (order X<Y); swap the order field: Y is admitted first $(pre)"
  echo "queue.reorder-after-start  move X ahead once Y has started: Y keeps running, X keeps waiting $(pre)"
  echo "queue.dequeue-during-check check slowed by the proxy (issue read +120 s); card cleared while checking: withdrawn, no plan step $(pre withdrawing github-api)"
  echo "queue.dequeue-before-cleanup  a cancelled Objective re-queued while the github cap is taken by that check, card cleared: withdrawn, no rerun:cleanup, finished record stands $(pre withdrawing check-cap github-api)"
  echo "queue.dequeue-held-cleanup re-run cleanup's reopen refused (403); card cleared while it holds or errors: withdrawn, no question, the card stays cleared $(pre gone-issue github-api)"
  echo "queue.burst-check-cap      maxActiveObjectives=2; 5 issues queued at once, checks slowed (+20 s): at most 2 checks at once (log spans) $(pre check-cap github-api)"
  echo "queue.gate-no-slot         maxActiveObjectives=1; one Objective waits at a required review (gate); a second is admitted and plans $(pre approval:human-gate)"
  echo "queue.paths-replan         two Objectives on src/shared<ID>.js; the lower one's issue is edited and it replans while the higher waits or builds; their work steps never overlap; both done $(pre)"
}
queue_cfg() { cfg_patch "$CUR_CFG" 'c["queue"]["maxActiveObjectives"]=1' 'c["queue"]["pollSeconds"]=10'; }

queue_run() {
  local g=queue t0 filler t1 t2
  # QUEUE_BASE=0 runs only the extra cases (QUEUE_EXTRA), so a long group can be split in runs.
  [ "${QUEUE_BASE:-1}" = 0 ] && { queue_more; return; }
  # Filler holds the only slot while two more wait for it.
  t0=$(now)
  filler=$(new_objective $g happy "queue filler" ID="$(uid)") || { record queue.happy $g FAIL "could not queue" "$t0"; return; }
  serve_start || return
  local p; p=$(wait_phase "$filler" '^(planning|building|finishing)$|^hold:' 600)
  t1=$(new_objective $g withdraw "queue dequeue-clear" ID="$(uid)")
  t2=$(new_objective $g withdraw2 "queue withdraw-cancel" ID="$(uid)")
  # Wait until both are checked and waiting for the slot (state exists, no plan step started).
  wait_for 300 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $t1)\" != none ] && [ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $t2)\" != none ]"
  local started1 started2; started1=$(st started "$t1" 'plan:*'); started2=$(st started "$t2" 'plan:*')
  if [ "$started1$started2" != 00 ]; then
    record queue.dequeue-clear $g UNREACHABLE "a waiting Objective started planning before its card could be changed (filler phase $p)" "$t0"
    record queue.withdraw-cancel $g UNREACHABLE "same" "$t0"
  else
    local tc=$(now)
    gh_card "$t1" ""; gh_card "$t2" Cancelled
    sleep 60   # several polls
    local s1 s2 c1 c2 pl1 pl2 m2
    s1=$(st status "$t1"); s2=$(st status "$t2"); c1=$(gh_card_value "$t1"); c2=$(gh_card_value "$t2")
    pl1=$(st started "$t1" 'plan:*'); pl2=$(st started "$t2" 'plan:*'); m2=$(gh_markers "$t2" | wc -l)
    if [ "$s1" = none ] && [ "$pl1" = 0 ] && [ -z "$c1" ]; then record queue.dequeue-clear $g PASS "#$t1 state removed, no plan step, card still cleared" "$tc"
    else record queue.dequeue-clear $g FAIL "#$t1 state=$s1 plan_started=$pl1 card='$c1' (expected none/0/empty)" "$tc"; fi
    if [ "$s2" = none ] && [ "$pl2" = 0 ] && [ "$c2" = Cancelled ] && [ "$m2" = 0 ]; then record queue.withdraw-cancel $g PASS "#$t2 state removed, card Cancelled, no Factory comments" "$tc"
    else record queue.withdraw-cancel $g FAIL "#$t2 state=$s2 plan_started=$pl2 card='$c2' markers=$m2" "$tc"; fi
    gh issue close "$t1" --repo "$REPO" --reason "not planned" >/dev/null 2>&1
    gh issue close "$t2" --repo "$REPO" --reason "not planned" >/dev/null 2>&1
  fi
  p=$(wait_phase "$filler" 'done|cancelled|failed' 3600)
  sleep 20; serve_stop
  if end_done "$filler"; then record queue.happy $g PASS "$EVID" "$t0"; else record queue.happy $g FAIL "$EVID (phase $p)" "$t0"; fi

  # Crash rounds (queue-drill.sh): crash, restart, plan question once, cancel.
  local pt n hold hid q
  for pt in $QUEUE_POINTS; do
    t0=$(now)
    if [ "$(node "$SUITE/lib/crashpoints.mjs" "$BUILD" check "$pt" | cut -f2)" != yes ]; then
      record "queue.crash@$pt" $g UNREACHABLE "no crashPoint site for $pt in this build" "$t0"; continue; fi
    n=$(new_objective $g hold "queue crash $pt" ID="$(uid)") || continue
    crash_at "$n" "$pt" 600
    if [ "$CRASH_R" != 137 ]; then record "queue.crash@$pt" $g FAIL "#$n never crashed ($CRASH_R)" "$t0"; settle_group $g; continue; fi
    serve_start || return
    p=$(wait_phase "$n" '^hold:' 900)
    hold=$(st hold "$n"); hid=$(python3 -c 'import json,sys;h=json.loads(sys.argv[1]);print(h["id"] if h else "")' "$hold")
    sleep 30   # let the question comment post
    q=$(marker_count "$(gh_markers "$n")" "hold:$hid")
    cli cancel "$n" >/dev/null 2>&1
    wait_phase "$n" 'cancelled' 300 >/dev/null; sleep 15; serve_stop
    end_cancelled "$n"; local ok=$?
    if [[ $p == hold:* ]] && [ "$q" = 1 ] && [ $ok = 0 ]; then record "queue.crash@$pt" $g PASS "crashed 137; held at ${p#hold:}, question x1; $EVID" "$t0"
    else record "queue.crash@$pt" $g FAIL "phase=$p question x$q; $EVID" "$t0"; fi
  done
  queue_more
}

QUEUE_EXTRA=${QUEUE_EXTRA:-reorder dequeue burst held-cleanup gate paths}
QUEUE_PORT=${QUEUE_PORT:-18560}
queue_more() {
  local t
  for t in $QUEUE_EXTRA; do
    case $t in reorder) q_reorder ;; dequeue) q_dequeue ;; burst) q_burst ;; held-cleanup) q_held_cleanup ;; gate) q_gate_slot ;; paths) q_paths_replan ;; esac
    serve_stop; proxy_stop q; restore_run
  done
}
q_started() { [ "$(st started "$1" 'plan:*')" = 1 ]; }

q_reorder() {
  local g=queue t0 f x y first=""; t0=$(now)
  gh_order_field >/dev/null 2>&1 || { record queue.reorder $g UNREACHABLE "the Project has no number field named by queue.orderField" "$t0"; record queue.reorder-after-start $g UNREACHABLE "same" "$t0"; return; }
  f=$(new_objective $g happy "queue reorder filler" ID="$(uid)") || return
  serve_alive || serve_start || return
  wait_phase "$f" '^(planning|building|finishing)$|^hold:' 900 >/dev/null
  x=$(new_objective $g withdraw "queue reorder X" ID="$(uid)") || return
  y=$(new_objective $g withdraw2 "queue reorder Y" ID="$(uid)") || return
  gh_order "$x" 2; gh_order "$y" 3
  wait_for 300 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $x)\" != none ] && [ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $y)\" != none ]"
  if q_started "$x" || q_started "$y"; then
    record queue.reorder $g UNREACHABLE "X or Y started before the reorder (filler $(st phase "$f"))" "$t0"; record queue.reorder-after-start $g UNREACHABLE "same" "$t0"
  else
    gh_order "$x" 5; gh_order "$y" 1; sleep 30
    cli_t 60 cancel "$f" >/dev/null 2>&1; wait_phase "$f" 'cancelled|done|failed' 900 >/dev/null
    local end=$(( $(now) + 900 ))
    while [ "$(now)" -lt "$end" ] && [ -z "$first" ]; do serve_tick; q_started "$y" && first=$y; q_started "$x" && first=${first:-$x}; [ -z "$first" ] && sleep 5; done
    local ev="order swapped to Y=1, X=5 while both waited; first admitted after the filler: #${first:-none} (X #$x, Y #$y)"
    [ "$first" = "$y" ] && ! q_started "$x" && record queue.reorder $g PASS "$ev" "$t0" || record queue.reorder $g FAIL "$ev; X started=$(st started "$x" 'plan:*')" "$t0"
    t0=$(now)
    if [ "$first" = "$y" ]; then
      gh_order "$x" 0; sleep 60
      local py; py=$(st phase "$y")
      if [[ $py =~ ^(planning|building|finishing|done|hold:) ]] && ! q_started "$x"; then record queue.reorder-after-start $g PASS "X moved ahead (0) after Y started: Y $py, X not started" "$t0"
      # A held Objective whose holds stop every step takes no slot (docs/reference/queue.md, Several at once), so X may start then.
      elif [[ $py == hold:* ]]; then record queue.reorder-after-start $g UNREACHABLE "Y held at ${py#hold:} (a held Objective takes no slot, so X may start); X started=$(st started "$x" 'plan:*')" "$t0"
      else record queue.reorder-after-start $g FAIL "after moving X ahead: Y $py, X started=$(st started "$x" 'plan:*')" "$t0"; fi
    else record queue.reorder-after-start $g UNREACHABLE "Y wasn't admitted first" "$t0"; fi
  fi
  local o; for o in "$y" "$x"; do cli_t 60 cancel "$o" >/dev/null 2>&1; done
  for o in "$y" "$x"; do wait_phase "$o" 'cancelled|done|failed|none' 900 >/dev/null; done
  sleep 15
}

# one Objective dequeued while its (slowed) check runs, and a cancelled one
# re-queued while that check holds the github cap, dequeued before its cleanup.
q_dequeue() {
  local g=queue t0 m n hold; t0=$(now)
  local c ok=0
  need queue.dequeue-during-check $g "$t0" withdrawing github-api || ok=1
  need queue.dequeue-before-cleanup $g "$t0" withdrawing check-cap github-api || ok=1
  [ $ok = 0 ] || return
  serve_stop; proxy_start q "$QUEUE_PORT"
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV $PROXY_ENV"
  m=$(new_objective $g hold "queue dequeue before cleanup" ID="$(uid)") || return
  serve_start || return
  hold=$(wait_phase "$m" '^hold:' 1200); cli_t 60 cancel "$m" >/dev/null 2>&1; wait_phase "$m" 'cancelled' 900 >/dev/null; sleep 20
  n=$(new_issue $g withdraw "queue dequeue during check" ID="$(uid)") || return
  proxy_rules q "GET ^/repos/$REPO/issues/$n\$ delay=120000"
  gh_enqueue "$n" >/dev/null
  wait_for 300 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $n)\" = checking ]" || { record queue.dequeue-during-check $g FAIL "#$n never showed checking" "$t0"; }
  local tq; tq=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh_card "$m" Queued; sleep 25
  gh_card "$n" ""; gh_card "$m" ""
  sleep 180; proxy_rules q
  local sn pn wn; sn=$(st status "$n"); pn=$(st started "$n" 'plan:*'); wn=$(st events "$n" event=withdrawn)
  if [ "$sn" = none ] && [ "$pn" = 0 ]; then record queue.dequeue-during-check $g PASS "#$n cleared while checking: state removed, no plan step, withdrawn events $wn" "$t0"
  else record queue.dequeue-during-check $g FAIL "#$n state=$sn plan started=$pn withdrawn events=$wn" "$t0"; fi
  local sm cl wm card; sm=$(st status "$m"); cl=$(st events "$m" event=start 'step=rerun:*'); wm=$(st events "$m" event=withdrawn); card=$(gh_card_value "$m")
  local ev="#$m (cancelled) re-queued at $tq while #$n's check held the cap, cleared 25 s later: status $sm, rerun steps started $cl, withdrawn events $wm, card '$card', issue $(gh_issue_state "$m")"
  if [ "$cl" != 0 ]; then record queue.dequeue-before-cleanup $g UNREACHABLE "the re-run's cleanup began before the dequeue; $ev" "$t0"
  elif [ "$sm" = cancelled ] && [ -z "$card" ] && [ "$wm" -ge 1 ]; then record queue.dequeue-before-cleanup $g PASS "$ev" "$t0"
  else record queue.dequeue-before-cleanup $g FAIL "$ev" "$t0"; fi
  gh issue close "$n" --repo "$REPO" --reason "not planned" >/dev/null 2>&1
  serve_stop
}

# the re-run cleanup's reopen is refused (403); the card is cleared while it holds.
q_held_cleanup() {
  local g=queue t0 m; t0=$(now)
  need queue.dequeue-held-cleanup $g "$t0" gone-issue github-api || return
  serve_stop; proxy_start q "$QUEUE_PORT"
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV $PROXY_ENV"
  m=$(new_objective $g hold "queue dequeue held cleanup" ID="$(uid)") || return
  serve_start || return
  wait_phase "$m" '^hold:' 1200 >/dev/null; cli_t 60 cancel "$m" >/dev/null 2>&1; wait_phase "$m" 'cancelled' 900 >/dev/null; sleep 20
  local q0; q0=$(marker_prefix_count "$(gh_markers "$m")" hold:)
  proxy_rules q "PATCH ^/repos/$REPO/issues/$m\$ status=403"
  gh_card "$m" Queued
  wait_for 600 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' events $m event=start 'step=rerun:*') -ge 1 ]"
  sleep 60
  local ph; ph=$(st phase "$m")
  local tdq; tdq=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh_card "$m" ""
  sleep 120
  local s w card q1; s=$(st status "$m"); w=$(st events "$m" event=withdrawn); card=$(gh_card_value "$m"); q1=$(marker_prefix_count "$(gh_markers "$m")" hold:)
  proxy_rules q
  local ev="#$m re-queued with its reopen refused (403s served $(proxy_count q PATCH "/issues/$m\$" 403)); phase before the dequeue $ph; after: status $s, withdrawn events $w, card '$card', question comments $q0 -> $q1"
  # The held cleanup posts its question while it holds; the withdrawal edits it to "no longer applies" and posts none after.
  local qn qa rq rw; qa=$(gh_hold_comments_since "$m" "$tdq"); read -r rq rw < <(gh_rerun_questions_withdrawn "$m")
  ev="$ev; questions after the dequeue $qa; re-run questions $rq, edited to no longer apply $rw"
  if [ "$w" -ge 1 ] && [ -z "$card" ] && [ "$qa" = 0 ] && [ "$rq" = "$rw" ] && [ "$s" = cancelled ]; then record queue.dequeue-held-cleanup $g PASS "$ev" "$t0"
  else record queue.dequeue-held-cleanup $g FAIL "$ev" "$t0"; fi
  serve_stop
}

# a burst of queued issues is checked within the github cap.
q_burst() {
  local g=queue t0 i ns=() tpl; t0=$(now)
  need queue.burst-check-cap $g "$t0" check-cap github-api || return
  serve_stop; proxy_start q "$QUEUE_PORT"
  local keep=$CUR_CFG; CUR_CFG="$RUN_DIR/config.queue-burst.json"; cp "$keep" "$CUR_CFG"; cfg_patch "$CUR_CFG" 'c["queue"]["maxActiveObjectives"]=2'
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV $PROXY_ENV"
  proxy_rules q "GET ^/repos/$REPO/issues/[0-9]+\$ delay=20000"
  serve_start || { CUR_CFG=$keep; return; }
  for tpl in withdraw withdraw2 withdraw3 filler filler2; do ns+=("$(new_objective $g "$tpl" "queue burst $tpl" ID="$(uid)")"); done
  local end=$(( $(now) + 1200 ))
  while [ "$(now)" -lt "$end" ]; do
    serve_tick; local left=0 n; for n in "${ns[@]}"; do [ "$(st get "$n" done.check)" = null ] && left=1; done
    [ $left = 0 ] && break; sleep 10
  done
  proxy_rules q
  local mc; mc=$(st maxconc check "${ns[@]}")
  local ev="#${ns[*]} queued at once, cap 2: most checks at once $mc; checked: $(for n in "${ns[@]}"; do [ "$(st get "$n" done.check)" != null ] && printf '#%s ' "$n"; done)"
  if [ "$mc" -ge 1 ] && [ "$mc" -le 2 ]; then record queue.burst-check-cap $g PASS "$ev" "$t0"; else record queue.burst-check-cap $g FAIL "$ev" "$t0"; fi
  for n in "${ns[@]}"; do cli_t 60 cancel "$n" >/dev/null 2>&1; done
  for n in "${ns[@]}"; do wait_phase "$n" 'cancelled|done|failed|none' 900 >/dev/null; done
  sleep 15; serve_stop; CUR_CFG=$keep
}

# a gate wait takes no slot (needs a human gate on main: approval).
q_gate_slot() {
  local g=queue t0 a w; t0=$(now)
  { [ "$(gh_human_gate)" = true ] || approved queue.gate-no-slot $g "$t0" "a required review on main (human gate)"; } || return
  rc_human_gate_on || { record queue.gate-no-slot $g FAIL "couldn't add a required review to main" "$t0"; restore_run; return; }
  local HOLD_POLICY="$HOLD_POLICY decide"
  a=$(new_objective $g happy "queue gate holder" ID="$(uid)") || { restore_run; return; }
  serve_alive || serve_start || return
  wait_for 3600 bash -c "python3 '$SUITE/lib/st.py' '$ROOT' get $a retries | grep -q '\"kind\": *\"gate\"'" \
    || { record queue.gate-no-slot $g FAIL "#$a never waited at a gate (phase $(st phase "$a"))" "$t0"; op_q_cleanup "$a"; return; }
  w=$(new_objective $g withdraw "queue gate second" ID="$(uid)") || { op_q_cleanup "$a"; return; }
  wait_for 1200 q_started "$w"
  local sw ga; sw=$(st started "$w" 'plan:*'); ga=$(st get "$a" retries | grep -c '"gate"')
  local ev="#$a waits at its gate (gate retries $ga); second #$w plan started=$sw"
  [ "$sw" = 1 ] && [ "$ga" -ge 1 ] && record queue.gate-no-slot $g PASS "$ev" "$t0" || record queue.gate-no-slot $g FAIL "$ev" "$t0"
  op_q_cleanup "$a" "$w"
}
op_q_cleanup() { local o; for o; do cli_t 60 cancel "$o" >/dev/null 2>&1; done; for o; do wait_phase "$o" 'cancelled|done|failed|none' 900 >/dev/null; done; sleep 15; serve_stop; restore_run; }

# two Objectives on the same path; the lower one replans (its issue is
# edited, answered replan) while the higher waits or builds. Never both building.
q_paths_replan() {
  local g=queue t0 a b id p; t0=$(now); id=$(uid)
  local keep=$CUR_CFG; CUR_CFG="$RUN_DIR/config.queue-paths.json"; cp "$keep" "$CUR_CFG"; cfg_patch "$CUR_CFG" 'c["queue"]["maxActiveObjectives"]=2'
  local HOLD_POLICY="$HOLD_POLICY decide"
  serve_stop
  a=$(new_objective $g paths1 "queue paths higher" ID="$id") || { CUR_CFG=$keep; return; }
  b=$(new_objective $g paths2 "queue paths lower" ID="$id") || { CUR_CFG=$keep; return; }
  serve_start || { CUR_CFG=$keep; return; }
  wait_for 2400 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' get $b done.plan)\" != null ]"
  local pl0; pl0=$(st events "$b" event=start 'step=plan*')
  gh issue edit "$b" --repo "$REPO" --body "$(gh issue view "$b" --repo "$REPO" --json body --jq .body)

Drill edit: keep both exports in alphabetical order in the file." >/dev/null
  local end=$(( $(now) + 5400 )) rp=0 left n
  while [ "$(now)" -lt "$end" ]; do
    serve_tick; left=0
    for n in "$a" "$b"; do
      p=$(st phase "$n")
      case $p in done|cancelled|failed) continue ;; esac
      left=1
      if [[ $p == hold:* ]]; then
        local hj; hj=$(st hold "$n")
        if [ "$n" = "$b" ] && [[ ,$(hold_field "$hj" answers), == *,replan,* ]] && [ $rp = 0 ]; then
          answer_t 60 "$b" replan --question "$(hold_field "$hj" id)" >/dev/null 2>&1; rp=1; log "#$b answered replan"
        else auto_answer "$n" || true; fi
      fi
    done
    [ $left = 0 ] && break; sleep 10
  done
  sleep 20
  local mc pl1; mc=$(st maxconc 'item:*:work' "$a" "$b"); pl1=$(st events "$b" event=start 'step=plan*')
  local oka okb eva evb; end_done "$a"; oka=$?; eva=$EVID; end_done "$b"; okb=$?; evb=$EVID
  local ev="lower #$b edited after planning; replan answered=$rp; plan starts $pl0 -> $pl1; most work steps at once across both $mc; $eva | $evb"
  if [ $oka = 0 ] && [ $okb = 0 ] && [ "$mc" -le 1 ] && [ "$pl1" -gt "$pl0" ]; then record queue.paths-replan $g PASS "$ev" "$t0"
  elif [ $rp = 0 ] && [ $oka = 0 ] && [ $okb = 0 ] && [ "$mc" -le 1 ]; then record queue.paths-replan $g UNREACHABLE "the lower Objective never asked about the edit (no replan); $ev" "$t0"
  else record queue.paths-replan $g FAIL "$ev" "$t0"; fi
  serve_stop; CUR_CFG=$keep
}
