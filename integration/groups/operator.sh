# operator: what an operator (or another account) does on GitHub around a
# running Objective, and what Factory must make of it:
#   forged-marker   a comment by another login carrying Factory's marker (S L380)
#   unchecked       a /factory comment whose author check fails waits and applies later (S L380)
#   incident        a second unreadable incident asks again; the old /factory cancel doesn't act (H L415)
#   edited-cancel   an old comment edited into /factory cancel doesn't act (H L415)
#   clock-ahead     a /factory answer right after queuing is read with the host clock ahead (H L415)
#   deleted-cancel  cancel after the issue is deleted settles and cleans up (H L415)
#   deleted-reply   a finished Objective's unsent reply to a deleted issue settles (H L416)
#   transfer        a transferred issue's cancel touches nothing in the other repo (H L416; approval)
#   rename          a renamed repository pauses, then resumes after the config fix (H L417; approval)
operator_needs() { echo "drill repo + Project; default provider; .github/workflows/drill-comment.yml on main for forged-marker (fixtures/repo/drill-comment.yml); a gh login that can delete issues (admin) for deleted-*; FACTORY_GITHUB_API; --allow-repo-changes for transfer (scratch repo) and rename"; }
operator_cost() { echo "~3-4 h; 6 hold Objectives to their plan question (1 planner call each), 1 cancel2 to an open PR, 2 happy Objectives to done (deleted-reply, rename)"; }
operator_minutes() { echo 240; }
OP_ONLY=${OP_ONLY:-forged-marker unchecked incident edited-cancel clock-ahead deleted-cancel deleted-reply transfer rename}
OP_PORT=${OP_PORT:-18559}
CLOCK_AHEAD_MS=${CLOCK_AHEAD_MS:-300000}
operator_plan() {
  echo "operator.forged-marker   github-actions[bot] posts '<!-- factory:N:plan -->' before planning: Factory still posts its own plan comment; the forged one is untouched $(pre)"
  echo "operator.unchecked       write-access read fails once (fault proxy) for a /factory answer: comment-unchecked logged, then it applies; a later /factory cancel applies too $(pre unchecked github-api)"
  echo "operator.incident        corrupt state, answer the question by '/factory cancel', re-queue, corrupt again: a second hold:unreadable:<digest> question; the old cancel doesn't act $(pre incident)"
  echo "operator.edited-cancel   a plain comment edited into '/factory cancel' while a hold is open: still held, no reply, not applied $(pre review-fixes)"
  echo "operator.clock-ahead     serve with Date ${CLOCK_AHEAD_MS} ms ahead (lib/clock-ahead.mjs); '/factory cancel' right after queuing is read and cancels $(pre review-fixes)"
  echo "operator.deleted-cancel  cancel2 with an open PR; issue deleted; cancel: cancelled, no open PR, no branch left $(pre review-fixes)"
  echo "operator.deleted-reply   a reply blocked by the proxy while the Objective finishes; issue deleted: reply-dropped logged, the sync stops posting $(pre gone-issue github-api)"
  echo "operator.transfer        held Objective's issue transferred to a scratch repo, then cancelled: the moved issue stays open with no new comment $(pre gone-issue approval:second-scratch-repo)"
  echo "operator.rename-pause    drill repo renamed with one held (question unposted) and one done (final card write unsent) Objective: service-problem, nothing posted $(pre repo-moved github-api approval:repo-rename)"
  echo "operator.rename-resume   config and state moved to the new name, restart: the question is posted, the card reads Done, no issue-gone; everything renamed back $(pre repo-moved github-api approval:repo-rename)"
}
operator_cfg() { cfg_patch "$CUR_CFG" 'c["queue"]["maxActiveObjectives"]=2' 'c["queue"]["pollSeconds"]=10'; }

# Wait for N's open plan question; prints the hold JSON (null when none came).
op_held() { wait_phase "$1" '^hold:' "${2:-1200}" >/dev/null; sleep 30; st hold "$1"; }
op_cancel() { cli_t 60 cancel "$1" >/dev/null 2>&1; wait_phase "$1" 'cancelled|done|failed' 900 >/dev/null; sleep 15; }

op_forged_marker() {
  local g=operator t0 n; t0=$(now)
  gh_has_workflow drill-comment.yml || { record operator.forged-marker $g UNREACHABLE "drill-comment.yml isn't on $REPO (copy fixtures/repo/drill-comment.yml to .github/workflows/)" "$t0"; return; }
  n=$(new_issue $g hold "operator forged marker" ID="$(uid)") || return
  gh workflow run drill-comment.yml --repo "$REPO" -f issue="$n" -f body="<!-- factory:$n:plan -->
Forged plan marker, posted by the drill as another login." >/dev/null 2>&1
  wait_for 300 bash -c "[ \"\$(gh api 'repos/$REPO/issues/$n/comments' --jq '[.[]|select(.user.type==\"Bot\")]|length')\" -ge 1 ]" \
    || { record operator.forged-marker $g FAIL "the workflow never posted the forged comment on #$n" "$t0"; return; }
  gh_enqueue "$n" >/dev/null
  local HOLD_POLICY="$HOLD_POLICY decide" me; me=$(gh_login)
  serve_alive || serve_start || return
  local end=$(( $(now) + 2400 )) cm mine=0
  while [ "$(now)" -lt "$end" ]; do
    serve_tick; auto_answer "$n"
    cm=$(gh_marker_comments "$n" plan)
    mine=$(python3 -c 'import json,sys;print(sum(1 for c in json.loads(sys.argv[1]) if c["login"]==sys.argv[2]))' "$cm" "$me")
    [ "$mine" -ge 1 ] && break
    case $(st status "$n") in cancelled|failed|done) break ;; esac
    sleep 20
  done
  sleep 20; cm=$(gh_marker_comments "$n" plan)
  local ev; ev=$(python3 -c 'import json,sys
c=json.loads(sys.argv[1]); me=sys.argv[2]
mine=[x for x in c if x["login"]==me]; other=[x for x in c if x["login"]!=me]
print(len(mine), len(other), all(x["updated"]==x["created"] for x in other))' "$cm" "$me")
  op_cancel "$n"; end_cancelled "$n"; local ok=$?
  local f o u; read -r f o u <<<"$ev"
  if [ "$f" = 1 ] && [ "$o" = 1 ] && [ "$u" = True ] && [ $ok = 0 ]; then record operator.forged-marker $g PASS "plan-marker comments: $f by $me, $o forged (untouched); $EVID" "$t0"
  else record operator.forged-marker $g FAIL "plan-marker comments by $me=$f, by others=$o, forged untouched=$u; $EVID" "$t0"; fi
}

op_unchecked() {
  local g=operator t0 n hold; t0=$(now)
  need operator.unchecked $g "$t0" unchecked github-api || return
  serve_stop; proxy_start op "$OP_PORT"
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV $PROXY_ENV"
  n=$(new_objective $g hold "operator unchecked comment" ID="$(uid)") || return
  serve_start || return
  hold=$(op_held "$n")
  [ "$hold" != null ] || { record operator.unchecked $g FAIL "#$n never asked its plan question" "$t0"; op_cancel "$n"; serve_stop; proxy_stop op; return; }
  # Write access is read again only after 10 minutes: wait that out from admission.
  local adm; adm=$(st get "$n" startedAt | python3 -c 'import json,sys,datetime;v=json.load(sys.stdin);print(int(datetime.datetime.fromisoformat(v.replace("Z","+00:00")).timestamp()) if v else 0)')
  local left=$(( adm + 660 - $(now) )); [ "$left" -gt 0 ] && { log "#$n: waiting $left s for the write-access cache to expire"; sleep "$left"; }
  proxy_rules op "GET ^/repos/$REPO/collaborators/[^/]+/permission\$ times=1"
  local rec c1 c2; rec=$(python3 -c 'import json,sys;h=json.loads(sys.argv[1]);a=[x for x in h["answers"] if x not in ("cancel","retry")];print(h["recommended"] if h["recommended"] not in ("cancel","retry") else (a[0] if a else "cancel"))' "$hold")
  c1=$(comment_answer "$n" "$rec" 'Use "/" as the separator.' "$(hold_field "$hold" id)"); sleep 3
  c2=$(gh_comment "$n" "/factory cancel")
  wait_phase "$n" 'cancelled|done|failed' 900 >/dev/null; sleep 30
  local f u1 a1 a2 s; f=$(proxy_count op GET '/collaborators/[^/]+/permission$' 502)
  u1=$(st events "$n" event=comment-unchecked "comment=$c1"); a1=$(st applied "$n" "comment-$c1"); a2=$(st applied "$n" "comment-$c2"); s=$(st status "$n")
  serve_stop; proxy_stop op
  local ev="permission reads failed $f; comment $c1 ($rec): unchecked events $u1, applied $a1; later comment $c2 (cancel): applied $a2; status $s"
  if [ "$f" = 0 ]; then record operator.unchecked $g UNREACHABLE "write access was never read while the fault was on; $ev" "$t0"
  elif [ "$u1" -ge 1 ] && [ "$a1" -ge 1 ] && [ "$a2" -ge 1 ] && [ "$s" = cancelled ]; then record operator.unchecked $g PASS "$ev" "$t0"
  else record operator.unchecked $g FAIL "$ev" "$t0"; fi
}

op_incident() {
  local g=operator t0 n; t0=$(now)
  need operator.incident $g "$t0" incident || return
  n=$(new_objective $g hold "operator unreadable incidents" ID="$(uid)") || return
  serve_alive || serve_start || return
  [ "$(op_held "$n")" != null ] || { record operator.incident $g FAIL "#$n never asked its plan question" "$t0"; op_cancel "$n"; return; }
  serve_stop
  local f="$ROOT/objectives/$n.json"
  echo '{"drill": "unreadable incident one' >"$f"
  serve_start || return
  wait_for 300 bash -c "gh api 'repos/$REPO/issues/$n/comments' --jq '.[].body' | grep -q 'factory:$n:hold:unreadable:'" \
    || { record operator.incident $g FAIL "no unreadable question for the first incident" "$t0"; return; }
  local cc; cc=$(gh_comment "$n" "/factory cancel")
  wait_phase "$n" 'cancelled' 600 >/dev/null; local s1; s1=$(st status "$n")
  gh_card "$n" Queued
  wait_phase "$n" '^hold:|^planning$|^building$' 1200 >/dev/null; sleep 20
  serve_stop
  cp "$f" "$RUN_DIR/state-$n.incident2.json"
  echo '{"drill": "unreadable incident two, other bytes' >"$f"
  serve_start || return
  local m2; wait_for 300 bash -c "[ \$(gh api 'repos/$REPO/issues/$n/comments' --paginate --jq '.[].body' | grep -o 'factory:$n:hold:unreadable:[^ ]*' | sort -u | wc -l) -ge 2 ]"
  sleep 90
  local m s2; m=$(gh_markers "$n"); m2=$(awk '$1 ~ /^hold:unreadable:/' <<<"$m"); s2=$(st status "$n")
  local qs; qs=$(wc -l <<<"$m2"); local dup; dup=$(awk '$2>1' <<<"$m2" | wc -l)
  local ev="first incident cancelled by comment $cc -> $s1; re-queued; second incident: unreadable questions [$(paste -sd' ' <<<"$m2")], status after 90 s $s2"
  serve_stop; cp "$RUN_DIR/state-$n.incident2.json" "$f"; serve_start || return
  op_cancel "$n"
  if [ "$s1" = cancelled ] && [ "$qs" = 2 ] && [ "$dup" = 0 ] && [ "$s2" = unreadable ]; then record operator.incident $g PASS "$ev" "$t0"
  else record operator.incident $g FAIL "$ev" "$t0"; fi
}

op_edited_cancel() {
  local g=operator t0 n c0; t0=$(now)
  need operator.edited-cancel $g "$t0" review-fixes || return
  n=$(new_objective $g hold "operator edited cancel" ID="$(uid)") || return
  c0=$(gh_comment "$n" "Drill note: nothing for Factory here.")
  serve_alive || serve_start || return
  [ "$(op_held "$n")" != null ] || { record operator.edited-cancel $g FAIL "#$n never asked its plan question" "$t0"; op_cancel "$n"; return; }
  gh api -X PATCH "repos/$REPO/issues/comments/$c0" -f body="/factory cancel" >/dev/null
  sleep 90
  local p r a; p=$(st phase "$n"); r=$(marker_count "$(gh_markers "$n")" "reply:comment-$c0"); a=$(st applied "$n" "comment-$c0")
  op_cancel "$n"; end_cancelled "$n"; local ok=$?
  local ev="comment $c0 edited into /factory cancel while held: phase after 90 s $p, reply x$r, applied $a; $EVID"
  if [[ $p == hold:* ]] && [ "$r" = 0 ] && [ "$a" = 0 ] && [ $ok = 0 ]; then record operator.edited-cancel $g PASS "$ev" "$t0"
  else record operator.edited-cancel $g FAIL "$ev" "$t0"; fi
}

op_clock_ahead() {
  local g=operator t0 n c p; t0=$(now)
  need operator.clock-ahead $g "$t0" review-fixes || return
  serve_stop
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV NODE_OPTIONS=--import=$SUITE/lib/clock-ahead.mjs DRILL_CLOCK_AHEAD_MS=$CLOCK_AHEAD_MS"
  serve_start || return
  n=$(new_objective $g hold "operator clock ahead" ID="$(uid)") || return
  c=$(gh_comment "$n" "/factory cancel")
  p=$(wait_phase "$n" 'cancelled|^hold:|done|failed' 1200)
  local a; a=$(st applied "$n" "comment-$c")
  [ "$p" = cancelled ] || op_cancel "$n"
  serve_stop
  local ev="host clock ${CLOCK_AHEAD_MS} ms ahead; '/factory cancel' (comment $c) right after queuing: reached $p, applied $a"
  if [ "$p" = cancelled ] && [ "$a" -ge 1 ]; then record operator.clock-ahead $g PASS "$ev" "$t0"
  else record operator.clock-ahead $g FAIL "$ev" "$t0"; fi
}

op_deleted_cancel() {
  local g=operator t0 n pr; t0=$(now)
  need operator.deleted-cancel $g "$t0" review-fixes || return
  n=$(new_objective $g cancel2 "operator deleted cancel" ID="$(uid)") || return
  serve_alive || serve_start || return
  local end=$(( $(now) + 2400 )); pr=""
  while [ "$(now)" -lt "$end" ] && [ -z "$pr" ]; do serve_tick; auto_answer "$n"; pr=$(gh_open_pr "$n"); [ -z "$pr" ] && sleep 10; done
  [ -n "$pr" ] || { record operator.deleted-cancel $g FAIL "#$n never opened a PR" "$t0"; op_cancel "$n"; return; }
  serve_stop
  gh issue delete "$n" --repo "$REPO" --yes >/dev/null 2>&1 || { record operator.deleted-cancel $g UNREACHABLE "the gh login can't delete issues on $REPO (needs admin)" "$t0"; serve_start; op_cancel "$n"; return; }
  serve_start || return
  cli_t 60 cancel "$n" >/dev/null 2>&1
  local p; p=$(wait_phase "$n" 'cancelled|failed|done' 1200); sleep 30; serve_stop
  local op br wt; op=$(gh_prs "$n" | python3 -c 'import json,sys;print(sum(1 for p in json.load(sys.stdin) if p["state"]=="OPEN"))')
  br=$(gh_branches_left "$n"); wt=$(worktrees_for "$n")
  local ev="#$n deleted with PR #$pr open; cancel -> $p; open PRs $op, factory/$n/ branches $br, worktrees $wt"
  if [ "$p" = cancelled ] && [ "$op" = 0 ] && [ "$br" = 0 ] && [ "$wt" = 0 ]; then record operator.deleted-cancel $g PASS "$ev" "$t0"
  else record operator.deleted-cancel $g FAIL "$ev" "$t0"; fi
}

op_deleted_reply() {
  local g=operator t0 n c p; t0=$(now)
  need operator.deleted-reply $g "$t0" gone-issue github-api || return
  serve_stop; proxy_start op "$OP_PORT"
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV $PROXY_ENV" HOLD_POLICY="$HOLD_POLICY decide"
  n=$(new_issue $g happy "operator deleted reply" ID="$(uid)") || return
  proxy_rules op "POST ^/repos/$REPO/issues/$n/comments\$ status=502 body=factory:$n:reply:"
  gh_enqueue "$n" >/dev/null
  serve_start || return
  wait_phase "$n" '^(planning|building|finishing)$' 900 >/dev/null
  c=$(gh_comment "$n" "/factory retry")   # no open question: Factory replies, and the proxy holds the reply back
  p=$(wait_phase "$n" 'done|cancelled|failed' 3600); sleep 30
  local held; held=$(proxy_count op POST "/issues/$n/comments\$" 502)
  serve_stop
  gh issue delete "$n" --repo "$REPO" --yes >/dev/null 2>&1 || { record operator.deleted-reply $g UNREACHABLE "the gh login can't delete issues on $REPO (needs admin)" "$t0"; proxy_stop op; return; }
  proxy_rules op
  serve_start || return
  sleep 120
  local before; before=$(proxy_count op POST "/issues/$n/comments\$")
  sleep 60
  local after rd s; after=$(proxy_count op POST "/issues/$n/comments\$"); rd=$(st events "$n" event=reply-dropped); s=$(st status "$n")
  serve_stop; proxy_stop op
  local ev="#$n $p with the reply to comment $c held back ($held refused posts); issue deleted; restart: reply-dropped x$rd, status $s, reply posts in the last 60 s $((after - before))"
  if [ "$p" = done ] && [ "$held" -ge 1 ] && [ "$rd" -ge 1 ] && [ "$s" = done ] && [ "$after" = "$before" ]; then record operator.deleted-reply $g PASS "$ev" "$t0"
  elif [ "$held" = 0 ]; then record operator.deleted-reply $g UNREACHABLE "no reply was ever held back (none posted); $ev" "$t0"
  else record operator.deleted-reply $g FAIL "$ev" "$t0"; fi
}

op_transfer() {
  local g=operator t0 n xr; t0=$(now)
  need operator.transfer $g "$t0" gone-issue || return
  approved operator.transfer $g "$t0" "a second scratch repository (issue transfer target)" || return
  # A standing scratch repo (DRILL_XFER_REPO, default NAME-2) is used as is; never created or deleted here.
  xr=${DRILL_XFER_REPO:-$NAME-2}
  gh repo view "$OWNER/$xr" >/dev/null 2>&1 || { record operator.transfer $g UNREACHABLE "scratch repo $OWNER/$xr doesn't exist" "$t0"; return; }
  n=$(new_objective $g hold "operator transfer" ID="$(uid)") || { restore_run; return; }
  serve_alive || serve_start || return
  [ "$(op_held "$n")" != null ] || { record operator.transfer $g FAIL "#$n never asked its plan question" "$t0"; op_cancel "$n"; restore_run; return; }
  local tt url m; tt=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  url=$(gh issue transfer "$n" "$OWNER/$xr" --repo "$REPO" 2>/dev/null); m=$(grep -o '[0-9]*$' <<<"$url")
  [ -n "$m" ] || { record operator.transfer $g FAIL "the transfer of #$n failed" "$t0"; op_cancel "$n"; restore_run; return; }
  sleep 20
  cli_t 60 cancel "$n" >/dev/null 2>&1
  local p; p=$(wait_phase "$n" 'cancelled|failed|done' 900); sleep 60
  local is nc; is=$(gh issue view "$m" --repo "$OWNER/$xr" --json state --jq .state)
  nc=$(gh api "repos/$OWNER/$xr/issues/$m/comments" --paginate --jq "[.[]|select(.created_at >= \"$tt\")]|length")
  serve_stop
  local ev="#$n moved to $OWNER/$xr#$m while held; cancel -> $p; moved issue $is, comments since the transfer $nc"
  restore_run
  if [ "$p" = cancelled ] && [ "$is" = OPEN ] && [ "$nc" = 0 ]; then record operator.transfer $g PASS "$ev" "$t0"
  else record operator.transfer $g FAIL "$ev" "$t0"; fi
}

# Rename: the repository answers under a new name. Factory pauses; the
# operator's fix is the configuration's repository plus the state directory,
# which follows the repository's name, then a restart.
op_rename() {
  local g=operator t0 f h new; t0=$(now)
  local c ok=0
  for c in operator.rename-pause operator.rename-resume; do need "$c" $g "$t0" repo-moved github-api || ok=1; done; [ $ok = 0 ] || return
  # OP_RENAME_APPROVED=1: renaming the drill repository is approved on its own, without the other --allow-repo-changes cases.
  for c in operator.rename-pause operator.rename-resume; do [ -n "${OP_RENAME_APPROVED:-}" ] || approved "$c" $g "$t0" "renaming the drill repository" || ok=1; done; [ $ok = 0 ] || return
  serve_stop; proxy_start op "$OP_PORT"
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV $PROXY_ENV" HOLD_POLICY="$HOLD_POLICY decide"
  f=$(new_issue $g happy "operator rename finished" ID="$(uid)") || return
  h=$(new_issue $g hold "operator rename held" ID="$(uid)") || return
  # The finished one's final card write and the held one's question stay unsent.
  proxy_rules op "POST ^/graphql\$ status=502 body=updateProjectV2ItemFieldValue" \
    "POST ^/repos/$REPO/issues/$h/comments\$ status=502 body=factory:$h:hold:"
  gh_enqueue "$f" >/dev/null; gh_enqueue "$h" >/dev/null
  serve_start || return
  local pf ph; pf=$(wait_phase "$f" 'done|cancelled|failed' 3600); ph=$(wait_phase "$h" '^hold:' 600); sleep 20
  serve_stop
  local card0 q0; card0=$(gh_card_value "$f"); q0=$(marker_prefix_count "$(gh_markers "$h")" hold:)
  if [ "$pf" != done ] || [[ $ph != hold:* ]] || [ "$card0" = Done ] || [ "$q0" != 0 ]; then
    for c in operator.rename-pause operator.rename-resume; do record "$c" $g UNREACHABLE "setup missed: #$f $pf (card '$card0'), #$h $ph (questions posted $q0)" "$t0"; done
    proxy_rules op; serve_start; op_cancel "$h"; serve_stop; proxy_stop op; return
  fi
  new="$NAME-renamed-$SFX"
  local oldroot=$ROOT newroot; newroot="$STATE/$(echo "$OWNER/$new" | tr 'A-Z' 'a-z' | sed 's#/#__#')"
  rc_rename "$new" || { record operator.rename-pause $g FAIL "the rename failed" "$t0"; restore_run; proxy_stop op; return; }
  proxy_rules op
  serve_start || { restore_run; return; }
  sleep 120
  local prob ev0 q1 card1
  prob=$(cli_t 30 status --json | python3 -c 'import json,sys;print(json.load(sys.stdin).get("problem") or "")' 2>/dev/null)
  ev0=$(st events 0 event=service-problem)
  q1=$( (REPO="$OWNER/$new"; gh_markers "$h") | awk '$1 ~ /^hold:/' | wc -l); card1=$( (NAME=$new; gh_card_value "$f") )
  serve_stop
  local evp="renamed to $OWNER/$new; status problem '${prob:0:120}', service-problem events $ev0; while paused: #$h questions $q1, #$f card '$card1'"
  if [ -n "$prob" ] && [ "$ev0" -ge 1 ] && [ "$q1" = 0 ] && [ "$card1" != Done ]; then record operator.rename-pause $g PASS "$evp" "$t0"
  else record operator.rename-pause $g FAIL "$evp" "$t0"; fi
  # The operator's fix: state and configuration follow the new name.
  t0=$(now)
  cp "$CUR_CFG" "$RUN_DIR/config.pre-rename.json"
  restore_push "cp '$RUN_DIR/config.pre-rename.json' '$CUR_CFG'"
  mv "$oldroot" "$newroot" && restore_push "mv '$newroot' '$oldroot'"
  cfg_patch "$CUR_CFG" "c['repository']='$OWNER/$new'"
  local REPO="$OWNER/$new" NAME=$new ROOT=$newroot
  serve_start || { restore_run; return; }
  wait_for 300 bash -c "gh api 'repos/$REPO/issues/$h/comments' --jq '.[].body' | grep -q 'factory:$h:hold:'"; sleep 60
  local q2 card2 gone; q2=$(gh_markers "$h" | awk '$1 ~ /^hold:/{s+=$2} END{print s+0}'); card2=$(gh_card_value "$f")
  gone=$(( $(st events "$f" event=issue-gone) + $(st events "$h" event=issue-gone) ))
  op_cancel "$h"; serve_stop
  local evr="config and state moved to $REPO, restarted: #$h questions $q2, #$f card '$card2', issue-gone events $gone"
  restore_run
  proxy_stop op
  if [ "$q2" = 1 ] && [ "$card2" = Done ] && [ "$gone" = 0 ]; then record operator.rename-resume $g PASS "$evr; renamed back" "$t0"
  else record operator.rename-resume $g FAIL "$evr; renamed back" "$t0"; fi
}

operator_run() {
  local t
  for t in $OP_ONLY; do
    case $t in
      forged-marker) op_forged_marker ;; unchecked) op_unchecked ;; incident) op_incident ;;
      edited-cancel) op_edited_cancel ;; clock-ahead) op_clock_ahead ;; deleted-cancel) op_deleted_cancel ;;
      deleted-reply) op_deleted_reply ;; transfer) op_transfer ;; rename) op_rename ;;
    esac
    serve_stop; proxy_stop op; restore_run
  done
}
