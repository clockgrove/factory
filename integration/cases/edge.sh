# The edge suite (run-suite.sh --suite edge) on clockgrove/factory-drill:
# PRD requirements no main case covers. Installation E serves; E2 is a
# fresh state directory that rebuilds Objectives from GitHub alone.

setup_edge() {
  clone $M_REPO "$STATE_BASE/checkout-e" || return 1
  write_config "$STATE_BASE/config-e.json" $M_REPO "$STATE_BASE/checkout-e" 6
  inst_define E $M_REPO "$STATE_BASE/config-e.json"
  inst_define E2 $M_REPO "$STATE_BASE/config-e.json"
  printf '%s\n' "FACTORY_BACKOFF_MS=10000" >"$RUN_DIR/inst/E/extra_env"; cp "$RUN_DIR/inst/E/extra_env" "$RUN_DIR/inst/E2/extra_env"
  if [ -n "$(git ls-remote "https://github.com/$M_REPO.git" refs/factory/holder 2>/dev/null)" ]; then
    git -C "$STATE_BASE/checkout-e" push -q origin :refs/factory/holder
  fi
  inst E; serve_up
}

# PRD 9: one delivered and one mid-build Objective, rebuilt by `factory reset`
# on a clean state directory (E2, which takes the repository over).
case_reset() {
  local t0 d b pr; t0=$(now)
  local HOLD_POLICY="d2 review decide"
  need reset.delivered "$t0" reset || { record reset.mid-build UNREACHABLE "feature absent: reset" "$t0"; return; }
  d=$(new_objective happy "reset delivered" ID="$(uid)") || return
  b=$(new_objective chain2 "reset mid-build" ID="$(uid)") || return
  wait_phase "$d" 'done|cancelled|failed' 1500 >/dev/null
  wait_for 1500 has_open_pr "$b"; pr=$(gh_open_pr "$b")
  [ -n "$pr" ] && [ "$(st status "$d")" = done ] || { record reset.delivered FAIL "setup: #$d $(st status "$d"), #$b open PR '${pr:-none}'" "$t0"; return; }
  local prs_d m_d prs_b; prs_d=$(gh_prs "$d"); m_d=$(gh_markers "$d")
  # E stops; E2 starts on an empty state directory and rebuilds both from GitHub.
  wait_for 600 test -e "$RUN_DIR/archived.done"   # the archived case uses E's queue first
  SERVE_DIR=$(serve_dir_of E); serve_down
  inst E2; serve_up "" takeover || return
  cli_t 120 reset "$d" >"$RUN_DIR/reset.$d.out" 2>&1; local rd=$?
  cli_t 120 reset "$b" >"$RUN_DIR/reset.$b.out" 2>&1; local rb=$?
  wait_for 300 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $d)\" = done ]"
  wait_phase "$b" 'done|cancelled|failed' 1500 >/dev/null; sleep 20
  PULLS_TTL=0 end_done "$d"; local okd=$?; [ "$(PULLS_TTL=0 gh_prs "$d")" = "$prs_d" ] && [ "$(gh_markers "$d")" = "$m_d" ] || okd=1
  rec_if reset.delivered $okd "reset exit $rd on a clean state dir: PRs and markers unchanged: $([ $okd = 0 ] && echo yes || echo no); $EVID" "$t0"
  end_done "$b"; rec_if reset.mid-build $? "reset exit $rb with PR #$pr open, then finished: $EVID" "$t0"
  SERVE_DIR=$(serve_dir_of E2)
}

# `factory run N` on an issue whose Project card is archived admits it.
case_archived() {
  local t0 n item; t0=$(now)
  need queue.archived-card "$t0" run || { touch "$RUN_DIR/archived.done"; return; }
  n=$(new_issue withdraw "archived card" ID="$(uid)") || return
  item=$(gh project item-add "$(gh_pj "d['number']")" --owner "$(gh_pj "d['owner']['login']")" --url "https://github.com/$REPO/issues/$n" --format json --jq .id) || return
  gh project item-archive "$(gh_pj "d['number']")" --owner "$(gh_pj "d['owner']['login']")" --id "$item" >/dev/null || { record queue.archived-card FAIL "couldn't archive #$n's card" "$t0"; return; }
  cli_t 40 run "$n" >>"$RUN_DIR/run.$n.out" 2>&1
  wait_for 300 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $n)\" != none ]"
  local s; s=$(st status "$n"); local adm; adm=$(st events "$n" event=admitted)
  cancel_wait "$n" 300; touch "$RUN_DIR/archived.done"
  [ "$s" != none ] && [ "$adm" -ge 1 ]; rec_if queue.archived-card $? "#$n with an archived card: 'factory run' admitted it ($s, admitted x$adm)" "$t0"
}
