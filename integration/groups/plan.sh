# plan: a planner question answered on GitHub, and crashes at plan step
# boundaries.
plan_needs() { echo "drill repo + Project; default provider"; }
plan_cost() { echo "~30-45 min; 1 Objective to completion + 1 per crash point cancelled after its plan comment"; }
plan_minutes() { echo 45; }
PLAN_POINTS=${PLAN_POINTS:-engine:plan:*:started engine:plan:*:applied}
plan_plan() {
  echo "plan.ask-answer  hold Objective: question x1, '/factory <recommended>' comment applied once (reply x1), plan x1, finishes done"
  local pt; for pt in $PLAN_POINTS; do
    echo "plan.crash@$pt  happy Objective; crash, restart, plan comment x1, then cancelled cleanly [site: $(node "$SUITE/lib/crashpoints.mjs" "$BUILD" check "$pt" | cut -f2)]"
  done
  echo "plan.replan-final        crash at engine:final:started, a failing test lands on main: final holds retry/replan/cancel; main fixed; 'replan' plans exactly once, final's repairs reset, done $(pre review-fixes)"
  echo "plan.continue-edit       issue edited while planning: the edit question answered 'continue'; no edit question again (publish included); done $(pre review-fixes)"
  echo "plan.retry-final-review  crash at engine:final-review:started, restart with FACTORY_DEADLINE_MS=3000 until final review holds; 'retry' without the knob: final validation doesn't run again; done $(pre review-fixes deadline)"
}

plan_run() {
  local g=plan t0 n p hold hid rec cid m
  # PLAN_BASE=0 runs only the extra cases (PLAN_EXTRA).
  if [ "${PLAN_BASE:-1}" = 0 ]; then
    local t; for t in ${PLAN_EXTRA:-replan-final continue-edit retry-final-review}; do
      case $t in replan-final) plan_replan_final ;; continue-edit) plan_continue_edit ;; retry-final-review) plan_retry_final_review ;; esac
    done; return
  fi
  t0=$(now)
  n=$(new_objective $g hold "plan ask-answer" ID="$(uid)") || return
  serve_start || return
  p=$(wait_phase "$n" '^hold:' 1200)
  if [[ $p != hold:* ]]; then
    record plan.ask-answer $g FAIL "#$n never asked (phase $p)" "$t0"
  else
    hold=$(st hold "$n")
    read -r hid rec < <(python3 -c 'import json,sys;h=json.loads(sys.argv[1]);a=[x for x in h["answers"] if x not in ("cancel","retry")];print(h["id"], h["recommended"] if h["recommended"] not in ("cancel","retry") else (a[0] if a else "cancel"))' "$hold")
    sleep 30
    cid=$(comment_answer "$n" "$rec" 'Use "/" as the separator.' "$hid")
    log "#$n answered '$rec' by comment $cid"
    p=$(wait_phase "$n" 'done|cancelled|failed' 3600)
    sleep 20
    m=$(gh_markers "$n")
    local q r; q=$(marker_count "$m" "hold:$hid"); r=$(marker_count "$m" "reply:comment-$cid")
    if end_done "$n" && [ "$q" = 1 ] && [ "$r" = 1 ]; then record plan.ask-answer $g PASS "question x1, reply x1; $EVID" "$t0"
    else end_done "$n"; record plan.ask-answer $g FAIL "question x$q reply x$r; $EVID (phase $p)" "$t0"; fi
  fi
  serve_stop

  local pt
  for pt in $PLAN_POINTS; do
    t0=$(now)
    if [ "$(node "$SUITE/lib/crashpoints.mjs" "$BUILD" check "$pt" | cut -f2)" != yes ]; then
      record "plan.crash@$pt" $g UNREACHABLE "no crashPoint site for $pt in this build" "$t0"; continue; fi
    n=$(new_objective $g happy "plan crash $pt" ID="$(uid)") || continue
    crash_at "$n" "$pt" 1200
    if [ "$CRASH_R" != 137 ]; then record "plan.crash@$pt" $g FAIL "#$n never crashed ($CRASH_R)" "$t0"; settle_group $g; continue; fi
    serve_start || return
    p=$(wait_phase "$n" '^(building|finishing|done)$' 1800)
    sleep 20
    local pl; pl=$(marker_count "$(gh_markers "$n")" plan)
    cli cancel "$n" >/dev/null 2>&1
    wait_phase "$n" 'cancelled|done' 600 >/dev/null; sleep 15; serve_stop
    if [ "$(st status "$n")" = done ]; then end_done "$n"; else end_cancelled "$n"; fi; local ok=$?
    if [ "$pl" = 1 ] && [ $ok = 0 ]; then record "plan.crash@$pt" $g PASS "crashed 137; plan x1 after restart; $EVID" "$t0"
    else record "plan.crash@$pt" $g FAIL "phase=$p plan x$pl; $EVID" "$t0"; fi
  done
  local t; for t in ${PLAN_EXTRA:-replan-final continue-edit retry-final-review}; do
    case $t in replan-final) plan_replan_final ;; continue-edit) plan_continue_edit ;; retry-final-review) plan_retry_final_review ;; esac
    serve_stop
  done
}
iso_ms() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }

# `replan` to final validation's hold plans once.
plan_replan_final() {
  local g=plan t0 n id fn hold; t0=$(now); id=$(uid); fn="squash$id"
  need plan.replan-final $g "$t0" review-fixes || return
  local HOLD_POLICY="$HOLD_POLICY decide"
  serve_stop
  n=$(new_objective $g exec "plan replan-final $fn" FN="$fn" SPEC="\`$fn(s)\` replaces every run of spaces in \`s\` with one space: \`$fn(\"a   b  c\")\` is \`\"a b c\"\`.") || return
  crash_at "$n" engine:final:started 3600
  [ "$CRASH_R" = 137 ] || { record plan.replan-final $g FAIL "#$n never reached final validation ($CRASH_R)" "$t0"; settle_group $g; return; }
  local brk="test/drillBreak$id.test.js"
  gh api -X PUT "repos/$REPO/contents/$brk" -f message="drill: break main for the final validation hold" \
    -f content="$(printf '%s\n' "import { test } from 'node:test';" "import assert from 'node:assert/strict';" "" "test('drill break $id', () => { assert.equal(1, 2); });" | base64 -w0)" >/dev/null
  serve_start || return
  local p; p=$(wait_phase "$n" '^hold:final$|done|cancelled|failed' 1800); hold=$(st hold "$n" final)
  local sha; sha=$(gh api "repos/$REPO/contents/$brk?ref=main" --jq .sha 2>/dev/null)
  [ -n "$sha" ] && gh api -X DELETE "repos/$REPO/contents/$brk" -f message="drill: unbreak main" -f sha="$sha" >/dev/null
  if [[ ,$(hold_field "$hold" answers), != *,replan,* ]]; then
    record plan.replan-final $g FAIL "no final hold with replan (phase $p, hold [$(hold_field "$hold" answers)])" "$t0"
    cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled|done' 900 >/dev/null; serve_stop; return
  fi
  local ta rep0; ta=$(iso_ms); rep0=$(st get "$n" repairs)
  answer_t 60 "$n" replan --question "$(hold_field "$hold" id)" >/dev/null 2>&1
  # Spend guard: more than PLAN_REPLAN_MAX_CALLS (5) planner calls after the replan cancels it.
  local end=$(( $(now) + 3600 )) calls=0 lasthold=""
  while [ "$(now)" -lt "$end" ]; do
    serve_tick; p=$(st phase "$n")
    case $p in done|cancelled|failed) break ;; esac
    calls=$(python3 - "$ROOT" "$n" "$ta" <<'PY'
import json, glob, os, sys
root, n, ta = sys.argv[1:4]; c = 0
for f in glob.glob(os.path.join(root, "logs", n, "*.jsonl")):
    for l in open(f, errors="replace"):
        try: e = json.loads(l)
        except Exception: continue
        if e.get("event") in ("planner-call", "model-usage") and e.get("phase") == "plan" and e.get("at", "") >= ta: c += 1
print(c)
PY
)
    if [[ $p == hold:* ]]; then lasthold=$(st hold "$n"); fi
    if [ "$calls" -gt "${PLAN_REPLAN_MAX_CALLS:-5}" ]; then log "#$n: $calls planner calls after the replan: cancelling (spend guard)"; cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" cancelled 600 >/dev/null; break; fi
    if [[ $p == hold:* ]] && [[ ,$(hold_field "$lasthold" answers), == *,more,* ]] && [ "$(hold_field "$lasthold" recommended)" = more ]; then
      log "#$n holds with more after $calls planner calls: stopping here (allowance reached)"; break; fi
    [[ $p == hold:* ]] && auto_answer "$n"
    sleep 5
  done
  echo "$lasthold" >"$RUN_DIR/replan-final-lasthold.$n.json"
  log "#$n replan-final: planner calls after replan $calls; last hold $(hold_field "$lasthold" step) [$(hold_field "$lasthold" answers)] rec=$(hold_field "$lasthold" recommended)"
  [[ $(st phase "$n") == hold:* ]] && { cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" cancelled 600 >/dev/null; }
  sleep 20; serve_stop
  local pl rep1 fh; pl=$(st starts-since "$n" "$ta" 'plan:*'); rep1=$(st get "$n" repairs)
  fh=$(st events "$n" event=outcome outcome=hold step=final)
  local fr; fr=$(python3 -c 'import json,sys;r=json.loads(sys.argv[1]) or {};print(r.get("final",{}).get("count",0))' "$rep1")
  end_done "$n"; local ok=$?
  local ev="final held [$(hold_field "$hold" answers)]; main fixed; replan at $ta; plan starts since $pl; planner calls $calls; last hold $(hold_field "$lasthold" step) [$(hold_field "$lasthold" answers)] rec=$(hold_field "$lasthold" recommended); repairs before $(head -c 160 <<<"$rep0"), after $(head -c 160 <<<"$rep1"); final holds $fh; $EVID"
  [ $ok = 0 ] && [ "$pl" = 1 ] && [ "$fr" = 0 ] && record plan.replan-final $g PASS "$ev" "$t0" || record plan.replan-final $g FAIL "$ev" "$t0"
}

# `continue` to the planning edit question doesn't ask again at publish.
plan_continue_edit() {
  local g=plan t0 n; t0=$(now)
  need plan.continue-edit $g "$t0" review-fixes || return
  local HOLD_POLICY="$HOLD_POLICY decide"
  n=$(new_objective $g happy "plan continue edit" ID="$(uid)") || return
  serve_alive || serve_start || return
  wait_for 1200 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' started $n 'plan*') = 1 ]"
  gh issue edit "$n" --repo "$REPO" --body "$(gh issue view "$n" --repo "$REPO" --json body --jq .body)

Drill edit while planning: nothing changes in the goal." >/dev/null
  local asked=0 steps="" end=$(( $(now) + 3600 )) p hj
  while [ "$(now)" -lt "$end" ]; do
    serve_tick; p=$(st phase "$n")
    case $p in done|cancelled|failed) break ;; esac
    if [[ $p == hold:* ]]; then
      hj=$(st hold "$n")
      if [[ ,$(hold_field "$hj" answers), == *,continue,* ]]; then
        local hid; hid=$(hold_field "$hj" id)
        if [ ! -f "$RUN_DIR/cont.$n.$hid" ]; then touch "$RUN_DIR/cont.$n.$hid"; asked=$((asked + 1)); steps="$steps $(hold_field "$hj" step)"; answer_t 60 "$n" continue --question "$hid" >/dev/null 2>&1; fi
      else auto_answer "$n" || { log "#$n held at $p"; break; }; fi
    fi
    sleep 10
  done
  sleep 20
  end_done "$n"; local ok=$?
  local ev="edited while planning; edit questions $asked at [${steps# }]; $EVID"
  if [ "$asked" = 0 ]; then record plan.continue-edit $g UNREACHABLE "the edit came too late for planning to ask; $ev" "$t0"
  elif [ $ok = 0 ] && [ "$asked" = 1 ]; then record plan.continue-edit $g PASS "$ev" "$t0"
  else record plan.continue-edit $g FAIL "$ev" "$t0"; fi
}

# A serve whose step deadlines are capped at 3 s (dynamic scope: serve_start sees the local).
plan_tight_serve() { local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_DEADLINE_MS=3000 FACTORY_BACKOFF_MS=5000"; serve_start; }
# `retry` to a final-review error hold doesn't rerun final validation.
plan_retry_final_review() {
  local g=plan t0 n; t0=$(now)
  need plan.retry-final-review $g "$t0" review-fixes deadline || return
  local HOLD_POLICY="$HOLD_POLICY decide"
  serve_stop
  n=$(new_objective $g happy "plan retry final review" ID="$(uid)") || return
  crash_at "$n" engine:final-review:started 3600
  [ "$CRASH_R" = 137 ] || { record plan.retry-final-review $g FAIL "#$n never reached final review ($CRASH_R)" "$t0"; settle_group $g; return; }
  local f0; f0=$(st events "$n" event=start step=final)
  plan_tight_serve || return
  local p hold; p=$(wait_phase "$n" '^hold:final-review$|done|cancelled|failed' 1200); hold=$(st hold "$n" final-review)
  serve_stop
  if [[ $p != hold:final-review ]]; then record plan.retry-final-review $g FAIL "final review never held under a 3 s deadline (phase $p)" "$t0"; serve_start; cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled|done' 900 >/dev/null; serve_stop; return; fi
  local f1; f1=$(st events "$n" event=start step=final)
  serve_start || return
  answer_t 60 "$n" retry --question "$(hold_field "$hold" id)" >/dev/null 2>&1
  p=$(wait_phase "$n" 'done|cancelled|failed' 2700); sleep 20; serve_stop
  local f2; f2=$(st events "$n" event=start step=final)
  end_done "$n"; local ok=$?
  local ev="final-review held [$(hold_field "$hold" answers)] under a 3 s deadline; final starts $f0 / $f1 / $f2 (crash, hold, after retry); $EVID"
  [ $ok = 0 ] && [ "$f2" = "$f1" ] && record plan.retry-final-review $g PASS "$ev" "$t0" || record plan.retry-final-review $g FAIL "$ev" "$t0"
}
