# tracking: `factory run`, Work Item issue tracking, the live status comment,
# cancel comments and reminders, the deadline, blocked-by dependencies,
# answer --text-file and diagnostics.
# Crash points of these features are recorded here as crash-points.<point>.
tracking_needs() { echo "drill repo + Project; default provider; a build with 'factory run' and tracking"; }
tracking_cost() { echo "~3-4 h; ~14 Objectives (5 to done), the rest cancelled at a question or an open PR"; }
tracking_minutes() { echo 240; }
TRACK_ONLY=${TRACK_ONLY:-run run-crash tracking tracking-crash cancel remind deadline blocked-by}
tracking_plan() {
  echo "tracking.run-command        'factory run N' on an unqueued issue (tracking off): Factory queues the card, the follower exits 0 at done"
  echo "tracking.tracking-off       tracking.enabled false: no sub-issue is created"
  echo "crash-points.run:queue:* crash around run's card write, restart: the request is read again, admitted once"
  echo "crash-points.run:unqueue:* cancel of a run not yet admitted: the queued card moves to Cancelled, never admitted"
  echo "tracking.tracking           chain2 labelled P1: one sub-issue per item (role label, P1 inherited, blocked-by, closed completed, no duplicates); Objective labelled"
  echo "tracking.item-cards         Work Item cards on the Project carry no option and are never admitted"
  echo "tracking.status-issue       'status --issue <item issue> --json' names the Objective; status --json has allowances"
  echo "tracking.status-comment     exactly one live status comment, edited in place"
  echo "tracking.diagnostics        'diagnostics N --summary --json' and '--logs ITEM --json' parse"
  echo "crash-points.sync:status|objective-role|item-issue:* chained on twin Objectives with tracking on; end: no duplicate issue, comment or label"
  echo "tracking.cancel-comment     cancel during CI (crash at sync:cancel:*): one cancelled:<run> comment; item issues closed not planned"
  echo "crash-points.sync:remind:* + tracking.reminder  any hold, FACTORY_REMIND_MS=60000: one remind:hold:<id> comment"
  echo "tracking.text-file          answer --text-file: the request carries the file's text"
  echo "tracking.deadline           'run --deadline 4m' on a hold: cancelled at the deadline (ended.by deadline), one cancel comment; engine:deadline:* crash points"
  echo "tracking.blocked-by         B blocked by A (issue dependency): B plans only after A is done; both done"
}
tracking_cfg() { cfg_patch "$CUR_CFG" 'c["queue"]["maxActiveObjectives"]=3' 'c["queue"]["pollSeconds"]=10'; }

w_api() { gh api "$@" 2>/dev/null; }
w_subs() { w_api "repos/$REPO/issues/$1/sub_issues?per_page=100" --jq '[.[]|{number, state, reason: .state_reason, labels: [.labels[].name], mark: ([(.body // "") | capture("<!-- factory:[0-9]+:item:(?<i>[^ ]+) -->")][0].i // "")}]' || echo "[]"; }
w_items() { st get "$1" done.plan.items | python3 -c 'import json,sys;print(len(json.load(sys.stdin) or []))'; }
# w_run N SECS [ARGS]: `factory run N`, answering planner questions (exit 2) by the decide policy; sets W_RC.
w_run() {
  local n=$1 secs=$2; shift 2; local end=$(( $(now) + secs )) i
  W_RC=99
  for i in 1 2 3 4 5 6; do
    cli_t $(( end - $(now) > 30 ? end - $(now) : 30 )) run "$n" "$@" >>"$RUN_DIR/run.$n.out" 2>&1; W_RC=$?
    [ "$W_RC" = 2 ] || return 0
    local HOLD_POLICY="d2 review decide"; auto_answer "$n" || return 0
    sleep 5; set --   # later follows take no options
  done
}
w_record_chain() { # like record_chain, but a point the run never reached is UNREACHABLE
  local g=$1 ok=$2 ev=$3 t0=$4; shift 4; local pt
  for pt in "$@"; do
    if [[ ${CH[$pt]:-} == crashed* ]]; then [ "$ok" = 0 ] && record "crash-points.$pt" "$g" PASS "${CH[$pt]}; $ev" "$t0" || record "crash-points.$pt" "$g" FAIL "${CH[$pt]}; $ev" "$t0"
    else record "crash-points.$pt" "$g" UNREACHABLE "${CH[$pt]:-not run}: the run never reached it; $ev" "$t0"; fi
  done
}

w_run_command() {
  local g=tracking t0 n keep=$CUR_CFG; t0=$(now)
  cli_has run || { record tracking.run-command $g UNREACHABLE "feature absent: run" "$t0"; return; }
  CUR_CFG="$RUN_DIR/config.tracking-off.json"; cp "$keep" "$CUR_CFG"; cfg_patch "$CUR_CFG" 'c.setdefault("tracking",{})["enabled"]=False'
  n=$(new_issue $g happy "tracking run command" ID="$(uid)") || { CUR_CFG=$keep; return; }
  serve_start || { CUR_CFG=$keep; return; }
  w_run "$n" 3000; local rc=$W_RC
  wait_phase "$n" 'done|cancelled|failed' 600 >/dev/null; sleep 20
  local card subs; card=$(gh_card_value "$n"); subs=$(w_subs "$n")
  serve_stop; CUR_CFG=$keep
  end_done "$n"; local ok=$?
  local ns; ns=$(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1])))' "$subs")
  [ $ok = 0 ] && [ "$rc" = 0 ] && [ "$card" = Done ] && record tracking.run-command $g PASS "run exit $rc; card $card; $EVID" "$t0" || record tracking.run-command $g FAIL "run exit $rc; card '$card'; $EVID" "$t0"
  [ "$ns" = 0 ] && [ $ok = 0 ] && record tracking.tracking-off $g PASS "#$n done with tracking.enabled false: $ns sub-issues" "$t0" || record tracking.tracking-off $g FAIL "#$n: $ns sub-issues with tracking off (done check $ok)" "$t0"
}

# run:queue:* — crash around the card write; the request is read again after the restart.
w_run_crash() {
  local g=tracking t0 pt n
  for pt in run:queue:before run:queue:after; do
    t0=$(now)
    n=$(new_issue $g hold "tracking crash $pt" ID="$(uid)") || continue
    serve_start "$pt" || return
    ( cli_t 60 run "$n" >>"$RUN_DIR/run.$n.out" 2>&1 & )
    local end=$(( $(now) + 120 )); while [ "$(now)" -lt "$end" ] && [ ! -s "$SERVE_DIR/exit" ]; do sleep 2; done
    local code; code=$(cat "$SERVE_DIR/exit" 2>/dev/null); serve_stop
    [ "$code" = 137 ] && CH[$pt]="crashed $(ts)" || CH[$pt]="missed (exit ${code:-none})"
    serve_start || return
    wait_for 600 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $n)\" != none ]"
    local p; p=$(wait_phase "$n" '^hold:|done|cancelled' 900)
    local adm; adm=$(st events "$n" event=admitted)
    cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" cancelled 600 >/dev/null; sleep 15; serve_stop
    end_cancelled "$n"; local ok=$?
    [ "$adm" = 1 ] && [[ $p == hold:* ]] || ok=1
    w_record_chain crash-points $ok "#$n admitted x$adm after the restart, reached $p; $EVID" "$t0" "$pt"
  done
  # run:unqueue:* — the card reads queued (crash right after run's write), the run is cancelled before admission.
  t0=$(now); CH=()
  n=$(new_issue $g hold "tracking crash run:unqueue" ID="$(uid)") || return
  serve_start run:queue:after || return
  ( cli_t 60 run "$n" >>"$RUN_DIR/run.$n.out" 2>&1 & )
  local end=$(( $(now) + 120 )); while [ "$(now)" -lt "$end" ] && [ ! -s "$SERVE_DIR/exit" ]; do sleep 2; done
  serve_stop
  cli_t 30 cancel "$n" >/dev/null 2>&1   # waits in requests/ while the service is stopped
  chain "$n" run:unqueue:before run:unqueue:after
  serve_start || return; sleep 60
  local s card plan; s=$(st status "$n"); card=$(gh_card_value "$n"); plan=$(st events "$n" event=start 'step=plan*')
  serve_stop
  local ok=1; [ "$card" = Cancelled ] && [ "$plan" = 0 ] && ok=0
  w_record_chain crash-points $ok "#$n status $s, card '$card', plan starts $plan" "$t0" run:unqueue:before run:unqueue:after
  gh issue close "$n" --repo "$REPO" --reason "not planned" >/dev/null 2>&1
}

w_tracking() {
  local g=tracking t0 n; t0=$(now)
  local HOLD_POLICY="d2 review decide"
  n=$(new_objective $g chain2 "tracking tracking" ID="$(uid)") || return
  gh issue edit "$n" --repo "$REPO" --add-label P1 >/dev/null 2>&1   # priority inheritance: items get P1
  serve_start || return
  local p; p=$(wait_phase "$n" 'done|cancelled|failed' 3600); sleep 75   # the after-end tracking pass
  local items subs; items=$(w_items "$n"); subs=$(w_subs "$n")
  local olabels; olabels=$(w_api "repos/$REPO/issues/$n" --jq '[.labels[].name]|join(",")')
  local otype; otype=$(w_api "repos/$REPO/issues/$n" --jq '.type.name // ""')
  local first; first=$(python3 -c 'import json,sys;s=json.loads(sys.argv[1]);print(s[0]["number"] if s else "")' "$subs")
  # blocked-by between the two item issues
  local blk=0 x; for x in $(python3 -c 'import json,sys;print(" ".join(str(i["number"]) for i in json.loads(sys.argv[1])))' "$subs"); do
    blk=$(( blk + $(w_api "repos/$REPO/issues/$x/dependencies/blocked_by" --jq 'length' || echo 0) )); done
  local sj; sj=$( [ -n "$first" ] && cli_t 30 status --issue "$first" --json 2>/dev/null )
  local cards=""; [ -n "$first" ] && cards=$(gh_card_value "$first")
  local istate=""; [ -n "$first" ] && istate=$(st status "$first")
  local allow; allow=$(cli_t 30 status "$n" --json 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin)
r=[o for o in d.get("objectives",[]) if str(o.get("issue"))==sys.argv[1]]
print("yes" if r and "allowances" in r[0] else "no")' "$n" 2>/dev/null)
  local diag1 diag2 item1; item1=$(st get "$n" done.plan.items | python3 -c 'import json,sys;i=json.load(sys.stdin) or [];print(i[0]["id"] if i else "")')
  cli_t 60 diagnostics "$n" --summary --json 2>/dev/null | python3 -c 'import json,sys;json.load(sys.stdin)' 2>/dev/null; diag1=$?
  cli_t 60 diagnostics "$n" --logs "$item1" --json 2>/dev/null | python3 -c 'import json,sys;json.load(sys.stdin)' 2>/dev/null; diag2=$?
  local sc; sc=$(gh api "repos/$REPO/issues/$n/comments" --paginate --jq '[.[]|select(.body|contains("<!-- factory:'"$n"':status:"))|{created: .created_at, updated: .updated_at}]' | python3 -c 'import json,sys
rows=[r for l in sys.stdin for r in json.loads(l)]
print(len(rows), sum(1 for r in rows if r["updated"]>r["created"]))')
  serve_stop
  end_done "$n"; local ok=$?
  local tr; tr=$(python3 - "$subs" "$items" "$olabels" <<'PY'
import json, sys
s = json.loads(sys.argv[1]); items = int(sys.argv[2] or 0); ol = sys.argv[3].split(",")
marks = [x["mark"] for x in s]
bad = []
if len(s) != items: bad.append(f"{len(s)} sub-issues for {items} items")
if len(set(marks)) != len(marks) or "" in marks: bad.append(f"item markers {marks}")
if any("factory:work-item" not in x["labels"] for x in s): bad.append("an item issue lacks factory:work-item")
if any("P1" not in x["labels"] for x in s): bad.append("an item issue lacks the Objective's P1")
if any(x["state"] != "closed" or x["reason"] != "completed" for x in s): bad.append("states " + ",".join(f'{x["state"]}/{x["reason"]}' for x in s))
if "factory:objective" not in ol: bad.append(f"Objective labels {ol}")
print(("FAIL " if bad else "PASS ") + "; ".join(bad) + f" | {len(s)} item issues {[x['number'] for x in s]}")
PY
)
  [ $ok = 0 ] && [ "${tr%% *}" = PASS ] && [ "$blk" -ge 1 ] && record tracking.tracking $g PASS "${tr#* }; blocked-by links $blk; Objective type '${otype}'; $EVID" "$t0" \
    || record tracking.tracking $g FAIL "${tr#* }; blocked-by links $blk; Objective type '${otype}'; $EVID" "$t0"
  [ -n "$first" ] && [ -z "$cards" ] && [ "$istate" = none ] && record tracking.item-cards $g PASS "item issue #$first: card option '' and no Factory state" "$t0" || record tracking.item-cards $g FAIL "item issue #${first:-none}: card '$cards', state $istate" "$t0"
  local foc; foc=$(python3 -c 'import json,sys
try: d=json.loads(sys.argv[1])
except Exception: print("unparsable"); sys.exit()
print(json.dumps(d.get("focus"))[:160] if "focus" in d else "no focus; keys "+",".join(list(d)[:8]))' "$sj")
  [[ $foc == *"$n"* ]] && [ "$allow" = yes ] && record tracking.status-issue $g PASS "status --issue $first: focus $foc; status --json allowances present" "$t0" || record tracking.status-issue $g FAIL "status --issue ${first:-none}: $foc; allowances $allow" "$t0"
  read -r scn sce <<<"$sc"
  [ "$scn" = 1 ] && [ "${sce:-0}" -ge 1 ] && record tracking.status-comment $g PASS "one status comment, edited in place" "$t0" || record tracking.status-comment $g FAIL "status comments $scn, edited $sce" "$t0"
  [ "$diag1" = 0 ] && [ "$diag2" = 0 ] && record tracking.diagnostics $g PASS "diagnostics --summary --json and --logs $item1 --json parse" "$t0" || record tracking.diagnostics $g FAIL "summary exit/parse $diag1, logs $diag2" "$t0"
}

# Tracking crash points, chained in the order a run reaches them. Role labels are made once per
# installation (they exist already) and priority labels need a P<n> label on the repo: UNREACHABLE.
W_TRACK_CHAINS=${W_TRACK_CHAINS:-"sync:status:before sync:status:after sync:objective-role:before sync:objective-role:after sync:item-issue:create:before sync:item-issue:create:after sync:item-issue:label:before sync:item-issue:label:after|sync:item-issue:card:before sync:item-issue:card:after sync:item-issue:link:before sync:item-issue:link:after sync:item-issue:comment:before sync:item-issue:comment:after sync:item-issue:edit:before sync:item-issue:edit:after sync:item-issue:close:before sync:item-issue:close:after"}
w_tracking_crash() {
  local g=tracking t0 n chainspec pts; t0=$(now)
  local p; for p in sync:roles:label:before sync:roles:label:after; do record "crash-points.$p" $g UNREACHABLE "the role labels exist on the repo already (made once per installation); deleting them wasn't approved" "$t0"; done
  local HOLD_POLICY="d2 review decide"
  IFS='|' read -ra chains <<<"$W_TRACK_CHAINS"
  for chainspec in "${chains[@]}"; do
    t0=$(now); CH=(); read -ra pts <<<"$chainspec"
    n=$(new_objective $g chain2 "tracking crash tracking ${pts[0]}" ID="$(uid)") || continue
    gh issue edit "$n" --repo "$REPO" --add-label P1 >/dev/null 2>&1   # priority labels reach sync:item-issue:label
    CRASH_TIMEOUT=900 chain "$n" "${pts[@]}"
    serve_start || return
    wait_phase "$n" 'done|cancelled|failed' 3600 >/dev/null; sleep 75; serve_stop
    end_done "$n"; local ok=$?
    local subs items; subs=$(w_subs "$n"); items=$(w_items "$n")
    local d; d=$(python3 -c 'import json,sys;s=json.loads(sys.argv[1]);m=[x["mark"] for x in s];print("ok" if len(m)==len(set(m)) and len(s)==int(sys.argv[2] or 0) else "issues %d for %s items, markers %s"%(len(s),sys.argv[2],m))' "$subs" "$items")
    local ic; ic=0; for x in $(python3 -c 'import json,sys;print(" ".join(str(i["number"]) for i in json.loads(sys.argv[1])))' "$subs"); do
      local c; c=$(gh api "repos/$REPO/issues/$x/comments" --jq '[.[]|select(.body|contains(":item-status:"))]|length' 2>/dev/null); [ "${c:-0}" -gt 1 ] && ic=$((ic + 1)); done
    [ "$d" = ok ] && [ "$ic" = 0 ] || ok=1
    w_record_chain $g $ok "item issues $d, issues with >1 live comment $ic; $EVID" "$t0" "${pts[@]}"
  done
}

# Cancel during CI with tracking on; crash around the cancel comment.
w_cancel() {
  local g=tracking t0 n pr; t0=$(now); CH=()
  n=$(new_objective $g cancel2 "tracking cancel comment" ID="$(uid)") || return
  serve_start || return
  local end=$(( $(now) + 2400 )); pr=""
  while [ "$(now)" -lt "$end" ] && [ -z "$pr" ]; do serve_tick; pr=$(gh_open_pr "$n"); [ -z "$pr" ] && sleep 10; done
  serve_stop
  [ -n "$pr" ] || { record tracking.cancel-comment $g FAIL "#$n never opened a PR" "$t0"; serve_start; cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" cancelled 900 >/dev/null; serve_stop; return; }
  rm -f "$RUN_DIR/cp-cancel-sent"
  CRASH_HOOK=cp_cancel_hook chain "$n" sync:cancel:before sync:cancel:after
  serve_alive || serve_start
  wait_phase "$n" cancelled 1800 >/dev/null; sleep 75; serve_stop
  end_cancelled "$n"; local ok=$?
  local cc; cc=$(marker_prefix_count "$(gh_markers "$n")" cancelled:)
  local subs; subs=$(w_subs "$n")
  local np; np=$(python3 -c 'import json,sys;s=json.loads(sys.argv[1]);print(len(s), sum(1 for x in s if x["state"]=="closed" and x["reason"]=="not_planned"))' "$subs")
  read -r nsub nnp <<<"$np"
  local ev="cancelled:<run> comments $cc; item issues $nsub, closed not planned $nnp; $EVID"
  [ $ok = 0 ] && [ "$cc" = 1 ] && record tracking.cancel-comment $g PASS "$ev" "$t0" || record tracking.cancel-comment $g FAIL "$ev" "$t0"
  [ "$nsub" -ge 1 ] && [ "$nsub" = "$nnp" ] && record tracking.items-not-planned $g PASS "$ev" "$t0" || record tracking.items-not-planned $g FAIL "$ev" "$t0"
  local cok=1; [ $ok = 0 ] && [ "$cc" = 1 ] && cok=0
  w_record_chain $g $cok "$ev" "$t0" sync:cancel:before sync:cancel:after
}

# The 24 h question reminder, shortened: crash around it, then one reminder; then answer by --text-file.
w_remind() {
  local g=tracking t0 n hid; t0=$(now); CH=()
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_REMIND_MS=60000"
  n=$(new_objective $g hold "tracking remind" ID="$(uid)") || return
  serve_start || return
  wait_phase "$n" '^hold:' 1500 >/dev/null; hid=$(hold_field "$(st hold "$n")" id); sleep 20; serve_stop
  chain "$n" sync:remind:before sync:remind:after
  serve_start || return; sleep 150
  local rc; rc=$(marker_count "$(gh_markers "$n")" "remind:hold:$hid")
  local still; still=$(hold_field "$(st hold "$n")" id)
  local ok=1; [ "$rc" = 1 ] && [ "$still" = "$hid" ] && ok=0
  w_record_chain $g $ok "remind:hold:$hid comments $rc" "$t0" sync:remind:before sync:remind:after
  [ $ok = 0 ] && record tracking.reminder $g PASS "one reminder for $hid after FACTORY_REMIND_MS, across two crashes" "$t0" || record tracking.reminder $g FAIL "reminders for $hid: $rc (hold now $still)" "$t0"
  # --text-file
  t0=$(now)
  local tf="$RUN_DIR/answer-$n.txt"; printf 'Join with a forward slash "/" (drill %s).\n' "$RUN_ID" >"$tf"
  local out code; out=$(cli_t 60 answer "$n" answer --question "$hid" --text-file "$tf" 2>&1); code=$?
  sleep 10
  local got; got=$(python3 - "$ROOT" "$n" "$hid" <<'PY'
import json, glob, os, sys
root, n, hid = sys.argv[1:4]; t = ""
for f in glob.glob(os.path.join(root, "logs", n, "*.jsonl")):
    for l in open(f, errors="replace"):
        try: e = json.loads(l)
        except Exception: continue
        r = e.get("request") or {}
        if e.get("event") == "request" and r.get("question") == hid: t = r.get("text", "")
print(t)
PY
)
  [ "$code" = 0 ] && [ "$got" = "$(cat "$tf")" ] && record tracking.text-file $g PASS "answer --text-file applied; request text = file" "$t0" || record tracking.text-file $g FAIL "exit $code ($(head -c 120 <<<"$out")); request text '$(head -c 80 <<<"$got")'" "$t0"
  cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" cancelled 600 >/dev/null; sleep 15; serve_stop
}

# Absolute deadline via `run --deadline`, then its crash points.
w_deadline() {
  local g=tracking t0 n; t0=$(now)
  cli_has run || { record tracking.deadline $g UNREACHABLE "feature absent: run" "$t0"; return; }
  n=$(new_issue $g hold "tracking deadline" ID="$(uid)") || return
  serve_start || return
  cli_t 1500 run "$n" --deadline 5m >>"$RUN_DIR/run.$n.out" 2>&1; local rc=$?
  local dl; dl=$(cli_t 30 status "$n" --json 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin); r=[o for o in d.get("objectives",[]) if str(o.get("issue"))==sys.argv[1]]
print(json.dumps((r[0].get("deadline") if r else None)))' "$n")
  local p; p=$(wait_phase "$n" 'cancelled|done' 900); sleep 60
  local by; by=$(st get "$n" ended.by); local cc; cc=$(marker_prefix_count "$(gh_markers "$n")" cancelled:)
  serve_stop
  end_cancelled "$n"; local ok=$?
  local ev="run --deadline 5m exit $rc (a question), status deadline $dl; then $p, ended.by $by, cancel comments $cc; $EVID"
  [ $ok = 0 ] && [ "$by" = '"deadline"' ] && [ "$cc" = 1 ] && [ "$dl" != null ] && record tracking.deadline $g PASS "$ev" "$t0" || record tracking.deadline $g FAIL "$ev" "$t0"
  # engine:deadline:before-cancel, then :cancelled on the restart past it.
  t0=$(now); CH=()
  n=$(new_issue $g hold "tracking deadline crash" ID="$(uid)") || return
  serve_start || return
  cli_t 1500 run "$n" --deadline 4m >>"$RUN_DIR/run.$n.out" 2>&1
  serve_stop
  chain "$n" engine:deadline:before-cancel engine:deadline:cancelled
  serve_start || return
  wait_phase "$n" cancelled 600 >/dev/null; sleep 60; serve_stop
  by=$(st get "$n" ended.by); cc=$(marker_prefix_count "$(gh_markers "$n")" cancelled:)
  end_cancelled "$n"; ok=$?
  [ "$by" = '"deadline"' ] && [ "$cc" = 1 ] || ok=1
  w_record_chain $g $ok "ended.by $by, cancel comments $cc; $EVID" "$t0" engine:deadline:before-cancel engine:deadline:cancelled
}

# Objective dependencies: B blocked by A through GitHub's issue dependency.
w_blocked_by() {
  local g=tracking t0 a b; t0=$(now)
  local HOLD_POLICY="d2 review decide"
  a=$(new_issue $g happy "tracking blocker A" ID="$(uid)") || return
  b=$(new_issue $g filler "tracking blocked B" ID="$(uid)") || return
  local aid; aid=$(gh api "repos/$REPO/issues/$a" --jq .id)
  gh api -X POST "repos/$REPO/issues/$b/dependencies/blocked_by" -F issue_id="$aid" >/dev/null 2>&1 \
    || { record tracking.blocked-by $g UNREACHABLE "couldn't add the blocked-by link #$b <- #$a" "$t0"; return; }
  gh_enqueue "$b" >/dev/null; gh_enqueue "$a" >/dev/null
  serve_start || return
  wait_phase "$a" 'done|cancelled|failed' 3600 >/dev/null
  local adone; adone=$(python3 - "$ROOT" "$a" <<'PY'
import json, glob, os, sys
root, n = sys.argv[1:3]; t = ""
for f in glob.glob(os.path.join(root, "logs", n, "*.jsonl")):
    for l in open(f, errors="replace"):
        try: e = json.loads(l)
        except Exception: continue
        if e.get("step") == "report" and e.get("event") == "outcome" and e.get("outcome") == "done": t = e.get("at", "")
        if e.get("event") == "settled" and not t: t = e.get("at", "")
print(t)
PY
)
  local bplan0; bplan0=$(st events "$b" event=start 'step=plan*')
  wait_phase "$b" 'done|cancelled|failed' 3600 >/dev/null; sleep 20; serve_stop
  local early; early=$(python3 - "$ROOT" "$b" <<'PY'
import json, glob, os, sys
root, n = sys.argv[1:3]; first = ""
for f in glob.glob(os.path.join(root, "logs", n, "*.jsonl")):
    for l in open(f, errors="replace"):
        try: e = json.loads(l)
        except Exception: continue
        if e.get("event") == "start" and str(e.get("step", "")).startswith("plan") and (not first or e["at"] < first): first = e["at"]
print(first)
PY
)
  end_done "$a"; local oka=$? eva=$EVID; end_done "$b"; local okb=$?
  local ev="A #$a done at $adone; B #$b first plan step at $early (plan starts before A ended: $bplan0); $eva | $EVID"
  if [ $oka = 0 ] && [ $okb = 0 ] && [ "$bplan0" = 0 ] && [ -n "$early" ]; then record tracking.blocked-by $g PASS "$ev" "$t0"
  else record tracking.blocked-by $g FAIL "$ev" "$t0"; fi
}

tracking_run() {
  local t
  for t in $TRACK_ONLY; do
    case $t in
      run) w_run_command ;; run-crash) w_run_crash ;; tracking) w_tracking ;; tracking-crash) w_tracking_crash ;;
      cancel) w_cancel ;; remind) w_remind ;; deadline) w_deadline ;; blocked-by) w_blocked_by ;;
    esac
    serve_stop
  done
}
