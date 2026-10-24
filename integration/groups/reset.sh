# reset: `factory reset ISSUE` rebuilds an Objective's state from GitHub
# (plan comment, PRs, report). Only for builds whose CLI has `reset`.
# The reset:* crash points are in crash-points.
reset_needs() { echo "drill repo + Project; a build with 'factory reset'; default provider"; }
reset_cost() { echo "~30-45 min; 3 Objectives in parallel to completion + 1 plain issue"; }
reset_minutes() { echo 45; }
reset_plan() {
  echo "reset.refuse-none   reset of an issue Factory never saw: refused with code no_factory_state"
  echo "reset.done          reset of a done Objective: still done, no new PR or comment"
  echo "reset.in-flight     reset while a PR is open: finishes done once, no duplicate PR"
  echo "reset.unreadable    corrupt state file: service lists it unreadable; reset rebuilds it and it finishes done"
  echo "reset.foreign-json  a comment by the operator with a json plan-like block, posted before Factory's plan: reset of the done Objective rebuilds the same Work Items from Factory's marked plan $(pre reset)"
}
reset_cfg() { cfg_patch "$CUR_CFG" 'c["queue"]["maxActiveObjectives"]=3'; }
reset_run() {
  local g=reset t0 a b c r
  t0=$(now)
  if ! cli_has reset; then
    for r in refuse-none done in-flight unreadable foreign-json; do record "reset.$r" $g UNREACHABLE "this build's CLI has no reset command" "$t0"; done; return
  fi
  a=$(new_objective $g happy "reset done" ID="$(uid)")
  # a json block that isn't Factory's plan, before the plan comment.
  gh_comment "$a" "Operator notes for this Objective (not a plan):

\`\`\`json
{\"version\": 1, \"items\": [{\"id\": \"drill-fake-item\", \"title\": \"not Factory's\"}]}
\`\`\`" >/dev/null
  b=$(new_objective $g happy "reset in-flight" ID="$(uid)")
  c=$(new_objective $g happy "reset unreadable" ID="$(uid)")
  serve_start || return
  # refuse-none: a plain issue that is not on the Project.
  local plain err code
  plain=$(gh issue create --repo "$REPO" --title "Suite $RUN_ID: reset refuse-none" --body "Not an Objective." | grep -o '[0-9]*$')
  err=$(cli_t 60 reset "$plain" 2>&1 >/dev/null); code=$(grep -o '"code":"[a-z_]*"' <<<"$err" | head -1 | cut -d'"' -f4)
  gh issue close "$plain" --repo "$REPO" --reason "not planned" >/dev/null 2>&1
  [ "$code" = no_factory_state ] && record reset.refuse-none $g PASS "refused: $code" "$t0" || record reset.refuse-none $g FAIL "code='$code'" "$t0"
  # in-flight: reset as soon as b has an open PR.
  t0=$(now)
  local pr=""; local end=$(( $(now) + 2400 ))
  while [ "$(now)" -lt "$end" ] && [ -z "$pr" ]; do serve_tick; pr=$(gh_open_pr "$b"); [ -z "$pr" ] && sleep 10; done
  [ -n "$pr" ] && cli_t 60 reset "$b" >/dev/null 2>&1 && log "#$b reset with PR #$pr open"
  # unreadable: once c has a plan, stop, corrupt its state, restart.
  wait_phase "$c" '^(building|finishing|done)$' 1800 >/dev/null
  serve_stop
  cp "$ROOT/objectives/$c.json" "$RUN_DIR/state-$c.backup.json"
  echo '{"not": "a state' >"$ROOT/objectives/$c.json"
  serve_start || return; sleep 20
  local unr; unr=$(st unreadable "$c")
  cli_t 60 reset "$c" >/dev/null 2>&1
  wait_phase "$a" 'done|cancelled|failed' 2700 >/dev/null
  local before; before=$(gh_prs "$a"); local mb; mb=$(gh_markers "$a")
  local items0; items0=$(st get "$a" done.plan.items | python3 -c 'import json,sys;print(" ".join(i["id"] for i in (json.load(sys.stdin) or [])))')
  cli_t 60 reset "$a" >/dev/null 2>&1; sleep 60
  local items1; items1=$(st get "$a" done.plan.items | python3 -c 'import json,sys;print(" ".join(i["id"] for i in (json.load(sys.stdin) or [])))')
  wait_phase "$b" 'done|cancelled|failed' 2700 >/dev/null
  wait_phase "$c" 'done|cancelled|failed' 2700 >/dev/null
  sleep 20; serve_stop
  end_done "$a"; local ok=$?; [ "$(gh_prs "$a")" = "$before" ] && [ "$(gh_markers "$a")" = "$mb" ] || ok=1
  [ $ok = 0 ] && record reset.done $g PASS "PRs and markers unchanged; $EVID" "$t0" || record reset.done $g FAIL "PRs/markers changed or not done; $EVID" "$t0"
  if [ -n "$items0" ] && [ "$items0" = "$items1" ] && [[ " $items1 " != *" drill-fake-item "* ]]; then record reset.foreign-json $g PASS "Work Items before reset [$items0], after [$items1]; the operator's json block was ignored" "$t0"
  else record reset.foreign-json $g FAIL "Work Items before reset [$items0], after [$items1]" "$t0"; fi
  if [ -z "$pr" ]; then record reset.in-flight $g FAIL "#$b never had an open PR to reset on" "$t0"
  elif end_done "$b"; then record reset.in-flight $g PASS "reset with PR #$pr open; $EVID" "$t0"
  else record reset.in-flight $g FAIL "$EVID" "$t0"; fi
  if [ "$unr" = 1 ] && end_done "$c"; then record reset.unreadable $g PASS "listed unreadable, rebuilt; $EVID" "$t0"
  else end_done "$c"; record reset.unreadable $g FAIL "unreadable listed=$unr; $EVID" "$t0"; fi
}
