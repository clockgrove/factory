# stability: service behaviours the other groups don't reach:
# the service crash loop (delayed resume, then a suspect hold), a re-queue
# reopening a cancelled Objective, the author hold for a non-writer's issue,
# the pre-publish secret scan, updateMerge (GitHub's update-branch merge is
# Factory's own), and the wait clock pausing while a question is open.
stability_needs() { echo "drill repo + Project; default provider; .github/workflows/drill-issue.yml on main (files an issue as github-actions[bot]); policy.allowedSecretNames holding DRILL_DUMMY_CANARY in the scratch config (a dummy value is set in the serve's environment); a build with FACTORY_GITHUB_API, FACTORY_WAIT_MS and FACTORY_BACKOFF_MS"; }
stability_cost() { echo "~2-3 h; crash-loop/requeue: 1 hold Objective (3 planner calls) + 3 fillers cancelled at check; author-hold: 1 planner call; secret: 1 Objective to its publish hold; update-merge and wait-clock: 1 Objective each to completion"; }
stability_minutes() { echo 240; }
STAB_CANARY=${STAB_CANARY:-drillcanary-4f9e2b71-dummy}
STAB_PORT=${STAB_PORT:-18556}
STAB_ONLY=${STAB_ONLY:-crash-loop requeue-finished author-hold secret-scan update-merge wait-clock reset-foreign rate-limit gate-question requeue-report}
stability_plan() {
  echo "stability.crash-loop     3 SIGKILLs while the same plan step runs (a filler's check finishing in runs 2-3): start 3 resumes after resumeAt, start 4 holds that step with retry/cancel"
  echo "stability.requeue-reopen the crash-loop Objective cancelled (issue closed), card set Queued: Factory reopens the issue and plans again"
  echo "stability.author-hold    issue filed by github-actions[bot]: holds with approve/cancel before any plan step; approve plans it; approval kept by digest"
  echo "stability.secret-scan    worker writes \$DRILL_DUMMY_CANARY (dummy, allowedSecretNames): publish holds with repair/cancel, nothing pushed, no comment shows the value"
  echo "stability.update-merge   crash after the PR opens, main advances, update-branch (web-flow merge) on the PR: Factory goes on with no hold and merges that head"
  echo "stability.wait-clock     PR creation fails (502) for two parallel items, FACTORY_WAIT_MS=240000: one holds; while it's open the other's 'since' is frozen; answered 'wait', the other's since moves by the open time"
  echo "stability.reset-foreign  crash at deliver:pr-create:before, a foreign commit on factory/N/<item>, restart: publish holds with retry/reset/cancel; 'reset' replaces the branch, the foreign file never reaches main, done $(pre)"
  echo "stability.rate-limit     POST /pulls answers 429 with x-ratelimit-remaining 0 and a reset 180 s out: the step waits (wait.kind reset, error count 0) until the reset $(pre rate-reset github-api)"
  echo "stability.plain-403      then PUT merge answers a plain 403 (no rate-limit headers): no reset wait; the step holds or counts an error $(pre rate-reset github-api)"
  echo "stability.gate-question  required review on main, FACTORY_REMIND_MS=180000: during the merge gate the issue is edited and the edit question answered 'continue'; exactly one remind marker, ~180 s after the gate began $(pre remind approval:human-gate)"
  echo "stability.requeue-report a done Objective re-queued and run to done again: two report markers, report:<run> for each run, each once $(pre run-report)"
}
stability_cfg() { cfg_patch "$CUR_CFG" 'c["queue"]["maxActiveObjectives"]=1' 'c["queue"]["pollSeconds"]=10' \
  'c.setdefault("policy",{}); n=c["policy"].setdefault("allowedSecretNames",[]); "DRILL_DUMMY_CANARY" in n or n.append("DRILL_DUMMY_CANARY")'; }

svc_get() { python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print(""); sys.exit()
v=d.get(sys.argv[2]); print("" if v is None else (v if isinstance(v,(str,int)) else json.dumps(v)))' "$ROOT/service.json" "$1"; }
# Open attempts of N whose step matches GLOB: "STEP RUN STARTEDAT" lines.
attempts_of() { python3 - "$ROOT" "$1" "$2" <<'PY'
import json, sys, os, fnmatch
try: d = json.load(open(os.path.join(sys.argv[1], "objectives", sys.argv[2] + ".json")))
except Exception: sys.exit()
for k, a in (d.get("attempts") or {}).items():
    if fnmatch.fnmatchcase(k, sys.argv[3]): print(k, a.get("run", "-"), a.get("startedAt", "-"))
PY
}
retries_of() { st get "$1" retries; }
iso_s() { python3 -c 'import sys,datetime;print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")).timestamp()))' "$1"; }
# SIGKILL the serve: a death, not a clean stop.
stab_kill_serve() {
  local p s; p=$(serve_pid); s=$(starttime "$p"); serve_tick
  kill_exact "$p" "$s" KILL
  local i; for i in $(seq 1 30); do [ -s "$SERVE_DIR/exit" ] && break; sleep 1; done
  serve_reap; log "serve pid $p SIGKILLed (exit $(cat "$SERVE_DIR/exit" 2>/dev/null))"
}
# STAB_WAIT_HEARTBEAT=1 (default) waits for service.json to count the filler's
# step before the kill.
STAB_WAIT_HEARTBEAT=${STAB_WAIT_HEARTBEAT:-1}
stab_run_ready() { # N FILLER RUNID: filler checked and N's plan attempt is this run's
  [ "$(st get "$2" done.check)" != null ] || return 1
  [ "$STAB_WAIT_HEARTBEAT" = 1 ] && { [ "$(svc_get finished)" -gt 0 ] 2>/dev/null || return 1; }
  attempts_of "$1" 'plan*' | awk -v r="$3" '$2==r{f=1} END{exit !f}'
}

stab_crash_loop() {
  local g=stability t0 a f r runid resume="" ra="" fillers=() ok=0 why=""
  t0=$(now)
  a=$(new_objective $g hold "stability crash-loop" ID="$(uid)") || return
  for r in 1 2 3; do
    serve_start || return
    wait_for 60 bash -c "[ \"\$(python3 -c 'import json;print(json.load(open(\"$ROOT/service.json\")).get(\"pid\"))' 2>/dev/null)\" = $(serve_pid) ]"
    runid=$(svc_get runId)
    [ "$r" = 3 ] && { resume=$(svc_get resumeAt); log "run 3 resumeAt=$resume starts=$(svc_get starts)"; }
    f=$(new_objective $g withdraw "stability crash-loop filler $r" ID="$(uid)"); fillers+=("$f")
    if ! wait_for 1200 stab_run_ready "$a" "$f" "$runid"; then why="run $r: never had a checked filler and #$a's plan attempt in run $runid (phase $(st phase "$a"), attempts: $(attempts_of "$a" '*' | paste -sd,))"; ok=1; break; fi
    [[ $(st phase "$a") == hold:* ]] && { why="#$a reached its plan question before the kill in run $r"; ok=1; break; }
    [ "$r" = 3 ] && ra=$(attempts_of "$a" 'plan*' | awk -v r="$runid" '$2==r{print $3; exit}')
    stab_kill_serve
    sleep 2
  done
  local fl; for fl in "${fillers[@]}"; do cli_t 15 cancel "$fl" >/dev/null 2>&1; done
  if [ $ok = 0 ]; then
    serve_start || return
    wait_for 120 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' phase $a)\" != planning ]"
    sleep 5
    local hold starts4 resume4 ev; hold=$(st hold "$a"); starts4=$(svc_get starts); resume4=$(svc_get resumeAt)
    ev=$(st events 0 event=crash-loop)
    local hs; hs=$(python3 -c 'import json,sys;h=json.loads(sys.argv[1]) or {};print(h.get("step","-"), ",".join(h.get("answers",[])))' "$hold")
    local d3=""; [ -n "$resume" ] && [ -n "$ra" ] && d3=$(( $(iso_s "$ra") - $(iso_s "$resume") ))
    local n4; n4=$(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1] or "[]")))' "$starts4")
    local prog; prog=$(svc_get crashes | python3 -c 'import json,sys;print(",".join(str(c.get("progressed")).lower() for c in json.loads(sys.stdin.read() or "[]")))')
    why="run 3 resumeAt=$resume, its plan attempt started ${d3:-?} s after it; start 4: starts=$n4 resumeAt=$resume4; crash-loop log events=$ev; crashes progressed=[$prog] (heartbeat wait $STAB_WAIT_HEARTBEAT); hold: $hs"
    if [ -n "$d3" ] && [ "$d3" -ge 0 ] && [ "$n4" = 4 ] && [ -n "$resume4" ] && [[ $hs == plan*" retry,cancel" ]]; then
      record stability.crash-loop $g PASS "$why" "$t0"
    else record stability.crash-loop $g FAIL "$why" "$t0"; fi
  else record stability.crash-loop $g FAIL "$why" "$t0"; fi
  for fl in "${fillers[@]}"; do wait_phase "$fl" 'cancelled|done|failed|none' 300 >/dev/null; done

  stab_requeue "$a"
}

# Re-queue reopens: cancel A (issue closed), then set its card Queued.
# Without an issue, a fresh hold Objective is taken to its plan question first.
stab_requeue() {
  local g=stability t0 a=${1:-}
  t0=$(now)
  serve_alive || serve_start || return
  if [ -z "$a" ]; then
    a=$(new_objective $g hold "stability requeue" ID="$(uid)") || return
    wait_phase "$a" '^hold:' 1200 >/dev/null
  fi
  cli_t 60 cancel "$a" >/dev/null 2>&1
  wait_phase "$a" 'cancelled' 600 >/dev/null; sleep 20
  local is0; is0=$(gh_issue_state "$a")
  local tq; tq=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh_card "$a" Queued
  local p; p=$(wait_phase "$a" '^hold:|^planning$|^building$' 1200)
  sleep 15
  local is1; is1=$(gh_issue_state "$a")
  # Timeline after the re-queue: who reopened and closed it, by structure.
  local tl; tl=$(gh api "repos/$REPO/issues/$a/timeline" --paginate --jq ".[]|select(.created_at >= \"$tq\" and (.event==\"reopened\" or .event==\"closed\" or .event==\"project_v2_item_status_changed\"))|\"\(.event):\(.actor.login)\"" | paste -sd' ')
  cli_t 60 cancel "$a" >/dev/null 2>&1; wait_phase "$a" 'cancelled' 600 >/dev/null; sleep 15
  end_cancelled "$a"; local okc=$?
  local ev="after cancel: $is0; re-queued: timeline [$tl], issue $is1 15 s after reaching $p; cancelled again: $EVID"
  if [ "$is0" = "CLOSED NOT_PLANNED" ] && [[ $tl == *reopened:* ]] && [[ $is1 == OPEN* ]] && [[ $p =~ ^(hold:|planning|building) ]] && [ $okc = 0 ]; then
    record stability.requeue-reopen $g PASS "$ev" "$t0"
  else record stability.requeue-reopen $g FAIL "$ev" "$t0"; fi
  serve_stop
}

# Re-queue a finished (done) Objective with the Project's auto-close workflow
# active: the issue stays open and the Objective runs. Then cancel it and
# re-queue again crashing at each rerun:status point (when the build has them).
STAB_RQ_POINTS=${STAB_RQ_POINTS:-rerun:status:before rerun:status:after}
stab_rq_tl() { gh api "repos/$REPO/issues/$1/timeline" --paginate --jq ".[]|select(.created_at >= \"$2\" and (.event==\"reopened\" or .event==\"closed\"))|\"\(.event):\(.actor.login)\"" | paste -sd' '; }
stab_rq_round() { # N NAME [POINT...]: re-queue, crash at each point, then verify open + running
  local n=$1 name=$2 g=stability t0 tq p pt; shift 2
  t0=$(now); tq=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local before is0; before=$(st status "$n"); is0=$(gh_issue_state "$n")
  gh_card "$n" Queued
  CH=(); for pt in "$@"; do
    crash_at "$n" "$pt" 600; [ "$CRASH_R" = 137 ] && CH[$pt]="crashed $(ts)" || CH[$pt]="missed ($CRASH_R)"; log "#$n $pt: ${CH[$pt]}"; sleep 2
  done
  serve_alive || serve_start || return
  p=$(wait_phase "$n" '^hold:|^planning$|^building$' 1200); sleep 30
  local is1 tl hold hq; is1=$(gh_issue_state "$n"); tl=$(stab_rq_tl "$n" "$tq"); hold=$(st hold "$n")
  hq=$(python3 -c 'import json,sys;h=json.loads(sys.argv[1]) or {};print(h.get("step",""))' "$hold")
  local closer; closer=$(awk '{for(i=1;i<=NF;i++) if($i ~ /^closed:/) c=substr($i,8)} END{print c}' <<<"$tl")
  local named=""; [ -n "$closer" ] && python3 -c 'import json,sys;h=json.loads(sys.argv[1]) or {};sys.exit(0 if sys.argv[2] in h.get("question","") else 1)' "$hold" "$closer" && named=yes
  local pl; pl=$(st events "$n" event=start 'step=plan:*')
  local ev="was $before ($is0); re-queued; $(for pt in "$@"; do printf '%s %s; ' "$pt" "${CH[$pt]}"; done)timeline [$tl]; issue $is1 30 s after reaching $p; plan starts $pl${hq:+; hold at $hq}${closer:+; closer $closer named in hold: ${named:-no}}"
  local ok=0
  [[ $is1 == OPEN* ]] && [[ $tl == *reopened:* ]] && [[ $p =~ ^(hold:decide|hold:plan|planning|building) ]] || ok=1
  for pt in "$@"; do [[ ${CH[$pt]} == crashed* ]] || ok=1; done
  cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled' 600 >/dev/null; sleep 15
  end_cancelled "$n" || ok=1; ev="$ev; $EVID"
  if [ $ok = 0 ]; then record "stability.$name" $g PASS "$ev" "$t0"
  elif [[ $is1 == CLOSED* ]] && [ -n "$hq" ] && [ "$named" = yes ]; then record "stability.$name" $g FAIL "closed again, and the hold names $closer: $ev" "$t0"
  else record "stability.$name" $g FAIL "$ev" "$t0"; fi
  serve_stop
}
stab_requeue_finished() {
  local g=stability t0 n p
  t0=$(now)
  n=$(new_objective $g happy "stability requeue finished" ID="$(uid)") || return
  serve_alive || serve_start || return
  p=$(wait_phase "$n" 'done|cancelled|failed' 2700); sleep 30; serve_stop
  [ "$p" = done ] || { record stability.requeue-finished $g FAIL "#$n never finished ($p)" "$t0"; return; }
  stab_rq_round "$n" requeue-finished
  local pts=() pt; for pt in $STAB_RQ_POINTS; do build_has_env "${pt%:*}" && pts+=("$pt"); done
  if [ ${#pts[@]} -eq 0 ]; then record stability.requeue-crash $g UNREACHABLE "no rerun:status crash point in this build" "$t0"
  else stab_rq_round "$n" requeue-crash "${pts[@]}"; fi
}

stab_author_hold() {
  local g=stability t0 f title n p hold
  t0=$(now)
  f="$RUN_DIR/objectives/stability-author-$(date +%H%M%S).md"; mkdir -p "$RUN_DIR/objectives"
  render hold "$f" ID="$(uid)" || return
  title="Suite $RUN_ID: stability author-hold"
  gh workflow run drill-issue.yml --repo "$REPO" -f title="$title" -f body="$(cat "$f")" >/dev/null 2>&1 \
    || { record stability.author-hold $g UNREACHABLE "drill-issue.yml can't be dispatched on $REPO" "$t0"; return; }
  local end=$(( $(now) + 300 )); n=""
  while [ "$(now)" -lt "$end" ] && [ -z "$n" ]; do
    sleep 10
    n=$(gh issue list --repo "$REPO" --state open --search "\"$title\" in:title" --json number,author,title \
      --jq ".[]|select(.title==\"$title\" and .author.is_bot)|.number" | head -1)
  done
  [ -n "$n" ] || { record stability.author-hold $g FAIL "the workflow never filed the issue" "$t0"; return; }
  echo "$n $g" >>"$RUN_DIR/issues"; gh_enqueue "$n" >/dev/null; log "queued #$n (bot-authored)"
  serve_alive || serve_start || return
  p=$(wait_phase "$n" '^hold:' 600); hold=$(st hold "$n")
  local hs pl0; hs=$(python3 -c 'import json,sys;h=json.loads(sys.argv[1]) or {};print(h.get("step","-"), h.get("id","-"), ",".join(h.get("answers",[])))' "$hold")
  pl0=$(st started "$n" 'plan:*')
  sleep 30
  local hid; hid=$(cut -d' ' -f2 <<<"$hs"); local q; q=$(marker_count "$(gh_markers "$n")" "hold:$hid")
  answer_t 60 "$n" approve --question "$hid" >/dev/null 2>&1
  wait_for 900 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' started $n 'plan:*') = 1 ]"; local pl1; pl1=$(st started "$n" 'plan:*')
  local kept; kept=$(st get "$n" kept.objective:author-approval)
  cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled' 600 >/dev/null; sleep 15
  end_cancelled "$n"; local ok=$?
  local ev="hold $hs (question x$q); plan before approve=$pl0, after=$pl1; kept=$(head -c 80 <<<"$kept"); $EVID"
  if [[ $hs == *" approve,cancel" ]] && [ "$pl0" = 0 ] && [ "$pl1" = 1 ] && [ "$q" = 1 ] && [[ $kept == *digest* ]] && [ $ok = 0 ]; then
    record stability.author-hold $g PASS "$ev" "$t0"
  else record stability.author-hold $g FAIL "phase=$p; $ev" "$t0"; fi
}

stab_secret_scan() {
  local g=stability t0 n p hold id SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV DRILL_DUMMY_CANARY=$STAB_CANARY" HOLD_POLICY="$HOLD_POLICY decide"
  t0=$(now); id=$(uid)
  serve_stop
  n=$(new_objective $g canary "stability secret-scan" ID="$id") || return
  serve_start || return
  p=$(wait_phase "$n" '^hold:item:.*:publish$|done|cancelled|failed' 3600); hold=$(st hold "$n")
  local hs; hs=$(python3 -c 'import json,sys;h=json.loads(sys.argv[1]) or {};print(h.get("step","-"), ",".join(h.get("answers",[])))' "$hold")
  sleep 30
  # Nothing pushed: no factory/N/ branch holds the value; no comment shows it.
  local refs leak=0 r; refs=$(gh api "repos/$REPO/git/matching-refs/heads/factory/$n/" --jq '.[].ref' 2>/dev/null)
  for r in $refs; do
    gh api "repos/$REPO/compare/main...${r#refs/heads/}" --jq '.files[].patch' 2>/dev/null | grep -q "$STAB_CANARY" && leak=1
  done
  local cm; cm=$({ gh api "repos/$REPO/issues/$n/comments" --paginate --jq '.[].body'; gh issue view "$n" --repo "$REPO" --json body --jq .body; } | grep -c "$STAB_CANARY")
  local onmain=0; gh_file "src/canary$id.js" | grep -q "$STAB_CANARY" && onmain=1
  cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled|done|failed' 600 >/dev/null; sleep 15
  serve_stop
  local ev="phase=$p hold: $hs; factory/$n/ branches: $(wc -w <<<"$refs"), value in a pushed diff=$leak, comments showing it=$cm, on main=$onmain"
  if [[ $hs == item:*" repair,cancel" ]] && [ $leak = 0 ] && [ "$cm" = 0 ] && [ $onmain = 0 ]; then record stability.secret-scan $g PASS "$ev" "$t0"
  elif [ $leak = 0 ] && [ $onmain = 0 ] && [[ $p != hold:* ]]; then record stability.secret-scan $g UNREACHABLE "the worker never wrote the value; $ev" "$t0"
  else record stability.secret-scan $g FAIL "$ev" "$t0"; fi
}

stab_update_merge() {
  local g=stability t0 n fn pr old new id p
  t0=$(now); id=$(uid); fn="stripSpaces$id"
  n=$(new_objective $g exec "stability update-merge $fn" FN="$fn" SPEC="\`$fn(s)\` returns \`s\` with every space character removed: \`$fn(\"a b  c\")\` is \`\"abc\"\`.") || return
  crash_at "$n" deliver:pr-create:after 2400
  if [ "$CRASH_R" != 137 ]; then record stability.update-merge $g FAIL "#$n never crashed after opening its PR ($CRASH_R)" "$t0"; return; fi
  pr=$(gh_open_pr "$n"); old=$(gh pr view "$pr" --repo "$REPO" --json headRefOid --jq .headRefOid)
  gh api -X PUT "repos/$REPO/contents/notes/update-merge-$id.md" -f message="drill: advance main for the update-merge check" \
    -f content="$(printf 'update-merge drill %s\n' "$RUN_ID" | base64 -w0)" >/dev/null
  sleep 5
  gh api -X PUT "repos/$REPO/pulls/$pr/update-branch" -f expected_head_sha="$old" >/dev/null 2>&1
  wait_for 180 bash -c "[ \"\$(gh pr view $pr --repo $REPO --json headRefOid --jq .headRefOid)\" != $old ]"
  new=$(gh pr view "$pr" --repo "$REPO" --json headRefOid --jq .headRefOid)
  local wf; wf=$(gh api "repos/$REPO/commits/$new" --jq '"\(.committer.login) \(.parents|length) \(.parents[0].sha)"')
  [ "$new" != "$old" ] || { record stability.update-merge $g FAIL "update-branch didn't move PR #$pr" "$t0"; return; }
  serve_start || return
  p=$(wait_phase "$n" 'done|cancelled|failed|^hold:' 2700); sleep 20; serve_stop
  local holds merged mh; holds=$(st events "$n" event=outcome outcome=hold)
  read -r merged mh < <(gh pr view "$pr" --repo "$REPO" --json state,headRefOid --jq '"\(.state) \(.headRefOid)"')
  end_done "$n"; local ok=$?
  local ev="PR #$pr head $old -> $new ($wf); phase=$p holds=$holds; PR $merged at head $mh; $EVID"
  # A later CI repair may replace the update merge with a rebased commit
  # (Factory's own branch); what counts is that no step held over it.
  local pubs; pubs=$(st events "$n" event=outcome outcome=done 'step=item:*:publish')
  ev="$ev; publish done x$pubs"
  if [ $ok = 0 ] && [ "$holds" = 0 ] && [ "$merged" = MERGED ] && [[ $wf == "web-flow 2 $old" ]]; then record stability.update-merge $g PASS "$ev" "$t0"
  else record stability.update-merge $g FAIL "$ev" "$t0"; fi
}

STAB_PROXY=""
stab_stop_proxy() { [ -n "$STAB_PROXY" ] && { read -r p s <<<"$STAB_PROXY"; kill_exact "$p" "$s" TERM; STAB_PROXY=""; }; }
stab_wait_clock() {
  local g=stability t0 n p hold HOLD_POLICY="$HOLD_POLICY decide"
  t0=$(now)
  if ! build_has_env FACTORY_GITHUB_API || ! build_has_env FACTORY_WAIT_MS; then
    record stability.wait-clock $g UNREACHABLE "this build lacks FACTORY_GITHUB_API or FACTORY_WAIT_MS" "$t0"; return; fi
  local rules="$RUN_DIR/fault-rules" log="$RUN_DIR/fault-calls.jsonl"; : >"$rules"; : >"$log"
  node "$SUITE/lib/gh-fault-proxy.mjs" "$STAB_PORT" "$log" "$rules" </dev/null >"$RUN_DIR/fault-proxy.out" 2>&1 &
  local pp=$!; track $pp; STAB_PROXY="$pp $(starttime $pp)"; sleep 1
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_GITHUB_API=http://127.0.0.1:$STAB_PORT FACTORY_WAIT_MS=240000 FACTORY_BACKOFF_MS=10000"
  echo "POST ^/repos/$REPO/pulls\$" >"$rules"
  serve_stop
  n=$(new_objective $g twin "stability wait-clock" ID="$(uid)") || { stab_stop_proxy; return; }
  serve_start || { stab_stop_proxy; return; }
  # Until a step holds with 'wait' among its answers (the transient budget).
  local end=$(( $(now) + 3600 )) hs=""
  while [ "$(now)" -lt "$end" ]; do
    serve_tick; p=$(st phase "$n")
    case $p in done|cancelled|failed) break ;; esac
    if [[ $p == hold:* ]]; then
      hold=$(st hold "$n")
      if python3 -c 'import json,sys;sys.exit(0 if "wait" in (json.loads(sys.argv[1]) or {}).get("answers",[]) else 1)' "$hold"; then hs=1; break; fi
      auto_answer "$n" || { log "#$n held at $p, not a wait hold"; break; }
    fi
    sleep 5
  done
  if [ -z "$hs" ]; then
    : >"$rules"; record stability.wait-clock $g FAIL "#$n never held on the transient budget (phase $p, 502s served: $(grep -c '"status":502' "$log"))" "$t0"
    cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled|done' 600 >/dev/null; serve_stop; stab_stop_proxy; return
  fi
  local hstep asked other; read -r hstep asked < <(python3 -c 'import json,sys;h=json.loads(sys.argv[1]);print(h["step"], h["askedAt"])' "$hold")
  local r0; r0=$(retries_of "$n")
  other=$(python3 -c 'import json,sys;r=json.loads(sys.argv[1]) or {};k=[x for x in r if x!=sys.argv[2] and x.startswith("item:") and (r[x].get("wait") or {}).get("kind") not in ("gate","reset")];print(k[0] if k else "")' "$r0" "$hstep")
  if [ -z "$other" ]; then
    : >"$rules"; record stability.wait-clock $g UNREACHABLE "held at $hstep, but no other item step was waiting (retries: $(head -c 300 <<<"$r0"))" "$t0"
    cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled|done' 600 >/dev/null; serve_stop; stab_stop_proxy; return
  fi
  local since0 next0; read -r since0 next0 < <(python3 -c 'import json,sys;r=json.loads(sys.argv[1])[sys.argv[2]];print(r["since"], r["nextAt"])' "$r0" "$other")
  # Keep the question open until well past the other step's nextAt, so its
  # clock has time to pause (a step only waits once it is due).
  local hold_s; hold_s=$(( $(iso_s "$next0") - $(now) + 240 )); [ "$hold_s" -lt 300 ] && hold_s=300
  log "#$n held at $hstep (asked $asked); $other since=$since0 nextAt=$next0; keeping the question open $hold_s s"
  sleep "$hold_s"
  local mid; mid=$(retries_of "$n" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get(sys.argv[1],{}).get("since",""))' "$other")
  local ta; ta=$(now); answer_t 60 "$n" wait --question "$(hold_field "$hold" id)" >/dev/null 2>&1
  wait_for 120 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' hold $n)\" = null ]"
  local tb; tb=$(now)
  local since1; since1=$(retries_of "$n" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get(sys.argv[1],{}).get("since",""))' "$other")
  : >"$rules"
  # The other step mustn't hold right after the answer (its budget was paused).
  sleep 60; local p2; p2=$(st phase "$n"); local h2; h2=$(st hold "$n" | python3 -c 'import json,sys;h=json.load(sys.stdin) or {};print(h.get("step",""))')
  local exp lo hi shift
  exp=$(( ta - $(python3 -c 'import sys,datetime as d;f=lambda s:d.datetime.fromisoformat(s.replace("Z","+00:00")).timestamp();print(int(max(f(sys.argv[1]),f(sys.argv[2]))))' "$asked" "$next0") ))
  shift=""; [ -n "$since1" ] && shift=$(( $(iso_s "$since1") - $(iso_s "$since0") ))
  lo=$(( exp - 10 )); hi=$(( exp + (tb - ta) + 30 ))
  p=$(wait_phase "$n" 'done|cancelled|failed' 2700); sleep 20; serve_stop; stab_stop_proxy
  end_done "$n"; local okd=$?
  local ev="held $hstep for $((ta - $(iso_s "$asked"))) s; $other since $since0 -> (open) $mid -> (answered) $since1: moved ${shift:-?} s, expected $lo..$hi; after: phase $p2${h2:+ held at $h2}; 502s served $(grep -c '"status":502' "$log"); end: $EVID"
  if [ "$exp" -lt 60 ]; then record stability.wait-clock $g UNREACHABLE "the other step was never due while the question was open; $ev" "$t0"
  elif [ "$mid" = "$since0" ] && [ -n "$shift" ] && [ "$shift" -ge "$lo" ] && [ "$shift" -le "$hi" ] && [ "$h2" != "$other" ]; then
    record stability.wait-clock $g PASS "$ev" "$t0"
  else record stability.wait-clock $g FAIL "$ev" "$t0"; fi
  [ $okd = 0 ] || log "wait-clock Objective #$n didn't finish cleanly: $EVID"
}

# a Factory branch with someone else's commit; the publish asks, `reset` replaces it.
stab_reset_foreign() {
  local g=stability t0 n id fn br; t0=$(now); id=$(uid); fn="dropSpaces$id"
  local HOLD_POLICY="$HOLD_POLICY decide"
  serve_stop
  n=$(new_objective $g exec "stability reset-foreign $fn" FN="$fn" SPEC="\`$fn(s)\` returns \`s\` with every space removed: \`$fn(\"a b c\")\` is \`\"abc\"\`.") || return
  crash_at "$n" deliver:pr-create:before 2400
  [ "$CRASH_R" = 137 ] || { record stability.reset-foreign $g FAIL "#$n never crashed before creating its PR ($CRASH_R)" "$t0"; return; }
  br=$(gh api "repos/$REPO/git/matching-refs/heads/factory/$n/" --jq '.[0].ref' | sed 's#refs/heads/##')
  [ -n "$br" ] || { record stability.reset-foreign $g FAIL "#$n pushed no branch before the crash" "$t0"; serve_start; cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" cancelled 600 >/dev/null; serve_stop; return; }
  gh api -X PUT "repos/$REPO/contents/notes/foreign-$id.md" -f branch="$br" -f message="drill: a commit Factory didn't make" \
    -f content="$(printf 'foreign %s\n' "$RUN_ID" | base64 -w0)" >/dev/null
  serve_start || return
  local p hold; p=$(wait_phase "$n" '^hold:item:.*:publish$|done|cancelled|failed' 1800); hold=$(st hold "$n" 'item:*:publish')
  local ans; ans=$(hold_field "$hold" answers)
  if [[ ,$ans, != *,reset,* ]]; then
    record stability.reset-foreign $g FAIL "after a foreign commit on $br: phase $p, hold answers [$ans]" "$t0"
    cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled|done' 600 >/dev/null; serve_stop
    gh api -X DELETE "repos/$REPO/git/refs/heads/$br" >/dev/null 2>&1; return
  fi
  sleep 20
  answer_t 60 "$n" reset --question "$(hold_field "$hold" id)" >/dev/null 2>&1
  p=$(wait_phase "$n" 'done|cancelled|failed' 2700); sleep 20; serve_stop
  local onmain=0; gh_file "notes/foreign-$id.md" >/dev/null && onmain=1
  end_done "$n"; local ok=$?
  local ev="foreign commit on $br; publish held [$ans]; answered reset -> $p; foreign file on main=$onmain; $EVID"
  [ $ok = 0 ] && [ $onmain = 0 ] && record stability.reset-foreign $g PASS "$ev" "$t0" || record stability.reset-foreign $g FAIL "$ev" "$t0"
}

# only a real rate limit waits for its reset; a plain 403 doesn't.
stab_rate_limit() {
  local g=stability t0 n p; t0=$(now)
  local ok=0
  need stability.rate-limit $g "$t0" rate-reset github-api || ok=1
  need stability.plain-403 $g "$t0" rate-reset github-api || ok=1
  [ $ok = 0 ] || return
  serve_stop; proxy_start stab "$STAB_PORT"
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV $PROXY_ENV FACTORY_BACKOFF_MS=10000" HOLD_POLICY="$HOLD_POLICY decide"
  local reset; reset=$(epoch_in 100000)   # set for real when the step first asks
  n=$(new_objective $g happy "stability rate-limit" ID="$(uid)") || return
  serve_start || return
  # Arm the limit once planning is done, so it meets the PR creation.
  wait_for 2400 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' get $n done.plan)\" != null ]"
  reset=$(epoch_in 240)
  proxy_rules stab "POST ^/repos/$REPO/pulls\$ status=429 until=$reset h:x-ratelimit-remaining=0 h:x-ratelimit-reset=$reset"
  wait_for 1800 bash -c "[ \$(grep -c '\"status\":429' '$RUN_DIR/stab.calls.jsonl') -ge 1 ]"
  sleep 20
  local rs; rs=$(st get "$n" retries | python3 -c 'import json,sys
r=json.load(sys.stdin) or {}
k=[x for x in r if x.endswith(":publish")]
if not k: print("none"); sys.exit()
v=r[k[0]]; print(k[0], (v.get("wait") or {}).get("kind","-"), v.get("count"), v.get("nextAt"))')
  local step kind cnt next; read -r step kind cnt next <<<"$rs"
  local p1; p1=$(wait_phase "$n" '^hold:|^(finishing|done)$' 900)
  local first_ok; first_ok=$(python3 - "$RUN_DIR/stab.calls.jsonl" "$reset" <<'PY'
import json, sys, datetime
reset = int(sys.argv[2]); t = None
for l in open(sys.argv[1]):
    r = json.loads(l)
    if r["method"] == "POST" and r["path"].endswith("/pulls") and r["status"] in (200, 201):
        t = datetime.datetime.fromisoformat(r["at"].replace("Z", "+00:00")).timestamp(); break
print("none" if t is None else int(t - reset))
PY
)
  local ev="429 with reset at $reset: $step wait=$kind errors=$cnt nextAt=$next; first PR created ${first_ok} s after the reset; then $p1"
  if [ "$kind" = reset ] && [ "$cnt" = 0 ] && [ "$first_ok" != none ] && [ "$first_ok" -ge -5 ] && [[ $p1 != hold:* ]]; then record stability.rate-limit $g PASS "$ev" "$t0"
  else record stability.rate-limit $g FAIL "$ev" "$t0"; fi
  # A plain 403 at merge: no reset wait.
  t0=$(now)
  proxy_rules stab "PUT ^/repos/$REPO/pulls/[0-9]+/merge\$ status=403"
  wait_for 2400 bash -c "[ \$(grep -c '\"status\":403' '$RUN_DIR/stab.calls.jsonl') -ge 1 ]"; sleep 30
  local ms; ms=$(st get "$n" retries | python3 -c 'import json,sys
r=json.load(sys.stdin) or {}
k=[x for x in r if x.endswith(":merge")]
print(" ".join("%s:%s:%s" % (x, (r[x].get("wait") or {}).get("kind","-"), r[x].get("count")) for x in k) or "none")')
  local mh; mh=$(st hold "$n" 'item:*:merge'); mh=$(hold_field "$mh" step)
  proxy_rules stab
  [ -n "$mh" ] && answer_t 60 "$n" retry --question "$(hold_id "$n" 'item:*:merge')" >/dev/null 2>&1
  p=$(wait_phase "$n" 'done|cancelled|failed' 2700); sleep 20; serve_stop; proxy_stop stab
  local ev2="plain 403 at merge (served $(grep -c '"status":403' "$RUN_DIR/stab.calls.jsonl")): merge retries [$ms], hold ${mh:-none}; end $p"
  if [[ $ms != *":reset:"* ]] && { [ -n "$mh" ] || [[ $ms =~ :[1-9] ]]; }; then record stability.plain-403 $g PASS "$ev2" "$t0"
  else record stability.plain-403 $g FAIL "$ev2" "$t0"; fi
}

# a question answered during a human gate doesn't move the gate's start; one reminder.
stab_gate_question() {
  local g=stability t0 n; t0=$(now)
  need stability.gate-question $g "$t0" remind || return
  { [ "$(gh_human_gate)" = true ] || approved stability.gate-question $g "$t0" "a required review on main (human gate)"; } || return
  rc_human_gate_on || { record stability.gate-question $g FAIL "couldn't add a required review to main" "$t0"; restore_run; return; }
  serve_stop
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_REMIND_MS=180000" HOLD_POLICY="$HOLD_POLICY decide"
  n=$(new_objective $g happy "stability gate question" ID="$(uid)") || return
  serve_start || return
  wait_for 3600 bash -c "python3 '$SUITE/lib/st.py' '$ROOT' get $n retries | grep -q '\"kind\": *\"gate\"'" \
    || { record stability.gate-question $g FAIL "#$n never waited at a gate ($(st phase "$n"))" "$t0"; cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" cancelled 600 >/dev/null; serve_stop; restore_run; return; }
  local since; since=$(st get "$n" retries | python3 -c 'import json,sys;r=json.load(sys.stdin);print(next(v["since"] for v in r.values() if (v.get("wait") or {}).get("kind")=="gate"))')
  sleep 30
  gh issue edit "$n" --repo "$REPO" --body "$(gh issue view "$n" --repo "$REPO" --json body --jq .body)

Drill edit during the review gate." >/dev/null
  local hq=""; local end=$(( $(now) + 600 ))
  while [ "$(now)" -lt "$end" ] && [ -z "$hq" ]; do
    local hj; hj=$(st hold "$n"); [[ ,$(hold_field "$hj" answers), == *,continue,* ]] && hq=$(hold_field "$hj" id); [ -z "$hq" ] && sleep 10
  done
  [ -n "$hq" ] && answer_t 60 "$n" continue --question "$hq" >/dev/null 2>&1
  local since2; since2=$(st get "$n" retries | python3 -c 'import json,sys;r=json.load(sys.stdin) or {};print(next((v["since"] for v in r.values() if (v.get("wait") or {}).get("kind")=="gate"), ""))')
  wait_for 600 bash -c "gh api 'repos/$REPO/issues/$n/comments' --jq '.[].body' | grep -q 'factory:$n:remind:'"; sleep 240
  local rc rt; rc=$(marker_prefix_count "$(gh_markers "$n")" remind:)
  rt=$(gh api "repos/$REPO/issues/$n/comments" --paginate --jq ".[]|select(.body|contains(\"factory:$n:remind:\"))|.created_at" | head -1)
  cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled|done' 900 >/dev/null; sleep 15; serve_stop
  restore_run
  local d=""; [ -n "$rt" ] && d=$(( $(iso_s "$rt") - $(iso_s "$since") ))
  local ev="gate since $since (after the answer: ${since2:-gone}); edit question ${hq:-never asked} answered continue; remind markers $rc, first ${d:-?} s after the gate began (FACTORY_REMIND_MS 180 s)"
  if [ -z "$hq" ]; then record stability.gate-question $g UNREACHABLE "no edit question came during the gate; $ev" "$t0"
  elif [ "$rc" = 1 ] && [ -n "$d" ] && [ "$d" -ge 170 ] && [ "$d" -le 300 ] && [ "$since2" = "$since" ]; then record stability.gate-question $g PASS "$ev" "$t0"
  else record stability.gate-question $g FAIL "$ev" "$t0"; fi
}

# a re-queued Objective posts its own report, marked with its run.
stab_requeue_report() {
  local g=stability t0 n p; t0=$(now)
  need stability.requeue-report $g "$t0" run-report || return
  local HOLD_POLICY="$HOLD_POLICY decide"
  n=$(new_objective $g happy "stability requeue report" ID="$(uid)") || return
  serve_alive || serve_start || return
  p=$(wait_phase "$n" 'done|cancelled|failed' 2700); sleep 30
  [ "$p" = done ] || { record stability.requeue-report $g FAIL "#$n never finished the first run ($p)" "$t0"; return; }
  local r1; r1=$(st get "$n" startedAt)
  gh_card "$n" Queued
  wait_phase "$n" '^(planning|building|finishing)$|^hold:' 1200 >/dev/null
  p=$(wait_phase "$n" 'done|cancelled|failed' 3600); sleep 30; serve_stop
  local m reps dups; m=$(gh_markers "$n"); reps=$(awk '$1 ~ /^report:/' <<<"$m"); dups=$(awk '$1 ~ /^report:/ && $2>1' <<<"$m" | wc -l)
  local ev="first run $r1, second run $(st get "$n" startedAt) -> $p; report markers [$(paste -sd' ' <<<"$reps")]"
  if [ "$p" = done ] && [ "$(wc -l <<<"$reps")" = 2 ] && [ "$dups" = 0 ]; then record stability.requeue-report $g PASS "$ev" "$t0"
  else record stability.requeue-report $g FAIL "$ev" "$t0"; fi
}

stability_run() {
  local t
  for t in $STAB_ONLY; do
    case $t in
      crash-loop) stab_crash_loop ;;
      requeue) stab_requeue ;;
      requeue-finished) stab_requeue_finished ;;
      author-hold) stab_author_hold ;;
      secret-scan) stab_secret_scan ;;
      update-merge) stab_update_merge ;;
      wait-clock) stab_wait_clock ;;
      reset-foreign) stab_reset_foreign ;;
      rate-limit) stab_rate_limit ;;
      gate-question) stab_gate_question ;;
      requeue-report) stab_requeue_report ;;
    esac
    proxy_stop stab; restore_run
    serve_stop
  done
}
