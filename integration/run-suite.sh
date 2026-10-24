#!/bin/bash
# Factory integration tests: real GitHub, real providers, on demand.
#
#   run-suite.sh [--suite main|edge] [--build DIR] [--state-base DIR] [--only a,b] [--dry-run]
#
# One parallel wave: every case of the suite starts at once and runs
# concurrently. The suite enforces its own wall clock: at 55 min it stops
# starting anything, stops its cases, cancels unsettled Objectives, then runs
# cleanup and the report, so a run never passes 60 min.
# Results: .runs/results/<PDT timestamp>.md; exit 1 on any FAIL, 3 when it
# refuses to start (a serve already runs for a scratch repository), 2 on bad usage.
set -uo pipefail
SUITE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUILD=$(dirname "$SUITE"); SUITE_NAME=main; ONLY=""; DRY=""; STATE_BASE=""
M_REPO=clockgrove/factory-drill; C_REPO=clockgrove/factory-drill-2
PROJECT_ID=PVT_kwDOEvXlbc4BoR0S   # Project #7, "Factory drill" (cards of both repositories)
usage() { sed -n 2,11p "$0" | sed 's/^# \{0,1\}//'; exit 2; }
while [ $# -gt 0 ]; do
  case $1 in
    --suite) SUITE_NAME=${2:?}; shift 2 ;;
    --build) BUILD=$(realpath "${2:?}"); shift 2 ;;
    --state-base) STATE_BASE=$(realpath -m "${2:?}"); shift 2 ;;
    --only) ONLY=${2:?}; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

# Cases: NAME LANE MINUTES WHAT. Minutes are each case's expected duration from
# the wave's start; every case runs concurrently, so the wave takes the longest.
CASE_TABLE_main=(
  "codex|M|30|Codex end to end on a two-layer native stack under strict protection: plan, work, PRs, CI, review, merge, update-branch, report, done once (happy.codex, stack.strict); the provider child killed in planning and in work retries with error count 0 (model-kill.*); with #1878: a model-written 'fixes #N' closes nothing and a .github/ change the Objective doesn't name is refused (security.*)"
  "claude|M|25|Claude end to end through 'factory run N --provider claude', followed to done: every model call on claude, card Done (happy.claude, queue.run-command)"
  "holds|M|25|a planner question asked once and answered by /factory comment; answers that decide nothing until the planning allowance asks 'more', which sends the kept answer once; then cancelled cleanly (holds.*, queue.cancel-held)"
  "queue|M|8|admitted, then its card cleared during a slowed check: withdrawn, never planned (queue.withdraw)"
  "cancel|M|20|a lasting 403 on merge holds the step (fault.lasting-403); with #1879 a 404 on a PR read right after creation retries (fault.lag-404); cancel with the PR open: one cancel comment, PR closed, branch deleted, issue closed not planned (queue.cancel-open-pr)"
  "media|M|30|two candidate sets, 'repair' at select, new sets, a pick; the asset lands as Git LFS (media.select-repair)"
  "attach|M|8|with #1878: another repository's attachment URL holds before any token is sent (security.foreign-attachment)"
  "crash|C|40|factory-drill-2: one installation at a time (holder.second-refused, take-over, release, restart); sampled crash points armed one at a time across live Objectives: plan:post, deliver:push, deliver:pr-create, deliver:merge, report:comment, report:close, sync:remind and sync:cancel, before and after (crash.*): every Objective done or cancelled once with no duplicate; two 60 s network cuts, no hold (netcut.*)"
)
CASE_TABLE_edge=(
  "reset|E|30|factory-drill: a delivered and a mid-build Objective rebuilt from GitHub by 'factory reset' on a clean state directory: the delivered one stays done with nothing new posted, the mid-build one finishes once (reset.delivered, reset.mid-build)"
  "archived|E|10|factory-drill: 'factory run N' on an issue whose Project card is archived admits it (queue.archived-card)"
)
case "$SUITE_NAME" in main|edge) ;; *) echo "unknown suite: $SUITE_NAME (main, edge)" >&2; exit 2 ;; esac
declare -n TABLE="CASE_TABLE_$SUITE_NAME"
SEL=()
for row in "${TABLE[@]}"; do IFS='|' read -r c _ _ _ <<<"$row"; [ -n "$ONLY" ] && [[ ",$ONLY," != *",$c,"* ]] && continue; SEL+=("$row"); done
[ ${#SEL[@]} -gt 0 ] || { echo "no cases selected" >&2; exit 2; }

RUN_ID=$(TZ=America/Los_Angeles date +%Y-%m-%dT%H%M%S%Z); SFX=$(TZ=America/Los_Angeles date +%m%d%H%M)
RUNS=$SUITE/.runs; mkdir -p "$RUNS/results"
STATE_BASE=${STATE_BASE:-$HOME/work/suite60-state-$SFX}
START_S=$(date +%s); STOP_AT=$(( START_S + 55 * 60 ))
if [ -n "$DRY" ]; then RUN_DIR=$(mktemp -d "$RUNS/.dry.XXXX"); else RUN_DIR="$RUNS/$RUN_ID"; mkdir -p "$RUN_DIR"; fi
mkdir -p "$RUN_DIR/answered"; : >"$RUN_DIR/results.tsv"; : >"$RUN_DIR/pids"; : >"$RUN_DIR/issues"; : >"$RUN_DIR/cases.tsv"
source "$SUITE/lib/common.sh"; source "$SUITE/lib/gh.sh"; source "$SUITE/lib/serve.sh"
source "$SUITE/cases/main.sh"; source "$SUITE/cases/crash.sh"; source "$SUITE/cases/edge.sh"
commit=$(git -C "$BUILD" log -1 --format='%h %s' 2>/dev/null | cut -c1-80)

budget() {
  echo "Budget (wall clock from the start):"
  echo "  setup: build check, fresh state dirs, configs, clones, scratch repo checks   <= 5 min"
  local w=0 row c lane mins what
  for row in "${SEL[@]}"; do IFS='|' read -r c lane mins what <<<"$row"; [ "$mins" -gt "$w" ] && w=$mins; done
  echo "  wave: ${#SEL[@]} case(s) at once; the longest expects $w min                <= 45 min (hard stop at 55)"
  echo "  end: cancel what is left, end checks, cleanup, report                       <= 5 min"
  echo "  expected total: ~$(( w + 9 )) min (limit 60)"
}
if [ -n "$DRY" ]; then
  echo "DRY RUN ($SUITE_NAME): nothing is started, queued or written."
  echo "Build: $BUILD ($commit)"; echo "State: $STATE_BASE (fresh per run)"; echo
  for row in "${SEL[@]}"; do IFS='|' read -r c lane mins what <<<"$row"; printf '%-8s lane %s  ~%2s min  %s\n' "$c" "$lane" "$mins" "$what"; done
  echo; budget
  rm -rf "$RUN_DIR"; exit 0
fi
[ -f "$BUILD/core/dist/cli.js" ] || { echo "no CLI at $BUILD/core/dist/cli.js (npm run build:core)" >&2; exit 2; }

# ---------- configuration ----------
# Plumbing runs on the fastest model and lowest effort each provider offers;
# `codex-plan` keeps the production planner, for the cases whose check is a
# planner decision (it must ask its question).
write_config() { # FILE REPO CHECKOUT MAX_ACTIVE [PY_EXPR...]
  local f=$1; shift
  python3 - "$f" "$@" <<'PY'
import json, sys
f, repo, checkout, active, *more = sys.argv[1:]
fast = {"model": "gpt-6-luna", "effort": "low", "serviceTier": "fast"}
haiku = {"model": "claude-haiku-5-5", "effort": "low"}
c = {
  "repository": repo, "checkout": checkout,
  "queue": {"projectId": "PVT_kwDOEvXlbc4BoR0S", "pollSeconds": 15, "maxActiveObjectives": int(active)},
  "execution": {"concurrency": 4, "workers": 12, "validations": 6},
  "providers": {
    "codex": {"planner": "codex", "models": {"planner": fast, "reviewer": fast}, "worker": {"kind": "codex", **fast}},
    "codex-plan": {"planner": "codex", "models": {"reviewer": fast, "planner": {"model": "gpt-6.1-sol", "effort": "high"}}, "worker": {"kind": "codex", **fast}},
    "claude": {"planner": "claude", "models": {"planner": haiku, "reviewer": haiku}, "worker": {"kind": "claude", **haiku}},
  },
  "defaultProvider": "codex",
}
for e in more: exec(e, {"c": c})
json.dump(c, open(f, "w"), indent=2)
PY
}
clone() { # REPO DIR
  [ -d "$2/.git" ] || git clone -q "https://github.com/$1.git" "$2" || return 1
  git -C "$2" lfs install --local >/dev/null 2>&1; git -C "$2" fetch -q origin
}

# ---------- the end: results, cleanup ----------
FINISHED=""
write_results() {
  local out="$RUNS/results/$RUN_ID.md" end_s; end_s=$(date +%s)
  local tot; tot=$(awk -F'\t' '{print $4}' "$RUN_DIR/results.tsv" | sort | uniq -c | awk '{printf "%s %s, ", $1, $2}')
  {
    echo "# Integration run $RUN_ID ($SUITE_NAME)"; echo
    echo "Wall time: **$(( (end_s - START_S) / 60 )) min $(( (end_s - START_S) % 60 )) s** (limit 60), from $(TZ=America/Los_Angeles date -d @"$START_S" '+%-I:%M %p') to $(TZ=America/Los_Angeles date -d @"$end_s" '+%-I:%M %p') PDT${INTERRUPTED:+. **Interrupted**}."; echo
    echo "- Build: $BUILD ($commit)"; echo "- State: $STATE_BASE"; echo "- Run dir: $RUN_DIR"; echo
    echo "**Totals:** ${tot%, }."; echo
    echo "## Cases"; echo; echo "| Case | Lane | Started | Ended | Duration |"; echo "|---|---|---|---|---|"
    awk -F'\t' '{d=$4-$3; printf "| %s | %s | +%dm%02ds | +%dm%02ds | %dm %02ds |\n", $1, $2, $3/60, $3%60, $4/60, $4%60, d/60, d%60}' "$RUN_DIR/cases.tsv"
    echo; echo "## Checks"; echo; echo "| Check | Case | Result | Evidence | Duration |"; echo "|---|---|---|---|---|"
    awk -F'\t' '{gsub(/\|/,"\\|",$5); d=$6+0; printf "| %s | %s | %s | %s | %dm %02ds |\n", $1, $2, ($4=="FAIL"?"**FAIL**":$4), $5, d/60, d%60}' "$RUN_DIR/results.tsv"
    [ -s "$RUN_DIR/issues" ] && { echo; echo "Objectives: $(awk '{printf "%s#%s (%s) ", ($3=="C"||$3=="H")?"drill-2 ":"", $1, $2}' "$RUN_DIR/issues")"; }
  } >"$out"
  echo "results: $out" >&2
}
CASE_PIDS=()
stop_cases() {
  touch "$RUN_DIR/stop"
  local p s i; for i in $(seq 1 45); do local alive=0; for p in "${CASE_PIDS[@]}"; do kill -0 "${p%% *}" 2>/dev/null && alive=1; done; [ $alive = 0 ] && break; sleep 1; done
  for p in "${CASE_PIDS[@]}"; do read -r p s <<<"$p"; same_proc "$p" "$s" && { log "stopping case process $p"; : >"$RUN_DIR/desc.case"; snap_desc "$p" "$RUN_DIR/desc.case"; kill_exact "$p" "$s" TERM; kill_desc_survivors "$RUN_DIR/desc.case"; }; done
}
# Cancel every unsettled Objective of the run (each installation's serve must run).
cancel_left() {
  local n c i any=""
  while read -r n c i; do
    [ "$i" = H ] && continue
    inst "$i"
    case $(st status "$n") in done|cancelled|failed) ;; none) gh_card "$n" Cancelled >/dev/null 2>&1; gh issue close "$n" --repo "$REPO" --reason "not planned" >/dev/null 2>&1 ;; *) cli_t 60 cancel "$n" >/dev/null 2>&1; any="$any $i:$n" ;; esac
  done <"$RUN_DIR/issues"
  [ -n "$any" ] || return 0
  log "cancelled at the end:$any"
  local end=$(( $(date +%s) + 150 )) left
  while [ "$(date +%s)" -lt "$end" ]; do
    left=""; for x in $any; do inst "${x%%:*}"; cancelled_clean "${x#*:}" || settled "${x#*:}" || left="$left $x"; done
    [ -z "$left" ] && break; sleep 5
  done
}
end_state() {
  local CASE=suite t0; t0=$(date +%s)
  inst M
  local nm; nm=$(gh api "repos/$M_REPO" --jq .name 2>/dev/null)
  local rv; rv=$(gh_human_gate); [ -e "$RUN_DIR/gate-on" ] && gate_off
  local open; open=$( { gh pr list -R "$M_REPO" --state open --json number --jq '.[].number'; gh pr list -R "$C_REPO" --state open --json number --jq '.[].number' | sed 's/^/drill-2#/'; } | paste -sd' ')
  local serves; serves=$( { running_serves "$M_REPO"; running_serves "$C_REPO"; } | wc -l)
  local units; units=$(systemctl --user list-units --all --no-legend 'factory-*' 2>/dev/null | wc -l)
  [ "$nm" = factory-drill ] && [ "$(gh_human_gate)" = false ] && [ -z "$open" ] && [ "$serves" = 0 ] && [ "$units" = 0 ]
  rec_if suite.end-state $? "factory-drill named '$nm'; review gate $(gh_human_gate) (was $rv); open PRs [${open}]; serves left $serves; factory units $units" "$t0"
}
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  [ -n "$FINISHED" ] && exit $code
  FINISHED=1
  stop_cases
  # Serves up for the cancellations, then down.
  inst C; SERVE_DIR=$(serve_dir_of C); if [ -n "$SERVE_DIR" ] && ! serve_alive && grep -q ' C$' "$RUN_DIR/issues"; then serve_up "" netns; fi
  cancel_left
  local i; for i in C H M E; do [ -d "$RUN_DIR/inst/$i" ] || continue; inst $i; SERVE_DIR=$(serve_dir_of $i); serve_down; done
  for i in M E; do proxy_stop $i; done
  local p s; while read -r p s; do same_proc "$p" "$s" && kill -TERM "$p" 2>/dev/null; done <"$RUN_DIR/pids"
  end_state
  write_results
  grep -q $'\tFAIL\t' "$RUN_DIR/results.tsv" && exit 1
  exit $code
}

# ---------- setup ----------
log "suite $SUITE_NAME, build $BUILD ($commit), state $STATE_BASE"
for r in $M_REPO $C_REPO; do s=$(running_serves "$r"); [ -n "$s" ] && { echo "refused: a serve runs for $r: $s" >&2; exit 3; }; done
trap 'INTERRUPTED=1; exit 130' INT TERM
trap cleanup EXIT
rm -rf "$STATE_BASE"; mkdir -p "$STATE_BASE"
SETUP0=$(date +%s)
setup_main() {
  clone $M_REPO "$STATE_BASE/checkout-m" & clone $C_REPO "$STATE_BASE/checkout-c" & wait
  write_config "$STATE_BASE/config-m.json" $M_REPO "$STATE_BASE/checkout-m" 12 'c["delivery"]={"kind":"native-stack"}' 'c.setdefault("autonomy",{})["allowances"]={"planningRevisions":2}'
  write_config "$STATE_BASE/config-c.json" $C_REPO "$STATE_BASE/checkout-c" 8
  inst_define M $M_REPO "$STATE_BASE/config-m.json"
  inst_define C $C_REPO "$STATE_BASE/config-c.json"
  inst_define H $C_REPO "$STATE_BASE/config-c.json"
  # factory-drill-2 starts from factory-drill's main when it is empty.
  if ! gh api "repos/$C_REPO/contents/package.json" >/dev/null 2>&1; then
    log "seeding $C_REPO from $M_REPO main"
    (cd "$STATE_BASE/checkout-m" && git lfs fetch --all -q origin && git push -q "https://github.com/$C_REPO.git" origin/main:refs/heads/main \
      && git -c lfs.allowincompletepush=true lfs push --all "https://github.com/$C_REPO.git" >/dev/null 2>&1)
    (cd "$STATE_BASE/checkout-c" && git fetch -q origin && git checkout -q -B main origin/main)
  fi
  # A holder record a crashed earlier run left would refuse this run's fresh installations.
  local r; for r in $M_REPO $C_REPO; do
    [ -n "$(git ls-remote "https://github.com/$r.git" refs/factory/holder 2>/dev/null)" ] && { log "removing $r's leftover holder record"; git -C "$STATE_BASE/checkout-m" push -q "https://github.com/$r.git" :refs/factory/holder; }
  done
  inst M
  [ "$(gh_human_gate)" = true ] && gate_off
  local open; open=$(gh pr list -R $M_REPO --state open --json number --jq length)
  [ "$open" = 0 ] || log "note: $M_REPO has $open open PRs at the start"
  # M: one serve for the whole wave, behind the fault proxy.
  proxy_start M 18611
  printf '%s\n' "FACTORY_GITHUB_API=$PROXY_URL" "FACTORY_BACKOFF_MS=10000" "FACTORY_DISPLAY_TIMEZONE=America/Los_Angeles" >"$RUN_DIR/inst/M/extra_env"
  printf '%s\n' "FACTORY_BACKOFF_MS=5000" "FACTORY_REMIND_MS=120000" "FACTORY_DISPLAY_TIMEZONE=America/Los_Angeles" >"$RUN_DIR/inst/C/extra_env"
  cp "$RUN_DIR/inst/C/extra_env" "$RUN_DIR/inst/H/extra_env"
  serve_up || return 1
}
if [ "$SUITE_NAME" = main ]; then setup_main || { log "setup failed"; exit 1; }
else setup_edge || { log "setup failed"; exit 1; }; fi
record_setup() { local CASE=suite; record suite.setup PASS "setup took $(( $(date +%s) - SETUP0 )) s" "$SETUP0"; }; record_setup

# ---------- the wave ----------
run_case() { # NAME LANE
  local c=$1 lane=$2 t0; t0=$(( $(date +%s) - START_S ))
  ( CASE=$c
    case $lane in M) inst M; SERVE_DIR=$(serve_dir_of M); case_$c ;; C) lane_c ;; E) inst E; SERVE_DIR=$(serve_dir_of E); case_$c ;; esac
    [ "$lane" = C ] || case_settle
    printf '%s\t%s\t%s\t%s\n' "$c" "$lane" "$t0" "$(( $(date +%s) - START_S ))" >>"$RUN_DIR/cases.tsv"
  ) &
  local p=$!; CASE_PIDS+=("$p $(starttime $p)")
}
for row in "${SEL[@]}"; do IFS='|' read -r c lane _ _ <<<"$row"; run_case "$c" "$lane"; done
log "wave: ${#SEL[@]} cases started; hard stop at $(TZ=America/Los_Angeles date -d @"$STOP_AT" '+%-I:%M %p')"
# Supervise: the shared serve stays up (a death is a finding, and it restarts); stop at 55 min.
SUP=""; [ "$SUITE_NAME" = main ] && SUP=M || SUP=E
while :; do
  alive=0; for p in "${CASE_PIDS[@]}"; do kill -0 "${p%% *}" 2>/dev/null && alive=1; done
  [ $alive = 0 ] && break
  [ "$(date +%s)" -ge "$STOP_AT" ] && { log "55 min: stopping the wave"; break; }
  inst $SUP; SERVE_DIR=$(serve_dir_of $SUP)
  if [ -n "$SERVE_DIR" ]; then
    serve_tick
    if serve_exited; then
      ( CASE=suite; record "suite.serve-$SUP" FAIL "the shared serve exited $(cat "$SERVE_DIR/exit"): $(tail -c 400 "$SERVE_DIR/out.log" | tr '\n' ' ')" "$START_S" )
      serve_up || true
    fi
  fi
  sleep 5
done
exit 0
