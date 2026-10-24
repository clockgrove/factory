# Shared helpers for run-suite.sh: processes, config, results, templates, waits.
# Sourced; expects SUITE BUILD STATE REPO ROOT RUN_DIR BASE_CFG CUR_CFG to be set.

ts() { TZ=America/Los_Angeles date '+%-I:%M:%S %p'; }
log() { echo "$(ts) $*" | tee -a "$RUN_DIR/journal" >&2; }
st() { python3 "$SUITE/lib/st.py" "$ROOT" "$@"; }
now() { date +%s; }

# ---------- results ----------
# record CHECK GROUP RESULT EVIDENCE T0
record() {
  local evid=${4//$'\t'/ }; evid=${evid//$'\n'/; }
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$evid" "$(( $(now) - $5 ))" >>"$RUN_DIR/results.tsv"
  log "$3 $2/$1: $evid"
}

# ---------- config (scratch copies only; the source file is never written) ----------
# cfg_patch FILE PY_EXPR...  each expression edits the dict `c`, e.g. 'c["queue"]["maxActiveObjectives"]=1'
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
# A fresh per-group copy of the run's scratch config.
cfg_for_group() { CUR_CFG="$RUN_DIR/config.$1.json"; cp "$BASE_CFG" "$CUR_CFG"; }

# ---------- CLI ----------
cli() { (cd "$BUILD" && FACTORY_STATE_DIR="$STATE" FACTORY_CONFIG="$CUR_CFG" node dist/cli.js "$@" --repo "$REPO"); }
# cli_t SECS ARGS...: cli under a time limit (`timeout` can't run the cli function itself).
cli_t() { local s=$1; shift; (cd "$BUILD" && FACTORY_STATE_DIR="$STATE" FACTORY_CONFIG="$CUR_CFG" timeout "$s" node dist/cli.js "$@" --repo "$REPO"); }
# The build's usage text, read once per run (help, or the bare command on old builds).
cli_help() {
  local f="$RUN_DIR/cli-help"
  [ -s "$f" ] || (cd "$BUILD" && { node dist/cli.js help 2>&1; node dist/cli.js 2>&1; }) >"$f"
  cat "$f"
}
cli_has() { cli_help | grep -qE "^\s+$1( |$)"; }
build_has_env() { grep -rqs -- "$1" "$BUILD/dist"; }
build_has_token() { grep -rqsF -- "$1" "$BUILD/dist"; }

# ---------- build features ----------
# A case names the features it needs. A build without one records the case
# UNREACHABLE (feature absent), never FAIL. A feature is a structural mark in
# the build's dist (or its usage text).
declare -gA FEAT_TOKEN=(
  [github-api]=FACTORY_GITHUB_API
  [wait-ms]=FACTORY_WAIT_MS
  [remind]=FACTORY_REMIND_MS
  [note]=FACTORY_NOTE_MS
  [deadline]=FACTORY_DEADLINE_MS
  [provider-trace]=FACTORY_PROVIDER_TRACE
  [branch-delete]=branch-kept
  [unchecked]=comment-unchecked
  [rate-reset]=x-ratelimit-reset
  [switch]=switchTargets
  [proxy-policy]=shell_environment_policy
  [run-report]=':report:${run}'
  [incident]='unreadable:${entry.incident}'
  [withdrawing]=withdrawing
  [review-fixes]=OBJECTIVE_ACCEPTED
  [continuation]='progress: true'
  [check-cap]='resource: "github"'
  [gone-issue]=reply-dropped
  [repo-moved]=RepositoryMoved
)
has_feature() {
  case $1 in
    holds-v2) cli_help | grep -qF -- '--question' ;;   # answer ISSUE ANSWER --question ID
    reset) cli_has reset ;;
    *) [ -n "${FEAT_TOKEN[$1]:-}" ] && build_has_token "${FEAT_TOKEN[$1]}" ;;
  esac
}
# need CHECK GROUP T0 FEATURE...: 0 when the build has them all; else records
# CHECK UNREACHABLE (feature absent) and returns 1.
need() {
  local c=$1 g=$2 t0=$3 f miss=(); shift 3
  for f; do has_feature "$f" || miss+=("$f"); done
  [ ${#miss[@]} -eq 0 ] && return 0
  record "$c" "$g" UNREACHABLE "feature absent: ${miss[*]}" "$t0"; return 1
}
# approved CHECK GROUP T0 WHAT: repository changes run only with
# --allow-repo-changes (the maintainer's approval); without it the case is UNREACHABLE (needs approval).
approved() {
  [ -n "${ALLOW_REPO_CHANGES:-}" ] && return 0
  record "$1" "$2" UNREACHABLE "needs approval: $4 (run with --allow-repo-changes once the maintainer approves)" "$3"; return 1
}
# pre FEATURE... [approval:WHAT]: the dry-run tag of a case on this build.
pre() {
  local f miss=() appr=()
  for f; do
    case $f in
      approval:*) [ -n "${ALLOW_REPO_CHANGES:-}" ] || appr+=("${f#approval:}") ;;
      *) has_feature "$f" || miss+=("$f") ;;
    esac
  done
  if [ ${#miss[@]} -gt 0 ]; then echo "[UNREACHABLE: feature absent: ${miss[*]}]"
  elif [ ${#appr[@]} -gt 0 ]; then echo "[UNREACHABLE: needs approval: ${appr[*]}]"
  else echo "[runs${*:+: $*}]"; fi
}

# ---------- process safety ----------
# Every process the suite starts is recorded as "PID STARTTIME" in $RUN_DIR/pids;
# kills go to exact PIDs whose start time still matches (no pkill, no reuse).
starttime() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null; }
track() { local s; s=$(starttime "$1") && echo "$1 $s" >>"$RUN_DIR/pids"; }
same_proc() { [ -n "$1" ] && [ "$(starttime "$1")" = "$2" ]; }
kill_exact() { # PID STARTTIME SIGNAL
  same_proc "$1" "$2" && kill "-$3" "$1" 2>/dev/null
}
# Snapshot the serve's descendants (codex, copilot, validators) so survivors
# of a crash can be killed by exact PID.
snap_desc() {
  local root=$1 out=$2
  python3 - "$root" >>"$out" 2>/dev/null <<'PY'
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

# Any `cli.js serve` for this repository (or with no --repo, which may read
# FACTORY_REPOSITORY) — from command lines only; other processes' environments
# are never read.
running_serves() {
  python3 - "$REPO" <<'PY'
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
# The state dir's own service record: a live PID there means a serve owns it.
state_owner() {
  local p
  p=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("pid",""))' "$ROOT/service.json" 2>/dev/null)
  [ -n "$p" ] && [ -r "/proc/$p/cmdline" ] && tr '\0' ' ' <"/proc/$p/cmdline" | grep -q 'cli.js' && echo "$p"
}
guard_serve() {
  local found owner
  found=$(running_serves); owner=$(state_owner)
  if [ -n "$found" ] || [ -n "$owner" ]; then
    log "refused: a serve is running for $REPO or owns $ROOT:"
    [ -n "$found" ] && echo "$found" | tee -a "$RUN_DIR/journal" >&2
    [ -n "$owner" ] && log "  service.json pid $owner is alive"
    return 1
  fi
}

# ---------- serve ----------
SERVE_N=0; SERVE_DIR=""; SERVE_EXTRA_ENV=${SERVE_EXTRA_ENV:-}; SERVE_ARGS=${SERVE_ARGS:-}
serve_start() { # [CRASH_POINT]
  local point=${1:-}
  guard_serve || return 1
  SERVE_N=$((SERVE_N + 1))
  local d="$RUN_DIR/serve/$(printf %03d $SERVE_N)-${point:-clean}"
  d=${d//\*/x}; d=${d//\#/_}
  mkdir -p "$d"; SERVE_DIR=$d
  local envs=("FACTORY_STATE_DIR=$STATE" "FACTORY_CONFIG=$CUR_CFG")
  local e; for e in $SERVE_EXTRA_ENV; do envs+=("$e"); done
  [ -n "$point" ] && envs+=("FACTORY_CRASH_AT=$point")
  printf '%s\n' "${envs[@]}" >"$d/env"
  (cd "$BUILD" && setsid env "${envs[@]}" bash -c \
    'node dist/cli.js serve --repo "$1" $3 >"$2/out.log" 2>&1 & echo $! >"$2/pid"; wait $!; echo $? >"$2/exit"' \
    _ "$REPO" "$d" "$SERVE_ARGS" </dev/null >/dev/null 2>&1 &)
  local i; for i in $(seq 1 100); do [ -s "$d/pid" ] && break; sleep 0.1; done
  [ -s "$d/pid" ] || { log "serve did not start"; return 1; }
  track "$(cat "$d/pid")"
  cp "$CUR_CFG" "$d/config.json"
  log "serve pid $(cat "$d/pid") started point=${point:-none}"
}
serve_pid() { cat "$SERVE_DIR/pid" 2>/dev/null; }
serve_alive() { [ -n "$SERVE_DIR" ] && [ -s "$SERVE_DIR/pid" ] && [ ! -s "$SERVE_DIR/exit" ] && kill -0 "$(serve_pid)" 2>/dev/null; }
serve_tick() { serve_alive && snap_desc "$(serve_pid)" "$SERVE_DIR/desc"; }
serve_reap() { [ -n "$SERVE_DIR" ] && kill_desc_survivors "$SERVE_DIR/desc"; }
serve_stop() {
  serve_alive || { serve_reap; return 0; }
  local p s; p=$(serve_pid); s=$(starttime "$p")
  serve_tick
  kill_exact "$p" "$s" TERM
  local i; for i in $(seq 1 120); do [ -s "$SERVE_DIR/exit" ] && break; sleep 1; done
  if [ ! -s "$SERVE_DIR/exit" ]; then log "serve $p still alive after 120 s: SIGKILL"; kill_exact "$p" "$s" KILL; sleep 2; fi
  serve_reap
  log "serve pid $p stopped (exit $(cat "$SERVE_DIR/exit" 2>/dev/null))"
}

# ---------- answers ----------
# Open holds of N as a JSON list, oldest first: `status N --json` (holds[], or
# the single `hold` of older builds), else the state file.
open_holds() {
  local out
  if out=$(cli_t 30 status "$1" --json 2>/dev/null) && [ -n "$out" ]; then
    python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
for r in d.get("objectives", []):
    if str(r.get("issue")) == sys.argv[1]:
        h = r.get("holds")
        print(json.dumps(h if isinstance(h, list) else ([r["hold"]] if r.get("hold") else [])))
        break
else:
    print("[]")' "$1" <<<"$out" 2>/dev/null && return 0
  fi
  st holds "$1"
}
# hold_id N [STEPGLOB]: the id of the oldest open hold (whose step matches).
hold_id() {
  open_holds "$1" | python3 -c 'import json,sys,fnmatch
g=sys.argv[1] if len(sys.argv)>1 else "*"
h=[x for x in json.load(sys.stdin) if fnmatch.fnmatchcase(str(x.get("step")),g)]
print(h[0]["id"] if h else "")' ${2:+"$2"}
}
# answer_t SECS N ANSWER [--question ID] [--text T]: `factory answer`, bound to
# its question when the build binds answers (such a build refuses any
# answer but cancel without --question). The id is the one given, else the
# oldest open hold's from `status --json`. Older builds get no --question.
answer_t() {
  local s=$1 n=$2 a=$3 q="" rest=(); shift 3
  while [ $# -gt 0 ]; do case $1 in --question) q=$2; shift 2 ;; *) rest+=("$1"); shift ;; esac; done
  if [ "$a" != cancel ] && has_feature holds-v2; then
    [ -n "$q" ] || q=$(hold_id "$n")
    [ -n "$q" ] && rest+=(--question "$q")
  fi
  cli_t "$s" answer "$n" "$a" "${rest[@]}"
}
# comment_answer N ANSWER [TEXT] [ID]: answer by `/factory` comment; prints the
# comment id. The short form `/factory ANSWER` is used only when exactly one
# hold is open and (holds-v2) its comment shows the short form; otherwise the
# bound form `/factory ANSWER --question ID`. Cancel is never bound.
comment_answer() {
  local n=$1 a=$2 text=${3:-} q=${4:-} body=""
  if [ "$a" != cancel ] && has_feature holds-v2; then
    local hs; hs=$(open_holds "$n")
    [ -n "$q" ] || q=$(python3 -c 'import json,sys;h=json.loads(sys.argv[1]);print(h[0]["id"] if h else "")' "$hs")
    if ! python3 -c 'import json,sys;h=json.loads(sys.argv[1]);sys.exit(0 if len(h)==1 and h[0].get("id")==sys.argv[2] and h[0].get("shortForm") is True else 1)' "$hs" "$q"; then
      body="/factory $a --question $q${text:+ $text}"
    fi
  fi
  gh_comment "$n" "${body:-/factory $a${text:+ $text}}"
}
# hold_field JSON FIELD: one field of a hold (lists joined by commas).
hold_field() { python3 -c 'import json,sys;h=json.loads(sys.argv[1] or "null") or {};v=h.get(sys.argv[2],"");print(",".join(v) if isinstance(v,list) else v)' "$1" "$2"; }

# ---------- waits ----------
# Hold policies, by structure: each open hold whose answers include the
# policy's answer and whose step matches is answered by CLI, bound to that
# hold, and noted.
#   d2      retry a "keeps failing" hold raised by drill restarts (any step)
#   review  accept at result/final review (source inputs never reach review)
#   decide  take the planner's recommended answer at a plan question (netcut, model-kill)
HOLD_POLICY=${HOLD_POLICY-d2 review}
auto_answer() { # N -> 0 when it answered at least one open hold
  local n=$1 holds id step pick rc=1
  holds=$(st holds "$n")
  [ "$holds" = "[]" ] && return 1
  while IFS=$'\t' read -r id step pick; do
    [ -n "$pick" ] || continue
    [ -f "$RUN_DIR/answered.$n.$id" ] && continue
    # Spend cap: at most AUTO_DECIDE_MAX (4) planner questions answered per Objective, then leave it held.
    if [[ $step == decide:* ]] && [ "$(ls "$RUN_DIR"/answered."$n".decide:* 2>/dev/null | wc -l)" -ge "${AUTO_DECIDE_MAX:-4}" ]; then
      [ -f "$RUN_DIR/decide-capped.$n" ] || { touch "$RUN_DIR/decide-capped.$n"; log "#$n: ${AUTO_DECIDE_MAX:-4} planner questions answered already; leaving $id open (spend cap)"; echo "#$n planner questions capped at ${AUTO_DECIDE_MAX:-4}" >>"$RUN_DIR/notes.$n"; }
      continue; fi
    touch "$RUN_DIR/answered.$n.$id"
    # A planner question re-asks on a bare `answer`; the text says to take its recommendation.
    if [ "$pick" = answer ]; then answer_t 60 "$n" answer --question "$id" --text "Take your recommended option." >/dev/null 2>&1
    else answer_t 60 "$n" "$pick" --question "$id" >/dev/null 2>&1; fi
    echo "#$n auto-answered $pick at $step" >>"$RUN_DIR/notes.$n"
    log "#$n auto-answered $pick (question $id at $step)"; rc=0
  done < <(python3 - "$holds" "$HOLD_POLICY" <<'PY'
import json, sys
pol = sys.argv[2].split()
for h in json.loads(sys.argv[1]):
    a = h.get("answers") or []; step = h.get("step", ""); pick = ""
    if "review" in pol and (step.endswith(":review") or step == "final-review") and "accept" in a: pick = "accept"
    elif "decide" in pol and step.startswith("decide:") and h.get("recommended") not in (None, "cancel"): pick = h["recommended"]
    # A crash-loop suspect from drill restarts is a failure hold with only retry/cancel, on any step (plan steps included).
    elif "d2" in pol and "retry" in a and "cancel" in a and len(a) == 2 and (h.get("cause") == "failure" or not step.startswith(("check", "plan", "decide"))): pick = "retry"
    print(f"{h.get('id', '')}\t{step}\t{pick}")
PY
)
  return $rc
}
# wait_phase N REGEX SECS: poll until the phase matches (e.g. 'done|cancelled|failed'
# or '^hold:'), the serve exits, or time runs out. Prints the last phase, or
# "exit:<code>" / "timeout:<phase>".
wait_phase() {
  local n=$1 want=$2 secs=$3 end p
  end=$(( $(now) + secs ))
  while [ "$(now)" -lt "$end" ]; do
    serve_tick
    p=$(st phase "$n")
    if [[ $p =~ $want ]]; then echo "$p"; return 0; fi
    if [[ $p == hold:* ]] && auto_answer "$n"; then sleep 5; continue; fi
    if [ -n "$SERVE_DIR" ] && [ -s "$SERVE_DIR/exit" ]; then echo "exit:$(cat "$SERVE_DIR/exit")"; return 1; fi
    sleep 5
  done
  echo "timeout:$p"; return 1
}
# wait_for SECS CMD...: poll a command until it succeeds.
wait_for() {
  local secs=$1; shift
  local end=$(( $(now) + secs ))
  while [ "$(now)" -lt "$end" ]; do serve_tick; "$@" && return 0; sleep 5; done
  return 1
}
# Crash at POINT: start serve with it and wait for its exit. Sets CRASH_R to
# 137 when it crashed, "objective:<status>" when Objective N settled first,
# "timeout" or "refused". Not for $(...): it must keep SERVE_DIR in this shell.
CRASH_R=""
crash_at() { # N POINT SECS
  local n=$1 pt=$2 secs=$3 end p init cl0
  CRASH_R=refused
  # Settled means it reached an end since this start: a cancel's cleanup must
  # have run (the cancel:* points are in it), and an Objective already
  # cancelled when a re-queue starts (rerun:*) isn't settled by that.
  init=$(st status "$n"); cl0=$(st has "$n" done.cancel:cleanup)
  serve_start "$pt" || return 1
  [ -n "${CRASH_HOOK:-}" ] && "$CRASH_HOOK" "$n" "$pt"
  end=$(( $(now) + secs ))
  while [ "$(now)" -lt "$end" ]; do
    serve_tick
    if [ -s "$SERVE_DIR/exit" ]; then serve_reap; CRASH_R=$(cat "$SERVE_DIR/exit"); return 0; fi
    p=$(st phase "$n")
    case $p in
      cancelled) if [ "$(st has "$n" done.cancel:cleanup)" = 1 ] && { [ "$init" != cancelled ] || [ "$cl0" = 0 ]; }; then serve_stop; CRASH_R="objective:$p"; return 1; fi ;;
      done|failed) if [ "$p" != "$init" ]; then serve_stop; CRASH_R="objective:$p"; return 1; fi ;;
    esac
    [[ $p == hold:* ]] && auto_answer "$n"
    sleep 3
  done
  serve_stop; CRASH_R=timeout; return 1
}
# chain N POINT...: crash at each point in turn on Objective N; sets CH[point].
declare -gA CH=()
chain() {
  local n=$1; shift; local pt r
  for pt in "$@"; do
    crash_at "$n" "$pt" "${CRASH_TIMEOUT:-1800}"; r=$CRASH_R
    if [ "$r" = 137 ]; then CH[$pt]="crashed $(ts)"; log "#$n CRASHED at $pt"
    else CH[$pt]="missed ($r)"; log "#$n NOT crashed at $pt: $r"; fi
    sleep 2
  done
}
# Record one row per chained point: PASS iff it crashed and the end check passed.
record_chain() { # GROUP OK(0/1) END_EVIDENCE T0 POINT...
  local g=$1 ok=$2 ev=$3 t0=$4; shift 4; local pt
  for pt in "$@"; do
    if [[ ${CH[$pt]:-} == crashed* ]] && [ "$ok" = 0 ]; then record "$g.$pt" "$g" PASS "${CH[$pt]}; $ev" "$t0"
    else record "$g.$pt" "$g" FAIL "${CH[$pt]:-not run}; $ev" "$t0"; fi
  done
}

# ---------- fault proxy (lib/gh-fault-proxy.mjs) ----------
# proxy_start NAME PORT: a pass-through GitHub API proxy. Its rules file is
# $RUN_DIR/NAME.rules (syntax in the proxy) and its log $RUN_DIR/NAME.calls.jsonl.
# Sets PROXY_ENV (add it to SERVE_EXTRA_ENV). Headers, and so the token, are
# never logged.
declare -gA PROXIES=()
PROXY_ENV=""
proxy_start() {
  local name=$1 port=$2
  : >"$RUN_DIR/$name.rules"; : >"$RUN_DIR/$name.calls.jsonl"
  node "$SUITE/lib/gh-fault-proxy.mjs" "$port" "$RUN_DIR/$name.calls.jsonl" "$RUN_DIR/$name.rules" </dev/null >"$RUN_DIR/$name.proxy.out" 2>&1 &
  local pp=$!; track $pp; PROXIES[$name]="$pp $(starttime $pp)"; sleep 1
  PROXY_ENV="FACTORY_GITHUB_API=http://127.0.0.1:$port"
}
proxy_rules() { local name=$1; shift; printf '%s\n' "$@" >"$RUN_DIR/$name.rules"; }
proxy_stop() { local p s; [ -n "${PROXIES[$1]:-}" ] || return 0; read -r p s <<<"${PROXIES[$1]}"; kill_exact "$p" "$s" TERM; unset "PROXIES[$1]"; }
proxy_stop_all() { local k; for k in "${!PROXIES[@]}"; do proxy_stop "$k"; done; }
# proxy_count NAME METHOD PATH_REGEX [STATUS]: logged calls that match.
proxy_count() {
  python3 -c '
import json, re, sys
log, m, rx, st = sys.argv[1:5]
n = 0
for l in open(log):
    try: r = json.loads(l)
    except ValueError: continue
    if r.get("method") == m and re.search(rx, r.get("path", "")) and (not st or str(r.get("status")) == st): n += 1
print(n)' "$RUN_DIR/$1.calls.jsonl" "$2" "$3" "${4:-}"
}
epoch_in() { echo $(( $(now) + $1 )); }

# ---------- approved repository changes, restored afterwards ----------
# Each change queues its undo in $RUN_DIR/restore before anything else runs;
# restore_run undoes them newest first (case end and the EXIT trap).
restore_push() { echo "$*" >>"$RUN_DIR/restore"; log "restore queued: $*"; }
restore_run() {
  [ -s "$RUN_DIR/restore" ] || return 0
  local line; tac "$RUN_DIR/restore" >"$RUN_DIR/restore.now"; : >"$RUN_DIR/restore"
  while read -r line; do log "restoring: $line"; eval "$line" || log "RESTORE FAILED: $line (undo it by hand)"; done <"$RUN_DIR/restore.now"
}

# ---------- templates ----------
# render NAME OUT [KEY=VALUE...]: fill {{KEY}} placeholders (SFX and RUN always).
render() {
  local tpl="$SUITE/objectives/$1.md" out=$2; shift 2
  python3 - "$tpl" "$out" "SFX=$SFX" "RUN=$RUN_ID" "FIXTURES=$SUITE/fixtures" "$@" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
for kv in sys.argv[3:]:
    k, v = kv.split("=", 1); text = text.replace("{{" + k + "}}", v)
left = re.findall(r"\{\{[A-Z0-9_]+\}\}", text)
if left: sys.exit(f"unfilled placeholders in {sys.argv[1]}: {sorted(set(left))}")
open(sys.argv[2], "w").write(text)
PY
}
# new_objective GROUP TEMPLATE TITLE [KEY=VALUE...] -> issue number (queued)
new_objective() {
  local g=$1 tpl=$2 title=$3; shift 3
  local f="$RUN_DIR/objectives/$g-$tpl-$(date +%H%M%S%N).md"
  mkdir -p "$RUN_DIR/objectives"
  render "$tpl" "$f" "$@" || return 1
  local n; n=$(gh_queue "Suite $RUN_ID: $title" "$f") || return 1
  echo "$n $g" >>"$RUN_DIR/issues"
  log "queued #$n ($g/$tpl)"
  echo "$n"
}
# new_issue GROUP TEMPLATE TITLE [KEY=VALUE...] -> issue number, filed but not
# queued (queue it with gh_enqueue once its number is used, e.g. in a proxy rule).
new_issue() {
  local g=$1 tpl=$2 title=$3; shift 3
  local f="$RUN_DIR/objectives/$g-$tpl-$(date +%H%M%S%N).md"
  mkdir -p "$RUN_DIR/objectives"
  render "$tpl" "$f" "$@" || return 1
  local n; n=$(gh issue create --repo "$REPO" --title "Suite $RUN_ID: $title" --body-file "$f" | grep -o '[0-9]*$') || return 1
  echo "$n $g" >>"$RUN_DIR/issues"
  log "filed #$n ($g/$tpl, not queued yet)"
  echo "$n"
}
# A short random identifier fragment for unique names per Objective.
uid() { python3 -c 'import random,string;print("Q"+"".join(random.choice(string.ascii_lowercase) for _ in range(4)))'; }

# ---------- cleanup of a group's Objectives ----------
# Cancel every Objective a group created that hasn't settled (needs a serve).
settle_group() {
  local g=$1 n gg open=()
  [ -s "$RUN_DIR/issues" ] || return 0
  while read -r n gg; do
    [ "$gg" = "$g" ] || continue
    case $(st status "$n") in done|cancelled|failed) ;; *) open+=("$n") ;; esac
  done <"$RUN_DIR/issues"
  [ ${#open[@]} -eq 0 ] && return 0
  [ -n "${KEEP:-}" ] && { log "--keep: leaving ${open[*]} as they are"; return 0; }
  log "cancelling unsettled Objectives of $g: ${open[*]}"
  serve_alive || serve_start || return 1
  for n in "${open[@]}"; do
    if [ "$(st status "$n")" = none ]; then gh_card "$n" Cancelled >/dev/null 2>&1; continue; fi
    cli cancel "$n" >/dev/null 2>&1
  done
  # A card cancelled while the serve admitted it (status read none just before) is a started run now: cancel it too.
  sleep 15; for n in "${open[@]}"; do case $(st status "$n") in none|done|cancelled|failed) ;; *) cli cancel "$n" >/dev/null 2>&1 ;; esac; done
  for n in "${open[@]}"; do wait_phase "$n" 'cancelled|done|failed|none' 300 >/dev/null; done
  sleep 20  # let the cancel comments and card writes land
  serve_stop
}
