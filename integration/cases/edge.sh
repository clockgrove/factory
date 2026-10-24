# The edge suite (run-suite.sh --suite edge) on clockgrove/factory-drill:
# PRD requirements no main case covers. Installation E serves behind the fault proxy.

setup_edge() {
  clone $M_REPO "$STATE_BASE/checkout-e" || return 1
  write_config "$STATE_BASE/config-e.json" $M_REPO "$STATE_BASE/checkout-e" 6
  inst_define E $M_REPO "$STATE_BASE/config-e.json"
  if [ -n "$(git ls-remote "https://github.com/$M_REPO.git" refs/factory/holder 2>/dev/null)" ]; then
    git -C "$STATE_BASE/checkout-e" push -q origin :refs/factory/holder
  fi
  inst E; proxy_start E 18612
  printf '%s\n' "FACTORY_GITHUB_API=$PROXY_URL" "FACTORY_BACKOFF_MS=10000" >"$RUN_DIR/inst/E/extra_env"
  serve_up && serve_ready
}

# PRD 9: Objectives rebuilt from GitHub alone. Two at once: one delivered, one
# mid-build with its PR open (its merge refused by the proxy). The serve stops,
# their state and work files go (worktrees pruned), and `factory reset` rebuilds
# each: the delivered one stays done with no new PR or marker; the mid-build
# one runs plan review (review:1:1) and finishes on its one PR.
case_reset() {
  local t0 d b pr; t0=$(now)
  local HOLD_POLICY="d2 review decide more"
  need reset.clean-dir "$t0" reset-rebuild || { touch "$RUN_DIR/reset.done"; return; }
  d=$(new_objective happy "reset delivered" ID="$(uid)") || return
  b=$(new_objective happy "reset mid-build" ID="$(uid)") || return
  prule_add "PUT ^/repos/$REPO/pulls/[0-9]+/merge\$ status=502 body=factory/$b/"
  wait_phase "$d" 'done|cancelled|failed' 1500 >/dev/null
  wait_for 1500 has_open_pr "$b"; pr=$(gh_open_pr "$b")
  if [ -z "$pr" ] || [ "$(st status "$d")" != done ]; then record reset.clean-dir FAIL "setup: #$d $(st status "$d"), #$b open PR '${pr:-none}'" "$t0"; prule_clear; return; fi
  local prs_d m_d prs_b; prs_d=$(PULLS_TTL=0 gh_prs "$d"); m_d=$(gh_markers "$d"); prs_b=$(PULLS_TTL=0 gh_prs "$b")
  wait_for 600 test -e "$RUN_DIR/archived.done"   # the archived case needs the serve first
  serve_down
  local n; for n in "$d" "$b"; do rm -rf "$ROOT/objectives/$n.json" "$ROOT/objectives/finished/$n.json" "$ROOT/work/$n"; done
  git -C "$(cfg_get 'c["checkout"]')" worktree prune
  serve_up && serve_ready || return
  prule_clear
  cli_t 120 reset "$d" >"$RUN_DIR/reset.$d.out" 2>&1; local rd=$?
  cli_t 120 reset "$b" >"$RUN_DIR/reset.$b.out" 2>&1; local rb=$?
  wait_phase "$d" 'done|cancelled|failed' 600 >/dev/null
  wait_phase "$b" 'done|cancelled|failed' 1500 >/dev/null; sleep 20
  end_done "$d"; local okd=$?
  [ "$(PULLS_TTL=0 gh_prs "$d")" = "$prs_d" ] && [ "$(gh_markers "$d")" = "$m_d" ] || okd=1
  local ev="delivered #$d: reset exit $rd, PRs and markers unchanged: $([ $okd = 0 ] && echo yes || echo no); $EVID"
  end_done "$b"; local okb=$? rv; rv=$(st started "$b" 'review:1:1')
  [ "$(PULLS_TTL=0 gh_prs "$b" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')" = 1 ] && [ "$rv" = 1 ] || okb=1
  ev="$ev | mid-build #$b: reset exit $rb with PR #$pr open, plan review ran $rv, PRs before $prs_b, after $(PULLS_TTL=0 gh_prs "$b"); $EVID"
  [ $okd = 0 ] && [ $okb = 0 ]; rec_if reset.clean-dir $? "$ev" "$t0"
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
