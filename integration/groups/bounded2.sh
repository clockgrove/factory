# bounded2: the crash-point classes that never ran (cancel, rerun, reset,
# plan-data, hold-cancel) plus sync:cancel and sync:remind, in one 45-minute
# run (B2_LIMIT s, default 2700, hard). The points are process-wide, so a
# single driver crashes at one point at a time while five Objectives run:
#   H hold.md     CRASH_POINTS (hold -> cancel), requests:applied, sync:cancel:*
#   PD happy.md   plan:data:* (FACTORY_COMMENT_LIMIT=1500 for every serve)
#   K cancel2.md  cancel:* during CI on its PR, then the re-run's rerun:* and sync:item-issue:reopen:*, then done
#   R happy.md    reset:answered once it is done
#   M remind.md   sync:remind:* at a required review (the gate is set only for this, then removed)
# A point not reached within its time is UNREACHABLE (not reached), never FAIL.
bounded2_needs() { echo "drill repo + Project; direct PUT/DELETE of required_pull_request_reviews on main for sync:remind"; }
bounded2_cost() { echo "<=45 min; 5 Objectives (K, R to done)"; }
bounded2_minutes() { echo 45; }
bounded2_plan() { echo "crash points: CRASH_POINTS, requests:applied, cancel:*, rerun:*, sync:item-issue:reopen:*, reset:answered, plan:data:*, sync:cancel:*, sync:remind:* (${B2_LIMIT:-2700} s limit)"; }
bounded2_cfg() { cfg_patch "$CUR_CFG" 'c["queue"]["maxActiveObjectives"]=5' 'c["queue"]["pollSeconds"]=10'; }

b2_left() { echo $(( B2_END - $(now) )); }
# Auto answers for everything but H (H's planner question is the hold the cancel chain needs).
b2_tick() {
  local n
  for n in $B2_AUTO; do [[ $(st phase "$n") == hold:* ]] && HOLD_POLICY="d2 review decide" auto_answer "$n" >/dev/null; done
}
b2_clean() { serve_alive || { serve_stop; serve_start || return 1; }; }
# b2_crash POINT SECS [HOOK]: serve with POINT until it crashes or SECS pass; then a clean serve again.
b2_crash() {
  local pt=$1 secs=$2 hook=${3:-} code=""
  [ "$(b2_left)" -gt 20 ] || { CH[$pt]="not run (limit)"; return 1; }
  [ "$secs" -gt "$(b2_left)" ] && secs=$(b2_left)
  serve_stop; serve_start "$pt" || return 1
  [ -n "$hook" ] && $hook
  local end=$(( $(now) + secs ))
  while [ "$(now)" -lt "$end" ]; do
    serve_tick
    [ -s "$SERVE_DIR/exit" ] && { code=$(cat "$SERVE_DIR/exit"); break; }
    b2_tick; sleep 3
  done
  serve_stop
  if [ "$code" = 137 ]; then CH[$pt]="crashed $(ts)"; log "CRASHED at $pt"; else CH[$pt]="missed (not reached in ${secs}s, exit ${code:-none})"; log "NOT crashed at $pt"; fi
  b2_clean
}
# b2_idle SECS CMD...: a clean serve until CMD holds (or SECS / the limit); does the opportunistic jobs.
b2_idle() {
  local secs=$1; shift; local end=$(( $(now) + secs ))
  [ "$end" -gt "$B2_END" ] && end=$B2_END
  b2_clean
  while [ "$(now)" -lt "$end" ]; do
    serve_tick; b2_tick; b2_jobs
    "$@" && return 0
    [ -s "$SERVE_DIR/exit" ] && { log "clean serve exited $(cat "$SERVE_DIR/exit")"; serve_stop; b2_clean; }
    sleep 5
  done
  return 1
}
# Opportunistic: reset R once it is done.
b2_jobs() {
  if [ -z "$R_RESET" ] && [ "$(st status "$R")" = done ] && [ -z "$B2_BUSY" ]; then
    sleep 20; R_RESET=1; R_PRS=$(gh_prs "$R")
    B2_BUSY=1; b2_crash reset:answered 120 b2_reset_hook; B2_BUSY=""
  fi
}
b2_reset_hook() { sleep 5; cli_t 60 reset "$R" >/dev/null 2>&1; log "#$R reset sent"; }
b2_cancel_h() { sleep 3; cli_t 60 cancel "$H" >/dev/null 2>&1; log "#$H cancel sent"; }
b2_cancel_k() { sleep 3; cli_t 60 cancel "$K" >/dev/null 2>&1; log "#$K cancel sent"; }
b2_has_pr() { [ -n "$(gh_open_pr "$K")" ]; }
b2_held() { [[ $(st phase "$1") == hold:* ]]; }
b2_settled() { [ "$(st status "$1")" = "$2" ] && { [ "$2" != cancelled ] || [ "$(st has "$1" done.cancel:cleanup)" = 1 ]; }; }
b2_at_gate() { st get "$1" retries | python3 -c 'import json,sys;r=json.load(sys.stdin) or {};sys.exit(0 if any((v.get("wait") or {}).get("kind")=="gate" for v in r.values()) else 1)'; }
# b2_record GROUP OK EVIDENCE T0 POINT...: PASS crashed+ok, FAIL crashed+not ok, UNREACHABLE missed.
b2_record() {
  local g=$1 ok=$2 ev=$3 t0=$4; shift 4; local pt
  for pt in "$@"; do
    case ${CH[$pt]:-not run} in
      crashed*) if [ "$ok" = 0 ]; then record "crash-points.$pt" crash-points PASS "${CH[$pt]}; $ev" "$t0"; else record "crash-points.$pt" crash-points FAIL "${CH[$pt]}; $ev" "$t0"; fi ;;
      *) record "crash-points.$pt" crash-points UNREACHABLE "${CH[$pt]:-not run}; $ev" "$t0" ;;
    esac
  done
}

bounded2_run() {
  local g=bounded2 t0; t0=$(now); B2_END=$(( t0 + ${B2_LIMIT:-2700} )); CH=()
  PD_CANCEL=""; R_RESET=""; R_PRS=""; B2_BUSY=""
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_COMMENT_LIMIT=${CP_COMMENT_LIMIT:-1500}"
  H=$(new_objective crash-points hold "bounded2 hold-cancel" ID="$(uid)") || return
  PD=$(new_objective crash-points happy "bounded2 plan data" ID="$(uid)") || return
  K=$(new_objective crash-points cancel2 "bounded2 cancel/rerun" ID="$(uid)") || return
  R=$(new_objective crash-points happy "bounded2 reset" ID="$(uid)") || return
  B2_AUTO="$PD $K $R"
  # ---- CRASH_POINTS (generic ones while the four are checked and planned)
  local LOCAL1="engine:check:started engine:check:before-apply engine:check:applied serve:loaded state:before-rename state:saved state:saved#2 state:saved#3 state:saved#4 state:saved#5"
  local pt; for pt in $LOCAL1; do b2_crash "$pt" 120; done
  # ---- plan data (any plan posted under the 1,500-char comment limit)
  B2_BUSY=1; b2_crash plan:data:before 600; b2_crash plan:data:after 600; B2_BUSY=""
  # ---- H's cancel: the request, the engine's cleanup, the cancel comment
  b2_idle 900 b2_held "$H"
  B2_BUSY=1
  b2_crash requests:applied 90 b2_cancel_h
  for pt in engine:cancel:cleanup:started engine:cancel:cleanup:before-apply engine:cancel:cleanup:applied sync:cancel:before sync:cancel:after; do b2_crash "$pt" 90; done
  B2_BUSY=""
  b2_idle 300 b2_settled "$H" cancelled
  local tH=$t0; sleep 10
  end_cancelled "$H"; local okH=$? mH; mH=$(gh_markers "$H")
  local cc; cc=$(marker_prefix_count "$mH" cancelled:); [ "$cc" = 1 ] || okH=1
  b2_record $g $okH "cancel comment x$cc; $EVID" "$tH" $LOCAL1 requests:applied engine:cancel:cleanup:started engine:cancel:cleanup:before-apply engine:cancel:cleanup:applied sync:cancel:before sync:cancel:after
  # ---- K: cancel during CI on its open PR
  local pr=""
  # PD has posted its plan by now (plan:data ran): cancel it unless done, so its cleanup can't meet K's cancel points.
  case $(st status "$PD") in done|cancelled|failed) ;; *) cli_t 60 cancel "$PD" >/dev/null 2>&1; PD_CANCEL=$(now); log "#$PD cancel sent" ;; esac
  b2_idle 1500 b2_has_pr
  pr=$(gh_open_pr "$K"); local tK=$(now)
  local CANCEL_PTS="cancel:pr-comment:before cancel:pr-comment:after cancel:pr-close:before cancel:pr-close:after cancel:branch-delete:before cancel:branch-delete:after cancel:close:before cancel:close:after"
  if [ -z "$pr" ]; then for pt in $CANCEL_PTS; do CH[$pt]="not run (#$K opened no PR within the limit)"; done
  else
    # PD and R must not be cancelling meanwhile (cancel:close is theirs too): PD settles first.
    [ -n "$PD_CANCEL" ] && b2_idle 240 b2_settled "$PD" cancelled
    B2_BUSY=1; local first=1
    for pt in $CANCEL_PTS; do if [ $first = 1 ]; then b2_crash "$pt" 120 b2_cancel_k; first=0; else b2_crash "$pt" 120; fi; done
    B2_BUSY=""
    [ "$(st status "$K")" = cancelled ] || cli_t 60 cancel "$K" >/dev/null 2>&1
    b2_idle 400 b2_settled "$K" cancelled; sleep 15
  fi
  end_cancelled "$K"; local okK=$? pc; pc=$(marker_prefix_count "$(gh_markers "$K")" pr-cancelled:); [ "$pc" = 1 ] || okK=1
  b2_record $g $okK "PR #${pr:-none}; pr-cancelled x$pc; $EVID" "$tK" $CANCEL_PTS
  # ---- K's re-run: reopen the PR, re-queue; the reopen of the issue is the rerun's own (rerun:reopen:*)
  local RERUN_PTS="rerun:pr-comment:before rerun:pr-comment:after rerun:pr-close:before rerun:pr-close:after rerun:status:before rerun:status:after rerun:reopen:before rerun:reopen:after"
  local REOPEN_PTS="sync:item-issue:reopen:before sync:item-issue:reopen:after"
  local tR=$(now)
  if [ -n "$pr" ] && b2_settled "$K" cancelled; then
    gh pr reopen "$pr" --repo "$REPO" >/dev/null 2>&1; gh_card "$K" Queued
    B2_BUSY=1; for pt in $RERUN_PTS; do b2_crash "$pt" 150; done
    for pt in $REOPEN_PTS; do b2_crash "$pt" 600; done; B2_BUSY=""
    b2_idle 1500 bash -c "s=\$(python3 '$SUITE/lib/st.py' '$ROOT' status $K); [ \"\$s\" = done ] || [ \"\$s\" = failed ]"
    sleep 20
  else for pt in $RERUN_PTS $REOPEN_PTS; do CH[$pt]="not run (no cancelled #$K with a PR)"; done; fi
  end_done "$K"; local okR=$? rp; rp=$(marker_prefix_count "$(gh_markers "$K")" pr-replanned:); [ "$rp" = 1 ] || okR=1
  b2_record $g $okR "pr-replanned x$rp; $EVID" "$tR" $RERUN_PTS $REOPEN_PTS
  # ---- reset (R done; done opportunistically by b2_jobs, or now)
  [ -z "$R_RESET" ] && b2_idle 600 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $R)\" = done ]" && b2_jobs
  [ -n "$R_RESET" ] && { b2_idle 300 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $R)\" = done ]"; sleep 10; }
  end_done "$R"; local okS=$?; [ -n "$R_RESET" ] && [ "$(gh_prs "$R")" = "$R_PRS" ] || okS=1
  b2_record $g $okS "PRs unchanged by reset: $([ "$(gh_prs "$R")" = "$R_PRS" ] && echo yes || echo no); $EVID" "$t0" reset:answered
  # ---- plan data on PD (and no duplicate markers on K or R either)
  case $(st status "$PD") in done|cancelled|failed) ;; *) cli_t 60 cancel "$PD" >/dev/null 2>&1 ;; esac
  b2_idle 300 bash -c "s=\$(python3 '$SUITE/lib/st.py' '$ROOT' status $PD); [ \"\$s\" = done ] || [ \"\$s\" = cancelled ]"; sleep 10
  local mP parts dup okP; mP=$(gh_markers "$PD"); parts=$(marker_prefix_count "$mP" plan-data:); dup=$(marker_dupes "$mP")
  if [ "$(st status "$PD")" = done ]; then end_done "$PD"; okP=$?; else end_cancelled "$PD"; okP=$?; fi
  [ "$parts" -ge 1 ] && [ -z "$dup" ] && [ "$(marker_count "$mP" plan)" = 1 ] || okP=1
  b2_record $g $okP "#$PD plan x$(marker_count "$mP" plan), plan-data parts $parts${dup:+, DUPES $dup}; $EVID" "$t0" plan:data:before plan:data:after
  # ---- remind at a required review (gate on only for this; removed right after)
  local REMIND_PTS="sync:remind:before sync:remind:after" tM=$(now)
  if [ "$(b2_left)" -lt 600 ]; then for pt in $REMIND_PTS; do CH[$pt]="not run (under 10 min left)"; done
  elif ! { restore_push b2_gate_off; b2_gate_on; }; then for pt in $REMIND_PTS; do CH[$pt]="not run (the review gate could not be set with PUT)"; done
  else
    M=$(new_objective crash-points remind "bounded2 remind" ID="$(uid)"); B2_AUTO="$B2_AUTO $M"
    SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_REMIND_MS=20000"; serve_stop; b2_clean
    b2_idle 1500 b2_at_gate "$M"
    if b2_at_gate "$M"; then B2_BUSY=1; for pt in $REMIND_PTS; do b2_crash "$pt" 120; done; B2_BUSY=""; b2_idle 60 false
    else for pt in $REMIND_PTS; do CH[$pt]="missed (#$M never waited at the gate)"; done; fi
    local mM rm rd; mM=$(gh_markers "$M"); rm=$(marker_prefix_count "$mM" remind:); rd=$(marker_dupes "$mM")
    cli_t 60 cancel "$M" >/dev/null 2>&1; b2_idle 300 b2_settled "$M" cancelled; sleep 10
    b2_gate_off; restore_run
    end_cancelled "$M"; local okM=$?; [ "$rm" = 1 ] && [ -z "$rd" ] || okM=1
    b2_record $g $okM "remind comments $rm${rd:+, DUPES $rd}; gate removed: $([ "$(gh_human_gate)" = false ] && echo yes || echo NO); $EVID" "$tM" $REMIND_PTS
    M_DONE=1
  fi
  [ -z "${M_DONE:-}" ] && b2_record $g 1 "" "$tM" $REMIND_PTS
  # ---- the limit: cancel what is left
  local n; for n in $H $PD $K $R ${M:-}; do case $(st status "$n") in done|cancelled|failed|none) ;; *) cli_t 60 cancel "$n" >/dev/null 2>&1; log "#$n cancelled at the end" ;; esac; done
  B2_END=$(( $(now) + 300 )); for n in $H $PD $K $R ${M:-}; do b2_idle 120 bash -c "s=\$(python3 '$SUITE/lib/st.py' '$ROOT' status $n); [ \"\$s\" != planning ] && [ \"\$s\" != building ] && [ \"\$s\" != finishing ] && [ \"\$s\" != checking ] && [ \"\$s\" != holding ]"; done
  sleep 15; serve_stop
}
# The review gate changes only through these two direct calls.
b2_gate_on() {
  gh api -X PUT "repos/$REPO/branches/main/protection/required_pull_request_reviews" -F required_approving_review_count=1 >/dev/null 2>"$RUN_DIR/gate-on.err" \
    && [ "$(gh_human_gate)" = true ] && { log "review gate ON (PUT)"; return 0; }
  log "PUT required_pull_request_reviews failed: $(head -c 200 "$RUN_DIR/gate-on.err")"; return 1
}
b2_gate_off() {
  [ "$(gh_human_gate)" = true ] || return 0
  gh api -X DELETE "repos/$REPO/branches/main/protection/required_pull_request_reviews" >/dev/null 2>&1
  [ "$(gh_human_gate)" = false ] && log "review gate OFF (DELETE)" || log "RESTORE FAILED: review gate still on; run: gh api -X DELETE repos/$REPO/branches/main/protection/required_pull_request_reviews"
}
