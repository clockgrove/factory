#!/bin/bash
# Factory integration tests: on demand, one entry point for every group.
#
#   run-suite.sh [--only a,b] [--skip a,b] [--build DIR] [--state DIR]
#                [--config FILE] [--repo OWNER/NAME] [--dry-run] [--approved-long]
#                [--local-only] [--no-model] [--keep] [--allow-repo-changes]
#
# Groups: queue plan exec stack media crash-points netcut model-kill
#         bounded-cost knowledge stability holds operator followups reset
#         providers recheck tracking bounded1 bounded2 bounded3
# See README.md. A plan expected to take over 60 min needs --approved-long.
# Results: .runs/results/<PDT timestamp>.md; exit 1 on any FAIL, 3 when
# refused (a serve is running, or a long plan without approval), 2 on bad usage.
set -uo pipefail
SUITE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ALL_GROUPS="queue plan exec stack media crash-points netcut model-kill bounded-cost knowledge stability holds operator followups reset providers recheck tracking bounded1 bounded2 bounded3"
LOCAL_GROUPS="knowledge"
LONG_MINUTES=60

RUNS=$SUITE/.runs
BUILD=$(dirname "$SUITE")
STATE=$RUNS/state
REPO=clockgrove/factory-drill
CONFIG=""; ONLY=""; SKIP=""; DRY=""; LOCAL_ONLY=""; NO_MODEL=""; KEEP=""; ALLOW_REPO_CHANGES=""; APPROVED_LONG=""
usage() { sed -n 2,14p "$0" | sed 's/^# \{0,1\}//'; exit 2; }
while [ $# -gt 0 ]; do
  case $1 in
    --only) ONLY=${2:?}; shift 2 ;;
    --skip) SKIP=${2:?}; shift 2 ;;
    --build) BUILD=$(realpath "${2:?}"); shift 2 ;;
    --state) STATE=$(realpath -m "${2:?}"); shift 2 ;;
    --config) CONFIG=$(realpath "${2:?}"); shift 2 ;;
    --repo) REPO=${2:?}; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --approved-long) APPROVED_LONG=1; shift ;;
    --local-only) LOCAL_ONLY=1; shift ;;
    --no-model) NO_MODEL=1; shift ;;
    --keep) KEEP=1; shift ;;
    --allow-repo-changes) ALLOW_REPO_CHANGES=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done
OWNER=${REPO%%/*}; NAME=${REPO#*/}
CONFIG=${CONFIG:-$HOME/.config/factory/$(echo "$REPO" | tr 'A-Z' 'a-z' | sed 's#/#__#').json}
ROOT="$STATE/$(echo "$REPO" | tr 'A-Z' 'a-z' | sed 's#/#__#')"
export LOCAL_ONLY NO_MODEL KEEP ALLOW_REPO_CHANGES

[ -f "$BUILD/core/dist/cli.js" ] || { echo "no CLI at $BUILD/core/dist/cli.js (build it with npm run build:core)" >&2; exit 2; }
if [ -f "$CONFIG" ]; then
  cfg_repo=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("repository",""))' "$CONFIG")
  [ "${cfg_repo,,}" = "${REPO,,}" ] || { echo "config $CONFIG is for '$cfg_repo', not $REPO" >&2; exit 2; }
elif [ -z "$DRY" ]; then echo "no config at $CONFIG (pass --config)" >&2; exit 2; fi

# Group selection, in suite order.
GROUPS_SEL=()
for g in $ALL_GROUPS; do
  [ -n "$ONLY" ] && [[ ",$ONLY," != *",$g,"* ]] && continue
  [[ ",$SKIP," == *",$g,"* ]] && continue
  GROUPS_SEL+=("$g")
done
for g in ${ONLY//,/ } ${SKIP//,/ }; do [[ " $ALL_GROUPS " == *" $g "* ]] || { echo "unknown group: $g" >&2; exit 2; }; done
[ ${#GROUPS_SEL[@]} -gt 0 ] || { echo "no groups selected" >&2; exit 2; }
# Expected minutes of a group (its _minutes), 0 when --local-only skips it.
group_minutes() {
  if [ -n "$LOCAL_ONLY" ] && [[ " $LOCAL_GROUPS " != *" $1 "* ]]; then echo 0; else "$(fn "$1" minutes)"; fi
}

RUN_ID=$(TZ=America/Los_Angeles date +%Y-%m-%dT%H%M%S%Z)
SFX=$(TZ=America/Los_Angeles date +%m%d%H%M)
mkdir -p "$RUNS"
if [ -n "$DRY" ]; then RUN_DIR=$(mktemp -d "$RUNS/.dry.XXXX"); else RUN_DIR="$RUNS/$RUN_ID"; mkdir -p "$RUN_DIR"; fi
BASE_CFG="$RUN_DIR/config.json"; CUR_CFG=$BASE_CFG
if [ -f "$CONFIG" ]; then cp "$CONFIG" "$BASE_CFG"; else printf '{"repository": "%s"}\n' "$REPO" >"$BASE_CFG"; fi
: >"$RUN_DIR/results.tsv"; : >"$RUN_DIR/pids"
source "$SUITE/lib/common.sh"
source "$SUITE/lib/gh.sh"
for g in $ALL_GROUPS; do source "$SUITE/groups/$g.sh"; done
fn() { echo "${1//-/_}_$2"; }
has_fn() { declare -F "$1" >/dev/null; }
TOTAL_MIN=0; for g in "${GROUPS_SEL[@]}"; do TOTAL_MIN=$(( TOTAL_MIN + $(group_minutes "$g") )); done

commit=$(git -C "$BUILD" log -1 --format='%h %s' 2>/dev/null | cut -c1-80)
header() {
  echo "Build:  $BUILD ($commit)"
  echo "State:  $STATE"
  if [ -f "$CONFIG" ]; then echo "Config: $CONFIG -> scratch copy $BASE_CFG (FACTORY_CONFIG; the source is never written)"
  else echo "Config: MISSING at $CONFIG (a real run needs it; pass --config)"; fi
  echo "Repo:   $REPO"
  echo "Groups: ${GROUPS_SEL[*]}${LOCAL_ONLY:+ (local-only)}${NO_MODEL:+ (no model calls)}"
  if [ -n "$ALLOW_REPO_CHANGES" ]; then echo "Repo changes: ALLOWED (human gate, strict protection, scratch repo, rename; each restored)"
  else echo "Repo changes: off (cases that need them are UNREACHABLE: needs approval)"; fi
  echo "Answers: $(has_feature holds-v2 && echo 'bound (--question ID)' || echo 'unbound (older build)')"
  echo "Expected: ~$TOTAL_MIN min$( [ "$TOTAL_MIN" -gt "$LONG_MINUTES" ] && { [ -n "$APPROVED_LONG" ] && echo " (over $LONG_MINUTES min: approved with --approved-long)" || echo " (over $LONG_MINUTES min: needs the maintainer's approval and --approved-long)"; })"
}

# ---------- dry run ----------
if [ -n "$DRY" ]; then
  echo "DRY RUN: nothing is started, queued or written."; header
  serves=$(running_serves); owner=$(state_owner)
  if [ -n "$serves$owner" ]; then echo "Guard:  a real run would REFUSE now:"; [ -n "$serves" ] && sed 's/^/          /' <<<"$serves"; [ -n "$owner" ] && echo "          service.json pid $owner owns $ROOT"
  else echo "Guard:  no serve for $REPO is running"; fi
  for g in "${GROUPS_SEL[@]}"; do
    echo; echo "== $g"
    if [ -n "$LOCAL_ONLY" ] && [[ " $LOCAL_GROUPS " != *" $g "* ]]; then echo "   (skipped: no local-only parts)"; continue; fi
    echo "   expect: ~$(group_minutes "$g") min"
    echo "   needs:  $($(fn "$g" needs))"
    echo "   cost:   $($(fn "$g" cost))"
    $(fn "$g" plan) | sed 's/^/   /'
  done
  echo; echo "Total: ~$TOTAL_MIN min over ${#GROUPS_SEL[@]} group(s)."
  if [ "$TOTAL_MIN" -gt "$LONG_MINUTES" ] && [ -z "$APPROVED_LONG" ]; then echo "A real run of this plan would REFUSE: over $LONG_MINUTES min needs the maintainer's approval, then --approved-long."; fi
  rm -rf "$RUN_DIR"; exit 0
fi
if [ "$TOTAL_MIN" -gt "$LONG_MINUTES" ] && [ -z "$APPROVED_LONG" ]; then
  echo "refused: this plan is expected to take ~$TOTAL_MIN min (${GROUPS_SEL[*]}). Over $LONG_MINUTES min needs the maintainer's approval; then pass --approved-long, or pick fewer groups with --only." >&2
  rm -rf "$RUN_DIR"; exit 3
fi

# ---------- real run ----------
STARTED=$(ts); START_S=$(now); CUR_GROUP=""; FINISHED=""
write_results() {
  [ -n "$FINISHED" ] && return; FINISHED=1
  mkdir -p "$RUNS/results"; local out="$RUNS/results/$RUN_ID.md" pass fail unr
  pass=$(awk -F'\t' '$3=="PASS"' "$RUN_DIR/results.tsv" | wc -l); fail=$(awk -F'\t' '$3=="FAIL"' "$RUN_DIR/results.tsv" | wc -l)
  unr=$(awk -F'\t' '$3=="UNREACHABLE"' "$RUN_DIR/results.tsv" | wc -l)
  # PARKED: needs an API key (managed providers); BLOCKED-BY-DEFECT: a confirmed Factory defect stops it. Neither counts against a gate.
  local park blk; park=$(awk -F'\t' '$3=="PARKED"' "$RUN_DIR/results.tsv" | wc -l); blk=$(awk -F'\t' '$3=="BLOCKED-BY-DEFECT"' "$RUN_DIR/results.tsv" | wc -l)
  {
    echo "# Integration run $RUN_ID"; echo
    echo "Started $STARTED, ended $(ts) PDT ($(( ($(now) - START_S) / 60 )) min)${INTERRUPTED:+. **Interrupted** during $CUR_GROUP}."; echo
    header | sed 's/^/- /'; echo "- Run dir (serve logs, scratch configs, Objective bodies): $RUN_DIR"; echo
    echo "**Totals:** $pass PASS, $fail FAIL, $unr UNREACHABLE, $park PARKED, $blk BLOCKED-BY-DEFECT."; echo
    echo "| Check | Group | Result | Evidence | Duration |"; echo "|---|---|---|---|---|"
    awk -F'\t' '{gsub(/\|/,"\\|",$4); d=$5+0; printf "| %s | %s | %s | %s | %dm %02ds |\n", $1, $2, ($3=="FAIL"?"**FAIL**":$3), $4, d/60, d%60}' "$RUN_DIR/results.tsv"
    if [ -s "$RUN_DIR/issues" ]; then echo; echo "Objectives created: $(awk '{printf "#%s (%s) ", $1, $2}' "$RUN_DIR/issues")"; fi
  } >"$out"
  echo "results: $out" >&2
}
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  [ -n "${INTERRUPTED:-}" ] && log "interrupted: cleaning up"
  # Results first, so a cleanup that hangs or is killed still leaves them.
  write_results; FINISHED=""
  serve_stop 2>/dev/null
  netcut_stop 2>/dev/null; bounded_cost_stop_proxy 2>/dev/null; stab_stop_proxy 2>/dev/null; fu_stop_proxy 2>/dev/null; proxy_stop_all 2>/dev/null; fu_stop_connect 2>/dev/null
  [ -n "$CUR_GROUP" ] && settle_group "$CUR_GROUP" 2>/dev/null
  serve_stop 2>/dev/null
  restore_run
  # Anything else this run started, by exact PID and start time.
  local p s; while read -r p s; do same_proc "$p" "$s" && { kill -TERM "$p" 2>/dev/null; sleep 1; same_proc "$p" "$s" && kill -KILL "$p" 2>/dev/null; }; done <"$RUN_DIR/pids"
  CUR_CFG=$BASE_CFG
  write_results
  exit $code
}
trap 'INTERRUPTED=1; exit 130' INT TERM
trap cleanup EXIT

header | tee "$RUN_DIR/header" >&2
if [ -z "$LOCAL_ONLY" ]; then guard_serve || { FINISHED=1; exit 3; }
else owner=$(state_owner); [ -n "$owner" ] && { log "refused: service.json pid $owner owns $ROOT"; FINISHED=1; exit 3; }; fi
mkdir -p "$STATE"

for g in "${GROUPS_SEL[@]}"; do
  if [ -n "$LOCAL_ONLY" ] && [[ " $LOCAL_GROUPS " != *" $g "* ]]; then log "skip $g: no local-only parts"; continue; fi
  CUR_GROUP=$g; SERVE_DIR=""
  cfg_for_group "$g"
  has_fn "$(fn "$g" cfg)" && $(fn "$g" cfg)
  log "== group $g (config $CUR_CFG)"
  $(fn "$g" run)
  serve_stop
  [ -z "$LOCAL_ONLY" ] && settle_group "$g"
  restore_run; proxy_stop_all
  CUR_CFG=$BASE_CFG; CUR_GROUP=""
done
write_results
grep -q $'\tFAIL\t' "$RUN_DIR/results.tsv" && exit 1
exit 0
