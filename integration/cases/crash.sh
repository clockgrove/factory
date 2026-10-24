# The main suite's lane on clockgrove/factory-drill-2: one installation in
# the repository at a time, then sampled crash points armed across live
# Objectives, with two network cuts. Runs as one background job (lane_c).
#   holder   installation C serves; H is refused; H takes over with --take-over and C stops; H's clean stop frees the repository
#   crash    every serve runs in a network namespace (lib/netns-serve.sh) and is
#            armed with one point at a time (FACTORY_CRASH_AT); a death starts the
#            next point. CA (two items) and CB (one) run to done; CQ holds at a
#            planner question for sync:remind, then is cancelled for sync:cancel
#            (armed before the cancel is sent). At the end every Objective must
#            be done or cancelled once, with no duplicate comment, PR or issue.
#   netcut   60 s cuts of the namespace's network while CA or CB plans and while one waits for CI: no hold
CRASH_LIFECYCLE="plan:post:before plan:post:after deliver:push:before deliver:push:after deliver:pr-create:before deliver:pr-create:after deliver:merge:before deliver:merge:after report:comment:before report:comment:after report:close:before report:close:after"
CRASH_REMIND="sync:remind:before sync:remind:after"
CRASH_CANCEL="sync:cancel:before sync:cancel:after"

# The repository's holder record: its commit sha, or empty.
holder_sha() { git ls-remote "https://github.com/$REPO.git" refs/factory/holder 2>/dev/null | cut -f1; }
wait_exit() { local i; for i in $(seq 1 "$1"); do serve_exited && return 0; sleep 1; done; return 1; }

c_holder() {
  local CASE=holder t0; t0=$(now)
  inst C; serve_up || return 1
  wait_for 90 bash -c "[ -n \"\$(git ls-remote https://github.com/$REPO.git refs/factory/holder 2>/dev/null)\" ]"
  local sha0; sha0=$(holder_sha); local cdir=$SERVE_DIR
  inst H; serve_up || return 1
  wait_exit 120; local rc; rc=$(cat "$SERVE_DIR/exit" 2>/dev/null)
  local sha1; sha1=$(holder_sha)
  SERVE_DIR=$cdir; local calive=0; serve_alive && calive=1
  [ -n "$sha0" ] && [ -n "$rc" ] && [ "$rc" != 0 ] && [ "$sha1" = "$sha0" ] && [ $calive = 1 ]
  rec_if holder.second-refused $? "C holds ($sha0); a second installation's serve exited ${rc:-not at all} in 120 s; holder then $sha1; C serving $calive" "$t0"
  t0=$(now); inst H; serve_up "" takeover || return 1
  local hdir=$SERVE_DIR; sleep 10
  SERVE_DIR=$cdir; wait_exit 120; local crc; crc=$(cat "$SERVE_DIR/exit" 2>/dev/null)
  SERVE_DIR=$hdir; local halive=0; serve_alive && halive=1; local sha2; sha2=$(holder_sha)
  [ $halive = 1 ] && [ -n "$crc" ] && [ -n "$sha2" ] && [ "$sha2" != "$sha0" ]
  rec_if holder.take-over $? "H serving with --take-over: $halive; holder $sha0 -> $sha2; C stopped by itself with exit ${crc:-none}" "$t0"
  t0=$(now); serve_down; local sha3; sha3=$(holder_sha)
  [ -z "$sha3" ] && [ "$(cat "$SERVE_DIR/exit")" = 0 ]; rec_if holder.release $? "H's clean stop (exit $(cat "$SERVE_DIR/exit")) leaves holder '${sha3:-none}'" "$t0"
}

# The lane's Objectives and their hold policies.
c_tick() {
  local n; for n in $CA $CB; do [[ $(st phase "$n") == hold:* ]] && HOLD_POLICY="d2 review decide more" auto_answer "$n" >/dev/null; done
  [[ $(st phase "$CQ") == hold:* ]] && HOLD_POLICY="d2" auto_answer "$CQ" >/dev/null
  c_netcut
}
c_question_open() { [ "$(hold_field "$(st hold "$CQ" 'decide*')" id)" != "" ]; }
# Cut the network once while CA or CB plans, once while one waits for CI.
c_netcut() {
  local n
  if [ -z "$CUT1" ]; then for n in $CA $CB; do
    if started "$n" 'plan*' && [ "$(st status "$n")" = planning ]; then CUT1=$(iso); serve_cut plan; CUT1E=$(iso); return; fi; done; fi
  if [ -z "$CUT2" ]; then for n in $CA $CB; do
    if [ "$(st events "$n" event=start 'step=item:*:ci')" -gt "$(st events "$n" event=outcome 'step=item:*:ci')" ]; then CUT2=$(iso); serve_cut ci; CUT2E=$(iso); return; fi; done; fi
}
# c_arm POINT WINDOW [TRIGGER]: start a serve armed with POINT; 0 when it crashed there.
CRASHES=0
c_arm() {
  local pt=$1 win=$2 trig=${3:-}
  if [ "$CRASHES" -ge 2 ]; then serve_up "" netns && sleep 8 && serve_down; CRASHES=0; fi   # a clean stop ends the crash streak
  serve_up "$pt" netns || return 1
  [ -n "$trig" ] && { sleep 5; $trig; }
  local end=$(( $(now) + win )) odd=0; [ "$end" -gt "$CRASH_END" ] && end=$CRASH_END
  while [ "$(now)" -lt "$end" ]; do
    serve_tick
    if serve_exited; then
      if [ "$(cat "$SERVE_DIR/exit")" = 137 ]; then CH[$pt]="crashed $(ts)"; CRASHES=$((CRASHES + 1)); RESTARTS=$((RESTARTS + 1)); log "CRASHED at $pt"; kill_desc_survivors "$SERVE_DIR/desc"; return 0; fi
      log "serve exited $(cat "$SERVE_DIR/exit") while armed at $pt: $(tail -c 300 "$SERVE_DIR/out.log" | tr '\n' ' ')"; UNEXPECTED="$UNEXPECTED $pt:exit$(cat "$SERVE_DIR/exit")"
      odd=$((odd + 1)); [ $odd -ge 3 ] && return 1
      sleep 5; serve_up "$pt" netns || return 1
    fi
    c_tick
    # A remind point is due before CQ's reminder: hand over to it.
    [ -n "${PREEMPT:-}" ] && $PREEMPT && { serve_down; CRASHES=0; return 2; }
    sleep 2
  done
  serve_down; CRASHES=0; return 1
}
c_remind_due() { [ -z "${CH[sync:remind:before]:-}" ] && [ -z "$REMIND_TRIED" ] && c_question_open; }
c_cancel_cq() { cli_t 60 cancel "$CQ" >/dev/null 2>&1; log "#$CQ cancel sent"; }

c_crash() {
  local CASE=crash t0; t0=$(now); declare -gA CH=(); CUT1=""; CUT2=""; CUT1E=""; CUT2E=""; UNEXPECTED=""; REMIND_TRIED=""; RESTARTS=0
  CRASH_END=$(( STOP_AT - 600 ))
  inst C
  CA=$(new_objective chain2 "crash lane two items" ID="$(uid)") || return
  CB=$(new_objective happy "crash lane one item" ID="$(uid)") || return
  CQ=$(new_objective hold "crash lane held" PROVIDER=codex-plan ID="$(uid)") || return
  local pt missed=()
  for pt in $CRASH_LIFECYCLE; do
    # sync:remind:* first whenever CQ's question is open and its reminder not yet due.
    if c_remind_due; then
      REMIND_TRIED=1
      c_arm sync:remind:before 300 && c_arm sync:remind:after 180
      c_arm sync:cancel:before 180 c_cancel_cq && c_arm sync:cancel:after 180
    fi
    PREEMPT=c_remind_due c_arm "$pt" 480; local r=$?
    if [ $r = 2 ]; then REMIND_TRIED=1; c_arm sync:remind:before 300 && c_arm sync:remind:after 180
      c_arm sync:cancel:before 180 c_cancel_cq && c_arm sync:cancel:after 180
      c_arm "$pt" 480; r=$?; fi
    [ $r = 0 ] || missed+=("$pt")
    [ "$(now)" -ge "$CRASH_END" ] && break
  done
  if [ -z "$REMIND_TRIED" ]; then c_arm sync:remind:before 300 && c_arm sync:remind:after 180; fi
  [ -z "${CH[sync:cancel:before]:-}" ] && { c_arm sync:cancel:before 180 c_cancel_cq && c_arm sync:cancel:after 180; }
  # Settle: a clean serve until CA and CB are done and CQ is cancelled.
  serve_up "" netns
  cancelled_clean "$CQ" || c_cancel_cq
  local end=$(( STOP_AT - 180 ))
  while [ "$(now)" -lt "$end" ]; do
    serve_tick; c_tick
    settled "$CA" && settled "$CB" && cancelled_clean "$CQ" && break
    serve_exited && { log "clean serve exited $(cat "$SERVE_DIR/exit")"; UNEXPECTED="$UNEXPECTED clean:exit$(cat "$SERVE_DIR/exit")"; serve_up "" netns; }
    sleep 5
  done
  sleep 20
  local ok=0 ev=""
  end_done "$CA" || ok=1; ev="$EVID"; end_done "$CB" || ok=1; ev="$ev | $EVID"
  end_cancelled "$CQ" || ok=1; ev="$ev | $EVID"
  local open=""; settled "$CA" || open="$open #$CA"; settled "$CB" || open="$open #$CB"; cancelled_clean "$CQ" || open="$open #$CQ"
  local cc rm; cc=$(marker_prefix_count "$(gh_markers "$CQ")" cancelled:); rm=$(marker_prefix_count "$(gh_markers "$CQ")" remind:)
  ev="$ev; CQ cancel comments $cc, reminders $rm${UNEXPECTED:+; unexpected exits:$UNEXPECTED}"
  [ "$cc" = 1 ] && [ "$rm" -le 1 ] || ok=1
  for pt in $CRASH_LIFECYCLE $CRASH_REMIND $CRASH_CANCEL; do
    if [ "$(node "$SUITE/lib/crashpoints.mjs" "$BUILD" check "$pt" | cut -f2)" != yes ]; then record "crash.$pt" UNREACHABLE "no crashPoint site for $pt in this build" "$t0"
    elif [[ ${CH[$pt]:-} == crashed* ]] && [ -n "$open" ] && [[ $ev != *DUPES* ]]; then record "crash.$pt" UNREACHABLE "${CH[$pt]}; unsettled at the stop:$open, so no end check; $ev" "$t0"
    elif [[ ${CH[$pt]:-} == crashed* ]]; then rec_if "crash.$pt" $ok "${CH[$pt]}; $ev" "$t0"
    else record "crash.$pt" UNREACHABLE "not reached while armed; $ev" "$t0"; fi
  done
  # A crashed installation restarts on its own holder record with no --take-over.
  local CASE=holder
  [ "$RESTARTS" -ge 1 ] && [ -z "$UNEXPECTED" ]; rec_if holder.restart $? "$RESTARTS restarts after a crash, none refused${UNEXPECTED:+; unexpected exits:$UNEXPECTED}" "$t0"
  local CASE=netcut
  c_cut_check plan "$CUT1" "$CUT1E" "$t0"; c_cut_check ci "$CUT2" "$CUT2E" "$t0"
}
# No hold (planner questions aside) on CA or CB from a cut until 3 min after it ended.
c_cut_check() {
  local name=$1 a=$2 b=$3 t0=$4
  [ -n "$a" ] || { record "netcut.$name" UNREACHABLE "no cut ($name): the moment didn't come while a serve ran" "$t0"; return; }
  [ -n "$b" ] || { record "netcut.$name" FAIL "the $name cut started at $a and was never restored" "$t0"; return; }
  local h; h=$(python3 - "$ROOT" "$a" "$b" $CA $CB <<'PY'
import datetime, glob, json, os, sys
root, a, b = sys.argv[1:4]
end = (datetime.datetime.fromisoformat(b.replace("Z", "+00:00")) + datetime.timedelta(minutes=3)).isoformat()[:19]
n = 0
for issue in sys.argv[4:]:
    for f in glob.glob(os.path.join(root, "logs", issue, "*.jsonl")):
        for l in open(f, errors="replace"):
            try: e = json.loads(l)
            except ValueError: continue
            at = str(e.get("at", ""))[:19]
            if e.get("event") == "outcome" and e.get("outcome") == "hold" and not str(e.get("step")).startswith("decide") and a[:19] <= at <= end: n += 1
print(n)
PY
)
  [ "$h" = 0 ] && settled "$CA" && settled "$CB"; rec_if "netcut.$name" $? "cut $a..$b: holds on #$CA #$CB in the cut and 3 min after: $h; both ended: $(st status "$CA")/$(st status "$CB")" "$t0"
}

lane_c() {
  c_holder || log "holder steps failed to start a serve"
  c_crash
  serve_down
}
