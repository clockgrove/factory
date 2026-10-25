# The main suite's lane on the run's second repository (C_REPO): one installation in
# the repository at a time, then sampled crash points armed across live
# Objectives, with two network cuts. Runs as one background job (lane_c).
#   holder   X (repository C on repository M's Project, which M serves) is refused before it takes C;
#            installation C serves; H is refused; H takes over with --take-over and C stops; H's clean stop frees the repository
#   crash    every serve runs in a network namespace (lib/netns-serve.sh) and is
#            armed with the next exact point (FACTORY_CRASH_AT); a death starts
#            the next point immediately, against one shared deadline. CQ first
#            holds for sync:remind and is cancelled for sync:cancel. Only then
#            are CA (two items), CB and CC (one each) queued concurrently, so
#            lifecycle effects cannot pass while reminder points are armed.
#            At the end every Objective must
#            be done or cancelled once, with no duplicate comment, PR or issue.
#   netcut   60 s cuts of the namespace's network while CA or CB plans and while one waits for CI: no hold
CRASH_LIFECYCLE="plan:post:before plan:post:after deliver:push:before deliver:push:after deliver:pr-create:before deliver:pr-create:after deliver:merge:before deliver:merge:after report:comment:before report:comment:after report:close:before report:close:after"
CRASH_REMIND="sync:remind:before sync:remind:after"
CRASH_CANCEL="sync:cancel:before sync:cancel:after"

# The repository's holder record: its commit sha, or empty.
holder_sha() { local s; s=$(c_budget "$STOP_AT" 30) || return 1; timeout "$s" git ls-remote "https://github.com/$REPO.git" refs/factory/holder 2>/dev/null | cut -f1; }
c_holder_present() { local sha; sha=$(holder_sha) || return 1; [ -n "$sha" ]; }
wait_exit() { local end=$(( $(now) + $1 )); [ "$end" -gt "$STOP_AT" ] && end=$STOP_AT; while [ "$(now)" -lt "$end" ] && ! stopping; do serve_exited && return 0; sleep 1; done; return 1; }
# A bounded command's seconds, never zero (timeout 0 would disable its limit).
c_budget() { local s=$(( $1 - $(now) )); [ "$s" -gt 0 ] || return 1; [ "$s" -le "$2" ] || s=$2; echo "$s"; }

# Single player per Project (PRD 8): while M serves repository M, an
# installation for repository C pointed at M's Project exits 78 naming
# repository M, before it takes C's record. C has no record yet, so the
# refusal can only be the Project's.
m_ready() { [ -n "$(timeout 30 git ls-remote "https://github.com/$M_REPO.git" refs/factory/holder 2>/dev/null)" ] && awk '$3=="M"{f=1} END{exit !f}' "$RUN_DIR/issues"; }
c_project_refused() {
  local CASE=holder t0; t0=$(now)
  # M holds its repository and has a card on the Project only once it has
  # work: without a main-lane case (`--only crash`) nothing queues there.
  if ! awk '$3=="M"{f=1} END{exit !f}' "$RUN_DIR/issues"; then
    inst M; new_objective happy "M's Objective for the Project refusal" ID="$(uid)" >/dev/null || return 1
  fi
  wait_for 300 m_ready || { record holder.project-refused FAIL "repository M had no holder record or queued Objective to refuse against" "$t0"; return 0; }
  sleep 15   # the queued card reaches the Project's open items
  inst X; serve_up || return 1
  wait_exit 120; local rc; rc=$(cat "$SERVE_DIR/exit" 2>/dev/null)
  local named=0; grep -qF "is served by another installation, on $M_REPO" "$SERVE_DIR/out.log" 2>/dev/null && named=1
  local sha; sha=$(holder_sha) || return 1
  serve_exited || serve_down
  [ "$rc" = 78 ] && [ $named = 1 ] && [ -z "$sha" ]
  rec_if holder.project-refused $? "X (repository C on M's Project) exited ${rc:-not at all} in 120 s; names $M_REPO: $named; C's holder record after: '${sha:-none}'" "$t0"
}

c_holder() {
  c_project_refused || return 1
  local CASE=holder t0; t0=$(now)
  inst C; serve_up || return 1
  wait_for 90 c_holder_present
  local sha0; sha0=$(holder_sha) || return 1; local cdir=$SERVE_DIR
  inst H; serve_up || return 1
  wait_exit 120; local rc; rc=$(cat "$SERVE_DIR/exit" 2>/dev/null)
  local sha1; sha1=$(holder_sha) || return 1
  SERVE_DIR=$cdir; local calive=0; serve_alive && calive=1
  [ -n "$sha0" ] && [ "$rc" = 78 ] && [ "$sha1" = "$sha0" ] && [ $calive = 1 ]
  rec_if holder.second-refused $? "C holds ($sha0); a second installation's serve exited ${rc:-not at all} in 120 s; holder then $sha1; C serving $calive" "$t0"
  t0=$(now); inst H; serve_up "" takeover || return 1
  local hdir=$SERVE_DIR; sleep 10
  SERVE_DIR=$cdir; wait_exit 120; local crc; crc=$(cat "$SERVE_DIR/exit" 2>/dev/null)
  SERVE_DIR=$hdir; local halive=0; serve_alive && halive=1; local sha2; sha2=$(holder_sha) || return 1
  [ $halive = 1 ] && [ "$crc" = 78 ] && [ -n "$sha2" ] && [ "$sha2" != "$sha0" ]
  rec_if holder.take-over $? "H serving with --take-over: $halive; holder $sha0 -> $sha2; C stopped by itself with exit ${crc:-none}" "$t0"
  t0=$(now); serve_down; local sha3; sha3=$(holder_sha) || return 1
  [ -z "$sha3" ] && [ "$(cat "$SERVE_DIR/exit")" = 0 ]; rec_if holder.release $? "H's clean stop (exit $(cat "$SERVE_DIR/exit")) leaves holder '${sha3:-none}'" "$t0"
}

# The lane's Objectives and their hold policies.
c_tick() {
  local n; for n in ${CA:-} ${CB:-} ${CC:-}; do [[ $(st phase "$n") == hold:* ]] && HOLD_POLICY="d2 review decide more" auto_answer "$n" >/dev/null; done
  [ -z "${CQ:-}" ] || { [[ $(st phase "$CQ") == hold:* ]] && HOLD_POLICY="d2" auto_answer "$CQ" >/dev/null; }
  c_netcut
}
# A live step of this serve, not an unmatched historical start from a crash.
c_step_running() {
  python3 - "$ROOT" "$1" "$2" <<'PY'
import fnmatch, json, os, sys
root, issue, pattern = sys.argv[1:]
try:
    with open(os.path.join(root, 'service.json')) as f: service = json.load(f)
    with open(os.path.join(root, 'objectives', issue + '.json')) as f: state = json.load(f)
except (OSError, ValueError): sys.exit(1)
sys.exit(0 if any(fnmatch.fnmatchcase(step, pattern) and attempt.get('run') == service.get('runId')
                 for step, attempt in state.get('attempts', {}).items()) else 1)
PY
}
# Cut the network once while CA or CB plans, once while one waits for CI.
c_netcut() {
  local n
  if [ -z "$CUT1" ]; then for n in ${CA:-} ${CB:-} ${CC:-}; do
    if c_step_running "$n" 'plan:*'; then CUT1=$(iso); serve_cut plan && CUT1E=$(iso); return; fi; done; fi
  if [ -z "$CUT2" ]; then for n in ${CA:-} ${CB:-} ${CC:-}; do
    if c_step_running "$n" 'item:*:ci'; then CUT2=$(iso); serve_cut ci && CUT2E=$(iso); return; fi; done; fi
}
# Pause requests apply before steps start. A clean stop of a paused queue
# clears the intentional crash streak without advancing past unseen hooks.
# Keep the next exact hook armed even for this reset; never run live work
# unarmed just to clear the streak.
c_queue_paused() {
  python3 - "$ROOT/service.json" "$RESET_RUN" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f: service = json.load(f)
except (OSError, ValueError): sys.exit(1)
sys.exit(0 if service.get('runId') and service['runId'] != sys.argv[2]
         and service.get('queue', {}).get('mode') == 'paused' else 1)
PY
}
c_reset_streak() {
  local pt=$1 s
  local RESET_RUN; RESET_RUN=$(python3 - "$ROOT/service.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f: print(json.load(f).get('runId', ''))
except (OSError, ValueError): print('')
PY
)
  s=$(c_budget "$CRASH_END" 15) || return 1
  cli_t "$s" queue pause >>"$RUN_DIR/crash-queue.out" 2>&1 || return 1
  serve_up "$pt" netns || return 1
  s=$(c_budget "$CRASH_END" 30) || return 1
  if ! wait_for "$s" c_queue_paused; then
    UNEXPECTED="$UNEXPECTED paused-reset:$pt"
    serve_down; return 1
  fi
  serve_down
  [ "$(cat "$SERVE_DIR/exit" 2>/dev/null)" = 0 ] || return 1
  s=$(c_budget "$CRASH_END" 15) || return 1
  cli_t "$s" queue resume >>"$RUN_DIR/crash-queue.out" 2>&1 || return 1
  CRASHES=0
}
c_cancel_cq() {
  local s; s=$(c_budget "$CRASH_END" 30) || return 1
  cli_t "$s" cancel "$CQ" >/dev/null 2>&1 || return 1
  log "#$CQ cancel sent"
}
# All hooks share CRASH_END. The globally first write in each family stops
# the whole service, so the next before/after hook is armed before any
# Objective can pass that frontier. Literal targets retain hook identity;
# a 137 from a broad wildcard would not say which hook was exercised.
c_drive() {
  local pt s
  for pt in $1; do
    [ "$(now)" -lt "$CRASH_END" ] && ! stopping || return 1
    if [ "$CRASHES" -ge 2 ]; then c_reset_streak "$pt" || return 1; fi
    serve_up "$pt" netns || return 1
    if [ "$pt" = sync:cancel:before ]; then c_cancel_cq || return 1; fi
    while [ "$(now)" -lt "$CRASH_END" ] && ! stopping; do
      serve_tick
      if serve_exited; then
        local rc; rc=$(cat "$SERVE_DIR/exit")
        if [ "$rc" != 137 ]; then
          UNEXPECTED="$UNEXPECTED $pt:exit$rc"
          log "serve exited $rc while armed at $pt"
          return 1
        fi
        CH[$pt]="crashed $(ts), PID $(serve_pid), exact target $pt"
        CRASHES=$((CRASHES + 1)); RESTARTS=$((RESTARTS + 1))
        log "CRASHED at $pt"
        kill_desc_survivors "$SERVE_DIR/desc"
        break
      fi
      c_tick
      sleep 1
    done
    [ -n "${CH[$pt]:-}" ] || { serve_down; return 1; }
  done
}

c_crash() {
  local CASE=crash t0; t0=$(now); declare -gA CH=(); CUT1=""; CUT2=""; CUT1E=""; CUT2E=""; UNEXPECTED=""; RESTARTS=0; CRASHES=0
  CA=""; CB=""; CC=""; CQ=""
  # Fifteen minutes remain after arming: ten to settle, five for end checks.
  CRASH_END=$(( STOP_AT - 900 ))
  inst C
  CQ=$(new_objective hold "crash lane held" PROVIDER=codex-plan ID="$(uid)") || return
  local ready=0
  if c_drive "$CRASH_REMIND $CRASH_CANCEL"; then
    CA=$(new_objective chain2 "crash lane two items" ID="$(uid)") &&
      CB=$(new_objective happy "crash lane one item" ID="$(uid)") && ready=1
    if [ "$ready" = 1 ]; then
      local fn; fn="trimEnd$(uid)"
      CC=$(new_objective exec "crash lane one item" FN="$fn" SPEC="\`$fn(s)\` removes the spaces at the end of \`s\`: \`$fn(\"ab  \")\` is \`\"ab\"\`.") || ready=0
    fi
    [ "$ready" != 1 ] || c_drive "$CRASH_LIFECYCLE"
  fi
  # Settle every admitted Objective, even after a missing hook. That failure
  # remains a failure; successful cleanup cannot turn it into a pass.
  serve_down
  serve_up "" netns
  cancelled_clean "$CQ" || { local s; s=$(c_budget "$STOP_AT" 30) && cli_t "$s" cancel "$CQ" >/dev/null 2>&1; }
  local end=$(( STOP_AT - 300 ))
  while [ "$(now)" -lt "$end" ] && ! stopping; do
    serve_tick; c_tick
    local pending=0 n
    for n in ${CA:-} ${CB:-} ${CC:-}; do settled "$n" || pending=1; done
    [ "$pending" = 0 ] && cancelled_clean "$CQ" && break
    serve_exited && { log "clean serve exited $(cat "$SERVE_DIR/exit")"; UNEXPECTED="$UNEXPECTED clean:exit$(cat "$SERVE_DIR/exit")"; serve_up "" netns; }
    sleep 2
  done
  local ok=0 ev=""
  [ "$ready" = 1 ] || { ok=1; ev="lifecycle Objectives could not all be admitted"; }
  for n in ${CA:-} ${CB:-} ${CC:-}; do end_done "$n" || ok=1; ev="$ev | $EVID"; done
  end_cancelled "$CQ" || ok=1; ev="$ev | $EVID"
  local cc rm; cc=$(marker_prefix_count "$(gh_markers "$CQ")" cancelled:); rm=$(marker_prefix_count "$(gh_markers "$CQ")" remind:)
  ev="$ev; CQ cancel comments $cc, reminders $rm${UNEXPECTED:+; unexpected exits:$UNEXPECTED}"
  [ "$cc" = 1 ] && [ "$rm" = 1 ] && [ -z "$UNEXPECTED" ] || ok=1
  local pt
  for pt in $CRASH_LIFECYCLE $CRASH_REMIND $CRASH_CANCEL; do
    if [ -n "${CH[$pt]:-}" ]; then rec_if "crash.$pt" $ok "${CH[$pt]}; $ev" "$t0"
    else record "crash.$pt" FAIL "not reached before the shared crash deadline; $ev" "$t0"; fi
  done
  # A crashed installation restarts on its own holder record with no --take-over.
  local CASE=holder
  [ "$RESTARTS" -ge 1 ] && [ -z "$UNEXPECTED" ]; rec_if holder.restart $? "$RESTARTS restarts after a crash, none refused${UNEXPECTED:+; unexpected exits:$UNEXPECTED}" "$t0"
  local CASE=netcut
  c_cut_check plan "$CUT1" "$CUT1E" "$t0"; c_cut_check ci "$CUT2" "$CUT2E" "$t0"
}
# No hold (planner questions aside) from a cut: none at a step of CA, CB or CC that ran during it, within 3 min of its end.
c_cut_check() {
  local name=$1 a=$2 b=$3 t0=$4
  [ -n "$a" ] || { record "netcut.$name" FAIL "no cut ($name): the moment didn't come while a serve ran" "$t0"; return; }
  [ -n "$b" ] || { record "netcut.$name" FAIL "the $name cut started at $a and was never restored" "$t0"; return; }
  local h; h=$(python3 - "$ROOT" "$a" "$b" $CA $CB $CC <<'PY'
import datetime, glob, json, os, sys
root, a, b = sys.argv[1:4]
end = (datetime.datetime.fromisoformat(b.replace("Z", "+00:00")) + datetime.timedelta(minutes=3)).isoformat()[:19]
n = 0
for issue in sys.argv[4:]:
    ev = []
    for f in sorted(glob.glob(os.path.join(root, "logs", issue, "*.jsonl"))):
        for l in open(f, errors="replace"):
            try: ev.append(json.loads(l))
            except ValueError: continue
    ran = {str(e.get("step")) for e in ev if e.get("event") == "start" and str(e.get("at", ""))[:19] <= b[:19]}
    for e in ev:
        at = str(e.get("at", ""))[:19]; step = str(e.get("step"))
        if e.get("event") == "outcome" and e.get("outcome") == "hold" and not step.startswith("decide") and step in ran and a[:19] <= at <= end: n += 1
print(n)
PY
)
  [ "$h" = 0 ]; rec_if "netcut.$name" $? "cut $a..$b: holds at steps that ran during it, within 3 min of its end: $h (#$CA $(st status "$CA"), #$CB $(st status "$CB"), #$CC $(st status "$CC"))" "$t0"
}

lane_c() {
  local lane_start suite_stop=$STOP_AT; lane_start=$(now)
  local STOP_AT=$(( lane_start + 45 * 60 ))
  # Bash dynamic scope gives all wait, CLI and serve helpers this tighter bound.
  [ "$STOP_AT" -le "$suite_stop" ] || STOP_AT=$suite_stop
  local HARD_STOP_AT=$STOP_AT
  if ! c_holder; then local CASE=holder; record holder.setup FAIL "holder steps failed to start a serve" "$lane_start"; fi
  c_crash
  serve_down
}
