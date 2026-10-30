# Shared helpers: installations, results, config, CLI, processes, answers, waits, templates.
# Sourced by run-suite.sh and by every case. Expects SUITE BUILD RUN_DIR STOP_AT.
# A case runs in its own background subshell, so the per-installation globals
# (`inst NAME` sets REPO OWNER NAME STATE ROOT CUR_CFG INST) are its own.

ts() { TZ=America/Los_Angeles date '+%-I:%M:%S %p'; }
log() { echo "$(ts) [${CASE:-suite}] $*" | tee -a "$RUN_DIR/journal" >&2; }
st() { python3 "$SUITE/lib/st.py" "$ROOT" "$@"; }
now() { date +%s; }
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# Milliseconds, zero-padded like Factory's own times, so the two compare as strings
# (uutils `date` prints %3N as unpadded nanoseconds: 01.015 s as "01.15204561").
iso_ms() { python3 -c 'import datetime;print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"))'; }
iso_s() { python3 -c 'import sys,datetime;print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")).timestamp()))' "$1"; }
# STOP_AT is the wave's stop (55 min after the start); inside a case, run_case
# lowers it to the case's own deadline, so every wait below is bounded by it.
# Seconds left before STOP_AT; never negative.
left() { local l=$(( STOP_AT - $(now) )); [ "$l" -gt 0 ] && echo "$l" || echo 0; }
stopping() { [ -e "$RUN_DIR/stop" ] || [ "$(now)" -ge "$STOP_AT" ]; }

# ---------- installations ----------
# inst_define NAME REPO CONFIG: one installation (its own FACTORY_STATE_DIR).
# Fails when the suite's GitHub identity can't be given to it (identity_setup):
# every caller stops there, so no installation runs as an identity the run
# didn't choose.
inst_define() {
  local d="$RUN_DIR/inst/$1"; mkdir -p "$d"
  local repo=$2 key; key=$(echo "$repo" | tr 'A-Z' 'a-z' | sed 's#/#__#')
  cat >"$d/env" <<EOF
INST=$1
REPO=$repo
OWNER=${repo%%/*}
NAME=${repo#*/}
STATE=$STATE_BASE/$1
ROOT=$STATE_BASE/$1/$key
CUR_CFG=$3
EOF
  mkdir -p "$STATE_BASE/$1"
  # A configuration the suite wrote gets the suite's GitHub identity now; the
  # prod case's own setup gives it to the one it creates.
  [ ! -e "$3" ] || identity_setup "$1"
}
# identity_setup NAME: give installation NAME the suite's GitHub identity
# (IDENTITY_ARGS, run-suite.sh) through `factory setup`: the GitHub App, and
# the suite's login as its operator, or the opt-out --github-login. Checked by
# identity_given.
identity_setup() {
  ( inst "$1"; cli_t 180 setup "${IDENTITY_ARGS[@]}" --json ) >"$RUN_DIR/identity-setup.$1.out" 2>"$RUN_DIR/identity-setup.$1.err"
  identity_given "$1" "$RUN_DIR/identity-setup.$1.out"
}
# identity_given NAME REPORT: installation NAME's `factory setup --json`
# REPORT gave it the suite's identity: not refused, no GitHub App check
# blocked, and as the App (SUITE_IDENTITY app) that check there. Otherwise
# the run fails (suite.github-identity) and stops (the wave's stop file): the
# installation would act as an identity the run didn't choose, and the run
# would prove nothing about the App.
identity_given() {
  SUITE_IDENTITY=$SUITE_IDENTITY python3 - "$2" <<'PY' 2>>"$RUN_DIR/identity-setup.$1.err" && return 0
import json, os, sys
try: d = json.load(open(sys.argv[1]))
except ValueError: sys.exit("setup printed no report")
app = [c for c in (d.get("readiness") or {}).get("checks", []) if c.get("name") == "GitHub App"]
if d.get("status") == "refused" or any(c.get("status") == "blocked" for c in app) or (os.environ["SUITE_IDENTITY"] == "app" and not app):
  sys.exit(json.dumps({"status": d.get("status"), "problems": d.get("problems"), "app": app})[:600])
PY
  local CASE=suite INST=$1
  record suite.github-identity FAIL "setup didn't give installation $1 the suite's GitHub identity ($SUITE_IDENTITY): $(tail -c 600 "$RUN_DIR/identity-setup.$1.err")" "$(now)"
  log "stopping the run: installation $1 didn't get the suite's GitHub identity ($([ "$SUITE_IDENTITY" = app ] && echo "GitHub App $FACTORY_SUITE_APP_ID" || echo "the gh login, --github-login")) ($2, $RUN_DIR/identity-setup.$1.err)"
  touch "$RUN_DIR/stop"
  return 1
}
# A replay (KEPT: the kept run's directory) reads the kept run's installations.
inst() { source "${KEPT:-$RUN_DIR}/inst/$1/env"; }
# The installation's live serve directory (the supervisor or the lane writes it).
serve_dir_of() { cat "$RUN_DIR/inst/$1/serve_dir" 2>/dev/null; }

# ---------- results ----------
# record CHECK RESULT EVIDENCE T0: one row (check, case, lane, result, evidence, seconds).
record() {
  local evid=${3//$'\t'/ }; evid=${evid//$'\n'/; }
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "${CASE:-suite}" "${INST:-}" "$2" "$evid" "$(( $(now) - $4 ))" >>"$RUN_DIR/results.tsv"
  log "$2 $1: ${evid:0:300}"
}
# rec_if CHECK COND_EXIT EVIDENCE T0: PASS when the condition (an exit code) is 0, else FAIL.
rec_if() { if [ "$2" = 0 ]; then record "$1" PASS "$3" "$4"; else record "$1" FAIL "$3" "$4"; fi; }
# rec_part CHECK KEPT LIVE EVIDENCE T0: a check whose evidence is partly the kept
# state and logs (exit code KEPT) and partly live GitHub (exit code LIVE, empty in
# a replay). A replay fails it on the kept part; it never passes it.
rec_part() {
  if [ -n "$3" ]; then [ "$2" = 0 ] && [ "$3" = 0 ]; rec_if "$1" $? "$4" "$5"
  elif [ "$2" = 0 ]; then record "$1" NOT-REPLAYABLE "the kept part passes, the rest is live GitHub: $4" "$5"
  else record "$1" FAIL "$4" "$5"; fi
}

# ---------- config (scratch copies only) ----------
cfg_patch() {
  local file=$1; shift
  python3 - "$file" "$@" <<'PY'
import json, sys
path = sys.argv[1]
c = json.load(open(path))
for expr in sys.argv[2:]:
    exec(expr, {"c": c})
json.dump(c, open(path, "w"), indent=2)
PY
}
cfg_get() { python3 -c 'import json,sys;c=json.load(open(sys.argv[1]));v=eval(sys.argv[2],{"c":c});print(v if isinstance(v,str) else json.dumps(v))' "$CUR_CFG" "$1"; }

# ---------- CLI ----------
cli() { (cd "$BUILD" && FACTORY_STATE_DIR="$STATE" FACTORY_CONFIG="$CUR_CFG" node dist/cli.js "$@" --repo "$REPO"); }
cli_t() {
  local s=$1 remaining=$(( STOP_AT - $(now) )); shift
  [ "$remaining" -gt 0 ] || return 124
  [ "$s" -le "$remaining" ] || s=$remaining
  (cd "$BUILD" && FACTORY_STATE_DIR="$STATE" FACTORY_CONFIG="$CUR_CFG" timeout --kill-after=2 "$s" node dist/cli.js "$@" --repo "$REPO")
}
cli_help() {
  local f="$RUN_DIR/cli-help"
  [ -s "$f" ] || (cd "$BUILD" && { node dist/cli.js help 2>&1; node dist/cli.js 2>&1; }) >"$f"
  cat "$f"
}
cli_has() { cli_help | grep -qE "^\s+$1( |$)"; }
build_has_token() { grep -rqsF -- "$1" "$BUILD/dist"; }
build_has_env() { build_has_token "$1"; }

# ---------- build features ----------
# A case names the features it needs; a build without one records the case
# UNREACHABLE (feature absent), never FAIL.
declare -gA FEAT_TOKEN=(
  [isolation]=cleanup-left
  [inert]='function inert('
  [protected-paths]=namesPath
  [attachment-scope]='sends its GitHub token only to'
  [reset-rebuild]=reset:plan
  [ci-rerun]=rerun-failed-jobs
  [thread-hold]='unresolved review thread'
)
has_feature() {
  case $1 in
    run) cli_has run ;;
    *) [ -n "${FEAT_TOKEN[$1]:-}" ] && build_has_token "${FEAT_TOKEN[$1]}" ;;
  esac
}
# need CHECK T0 FEATURE...: 0 when the build has them all; else UNREACHABLE.
need() {
  local c=$1 t0=$2 f miss=(); shift 2
  for f; do has_feature "$f" || miss+=("$f"); done
  [ ${#miss[@]} -eq 0 ] && return 0
  record "$c" UNREACHABLE "feature absent: ${miss[*]}" "$t0"; return 1
}

# ---------- process safety ----------
starttime() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null; }
track() { local s; s=$(starttime "$1") && echo "$1 $s" >>"$RUN_DIR/pids"; }
same_proc() { [ -n "$1" ] && [ "$(starttime "$1")" = "$2" ]; }
kill_exact() { same_proc "$1" "$2" && kill "-$3" "$1" 2>/dev/null; }
# Descendants of ROOT_PID as "PID START" lines, appended to OUT.
snap_desc() {
  python3 - "$1" >>"$2" 2>/dev/null <<'PY'
import os, sys
root = int(sys.argv[1]); kids = {}
for p in os.listdir("/proc"):
    if not p.isdigit(): continue
    try:
        st = open(f"/proc/{p}/stat").read().rsplit(")", 1)[1].split()
        kids.setdefault(int(st[1]), []).append((int(p), st[19]))
    except OSError: pass
todo = [root]
while todo:
    for pid, start in kids.get(todo.pop(), []):
        print(pid, start); todo.append(pid)
PY
}
kill_desc_survivors() {
  local f=$1 pid s
  [ -s "$f" ] || return 0
  sort -u "$f" | while read -r pid s; do
    if same_proc "$pid" "$s"; then log "killing leftover child $pid ($(tr '\0' ' ' </proc/$pid/cmdline 2>/dev/null | cut -c1-80))"; kill -KILL "$pid" 2>/dev/null; fi
  done
}
# Any `cli.js serve` for REPO (from command lines only; environments are never read).
running_serves() {
  python3 - "$1" <<'PY'
import os, sys
repo = sys.argv[1].lower()
for p in os.listdir("/proc"):
    if not p.isdigit() or int(p) == os.getpid(): continue
    try: args = open(f"/proc/{p}/cmdline", "rb").read().split(b"\0")
    except OSError: continue
    args = [a.decode(errors="replace") for a in args if a]
    js = [i for i, a in enumerate(args) if a.endswith("cli.js")]
    if not js or "serve" not in args[js[0] + 1:js[0] + 2]: continue
    r = None
    if "--repo" in args:
        i = args.index("--repo"); r = args[i + 1].lower() if i + 1 < len(args) else None
    if r is None or r == repo:
        print(p, " ".join(args)[:160])
PY
}

# ---------- answers ----------
open_holds() { st holds "$1"; }
hold_id() {
  open_holds "$1" | python3 -c 'import json,sys,fnmatch
g=sys.argv[1] if len(sys.argv)>1 else "*"
h=[x for x in json.load(sys.stdin) if fnmatch.fnmatchcase(str(x.get("step")),g)]
print(h[0]["id"] if h else "")' ${2:+"$2"}
}
# answer_t SECS N ANSWER [--question ID] [--text T]: bound to its question (the oldest open one by default).
answer_t() {
  local s=$1 n=$2 a=$3 q="" rest=(); shift 3
  while [ $# -gt 0 ]; do case $1 in --question) q=$2; shift 2 ;; *) rest+=("$1"); shift ;; esac; done
  if [ "$a" != cancel ]; then [ -n "$q" ] || q=$(hold_id "$n"); [ -n "$q" ] && rest+=(--question "$q"); fi
  cli_t "$s" answer "$n" "$a" "${rest[@]}"
}
# comment_answer N ANSWER [TEXT] [ID]: answer by `/factory` comment; prints the comment id.
comment_answer() {
  local n=$1 a=$2 text=${3:-} q=${4:-} body=""
  if [ "$a" != cancel ]; then
    local hs; hs=$(open_holds "$n")
    [ -n "$q" ] || q=$(python3 -c 'import json,sys;h=json.loads(sys.argv[1]);print(h[0]["id"] if h else "")' "$hs")
    python3 -c 'import json,sys;h=json.loads(sys.argv[1]);sys.exit(0 if len(h)==1 and h[0].get("id")==sys.argv[2] and h[0].get("shortForm") is True else 1)' "$hs" "$q" \
      || body="/factory $a --question $q${text:+ $text}"
  fi
  gh_comment "$n" "${body:-/factory $a${text:+ $text}}"
}
hold_field() { python3 -c 'import json,sys;h=json.loads(sys.argv[1] or "null") or {};v=h.get(sys.argv[2],"");print(",".join(v) if isinstance(v,list) else v)' "$1" "$2"; }
# The recommended answer of a hold, or its first answer other than cancel/retry.
hold_pick() { python3 -c 'import json,sys;h=json.loads(sys.argv[1] or "null") or {};a=[x for x in h.get("answers",[]) if x not in ("cancel","retry")];r=h.get("recommended");print(r if r not in ("cancel","retry",None) else (a[0] if a else "cancel"))' "$1"; }

# Hold policies, by structure (HOLD_POLICY, per case):
#   d2      retry a failure hold with only retry/cancel (a crash-loop suspect from the suite's restarts)
#   review  apply a fixture decision from AUTO_REVIEW_DECISIONS that names the
#           criterion ([{step,answer,arg,criterion,text}]: step a glob, arg the
#           criterion's number and/or criterion a regex its text must match,
#           case-insensitive, st.py `decides`); never invent evidence for a criterion
#   decide  ask the planner to choose within the existing Objective, without new authority
#           (at most AUTO_DECIDE_MAX per Objective)
#   more    answer `more` when it is the recommended answer (an allowance reached by the suite's own answers)
HOLD_POLICY=${HOLD_POLICY-d2 review}
# auto_answer N -> 0 when it answered an open hold or has an answer in flight;
# 2 when a hold is open, HOLD_POLICY (and AUTO_REVIEW_DECISIONS) has no answer
# left for any, and no answer of the case's own is waiting to be applied; else 1.
auto_answer() {
  local n=$1 choices choice id step pick arg text marker at seconds count rc=1 offered=""
  local fields=() args=()
  choices=$(st auto-answers "$n" "$HOLD_POLICY" "${AUTO_REVIEW_DECISIONS:-[]}") || return 1
  while IFS= read -r choice; do
    [ -n "$choice" ] || continue
    mapfile -d '' -t fields < <(python3 -c 'import hashlib,json,sys
c=json.loads(sys.argv[1])
for k in ("id","step","answer","arg","text"): print(c.get(k,""),end="\0")
print(hashlib.sha256(c["id"].encode()).hexdigest(),end="\0")' "$choice")
    id=${fields[0]}; step=${fields[1]}; pick=${fields[2]}; arg=${fields[3]}; text=${fields[4]}
    marker="$RUN_DIR/answered/$n.${fields[5]}"
    # Answered and accepted: the hold is still on its way out.
    [ -f "$marker" ] && { offered=1; continue; }
    if [[ $step == decide:* ]]; then
      count=$(python3 - "$RUN_DIR/answered" "$n" <<'PY'
import glob,json,os,sys
print(sum(1 for p in glob.glob(os.path.join(sys.argv[1],sys.argv[2]+".*"))
          if json.load(open(p)).get("step", "").startswith("decide:")))
PY
) || return 1
      [ "$count" -lt "${AUTO_DECIDE_MAX:-4}" ] || continue
    fi
    offered=1
    # A CLI exit of zero can mean only "queued". Wait for the service's
    # structured request result before recording an answer as accepted;
    # one the service hasn't applied yet is in flight, not unanswerable.
    [ "$(st answer-state "$n" "$choice")" = pending ] && { rc=0; continue; }
    seconds=$(left); [ "$seconds" -gt 0 ] || break
    [ "$seconds" -le 60 ] || seconds=60
    args=(); [ -z "$arg" ] || args+=("$arg")
    args+=(--question "$id"); [ -z "$text" ] || args+=(--text "$text")
    at=$(iso_ms)
    if ! answer_t "$seconds" "$n" "$pick" "${args[@]}" >"$RUN_DIR/answer.$n.out" 2>&1; then
      log "#$n answer $pick${arg:+ $arg} was refused or interrupted ($id at $step)"
      continue
    fi
    if [ "$(st answer-state "$n" "$choice" "$at")" != accepted ]; then
      log "#$n answer $pick${arg:+ $arg} is not confirmed applied yet ($id at $step)"
      rc=0; continue
    fi
    printf '%s\n' "$choice" >"$marker"
    echo "#$n auto-answered $pick at $step" >>"$RUN_DIR/notes.$n"
    log "#$n auto-answered $pick${arg:+ $arg} (question $id at $step)"; rc=0
  done <<<"$choices"
  [ -n "$offered" ] && return $rc
  # Unanswerable only while a hold stands (it may have cleared since the
  # read) and no answer the case sent itself (answer_t) is still queued.
  [ "$(st holds "$n")" != "[]" ] && [ "$(st pending "$n")" = 0 ] || return 1
  return 2
}
# wait_phase N REGEX SECS: poll the state until the phase matches (status, or
# "hold:<step>" while a question is open), answering by HOLD_POLICY. Never past
# STOP_AT. Prints the phase, or "timeout:<phase>" / "stopped:<phase>". A wait
# whose REGEX asks for no hold returns "held:<step>" at once on a hold
# HOLD_POLICY can't answer: nothing else would, and it would starve the case.
wait_phase() {
  local n=$1 want=$2 secs=$3 end p a
  end=$(( $(now) + secs )); [ "$end" -gt "$STOP_AT" ] && end=$STOP_AT
  while :; do
    p=$(st phase "$n")
    if [[ $p =~ $want ]]; then echo "$p"; return 0; fi
    a=1; [[ $p == hold:* ]] && { auto_answer "$n"; a=$?; }
    # Held only if the same hold still shows after the policy had its turn.
    [ "$a" = 2 ] && [[ $want != *hold* ]] && [ "$(st phase "$n")" = "$p" ] && { echo "held:${p#hold:}"; return 1; }
    stopping && { echo "stopped:$p"; return 1; }
    [ "$(now)" -ge "$end" ] && { echo "timeout:$p"; return 1; }
    if [ "$a" = 0 ]; then sleep 3; else sleep 4; fi
  done
}
# wait_for SECS CMD...: poll a command until it succeeds (never past STOP_AT).
wait_for() {
  local secs=$1; shift
  local end=$(( $(now) + secs )); [ "$end" -gt "$STOP_AT" ] && end=$STOP_AT
  while :; do "$@" && return 0; { stopping || [ "$(now)" -ge "$end" ]; } && return 1; sleep 4; done
}
settled() { case $(st status "$1") in done|cancelled|failed) return 0 ;; *) return 1 ;; esac; }
# A cancelled Objective whose cleanup has run.
cancelled_clean() { [ "$(st status "$1")" = cancelled ] && [ "$(st has "$1" done.cancel:cleanup)" = 1 ]; }
started() { [ "$(st started "$1" "$2")" = 1 ]; }
# started_or_answer N GLOB: started, answering N's holds by HOLD_POLICY meanwhile (for wait_for).
started_or_answer() { started "$1" "$2" && return 0; [[ $(st phase "$1") == hold:* ]] && auto_answer "$1" >/dev/null; return 1; }
# cancel_wait N: cancel and wait for the cleanup.
cancel_wait() { cli_t 60 cancel "$1" >/dev/null 2>&1; wait_for "${2:-300}" cancelled_clean "$1"; }

# ---------- fault proxy (lib/gh-fault-proxy.mjs) ----------
# One proxy per installation: its rules file holds every case's rules, each
# line tagged with its case (`#tag` at the end), so a case adds and clears
# only its own. The proxy re-reads the file per request. Its port is the one
# the OS picks (the proxy prints it once it listens): two runs at once never share one.
proxy_start() { # NAME -> sets PROXY_URL
  local name=$1 port="" end=$(( $(now) + 15 ))
  : >"$RUN_DIR/$name.rules"; : >"$RUN_DIR/$name.calls.jsonl"
  node "$SUITE/lib/gh-fault-proxy.mjs" 0 "$RUN_DIR/$name.calls.jsonl" "$RUN_DIR/$name.rules" </dev/null >"$RUN_DIR/$name.proxy.out" 2>&1 &
  local pp=$! ps; ps=$(starttime $pp); track $pp; echo "$pp $ps" >"$RUN_DIR/$name.proxy.pid"
  while [ -z "$port" ] && [ "$(now)" -lt "$end" ] && same_proc "$pp" "$ps"; do
    port=$(sed -n 's/^listening on 127\.0\.0\.1:\([0-9]*\)$/\1/p' "$RUN_DIR/$name.proxy.out"); [ -n "$port" ] || sleep 0.2
  done
  [ -n "$port" ] || { log "fault proxy $name did not start: $(tail -c 300 "$RUN_DIR/$name.proxy.out")"; return 1; }
  PROXY_URL="http://127.0.0.1:$port"
}
proxy_stop() { local p s; [ -s "$RUN_DIR/$1.proxy.pid" ] || return 0; read -r p s <"$RUN_DIR/$1.proxy.pid"; kill_exact "$p" "$s" TERM; rm -f "$RUN_DIR/$1.proxy.pid"; }
# prule_add RULE...: add rules tagged with this case to this installation's proxy.
prule_add() {
  local r; ( flock 9; for r; do printf '%s #%s\n' "$r" "$CASE" >>"$RUN_DIR/$INST.rules"; done ) 9>"$RUN_DIR/$INST.rules.lock"
  log "proxy rules +$#: $*"
}
# prule_clear: drop this case's rules.
prule_clear() {
  ( flock 9; grep -v " #$CASE\$" "$RUN_DIR/$INST.rules" >"$RUN_DIR/$INST.rules.tmp.$CASE"; mv "$RUN_DIR/$INST.rules.tmp.$CASE" "$RUN_DIR/$INST.rules" ) 9>"$RUN_DIR/$INST.rules.lock"
}
# proxy_count METHOD PATH_REGEX [STATUS]: this installation's logged calls that match.
proxy_count() {
  python3 -c '
import json, re, sys
log, m, rx, st = sys.argv[1:5]
n = 0
for l in open(log):
    try: r = json.loads(l)
    except ValueError: continue
    if r.get("method") == m and re.search(rx, r.get("path", "")) and (not st or str(r.get("status")) == st): n += 1
print(n)' "$RUN_DIR/$INST.calls.jsonl" "$1" "$2" "${3:-}"
}
epoch_in() { echo $(( $(now) + $1 )); }

# ---------- templates and Objectives ----------
render() {
  local tpl="$SUITE/objectives/$1.md" out=$2; shift 2
  python3 - "$tpl" "$out" "SFX=$SFX" "RUN=$RUN_ID" "FIXTURES=$SUITE/fixtures" "EXTRA=" "$@" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
vals = dict(kv.split("=", 1) for kv in sys.argv[3:])
for k, v in vals.items(): text = text.replace("{{" + k + "}}", v)
left = re.findall(r"\{\{[A-Z0-9_]+\}\}", text)
if left: sys.exit(f"unfilled placeholders in {sys.argv[1]}: {sorted(set(left))}")
open(sys.argv[2], "w").write(text)
PY
}
# new_issue TEMPLATE TITLE [KEY=VALUE...] -> issue number, filed but not queued.
new_issue() {
  local tpl=$1 title=$2; shift 2
  local f="$RUN_DIR/objectives/$CASE-$tpl-$(date +%H%M%S%N).md"
  mkdir -p "$RUN_DIR/objectives"
  render "$tpl" "$f" "$@" || return 1
  local n; n=$(gh_issue_file "Suite $SFX: $title" "$f") || return 1
  echo "$n $CASE $INST" >>"$RUN_DIR/issues"
  log "filed #$n ($tpl)"
  echo "$n"
}
# queue_issue N [PROVIDER]: queue a filed issue: on the Project card, or with
# `factory run N --provider P` (the follower is stopped; the run goes on).
# Adding the card and setting it Queued both repeat safely, so a GitHub
# failure is tried again; one that lasts fails here, never as a silent wait.
queue_issue() {
  if [ -n "${2:-}" ]; then cli_t 30 run "$1" --provider "$2" >>"$RUN_DIR/run.$1.out" 2>&1; log "factory run #$1 --provider $2 (follower stopped: rc $?)"; return 0; fi
  gh_retry "$RUN_DIR/enqueue.$1.err" "queueing #$1" gh_enqueue "$1" >/dev/null || return 1
  log "queued #$1"
}
# gh_retry ERRFILE WHAT CMD...: run CMD, GitHub calls that repeat safely, up to
# three times (a Project "temporary conflict" passes in seconds). Its stdout
# passes through; its stderr goes to ERRFILE and each failure is logged. One
# that lasts returns 1 with gh's last error left in ERRFILE for the evidence.
gh_retry() {
  local err=$1 what=$2 try; shift 2
  for try in 1 2 3; do
    "$@" 2>"$err" && return 0
    log "$what failed (try $try): $(head -c 300 "$err")"
    [ "$try" = 3 ] || sleep $(( try * 5 ))
  done
  return 1
}
# new_objective TEMPLATE TITLE [PROVIDER=P] [KEY=VALUE...] -> issue number, queued.
new_objective() {
  local tpl=$1 title=$2 prov=""; shift 2
  [[ ${1:-} == PROVIDER=* ]] && { prov=${1#PROVIDER=}; shift; }
  local n; n=$(new_issue "$tpl" "$title" "$@") || return 1
  queue_issue "$n" "$prov" || return 1
  echo "$n"
}
uid() { python3 -c 'import random,string;print("Q"+"".join(random.choice(string.ascii_lowercase) for _ in range(4)))'; }
# The case's own Objectives (this installation), in the order it filed them.
case_issues() { awk -v c="$CASE" -v i="$INST" '$2==c && $3==i {print $1}' "${KEPT:-$RUN_DIR}/issues" 2>/dev/null; }
# case_settle: cancel this case's unsettled Objectives (the wave's end does the same for all).
case_settle() {
  local n
  for n in $(case_issues); do
    case $(st status "$n") in done|cancelled|failed) ;; none) gh_card "$n" Cancelled >/dev/null 2>&1 ;; *) cli_t 60 cancel "$n" >/dev/null 2>&1 ;; esac
  done
}
