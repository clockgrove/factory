# The edge suite (run-suite.sh --suite edge) on the run's own repository
# (M_REPO): PRD requirements no main case covers. Installation E serves behind
# the fault proxy. The `flake` and `threads` cases each make their own
# repository and installation (F, R; see e_target): a CI workflow or a
# ruleset of their own that no other case's PRs should meet.

setup_edge() {
  clone $M_REPO "$STATE_BASE/checkout-e" || return 1
  write_config "$STATE_BASE/config-e.json" $M_REPO "$STATE_BASE/checkout-e" 6
  inst_define E $M_REPO "$STATE_BASE/config-e.json" || return 1
  inst E; proxy_start E 18612
  printf '%s\n' "FACTORY_GITHUB_API=$PROXY_URL" "FACTORY_BACKOFF_MS=10000" >"$RUN_DIR/inst/E/extra_env"
  serve_up && serve_ready
}

# PRD 9: Objectives rebuilt from GitHub alone. Two at once: one delivered, one
# mid-build with its PR open (its merge refused by the proxy). The serve stops,
# their state and work files go (worktrees pruned), and `factory reset` rebuilds
# each: the delivered one stays done with no new PR or marker; the mid-build
# one runs plan review (review:1:1) and finishes on its one PR.
edge_merge_refused() { [ "$(proxy_count PUT "/pulls/$1/merge\$" 502)" -gt 0 ]; }
case_reset() {
  local t0 d b pr; t0=$(now)
  local HOLD_POLICY="d2 review decide more"
  need reset.clean-dir "$t0" reset-rebuild || { touch "$RUN_DIR/reset.done"; return; }
  d=$(new_objective happy "reset delivered" ID="$(uid)") || return
  b=$(new_objective happy "reset mid-build" ID="$(uid)") || return
  wait_for 1500 has_open_pr "$b"; pr=$(gh_open_pr "$b")
  [ -n "$pr" ] || { record reset.clean-dir FAIL "setup: #$b never opened a PR" "$t0"; return; }
  prule_add "PUT ^/repos/$REPO/pulls/$pr/merge\$ status=502"
  wait_phase "$d" 'done|cancelled|failed' 1500 >/dev/null
  local refused=0; wait_for 600 edge_merge_refused "$pr" && refused=1
  if [ "$refused" != 1 ] || [ "$(st status "$d")" != done ] || [ "$(gh_open_pr "$b")" != "$pr" ]; then record reset.clean-dir FAIL "setup: #$d $(st status "$d"), #$b PR '$pr', merge refusal observed $refused" "$t0"; prule_clear; return; fi
  local prs_d m_d prs_b; prs_d=$(PULLS_TTL=0 gh_prs "$d"); m_d=$(gh_markers "$d"); prs_b=$(PULLS_TTL=0 gh_prs "$b")
  wait_for 600 test -e "$RUN_DIR/archived.done"   # the archived case needs the serve first
  # The shared serve's restart needs time to stop it cleanly and come back up.
  [ "$(left)" -ge 120 ] || { record reset.clean-dir FAIL "out of time before the reset: #$d done, #$b PR #$pr open" "$t0"; prule_clear; return; }
  # This restart is the case's own: the supervisor leaves the serve alone meanwhile.
  touch "$RUN_DIR/serve-restarting"
  serve_down
  local n; for n in "$d" "$b"; do rm -rf "$ROOT/objectives/$n.json" "$ROOT/objectives/finished/$n.json" "$ROOT/work/$n"; done
  git -C "$(cfg_get 'c["checkout"]')" worktree prune
  serve_up && serve_ready; local up=$?
  rm -f "$RUN_DIR/serve-restarting"
  [ $up = 0 ] || return
  prule_clear
  local reset_at; reset_at=$(iso_ms)
  cli_t 120 reset "$d" >"$RUN_DIR/reset.$d.out" 2>&1; local rd=$?
  cli_t 120 reset "$b" >"$RUN_DIR/reset.$b.out" 2>&1; local rb=$?
  wait_phase "$d" 'done|cancelled|failed' 600 >/dev/null
  wait_phase "$b" 'done|cancelled|failed' 1500 >/dev/null; sleep 20
  end_done "$d"; local okd=$?
  [ "$(PULLS_TTL=0 gh_prs "$d")" = "$prs_d" ] && [ "$(gh_markers "$d")" = "$m_d" ] || okd=1
  local ev="delivered #$d: reset exit $rd, PRs and markers unchanged: $([ $okd = 0 ] && echo yes || echo no); $EVID"
  end_done "$b"; local okb=$? rv; rv=$(st starts-since "$b" "$reset_at" 'review:*')
  [ "$(PULLS_TTL=0 gh_prs "$b" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')" = 1 ] && [ "$rv" -ge 1 ] || okb=1
  ev="$ev | mid-build #$b: reset exit $rb with PR #$pr open, plan reviews after reset $rv, PRs before $prs_b, after $(PULLS_TTL=0 gh_prs "$b"); $EVID"
  [ $okd = 0 ] && [ $okb = 0 ] && [ "$rd" = 0 ] && [ "$rb" = 0 ]; rec_if reset.clean-dir $? "$ev" "$t0"
}

# `factory run N` on an issue whose Project card is archived admits it.
case_archived() {
  local t0 n item; t0=$(now)
  need queue.archived-card "$t0" run || { touch "$RUN_DIR/archived.done"; return; }
  n=$(new_issue withdraw "archived card" ID="$(uid)") || return
  item=$(gh project item-add "$(gh_pj "d['number']")" --owner "$(gh_pj "d['owner']['login']")" --url "https://github.com/$REPO/issues/$n" --format json --jq .id) || return
  gh project item-archive "$(gh_pj "d['number']")" --owner "$(gh_pj "d['owner']['login']")" --id "$item" >/dev/null || { record queue.archived-card FAIL "couldn't archive #$n's card" "$t0"; touch "$RUN_DIR/archived.done"; return; }
  cli_t 40 run "$n" >>"$RUN_DIR/run.$n.out" 2>&1
  wait_for 300 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $n)\" != none ]"
  local s; s=$(st status "$n"); local adm; adm=$(st events "$n" event=admitted)
  cancel_wait "$n" 300; touch "$RUN_DIR/archived.done"
  [ "$s" != none ] && [ "$adm" -ge 1 ]; rec_if queue.archived-card $? "#$n with an archived card: 'factory run' admitted it ($s, admitted x$adm)" "$t0"
}

# ---------- installations F and R: a case's own repository ----------
# Every PR of repository M would meet a flaky CI job or a thread-resolution
# rule, so the flake and threads cases (lane E rows) each make their own:
# repository fd-<time>-f or -r (deleted with the others), a Project for it,
# installation F or R and its serve. The suite's gh login creates and changes
# them; Factory's login (the same one, or the GitHub App) only serves them.
# e_target LETTER WORKFLOW: the repository from the baseline with
# fixtures/repo/WORKFLOW as its CI (main still requires `test`, strict), its
# Project and installation LETTER (sets INST to it); no serve yet.
e_target() {
  local i=$1 s=${1,,} repo="$REPO_OWNER/$REPO_STEM-${1,,}" co="$STATE_BASE/checkout-${1,,}" sha="" pid=""
  {
    repo_create "${repo#*/}" &&
      sha=$(gh api "repos/$repo/contents/.github/workflows/ci.yml" --jq .sha) &&
      gh api -X PUT "repos/$repo/contents/.github/workflows/ci.yml" -f message="Drill: this target's CI ($2)" -f sha="$sha" \
        -f content="$(base64 -w0 <"$SUITE/fixtures/repo/$2")" >/dev/null &&
      pid=$(C_REPO=$repo project_create) && [ -n "$pid" ] &&
      clone "$repo" "$co"
  } 2>>"$RUN_DIR/$s.setup.err" || return 1
  write_config "$STATE_BASE/config-$s.json" "$repo" "$co" 4 "c['queue']['projectId']='$pid'"
  inst_define "$i" "$repo" "$STATE_BASE/config-$s.json" || return 1
  printf '%s\n' "FACTORY_BACKOFF_MS=10000" "FACTORY_DISPLAY_TIMEZONE=America/Los_Angeles" >"$RUN_DIR/inst/$i/extra_env"
  inst "$i"
}
e_serve() { serve_up && serve_ready; }
# e_end LETTER [N]: settle N, then stop LETTER's serve (never lane E's). A serve
# whose Objective won't settle stays up for the run's end to cancel it.
e_end() {
  [ -z "${2:-}" ] || settled "$2" || cancel_wait "$2" 300
  [ -n "${2:-}" ] && ! settled "$2" && return 0
  SERVE_DIR=$(serve_dir_of "$1"); serve_down
}

# #2054: a required check that fails on its first attempt only is rerun, not
# repaired. Repository F's `test` job fails on a pull request's first attempt,
# after `npm test` passed (fixtures/repo/flaky-ci.yml). Factory reruns the
# failed job once (rerun-failed-jobs), it passes on attempt 2, and the PR
# merges with no repair; the run log (ci-rerun, ci-flaky) and the report
# record the flake. Every Work Item PR meets it, each on its own head.
case_flake() {
  local t0 id n p live rl ends; t0=$(now); id=$(uid)
  SERVE_DIR=""   # lane E's serve is not this case's to stop
  need delivery.ci-rerun "$t0" ci-rerun || return 0
  { e_target F flaky-ci.yml && e_serve; } || { record delivery.ci-rerun FAIL "couldn't make repository F and installation F: $(tail -c 300 "$RUN_DIR/f.setup.err" 2>/dev/null)" "$t0"; e_end F; return 1; }
  local HOLD_POLICY="d2 review decide more"
  n=$(new_objective happy "CI flake rerun" ID="$id") || { record delivery.ci-rerun FAIL "couldn't file or queue the Objective on $REPO" "$t0"; e_end F; return 1; }
  p=$(wait_phase "$n" 'done|cancelled|failed' "$(( $(left) - 60 ))"); sleep 10
  live=$(flake_github "$n"); rl=$?
  end_done "$n"; ends=$?
  flake_check "$n" "$t0" "$(( rl || ends ))" "ended $p; $live; $EVID"
  e_end F "$n"
}
# flake_check N T0 [LIVE LIVE_EVIDENCE]: from F's state and logs (also
# run-suite.sh --replay): N done, its failed checks rerun (ci-rerun), every
# published Work Item's checks passed on a rerun (ci-flaky), and no Work Item
# repair. LIVE is the GitHub part's exit (flake_github, end_done), empty in a replay.
flake_check() {
  local ev="" rk=0
  ev=$(python3 -B - "$SUITE/lib" "$ROOT" "$1" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import st
root, n = sys.argv[2], sys.argv[3]
d = st.load(root, n)
d = d if isinstance(d, dict) else {}
evs = list(st.events(root, n))
items = sorted(k[len("item:"):-len(":publish")] for k in d.get("done") or {} if k.startswith("item:") and k.endswith(":publish"))
reruns = [e for e in evs if e.get("event") == "ci-rerun"]
flaky = sorted({str(e.get("item")) for e in evs if e.get("event") == "ci-flaky"})
repairs = sum(1 for e in evs if e.get("event") == "outcome" and e.get("outcome") == "repair" and str(e.get("step", "")).startswith("item:"))
missing = [i for i in items if i not in flaky]
ok = d.get("status") == "done" and bool(items) and bool(reruns) and not missing and repairs == 0
print(f"status {d.get('status')}; published Work Items {' '.join(items) or 'none'}; reruns (ci-rerun) {len(reruns)} "
      f"of {', '.join(sorted({c for e in reruns for c in e.get('checks') or []})) or 'no check'}; "
      f"passed on the rerun (ci-flaky) {' '.join(flaky) or 'none'}{'; never rerun: ' + ' '.join(missing) if missing else ''}; "
      f"Work Item repairs {repairs}")
sys.exit(0 if ok else 1)
PY
) || rk=$?
  rec_part delivery.ci-rerun "$rk" "${3:-}" "#$1 on $REPO: $ev${4:+; $4}" "$2"
}
replay_flake() { [ -s "$KEPT/inst/F/env" ] || return 0; inst F; local n; n=$(case_issues | head -1); [ -z "$n" ] || flake_check "$n" "$(now)"; }
# flake_github N: 0 when each of N's merged PRs' head shows its `ci` run failed
# on attempt 1 and passed on a later one, and N's report lists the possibly
# flaky check. Prints the evidence.
flake_github() {
  local prs="" p head row id attempt concl first rep="" out="" ok=0 merged=0
  prs=$(PULLS_TTL=0 gh_prs "$1") || { echo "PRs unreadable"; return 1; }
  for p in $(python3 -c 'import json,sys;print(" ".join(str(x["number"]) for x in json.loads(sys.argv[1]) if x["state"]=="MERGED"))' "$prs"); do
    merged=$(( merged + 1 )); first=""
    head=$(gh api "repos/$REPO/pulls/$p" --jq .head.sha) || { out="$out; PR #$p unreadable"; ok=1; continue; }
    # The head's pull_request `ci` run that went furthest: the rerun one.
    row=$(gh api "repos/$REPO/actions/runs?head_sha=$head&event=pull_request&per_page=100" \
      --jq '[.workflow_runs[]|select(.name=="ci")]|max_by(.run_attempt)|"\(.id) \(.run_attempt) \(.conclusion)"') || row=""
    read -r id attempt concl <<<"$row"
    [[ $id =~ ^[0-9]+$ ]] && first=$(gh api "repos/$REPO/actions/runs/$id/attempts/1" --jq .conclusion)
    out="$out; PR #$p head ${head:0:12}: ci run ${id:-none} attempt ${attempt:-?} ${concl:-?}, its attempt 1 ${first:-?}"
    [[ $attempt =~ ^[0-9]+$ ]] && [ "$attempt" -ge 2 ] && [ "$concl" = success ] && [ "$first" = failure ] || ok=1
  done
  rep=$(gh api "repos/$REPO/issues/$1/comments?per_page=100" --paginate --slurp | python3 -c 'import json,sys
n = sys.argv[1]
bodies = [c.get("body") or "" for page in json.load(sys.stdin) for c in page]
reports = [b for b in bodies if "<!-- factory:%s:report" % n in b]
print("yes" if any("Possibly flaky CI checks" in b and "`test`" in b for b in reports) else ("no, the report names no flake" if reports else "no report"))' "$1") || rep="unreadable"
  [ "$merged" -ge 1 ] && [ "$rep" = yes ] || ok=1
  echo "merged PRs $merged${out}; the report lists the flaky 'test': $rep"
  return $ok
}

# #2053: an unresolved review thread that the default branch requires
# resolved holds at once, naming the thread, where Factory used to wait
# silently for its generic 3 h question. Repository R's default-branch ruleset
# requires review thread resolution, and its `test` check takes a minute longer
# (fixtures/repo/slow-ci.yml). As soon as Factory's PR opens, the suite's gh
# login posts a line review comment on it: an open thread. Factory must hold
# within THREADS_BOUND, linking the thread and offering retry; the suite
# resolves the thread (resolveReviewThread), answers retry, and the PR merges.
THREADS_BOUND=600
case_threads() {
  local t0 id n pr p live rl ends; t0=$(now); id=$(uid)
  SERVE_DIR=""   # lane E's serve is not this case's to stop
  need holds.review-threads "$t0" thread-hold || return 0
  { e_target R slow-ci.yml && r_ruleset && e_serve; } || { record holds.review-threads FAIL "couldn't make repository R and installation R: $(tail -c 300 "$RUN_DIR/r.setup.err" 2>/dev/null)" "$t0"; e_end R; return 1; }
  local HOLD_POLICY="d2 review decide more"
  n=$(new_objective happy "unresolved review thread" ID="$id") || { record holds.review-threads FAIL "couldn't file or queue the Objective on $REPO" "$t0"; e_end R; return 1; }
  wait_for "$(left)" pr_or_settled "$n"; pr=$(gh_open_pr "$n")
  [ -n "$pr" ] || { record holds.review-threads FAIL "#$n never opened a PR ($(st phase "$n"))" "$t0"; e_end R "$n"; return 1; }
  r_comment "$n" "$pr" || { record holds.review-threads FAIL "not proved: couldn't open a review thread on PR #$pr while it was open: $(tail -c 300 "$RUN_DIR/r.comment.err" 2>/dev/null)" "$t0"; e_end R "$n"; return 1; }
  # Only the suite answers the thread's hold, once it has resolved the thread.
  p=$(HOLD_POLICY="" wait_phase "$n" '^hold:|done|cancelled|failed' "$THREADS_BOUND")
  local hj; hj=$(st hold "$n" 'item:*'); printf '%s\n' "$hj" >"$RUN_DIR/threads-hold.$n"
  if [ "$hj" != null ] && [[ ,$(hold_field "$hj" answers), == *,retry,* ]] && r_resolve "$n" "$pr"; then
    sleep 5; answer_t 60 "$n" retry --question "$(hold_field "$hj" id)" >/dev/null 2>&1
    wait_phase "$n" 'done|cancelled|failed' "$(( $(left) - 60 ))" >/dev/null; sleep 10
  fi
  live=$(r_github "$n"); rl=$?
  end_done "$n"; ends=$?
  threads_check "$n" "$t0" "$(( rl || ends ))" "after the thread: $p; $live; $EVID"
  e_end R "$n"
}
# r_ruleset: an active ruleset on R's default branch whose pull_request rule
# requires review threads resolved and no approving review (as Clockgrove's).
r_ruleset() {
  gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null 2>>"$RUN_DIR/r.setup.err" <<'JSON' || return 1
{"name": "Drill: resolve review threads", "target": "branch", "enforcement": "active",
 "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
 "rules": [{"type": "pull_request", "parameters": {"required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false,
   "require_code_owner_review": false, "require_last_push_approval": false, "required_review_thread_resolution": true}}]}
JSON
  log "ruleset on $REPO's main: review threads must be resolved"
}
# r_comment N PR: a review comment on the first line PR adds (else on its first
# file), as the suite's gh login: an open review thread. Refused once the PR
# is no longer open. Keeps {id, url, path, at} in threads-comment.N.
r_comment() {
  local state="" head="" files="" path="" line="" c=""
  state=$(gh api "repos/$REPO/pulls/$2" --jq '"\(.state) \(.head.sha)"' 2>>"$RUN_DIR/r.comment.err") || return 1
  read -r state head <<<"$state"
  [ "$state" = open ] || { echo "PR #$2 is $state before the comment" >>"$RUN_DIR/r.comment.err"; return 1; }
  files=$(gh api "repos/$REPO/pulls/$2/files?per_page=100" 2>>"$RUN_DIR/r.comment.err") || return 1
  read -r path line <<<"$(python3 -c 'import json,re,sys
files = json.loads(sys.argv[1])
for f in files:
    new = None
    for l in (f.get("patch") or "").splitlines():
        m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", l)
        if m: new = int(m.group(1)); continue
        if new is None or l.startswith("\\"): continue
        if l.startswith("+"): print(f["filename"], new); sys.exit()
        if not l.startswith("-"): new += 1
print(files[0]["filename"] if files else "")' "$files")"
  [ -n "$path" ] || { echo "PR #$2 changes no file" >>"$RUN_DIR/r.comment.err"; return 1; }
  local where=(-f path="$path"); if [ -n "$line" ]; then where+=(-F line="$line" -f side=RIGHT); else where+=(-f subject_type=file); fi
  c=$(gh api -X POST "repos/$REPO/pulls/$2/comments" -f body="Drill: an open review thread. The integration suite resolves it once Factory holds on it." \
    -f commit_id="$head" "${where[@]}" --jq '{id, url: .html_url, path, at: .created_at}' 2>>"$RUN_DIR/r.comment.err") || return 1
  printf '%s\n' "$c" >"$RUN_DIR/threads-comment.$1"
  log "#$1: review thread opened on PR #$2 at $path${line:+:$line}"
}
# r_resolve N PR: resolve the suite's thread on PR (GraphQL resolveReviewThread); keeps its id in threads-thread.N.
r_resolve() {
  local cid="" tid="" r=""
  cid=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["id"])' "$RUN_DIR/threads-comment.$1") || return 1
  tid=$(gh api graphql -F p="$2" -f o="$OWNER" -f r="$NAME" \
    -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id comments(first:1){nodes{databaseId}}}}}}}' \
    --jq ".data.repository.pullRequest.reviewThreads.nodes[]|select(.comments.nodes[0].databaseId==$cid)|.id") && [ -n "$tid" ] || { log "#$1: the suite's review thread on PR #$2 wasn't found"; return 1; }
  r=$(gh api graphql -f t="$tid" -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' \
    --jq .data.resolveReviewThread.thread.isResolved) && [ "$r" = true ] || { log "#$1: resolving review thread $tid failed"; return 1; }
  echo "$tid" >"$RUN_DIR/threads-thread.$1"; log "#$1: review thread $tid resolved"
}
# r_github N: 0 when the suite's thread shows resolved and R's main still
# has a rule requiring thread resolution. Prints the evidence.
r_github() {
  local tid="" res="" rules="" ok=0
  tid=$(cat "$RUN_DIR/threads-thread.$1" 2>/dev/null)
  if [ -n "$tid" ]; then
    res=$(gh api graphql -f t="$tid" -f query='query($t:ID!){node(id:$t){... on PullRequestReviewThread{isResolved}}}' --jq .data.node.isResolved) || res="unreadable"
  else res="no, the suite never resolved it"; fi
  rules=$(gh api "repos/$REPO/rules/branches/main" --jq '[.[]|select(.type=="pull_request" and .parameters.required_review_thread_resolution==true)]|length') || rules="unreadable"
  [ "$res" = true ] && [[ $rules =~ ^[1-9] ]] || ok=1
  echo "thread resolved on GitHub: $res; rules on main requiring thread resolution: $rules"
  return $ok
}
# threads_check N T0 [LIVE LIVE_EVIDENCE]: from R's state, the case's records
# of its review comment and of the hold it met (threads-comment.N,
# threads-hold.N) alone (also run-suite.sh --replay). The hold is a Work
# Item's ci or merge step, asked within THREADS_BOUND of the comment, naming
# unresolved review threads with a link to the suite's, offering retry; then
# N done. LIVE is the GitHub part's exit (r_github, end_done), empty in a replay.
threads_check() {
  local n=$1 d=${KEPT:-$RUN_DIR} ev="" rk=0
  ev=$(python3 - "$d/threads-comment.$n" "$d/threads-hold.$n" "$(st status "$n")" "$THREADS_BOUND" <<'PY'
import datetime, json, re, sys
def read(path):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return None
c, h, status, bound = read(sys.argv[1]), read(sys.argv[2]), sys.argv[3], int(sys.argv[4])
t = lambda s: datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
if not c:
    print(f"no review thread was opened; now {status}")
    sys.exit(1)
if not h:
    print(f"no hold of a Work Item within {bound // 60} min of the thread at {c.get('path')} ({c.get('at')}), the silent wait; now {status}")
    sys.exit(1)
q = h.get("question") or ""
answers = h.get("answers") or [o.get("answer") for o in h.get("options") or [] if isinstance(o, dict)]
gap = int((t(h["askedAt"]) - t(c["at"])).total_seconds()) if h.get("askedAt") else None
want = {
    "a Work Item's ci or merge step": bool(re.fullmatch(r"item:.+:(ci|merge)", str(h.get("step")))),
    "naming unresolved review threads": "unresolved review thread" in q,
    "linking the suite's thread": f"discussion_r{c.get('id')}" in q,
    "offering retry": "retry" in answers,
    f"asked within {bound // 60} min of the thread": gap is not None and 0 <= gap <= bound,
    "then done": status == "done",
}
miss = [k for k, ok in want.items() if not ok]
print(f"thread on {c.get('path')} at {c.get('at')}; hold {h.get('step')} [{','.join(str(a) for a in answers)}] asked "
      f"{'?' if gap is None else gap} s after it; " + ("missing: " + ", ".join(miss) if miss else "; ".join(want)) + f"; now {status}")
sys.exit(1 if miss else 0)
PY
) || rk=$?
  rec_part holds.review-threads "$rk" "${3:-}" "#$n on $REPO: $ev${4:+; $4}" "$2"
}
replay_threads() { [ -s "$KEPT/inst/R/env" ] || return 0; inst R; local n; n=$(case_issues | head -1); [ -z "$n" ] || threads_check "$n" "$(now)"; }
