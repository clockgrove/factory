# The edge suite (run-suite.sh --suite edge) on the run's own repository
# (M_REPO): PRD requirements no main case covers. Installation E serves behind
# the fault proxy.

setup_edge() {
  clone $M_REPO "$STATE_BASE/checkout-e" || return 1
  write_config "$STATE_BASE/config-e.json" $M_REPO "$STATE_BASE/checkout-e" 6
  inst_define E $M_REPO "$STATE_BASE/config-e.json"
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
