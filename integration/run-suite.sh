#!/bin/bash
# Factory integration tests: real GitHub, real providers, on demand.
#
#   run-suite.sh [--suite main|edge|prd] [--provider codex|claude] [--build DIR] [--state-base DIR] [--only a,b] [--capture] [--keep-repos] [--dry-run]
#   run-suite.sh --replay RUN_ID [--suite S] [--only a,b]
#
# --replay re-evaluates a kept run's replayable checks with this checkout's code
# over that run's state, logs and run files: nothing live, a new results file.
#
# --provider (default codex) is the provider every case runs on; the claude
# case, the cross-provider one, runs 'factory run N --provider' with the other.
# Each run creates its own private repositories under REPO_OWNER from
# fixtures/baseline/ and deletes them when it passes (a failed run keeps them
# for inspection; --keep-repos always does; later runs sweep them after 24 h).
# --capture records every model call's body for diagnosis (config capture):
# the run's state dir then holds prompts and answers, so keep it private.
# Factory runs as a GitHub App: FACTORY_SUITE_APP_ID and FACTORY_SUITE_APP_KEY
# (a key file) in the environment name it, with the gh login as operator.
# Without them a run stops at setup, unless FACTORY_SUITE_GITHUB_LOGIN=1 opts
# out: Factory then acts as the gh login (setup --github-login).
#
# One parallel wave: every case of the suite starts at once and runs
# concurrently, each within its own budget (the cases table's minutes). The
# suite enforces its own wall clock: at 55 min it stops
# starting anything, stops its cases, cancels unsettled Objectives, then runs
# cleanup and the report, so a run never passes 60 min.
# Results: /tmp/factory-integration-runs/results/<run id>.md; exit 1 on any FAIL, 3 when it
# refuses to start (no GitHub identity, or a serve already runs for a scratch
# repository), 2 on bad usage.
set -uo pipefail
{   # One block, parsed whole before it runs: an edit to this file can't change a running suite.
SUITE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUILD=$(dirname "$SUITE"); SUITE_NAME=main; PROVIDER=codex; ONLY=""; DRY=""; STATE_BASE=""; CAPTURE=""; KEEP_REPOS=""; REPLAY=""; KEPT=""
REPO_OWNER=clockgrove   # each run's repositories, and a Project for each, are made here (lib/repos.sh)
usage() { sed -n 2,29p "$0" | sed 's/^# \{0,1\}//'; exit 2; }
while [ $# -gt 0 ]; do
  case $1 in
    --suite) SUITE_NAME=${2:?}; shift 2 ;;
    --provider) PROVIDER=${2:?}; shift 2 ;;
    --build) BUILD=$(realpath "${2:?}"); shift 2 ;;
    --state-base) STATE_BASE=$(realpath -m "${2:?}"); shift 2 ;;
    --only) ONLY=${2:?}; shift 2 ;;
    --capture) CAPTURE=1; shift ;;
    --keep-repos) KEEP_REPOS=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --replay) REPLAY=${2:?}; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done
# The chosen provider's -plan variant asks the planner questions; the cross-provider case runs on the other one.
case "$PROVIDER" in codex) OTHER_PROVIDER=claude ;; claude) OTHER_PROVIDER=codex ;; *) echo "unknown provider: $PROVIDER (codex, claude)" >&2; exit 2 ;; esac
PLAN_PROVIDER=$PROVIDER-plan

# Cases: NAME LANE MINUTES WHAT. Minutes are each case's budget: its deadline is
# its start plus these minutes, never past the wave's stop, and every wait in
# the case ends there. Every case runs concurrently, so the wave takes the longest.
CASE_TABLE_main=(
  "codex|M|30|${PROVIDER^} end to end on a two-layer native stack under strict protection: plan, work, PRs, CI, review, merge, update-branch, report, done once (happy.codex, stack.strict); the provider child killed in planning and in work retries with error count 0 (model-kill.*); a closing phrase in actual PR text closes no decoy issue (security.fixes-keyword)"
  "claude|M|25|${OTHER_PROVIDER^} end to end through 'factory run N --provider $OTHER_PROVIDER', followed to done: every model call on $OTHER_PROVIDER, card Done (happy.claude, queue.run-command)"
  "holds|M|25|a planner question asked once and answered by /factory comment; answers that decide nothing until the planning allowance asks 'more', which sends the kept answer once; then cancelled cleanly (holds.*, queue.cancel-held)"
  "queue|M|8|admitted, then its card cleared during a slowed check: withdrawn, never planned (queue.withdraw)"
  "cancel|M|20|a lasting 403 on merge holds the step (fault.lasting-403); with #1879 a 404 on a PR read right after creation retries (fault.lag-404); cancel with the PR open: one cancel comment, PR closed, branch deleted, issue closed not planned (queue.cancel-open-pr)"
  "media|M|30|two candidate sets, 'repair' at select, new sets, a pick; the asset lands as Git LFS (media.select-repair)"
  "attach|M|8|with #1878: another repository's attachment URL holds before any token is sent (security.foreign-attachment)"
  "crash|C|40|repository C: one installation at a time (holder.second-refused, take-over, release, restart); a second installation on repository M's Project is refused (holder.project-refused); sampled crash points armed one at a time across live Objectives: plan:post, deliver:push, deliver:pr-create, deliver:merge, report:comment, report:close, sync:remind and sync:cancel, before and after (crash.*): every Objective done or cancelled once with no duplicate; two 60 s network cuts, no hold (netcut.*)"
)
CASE_TABLE_edge=(
  "reset|E|30|repository M: a delivered and a mid-build Objective (its PR open) lose their state and work files; 'factory reset' rebuilds each from GitHub: the delivered one stays done with no new PR or marker, the mid-build one runs plan review and finishes on its one PR (reset.clean-dir)"
  "archived|E|10|repository M: 'factory run N' on an issue whose Project card is archived admits it (queue.archived-card)"
  "flake|E|30|its own repository F, whose required 'test' job fails on a pull request's first attempt only: Factory reruns the failed job once, it passes on attempt 2, the PR merges with no repair, and the run log and report record the flake (delivery.ci-rerun, #2054)"
  "threads|E|30|its own repository R, whose default-branch ruleset requires review threads resolved: a line comment the suite posts on Factory's open PR holds within 10 min, naming the thread; resolved and answered retry, the PR merges (holds.review-threads, #2053)"
)
CASE_TABLE_prd=(
  "propose|P|15|factory propose from an intent and from a roadmap section; an approved draft creates its issues once, with blocked-by links (propose.*)"
  "recheck|P|25|a failed check names a missing Source; after the issue is fixed, 'recheck' plans, and no plan validates with the CI-only command the Objective asks for (toolchain.ci-only, intake.recheck)"
  "outsider|P|15|an Objective github-actions[bot] filed waits for a writer's approve; the bot's own /factory approve is ignored; an edit after approval asks again (intake.non-writer)"
  "amend|P|30|an operator's amendment is planned and reviewed; an edit after planning holds and 'replan' plans again (plan.amendment, plan.replan)"
  "discovery|P|35|drained until its plan is accepted, then a person's test on main needs a file no Work Item owns: the worker's required in-scope discovery becomes an amendment and is reviewed (plan.discovery)"
  "scope|P|40|the base item's merge refused: it holds, the independent item merges, the dependent never starts; retry finishes it (holds.item-scope*)"
  "paths|P|40|two Objectives owning the same file take turns (queue.paths-take-turns)"
  "shared|P|30|a person's change to the same file lands on main while Factory's PR is open: repaired, merged, the person's commit kept (delivery.shared-main)"
  "hostnet|P|25|sandbox.network host: final validation reaches a service on the host's loopback (worker.host-network)"
  "toolchain|P|25|its own repository T pins Node (.nvmrc) and pnpm (packageManager), and installation T requires 'pnpm run toolchain': a host node outside the pin holds the plan check, naming the fix; after a person pins the host's node, 'recheck' plans, and final validation runs the command under that pin and manager (toolchain.pin)"
  "seam|P|40|the production planner's plan of 19 criteria, several pinning exact messages and output lines, one a real consumer proven by a test: every covered criterion reaches its worker word for word (seam.criteria-verbatim); result review judges each criterion an item's command proves (seam.command-judged); a stub consumer is refused at result review, never first at final review (seam.stub-refused-early); a final-review refusal closes by 'repair' alone (seam.final-repair)"
  "nocheck|P|35|its own repository N (protected main, no required check, no workflow) and installation N: a Work Item PR with no checks merges 15-20 min after its push, with no hold (delivery.no-check-merge)"
  "prod|Q|45|repository C at production settings: 'factory setup' with no model call and '--background'; a /factory queue pause comment admits nothing until resume; planning in Project order and at most 3 at once; two items at once; no hold; status comment, Work Item issues and card; log, diagnostics, export; memory shown for a file an earlier Objective pinned; dream applies only on approval; stop and uninstall (setup.*, queue.*, exec.parallel-items, prod.no-holds, visibility.*, knowledge.*)"
)
case "$SUITE_NAME" in main|edge|prd) ;; *) echo "unknown suite: $SUITE_NAME (main, edge, prd)" >&2; exit 2 ;; esac
declare -n TABLE="CASE_TABLE_$SUITE_NAME"
for selected in ${ONLY//,/ }; do
  found=""
  for row in "${TABLE[@]}"; do [ "${row%%|*}" = "$selected" ] && found=1; done
  [ -n "$found" ] || { echo "unknown case: $selected" >&2; exit 2; }
done
SEL=()
for row in "${TABLE[@]}"; do IFS='|' read -r c _ _ _ <<<"$row"; [ -n "$ONLY" ] && [[ ",$ONLY," != *",$c,"* ]] && continue; SEL+=("$row"); done
[ ${#SEL[@]} -gt 0 ] || { echo "no cases selected" >&2; exit 2; }
# Repository C exists only for a selected case on the crash lane or the prd suite's lane Q.
NEEDS_C=""; for row in "${SEL[@]}"; do IFS='|' read -r _ lane _ _ <<<"$row"; [[ $lane == [CQ] ]] && NEEDS_C=1; done
# The run's GitHub identity, setup's preflight step: `app`, the suite's GitHub
# App (FACTORY_SUITE_APP_ID, and FACTORY_SUITE_APP_KEY, its private key's
# path), or `login`, the opt-out FACTORY_SUITE_GITHUB_LOGIN=1. Otherwise it
# prints why a live run can't start, and fails.
suite_identity() {
  if [ -n "${FACTORY_SUITE_APP_ID:-}${FACTORY_SUITE_APP_KEY:-}" ]; then
    [ "${FACTORY_SUITE_GITHUB_LOGIN:-}" != 1 ] || { echo "give the suite's GitHub App (FACTORY_SUITE_APP_ID, FACTORY_SUITE_APP_KEY) or FACTORY_SUITE_GITHUB_LOGIN=1, not both"; return 1; }
    [ -n "${FACTORY_SUITE_APP_ID:-}" ] && [ -f "${FACTORY_SUITE_APP_KEY:-}" ] || { echo "set FACTORY_SUITE_APP_ID and FACTORY_SUITE_APP_KEY (a key file) together"; return 1; }
    echo app
  elif [ "${FACTORY_SUITE_GITHUB_LOGIN:-}" = 1 ]; then
    echo login
  else
    echo "Factory runs as a GitHub App, setup's preflight step: set FACTORY_SUITE_APP_ID and FACTORY_SUITE_APP_KEY (its private key's path) for an App installed on All repositories of $REPO_OWNER ('factory setup --repo $REPO_OWNER/NAME --github-app-link' prints the link that registers one), or FACTORY_SUITE_GITHUB_LOGIN=1 to run as the gh login"
    return 1
  fi
}
# A live run stops here without one, before it creates anything.
SUITE_IDENTITY=""
if [ -z "$DRY" ] && [ -z "$REPLAY" ]; then
  SUITE_IDENTITY=$(suite_identity) || { echo "$SUITE_IDENTITY" >&2; exit 3; }
fi

# The run's id, which its run and state directories, results file, repositories
# and Projects are named from: its PDT start time and a random suffix, claimed
# by making its run directory, so two runs started in the same second (a Codex
# and a Claude lane) never share one.
RUNS=/tmp/factory-integration-runs; mkdir -p "$RUNS/results"
START_S=$(date +%s); HARD_STOP_AT=$(( START_S + 60 * 60 )); STOP_AT=$(( HARD_STOP_AT - 300 ))
export HARD_STOP_AT STOP_AT
for _ in 1 2 3 4 5; do
  RUN_SFX=$(od -An -N2 -tx2 /dev/urandom | tr -d ' \n')
  RUN_ID=$(TZ=America/Los_Angeles date -d @"$START_S" +%Y-%m-%dT%H%M%S%Z)-$RUN_SFX
  # This run's repositories: M (installation M, or E in the edge suite) and C (the crash lane).
  REPO_STEM=fd-$(TZ=America/Los_Angeles date -d @"$START_S" +%Y%m%d-%H%M%S)-$RUN_SFX
  if [ -n "$DRY" ]; then RUN_DIR=$(mktemp -d "$RUNS/.dry.XXXX"); break; fi
  RUN_DIR="$RUNS/$RUN_ID"; mkdir "$RUN_DIR" 2>/dev/null && break
  RUN_DIR=""
done
[ -n "$RUN_DIR" ] || { echo "could not claim a run directory under $RUNS" >&2; exit 3; }
SFX=$(TZ=America/Los_Angeles date -d @"$START_S" +%m%d%H%M)
M_REPO=$REPO_OWNER/$REPO_STEM-m; C_REPO=$REPO_OWNER/$REPO_STEM-c
STATE_BASE=${STATE_BASE:-/tmp/factory-integration/$RUN_ID}
mkdir -p "$RUN_DIR/answered"; : >"$RUN_DIR/results.tsv"; : >"$RUN_DIR/pids"; : >"$RUN_DIR/issues"; : >"$RUN_DIR/cases.tsv"; : >"$RUN_DIR/repos"; : >"$RUN_DIR/projects"
source "$SUITE/lib/common.sh"; source "$SUITE/lib/gh.sh"; source "$SUITE/lib/serve.sh"; source "$SUITE/lib/repos.sh"
source "$SUITE/cases/main.sh"; source "$SUITE/cases/crash.sh"; source "$SUITE/cases/edge.sh"; source "$SUITE/cases/prd.sh"
commit=$(git -C "$BUILD" log -1 --format='%h %s' 2>/dev/null | cut -c1-80)

budget() {
  echo "Budget (wall clock from the start):"
  echo "  setup: build check, fresh state dirs, configs, clones, scratch repo checks   <= 5 min"
  local w=0 row c lane mins what
  for row in "${SEL[@]}"; do IFS='|' read -r c lane mins what <<<"$row"; [ "$mins" -gt "$w" ] && w=$mins; done
  echo "  wave: ${#SEL[@]} case(s) at once, each stopped at its budget; the longest $w min <= 45 min (hard stop at 55)"
  echo "  end: cancel what is left, end checks, cleanup, report                       <= 5 min"
  echo "  expected total: ~$(( w + 9 )) min (limit 60)"
}
if [ -n "$DRY" ]; then
  echo "DRY RUN ($SUITE_NAME): nothing is started, queued or written."
  echo "Build: $BUILD ($commit)"; echo "Provider: $PROVIDER"; echo "State: $STATE_BASE (fresh per run)"
  case $(suite_identity) in
    app) echo "GitHub identity: GitHub App $FACTORY_SUITE_APP_ID, the gh login as operator" ;;
    login) echo "GitHub identity: the gh login (FACTORY_SUITE_GITHUB_LOGIN=1, setup --github-login)" ;;
    *) echo "GitHub identity: none, so a live run stops at setup: $(suite_identity)" ;;
  esac
  echo "Repositories: $M_REPO$([ -n "$NEEDS_C" ] && echo " and $C_REPO"), created from fixtures/baseline/,$([ -n "$NEEDS_C" ] && echo " each") on a Project of its own"; echo
  for row in "${SEL[@]}"; do IFS='|' read -r c lane mins what <<<"$row"; printf '%-8s lane %s  %2s min  %s\n' "$c" "$lane" "$mins" "$what"; done
  echo; budget
  rm -rf "$RUN_DIR"; exit 0
fi
[ -f "$BUILD/dist/cli.js" ] || [ -n "$REPLAY" ] || { echo "no CLI at $BUILD/dist/cli.js (npm run build)" >&2; exit 2; }

# Every remote call shares the run's deadline, including commands in bash
# predicates. Leave time for the final report even when an API stops replying.
GH_BIN=$(command -v gh) || [ -n "$REPLAY" ] || { echo "gh is required" >&2; exit 2; }
GIT_BIN=$(command -v git) || { echo "git is required" >&2; exit 2; }
export GH_BIN GIT_BIN
run_bounded() {
  local cap=$1 remaining; shift
  remaining=$(( HARD_STOP_AT - $(date +%s) - 20 ))
  [ "$remaining" -gt 0 ] || return 124
  [ "$cap" -le "$remaining" ] || cap=$remaining
  timeout --kill-after=2 "$cap" "$@"
}
gh() { run_bounded 30 "$GH_BIN" "$@"; }
git() { run_bounded 120 "$GIT_BIN" "$@"; }
export -f run_bounded gh git

# A selected check must be present exactly once and pass. An omitted or
# unreachable scenario is unfinished qualification, not a successful run.
required_checks() {
  case $1 in
    codex) echo 'model-kill.plan model-kill.work happy.codex stack.predecessor-wait stack.strict security.fixes-keyword' ;;
    claude) echo 'happy.claude queue.run-command' ;;
    holds) echo 'holds.ask holds.answer-comment holds.answered-comment holds.more queue.cancel-held' ;;
    queue) echo queue.withdraw ;;
    cancel) echo 'fault.lasting-403 fault.lag-404 queue.cancel-open-pr' ;;
    media) echo media.select-repair ;;
    attach) echo security.foreign-attachment ;;
    crash)
      echo 'holder.project-refused holder.second-refused holder.take-over holder.release holder.restart netcut.plan netcut.ci'
      local point; for point in $CRASH_LIFECYCLE $CRASH_REMIND $CRASH_CANCEL; do echo "crash.$point"; done ;;
    reset) echo reset.clean-dir ;;
    archived) echo queue.archived-card ;;
    flake) echo delivery.ci-rerun ;;
    threads) echo holds.review-threads ;;
    propose) echo 'propose.intent propose.roadmap' ;;
    recheck) echo 'toolchain.ci-only intake.recheck' ;;
    outsider) echo intake.non-writer ;;
    amend) echo 'plan.amendment plan.replan' ;;
    discovery) echo plan.discovery ;;
    scope) echo 'holds.item-scope holds.item-scope-after' ;;
    paths) echo queue.paths-take-turns ;;
    shared) echo delivery.shared-main ;;
    hostnet) echo worker.host-network ;;
    toolchain) echo toolchain.pin ;;
    nocheck) echo delivery.no-check-merge ;;
    seam) echo 'seam.criteria-verbatim seam.command-judged seam.stub-refused-early seam.final-repair' ;;
    prod) echo 'setup.config setup.background queue.pause-github queue.order queue.concurrency-3 exec.parallel-items prod.no-holds visibility.github visibility.cli knowledge.memory knowledge.dream' ;;
  esac
}
check_complete() {
  local row c lane mins what check count passed ok=0
  for row in "${SEL[@]}"; do
    IFS='|' read -r c lane mins what <<<"$row"
    for check in $(required_checks "$c") "case.$c"; do
      read -r count passed < <(awk -F'\t' -v key="$check" '$1==key{n++; if($4=="PASS") p++} END{print n+0,p+0}' "$RUN_DIR/results.tsv")
      if [ "$count" != 1 ] || [ "$passed" != 1 ]; then
        local CASE=suite INST=$lane
        record "incomplete.$check" FAIL "selected check has $count result(s), $passed PASS; exactly one PASS required" "$START_S"
        ok=1
      fi
    done
  done
  awk -F'\t' 'NF && $4!="PASS"{bad=1} END{exit bad}' "$RUN_DIR/results.tsv" || ok=1
  return "$ok"
}

# ---------- configuration ----------
# Plumbing runs on the fastest model and lowest effort each provider offers;
# `codex-plan` and `claude-plan` keep the production planner and reviewer
# (src/providers/codex.ts and claude.ts defaults), for the cases whose check
# is a planner decision (it must ask its question), so both providers' runs
# judge it at their production settings. The default
# provider is --provider's. The queue is repository M's Project, this run's
# own (setup_repos); an installation on another repository sets its own.
write_config() { # FILE REPO CHECKOUT MAX_ACTIVE [PY_EXPR...]
  local f=$1; shift
  [ -n "$M_PROJECT_ID" ] || { log "no Project for repository M"; return 1; }
  SUITE_CAPTURE=$CAPTURE SUITE_PROVIDER=$PROVIDER SUITE_PROJECT_ID=$M_PROJECT_ID python3 - "$f" "$@" <<'PY'
import json, os, sys
f, repo, checkout, active, *more = sys.argv[1:]
fast = {"model": "gpt-6-luna", "effort": "low", "serviceTier": "fast"}
haiku = {"model": "claude-haiku-5-5", "effort": "low"}
opus = {"model": "claude-opus-5-5", "effort": "medium"}  # Factory's Claude planner and reviewer default
sol_high = {"model": "gpt-6.1-sol", "effort": "high"}  # Factory's Codex planner default
sol_medium = {"model": "gpt-6.1-sol", "effort": "medium"}  # Factory's Codex reviewer default
c = {
  "repository": repo, "checkout": checkout,
  "queue": {"projectId": os.environ["SUITE_PROJECT_ID"], "pollSeconds": 15, "maxActiveObjectives": int(active)},
  "execution": {"concurrency": 4, "workers": 12, "validations": 6},
  # The suite's installation is production's too: its traffic yields first.
  "github": {"reserve": 2000},
  "providers": {
    "codex": {"planner": "codex", "models": {"planner": fast, "reviewer": fast}, "worker": {"kind": "codex", **fast}},
    "codex-plan": {"planner": "codex", "models": {"planner": sol_high, "reviewer": sol_medium}, "worker": {"kind": "codex", **fast}},
    "claude": {"planner": "claude", "models": {"planner": haiku, "reviewer": haiku}, "worker": {"kind": "claude", **haiku}},
    "claude-plan": {"planner": "claude", "models": {"planner": opus, "reviewer": opus}, "worker": {"kind": "claude", **haiku}},
  },
  "defaultProvider": os.environ["SUITE_PROVIDER"],
}
if os.environ.get("SUITE_CAPTURE"):
  c["capture"] = {"enabled": True}
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
    echo "# Integration run $RUN_ID ($SUITE_NAME)${REPLAY:+: Replay of $REPLAY}"; echo
    echo "Wall time: **$(( (end_s - START_S) / 60 )) min $(( (end_s - START_S) % 60 )) s** (limit 60), from $(TZ=America/Los_Angeles date -d @"$START_S" '+%-I:%M %p') to $(TZ=America/Los_Angeles date -d @"$end_s" '+%-I:%M %p') PDT${INTERRUPTED:+. **Interrupted**}."; echo
    if [ -n "$REPLAY" ]; then
      echo "Replay of $REPLAY: this checkout's checks over the run's kept state, logs and run files ($KEPT). Nothing ran live; a NOT-REPLAYABLE check needs a live run."; echo
      echo "- Suite code: $SUITE ($(git -C "$SUITE" log -1 --format='%h %s' | cut -c1-80))"; echo "- Run dir: $RUN_DIR"; echo
    else
      echo "- Build: $BUILD ($commit)"; echo "- Provider: $PROVIDER"; echo "- State: $STATE_BASE"; echo "- Run dir: $RUN_DIR"
      echo "- Repositories: $(sed "s|^|$REPO_OWNER/|" "$RUN_DIR/repos" | paste -sd' ')$([ -s "$RUN_DIR/projects" ] && echo ", Project #$(paste -sd' ' "$RUN_DIR/projects")") (${REPOS_NOTE:-none created})"; echo
    fi
    echo "**Totals:** ${tot%, }."; echo
    if [ -s "$RUN_DIR/cases.tsv" ]; then
      echo "## Cases"; echo; echo "| Case | Lane | Started | Ended | Duration |"; echo "|---|---|---|---|---|"
      awk -F'\t' '{d=$4-$3; printf "| %s | %s | +%dm%02ds | +%dm%02ds | %dm %02ds |\n", $1, $2, $3/60, $3%60, $4/60, $4%60, d/60, d%60}' "$RUN_DIR/cases.tsv"; echo
    fi
    echo "## Checks"; echo; echo "| Check | Case | Result | Evidence | Duration |"; echo "|---|---|---|---|---|"
    awk -F'\t' '{gsub(/\|/,"\\|",$5); d=$6+0; printf "| %s | %s | %s | %s | %dm %02ds |\n", $1, $2, ($4=="FAIL"?"**FAIL**":$4), $5, d/60, d%60}' "$RUN_DIR/results.tsv"
    python3 "$SUITE/lib/github-calls.py" "$STATE_BASE" "$RUN_DIR" 2>/dev/null
    [ -s "$RUN_DIR/issues" ] && { echo; echo "Objectives: $(awk '{printf "%s#%s (%s) ", ($3=="C"||$3=="H"||$3=="Q")?"C ":($3 ~ /^[NTFR]$/?$3" ":""), $1, $2}' "$RUN_DIR/issues")"; }
  } >"$out"
  echo "results: $out" >&2
}

# ---------- replay: a kept run's checks again, nothing live ----------
# A case's replay_<case> (cases/*.sh) finds its Objectives in the kept run's
# files and calls the check functions the live case calls. Every other selected
# check is NOT-REPLAYABLE, never PASS.
if [ -n "$REPLAY" ]; then
  KEPT=$RUNS/$REPLAY
  [ -d "$KEPT/inst" ] || { echo "no kept run at $KEPT" >&2; rm -rf "$RUN_DIR"; exit 2; }
  # A replay under another suite finds none of its lanes and would pass empty.
  kept_suite=$(sed -n '1s/^# Integration run [^ ]* (\([a-z]*\)).*/\1/p' "$RUNS/results/$REPLAY.md" 2>/dev/null)
  [ "$kept_suite" = "$SUITE_NAME" ] || { echo "$REPLAY was a '${kept_suite:-unknown}' run; replay it with --suite ${kept_suite:-<its suite>}" >&2; rm -rf "$RUN_DIR"; exit 2; }
  for row in "${SEL[@]}"; do
    IFS='|' read -r c lane _ _ <<<"$row"
    if [ -s "$KEPT/inst/$lane/env" ] && declare -F "replay_$c" >/dev/null; then ( CASE=$c; inst "$lane"; "replay_$c" ); fi
    for check in $(required_checks "$c"); do
      awk -F'\t' -v k="$check" '$1==k{f=1} END{exit !f}' "$RUN_DIR/results.tsv" ||
        ( CASE=$c INST=$lane; record "$check" NOT-REPLAYABLE "not replayed: its evidence isn't all in the kept run (live GitHub, the run's own drive or a moment's timing)" "$START_S" )
    done
  done
  write_results
  awk -F'\t' '$4=="FAIL"{f=1} END{exit f}' "$RUN_DIR/results.tsv"; exit
fi
CASE_PIDS=()
stop_cases() {
  touch "$RUN_DIR/stop"
  local p s end=$(( $(now) + 10 ))
  while [ "$(now)" -lt "$end" ]; do
    local alive=0; for p in "${CASE_PIDS[@]}"; do read -r p s <<<"$p"; same_proc "$p" "$s" && alive=1; done
    [ "$alive" = 0 ] && break; sleep 1
  done
  for p in "${CASE_PIDS[@]}"; do read -r p s <<<"$p"; same_proc "$p" "$s" && { log "stopping case process $p"; : >"$RUN_DIR/desc.case"; snap_desc "$p" "$RUN_DIR/desc.case"; kill_exact "$p" "$s" TERM; kill_desc_survivors "$RUN_DIR/desc.case"; }; done
  for p in "${CASE_PIDS[@]}"; do read -r p s <<<"$p"; kill_exact "$p" "$s" KILL || true; wait "$p" 2>/dev/null || true; done
}
# Cancel every unsettled Objective of the run (each installation's serve must run).
cancel_left() {
  local n c i any="" p jobs=()
  while read -r n c i; do
    [ "$i" = H ] && continue
    inst "$i"
    case $(st status "$n") in
      done|failed) ;;
      none) (gh_card "$n" Cancelled >/dev/null 2>&1; gh issue close "$n" --repo "$REPO" --reason "not planned" >/dev/null 2>&1) & jobs+=("$!") ;;
      *) (cli_t 30 cancel "$n" >/dev/null 2>&1) & jobs+=("$!"); any="$any $i:$n" ;;
    esac
  done <"$RUN_DIR/issues"
  for p in "${jobs[@]}"; do wait "$p" || record suite.cancel FAIL "a cleanup cancellation request failed" "$START_S"; done
  [ -n "$any" ] || return 0
  log "cancelled at the end:$any"
  local end=$(( $(now) + 90 )) left
  [ "$end" -lt "$(( HARD_STOP_AT - 90 ))" ] || end=$(( HARD_STOP_AT - 90 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    left=""; for x in $any; do inst "${x%%:*}"; cancelled_clean "${x#*:}" || [ "$(st status "${x#*:}")" = done ] || left="$left $x"; done
    [ -z "$left" ] && break; sleep 5
  done
  [ -z "${left:-}" ] || record suite.cancel FAIL "cleanup did not settle:$left" "$START_S"
}
end_state() {
  local CASE=suite t0; t0=$(date +%s)
  local name; case $SUITE_NAME in main) name=M ;; edge) name=E ;; prd) name=P ;; esac
  if [ ! -s "$RUN_DIR/inst/$name/env" ]; then
    record suite.end-state FAIL "setup did not create installation $name; end state is unproved" "$t0"
    return
  fi
  inst $name
  local nm rv open="" prs repo ok=0
  nm=$(gh api "repos/$M_REPO" --jq .name) || ok=1
  rv=$(gh_human_gate) || ok=1
  local repos="$M_REPO"; [ -n "$NEEDS_C" ] && repos="$repos $C_REPO"
  for repo in $repos; do
    if prs=$(gh api "repos/$repo/pulls?state=open&per_page=100" --jq '.[].number'); then
      [ -z "$prs" ] || open="$open $repo:$(tr '\n' ',' <<<"$prs")"
    else ok=1; fi
  done
  local serves; serves=$(for repo in $repos; do running_serves "$repo"; done | wc -l)
  local units="unknown"
  if units=$(run_bounded 5 systemctl --user list-units --all --no-legend 'factory-*'); then
    # Only this run's: the host may serve real installations too.
    units=$(awk -v stem="$REPO_STEM" 'NF && index($0, stem){n++} END{print n+0}' <<<"$units")
  else ok=1; fi
  [ "$nm" = "${M_REPO#*/}" ] && [ "$rv" = false ] && [ -z "$open" ] && [ "$serves" = 0 ] && [ "$units" = 0 ] || ok=1
  rec_if suite.end-state "$ok" "$M_REPO named '$nm'; review gate '$rv'; open PRs [${open}]; serves left $serves; factory units $units; read failures=$ok" "$t0"
}
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  [ -n "$FINISHED" ] && exit $code
  FINISHED=1
  STOP_AT=$(( HARD_STOP_AT - 30 )); export STOP_AT
  stop_cases
  # Serves up for the cancellations, then down.
  if [ -d "$RUN_DIR/inst/C" ]; then
    inst C; SERVE_DIR=$(serve_dir_of C)
    if [ -n "$SERVE_DIR" ] && ! serve_alive && grep -q ' C$' "$RUN_DIR/issues"; then serve_up "" netns || record suite.restart FAIL "could not restart crash lane for cleanup" "$START_S"; fi
  fi
  cancel_left
  # Q's serve is the user service the prod case installed: uninstall it.
  [ -s "$RUN_DIR/inst/Q/env" ] && (inst Q; q_uninstall)
  local i p jobs=(); for i in C H X M E P N F R; do [ -d "$RUN_DIR/inst/$i" ] || continue; (inst "$i"; SERVE_DIR=$(serve_dir_of "$i"); serve_down) & jobs+=("$!"); done
  for p in "${jobs[@]}"; do wait "$p" || record suite.stop FAIL "a serve could not be stopped" "$START_S"; done
  for i in M E P; do proxy_stop $i; done
  local s; while read -r p s; do kill_exact "$p" "$s" TERM || true; done <"$RUN_DIR/pids"
  [ -s "$RUN_DIR/repos" ] && end_state
  check_complete || code=1
  [ "$(now)" -lt "$HARD_STOP_AT" ] || { record suite.deadline FAIL "run exceeded its 60-minute wall-clock limit" "$START_S"; code=1; }
  # A passing run deletes its repositories; a failed one keeps them to inspect.
  local r kept=""
  if [ -z "$KEEP_REPOS" ] && [ "$code" = 0 ]; then
    while read -r r; do [ -n "$r" ] && { repo_delete "$r" || kept="$kept $r"; }; done <"$RUN_DIR/repos"
    while read -r r; do [ -n "$r" ] && { project_delete "$r" || kept="$kept Project #$r"; }; done <"$RUN_DIR/projects"
    REPOS_NOTE="deleted$([ -n "$kept" ] && echo "; could not delete:$kept")"
  else REPOS_NOTE="kept for inspection ($([ -n "$KEEP_REPOS" ] && echo "--keep-repos" || echo "the run failed"); swept after 24 h)"; fi
  write_results
  exit $code
}

# ---------- setup ----------
# Refuse missing host/account prerequisites before creating issues or making
# provider calls. These checks use the tools' own logins, never their files.
for tool in node python3 timeout flock unshare pasta systemctl; do
  command -v "$tool" >/dev/null || { echo "missing prerequisite: $tool" >&2; exit 3; }
done
git lfs version >/dev/null || { echo "git-lfs is required" >&2; exit 3; }
[ -c /dev/net/tun ] || { echo "network-cut cases need /dev/net/tun" >&2; exit 3; }
# Each run creates and deletes its repositories: an owner role and the delete_repo scope.
login=$(gh api user --jq .login) || { echo "gh is not logged in" >&2; exit 3; }
[ "$(gh api "orgs/$REPO_OWNER/memberships/$login" --jq .role 2>/dev/null)" = admin ] || { echo "gh login $login must be an owner of $REPO_OWNER to create its run repositories" >&2; exit 3; }
gh api -i user 2>/dev/null | grep -i '^x-oauth-scopes:' | grep -qw delete_repo || { echo "the gh token needs the delete_repo scope (gh auth refresh -s delete_repo)" >&2; exit 3; }
# Factory acts as the suite's GitHub App (SUITE_IDENTITY app): every
# installation's setup gives it (lib/common.sh identity_setup), with the gh
# login as its operator. The App is installed on all of REPO_OWNER's
# repositories, so the run's are too. With the opt-out, setup records
# --github-login instead.
if [ "$SUITE_IDENTITY" = app ]; then
  IDENTITY_ARGS=(--github-app-id "$FACTORY_SUITE_APP_ID" --github-app-key "$FACTORY_SUITE_APP_KEY" --operator "$login")
else
  IDENTITY_ARGS=(--github-login)
fi
log "suite $SUITE_NAME, provider $PROVIDER, build $BUILD ($commit), state $STATE_BASE, $([ "$SUITE_IDENTITY" = app ] && echo "as GitHub App $FACTORY_SUITE_APP_ID" || echo "as the gh login $login (FACTORY_SUITE_GITHUB_LOGIN=1)")"
for r in $M_REPO $C_REPO; do s=$(running_serves "$r"); [ -n "$s" ] && { echo "refused: a serve runs for $r: $s" >&2; exit 3; }; done
# Claimed, not just checked: another run given the same --state-base is refused.
mkdir -p "$(dirname "$STATE_BASE")" && mkdir "$STATE_BASE" 2>/dev/null || { echo "refused: state directory already exists: $STATE_BASE" >&2; exit 3; }
trap 'INTERRUPTED=1; exit 130' INT TERM
trap cleanup EXIT
SETUP0=$(date +%s)
# Each repository queues on a Project of its own, this run's: one installation
# serves a Project, so a run sharing another's would be refused there.
M_PROJECT_ID=""; C_PROJECT_ID=""
setup_repos() {
  repos_sweep; projects_sweep
  repo_create "${M_REPO#*/}" || return 1
  M_PROJECT_ID=$(project_create "$M_REPO") && [ -n "$M_PROJECT_ID" ] || return 1
  [ -z "$NEEDS_C" ] && return 0
  repo_create "${C_REPO#*/}" || return 1
  C_PROJECT_ID=$(project_create "$C_REPO") && [ -n "$C_PROJECT_ID" ]
}
setup_main() {
  clone $M_REPO "$STATE_BASE/checkout-m" || return 1
  write_config "$STATE_BASE/config-m.json" $M_REPO "$STATE_BASE/checkout-m" 12 'c["delivery"]={"kind":"native-stack"}' 'c.setdefault("autonomy",{})["allowances"]={"planningRevisions":2}'
  inst_define M $M_REPO "$STATE_BASE/config-m.json" || return 1
  if [ -n "$NEEDS_C" ]; then
    clone $C_REPO "$STATE_BASE/checkout-c" || return 1
    write_config "$STATE_BASE/config-c.json" $C_REPO "$STATE_BASE/checkout-c" 8 "c['queue']['projectId']='$C_PROJECT_ID'"
    inst_define C $C_REPO "$STATE_BASE/config-c.json" || return 1
    inst_define H $C_REPO "$STATE_BASE/config-c.json" || return 1
    # X: repository C configured on repository M's Project, which M serves.
    write_config "$STATE_BASE/config-x.json" $C_REPO "$STATE_BASE/checkout-c" 8
    inst_define X $C_REPO "$STATE_BASE/config-x.json" || return 1
    printf '%s\n' "FACTORY_BACKOFF_MS=5000" "FACTORY_REMIND_MS=120000" "FACTORY_DISPLAY_TIMEZONE=America/Los_Angeles" >"$RUN_DIR/inst/C/extra_env"
    cp "$RUN_DIR/inst/C/extra_env" "$RUN_DIR/inst/H/extra_env"; cp "$RUN_DIR/inst/C/extra_env" "$RUN_DIR/inst/X/extra_env"
  fi
  inst M
  [ "$(gh_human_gate)" = false ] || { log "required review must be OFF before the run"; return 1; }
  local open; open=$(gh pr list -R $M_REPO --state open --json number --jq length)
  [ "$open" = 0 ] || log "note: $M_REPO has $open open PRs at the start"
  # M: one serve for the whole wave, behind the fault proxy.
  proxy_start M || return 1
  printf '%s\n' "FACTORY_GITHUB_API=$PROXY_URL" "FACTORY_BACKOFF_MS=10000" "FACTORY_DISPLAY_TIMEZONE=America/Los_Angeles" >"$RUN_DIR/inst/M/extra_env"
  serve_up || return 1
  serve_ready
}
# The serve's own record names its PID: the CLI sees a running service from then on.
serve_ready() { wait_for 90 bash -c "[ \"\$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get(\"pid\"))' '$ROOT/service.json' 2>/dev/null)\" = $(serve_pid) ]"; }
setup_repos || { log "setup failed: could not create this run's repositories"; exit 1; }
case $SUITE_NAME in
  main) setup_main ;; edge) setup_edge ;; prd) setup_prd ;;
esac || { log "setup failed"; exit 1; }
record_setup() { local CASE=suite; record suite.setup PASS "setup took $(( $(date +%s) - SETUP0 )) s" "$SETUP0"; }; record_setup

# ---------- the wave ----------
run_case() { # NAME LANE MINUTES
  local c=$1 lane=$2 mins=$3 t0; t0=$(( $(date +%s) - START_S ))
  ( CASE=$c
    # The case's deadline: its minutes from now, never past the wave's stop.
    # Every wait, CLI call and loop clock in the case reads STOP_AT.
    local wave_stop=$STOP_AT; STOP_AT=$(( $(now) + mins * 60 ))
    [ "$STOP_AT" -le "$wave_stop" ] || STOP_AT=$wave_stop
    case $lane in C) lane_c ;; *) inst "$lane"; SERVE_DIR=$(serve_dir_of "$lane"); case_$c ;; esac
    local rc=$? over=""
    [ "$(now)" -lt "$STOP_AT" ] || over="; out of time (budget $mins min)"
    # Cancelling what the case left may use the wave's time.
    STOP_AT=$wave_stop
    [ "$lane" = C ] || case_settle
    rec_if "case.$c" "$rc" "case returned $rc$over" "$START_S"
    printf '%s\t%s\t%s\t%s\n' "$c" "$lane" "$t0" "$(( $(date +%s) - START_S ))" >>"$RUN_DIR/cases.tsv"
  ) &
  local p=$!; CASE_PIDS+=("$p $(starttime $p)")
}
for row in "${SEL[@]}"; do IFS='|' read -r c lane mins _ <<<"$row"; run_case "$c" "$lane" "$mins"; done
log "wave: ${#SEL[@]} cases started; hard stop at $(TZ=America/Los_Angeles date -d @"$STOP_AT" '+%-I:%M %p')"
# Supervise: the shared serve stays up (a death is a finding, and it restarts); stop at 55 min.
case $SUITE_NAME in main) SUP=M ;; edge) SUP=E ;; prd) SUP=P ;; esac
while :; do
  alive=0; for p in "${CASE_PIDS[@]}"; do kill -0 "${p%% *}" 2>/dev/null && alive=1; done
  [ $alive = 0 ] && break
  [ "$(date +%s)" -ge "$STOP_AT" ] && { log "55 min: stopping the wave"; break; }
  inst $SUP; SERVE_DIR=$(serve_dir_of $SUP)
  # A case restarting the shared serve on purpose (edge's reset) owns it until it's back.
  if [ -n "$SERVE_DIR" ] && [ ! -e "$RUN_DIR/serve-restarting" ]; then
    serve_tick
    if serve_exited; then
      ( CASE=suite; record "suite.serve-$SUP" FAIL "the shared serve exited $(cat "$SERVE_DIR/exit"): $(tail -c 400 "$SERVE_DIR/out.log" | tr '\n' ' ')" "$START_S" )
      serve_up || true
    fi
  fi
  sleep 5
done
exit 0
}
