# crash-points: every GitHub-side crash point of the selected build, and its
# local CRASH_POINTS list, enumerated by lib/crashpoints.mjs from the build's
# crashPoint() call sites — never a list kept here. Each point gets the
# scenario that reaches it; a point with no scenario, no site, or a
# precondition the drill repo lacks is UNREACHABLE with the reason.
crash_points_needs() { echo "drill repo + Project; default provider; sync:remind:* needs a human gate (required review) on main; reset:* needs a build with 'factory reset'"; }
crash_points_cost() { echo "~3-5 h: ~10 happy/cancel/rerun Objectives to completion + one hold Objective per CRASH_POINTS entry (planner call each). CRASH_LISTS=GITHUB halves it"; }
crash_points_minutes() { echo 300; }
CRASH_LISTS=${CRASH_LISTS:-GITHUB CRASH_POINTS}
# Order in which the happy-path points come up on one Objective.
CP_HAPPY_ORDER="serve:admitted sync:show:before sync:show:after plan:post:before plan:post:after sync:note:before sync:note:after deliver:branch-delete:before deliver:branch-delete:after report:comment:before report:comment:after report:close:before report:close:after"
CP_CHAIN_MAX=${CP_CHAIN_MAX:-4}

cp_points() {
  node "$SUITE/lib/crashpoints.mjs" "$BUILD" lists | awk -F'\t' -v L=" $CRASH_LISTS " 'index(L, " "$1" ")'
}
cp_class() {
  case $1 in
    plan:data:*) echo plan-data ;;
    # Their points run in the tracking group (tracking, run, cancel comment, reminder, deadline).
    sync:status:*|sync:objective-role:*|sync:roles:label:*|sync:cancel:*|run:*|engine:deadline:*) echo tracking ;;
    deliver:push:*|deliver:pr-create:*|deliver:merge:*) echo exec ;;
    deliver:update-branch:*|stack:*) echo stack ;;
    sync:item-issue:reopen:*) echo rerun ;;
    sync:item-issue:*) echo tracking ;;
    sync:remind:*) if build_has_token '"remind", `hold'; then echo tracking; else echo remind; fi ;;
    sync:ask:*|sync:reply:*) echo hold ;;
    cancel:*) echo cancel ;;
    rerun:*) echo rerun ;;
    serve:withdrawn) echo withdraw ;;
    reset:*) echo reset ;;
    *) if [[ " $CP_HAPPY_ORDER " == *" $1 "* ]]; then echo happy; else echo none; fi ;;
  esac
}
crash_points_plan() {
  local list pt site
  cp_points | while IFS=$'\t' read -r list pt site; do
    if [ "$pt" = - ]; then echo "$list: not declared by this build (nothing to enumerate)"; continue; fi
    local cls; [ "$list" = CRASH_POINTS ] && cls=hold-cancel || cls=$(cp_class "$pt")
    case $cls in
      plan-data) cls="plan-data (bigplan.md: 48 one-helper Work Items so the plan JSON exceeds 65,000 chars; CP_PLAN_DATA=0 skips) $(pre)" ;;
      remind) cls="remind (a human gate on main: present, or added with --allow-repo-changes) $(pre approval:human-gate)" ;;
      none) cls="UNREACHABLE (no scenario in the suite)" ;;
      tracking|exec|stack) cls="(run in the $cls group)" ;;
    esac
    [ "$site" = no ] && cls="UNREACHABLE (no crashPoint site in build)"
    printf 'crash-points.%-28s %-20s %s\n' "$pt" "[$list]" "$cls"
  done
}

# Crash at each plan:data point on one big-plan Objective. A plan that stays
# under the comment limit never reaches them: UNREACHABLE, not FAIL.
cp_plan_data() {
  local g=crash-points t0 n p pt HOLD_POLICY="$HOLD_POLICY decide"; t0=$(now); CH=()
  # FACTORY_COMMENT_LIMIT (tests only) lowers the comment limit, so a small plan takes
  # the plan-data continuation comments; older builds need bigplan's 48 items.
  local tpl=bigplan
  if build_has_env FACTORY_COMMENT_LIMIT; then tpl=happy; local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_COMMENT_LIMIT=${CP_COMMENT_LIMIT:-1500}"; fi
  n=$(new_objective $g $tpl "crash plan data" ID="$(uid)") || return
  for pt in "$@"; do
    serve_start "$pt" || return
    local end=$(( $(now) + ${CRASH_TIMEOUT:-3600} )) r=timeout
    while [ "$(now)" -lt "$end" ]; do
      serve_tick
      [ -s "$SERVE_DIR/exit" ] && { r=$(cat "$SERVE_DIR/exit"); break; }
      p=$(st phase "$n")
      [[ $p =~ ^(building|finishing|done|cancelled|failed)$ ]] && { r="past planning ($p)"; break; }
      [[ $p == hold:* ]] && auto_answer "$n"
      sleep 5
    done
    serve_stop
    [ "$r" = 137 ] && CH[$pt]="crashed $(ts)" || CH[$pt]="missed ($r)"; log "#$n $pt: ${CH[$pt]}"
  done
  serve_start || return
  wait_phase "$n" '^(building|finishing|done)$' 2400 >/dev/null; sleep 30
  local m parts dup; m=$(gh_markers "$n"); parts=$(marker_prefix_count "$m" plan-data:); dup=$(marker_dupes "$m")
  cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled|done|failed' 1800 >/dev/null; sleep 15; serve_stop
  end_cancelled "$n"; local ok=$?
  local ev="plan x$(marker_count "$m" plan), plan-data parts $parts${dup:+, DUPES $dup}; $EVID"
  if [ "$parts" = 0 ]; then
    for pt in "$@"; do record "$g.$pt" $g UNREACHABLE "the plan stayed under the comment limit (no plan-data part); $ev" "$t0"; done
  else
    [ -z "$dup" ] && [ "$(marker_count "$m" plan)" = 1 ] || ok=1
    record_chain $g $ok "$ev" "$t0" "$@"
  fi
}

cp_cancel_hook() { [ -f "$RUN_DIR/cp-cancel-sent" ] && return; touch "$RUN_DIR/cp-cancel-sent"; sleep 5; cli_t 60 cancel "$1" >/dev/null 2>&1; log "#$1 cancel sent"; }

crash_points_run() {
  local g=crash-points t0 list pt site
  declare -A cls=() ; local happy=() hold=() cancel=() rerun=() withdraw=() reset=() remind=() plandata=() local_pts=()
  t0=$(now)
  while IFS=$'\t' read -r list pt site; do
    [ "$pt" = - ] && { record "crash-points.$list" $g UNREACHABLE "$list is not declared by this build" "$t0"; continue; }
    [ "$site" = no ] && { record "$g.$pt" $g UNREACHABLE "no crashPoint site for $pt in this build" "$t0"; continue; }
    if [ "$list" = CRASH_POINTS ]; then [ -z "${CP_CLASSES:-}" ] || [[ " $CP_CLASSES " == *" hold-cancel "* ]] && local_pts+=("$pt"); continue; fi
    [ -n "${CP_CLASSES:-}" ] && [[ " $CP_CLASSES " != *" $(cp_class "$pt") "* ]] && continue
    case $(cp_class "$pt") in
      happy) happy+=("$pt") ;; hold) hold+=("$pt") ;; cancel) cancel+=("$pt") ;; rerun) rerun+=("$pt") ;;
      withdraw) withdraw+=("$pt") ;; reset) reset+=("$pt") ;; remind) remind+=("$pt") ;;
      plan-data) plandata+=("$pt") ;;
      tracking|exec|stack) ;;   # recorded by that group
      *) record "$g.$pt" $g UNREACHABLE "the suite has no scenario for this point" "$t0" ;;
    esac
  done < <(cp_points)
  # A re-run reopens its item issues only after its plan is accepted: those points go last in the rerun chain.
  local rr=() rl=(); for p in "${rerun[@]}"; do [[ $p == sync:item-issue:reopen:* ]] && rl+=("$p") || rr+=("$p"); done; rerun=("${rr[@]}" "${rl[@]}")
  build_has_env FACTORY_NOTE_MS && SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_NOTE_MS=20000"
  local base_cfg=$CUR_CFG

  # Happy path: chains of up to CP_CHAIN_MAX points per Objective, in path order.
  local ordered=() p; for p in $CP_HAPPY_ORDER; do [[ " ${happy[*]} " == *" $p "* ]] && ordered+=("$p"); done
  local i=0 n
  while [ $i -lt ${#ordered[@]} ]; do
    local part=("${ordered[@]:$i:$CP_CHAIN_MAX}"); i=$((i + CP_CHAIN_MAX))
    t0=$(now); CH=()
    n=$(new_objective $g happy "crash happy ${part[0]}" ID="$(uid)") || continue
    chain "$n" "${part[@]}"
    serve_start || return
    wait_phase "$n" 'done|cancelled|failed' 2700 >/dev/null; sleep 20; serve_stop
    end_done "$n"; record_chain $g $? "$EVID" "$t0" "${part[@]}"
  done

  # Hold: ask points while the question posts, reply points while the answer applies.
  if [ ${#hold[@]} -gt 0 ]; then
    t0=$(now); CH=()
    n=$(new_objective $g hold "crash hold" ID="$(uid)")
    local ask=() reply=(); for p in "${hold[@]}"; do [[ $p == sync:ask:* ]] && ask+=("$p") || reply+=("$p"); done
    [ ${#ask[@]} -gt 0 ] && chain "$n" "${ask[@]}"
    serve_start || return
    local ph; ph=$(wait_phase "$n" '^hold:' 1200); sleep 30
    local hid rec; read -r hid rec < <(python3 -c 'import json,sys;h=json.loads(sys.argv[1]) or {};a=[x for x in h.get("answers",[]) if x not in ("cancel","retry")];print(h.get("id","-"), h.get("recommended") if h.get("recommended") not in ("cancel","retry",None) else (a[0] if a else "cancel"))' "$(st hold "$n")")
    serve_stop
    local cid=""; [ ${#reply[@]} -gt 0 ] && cid=$(comment_answer "$n" "$rec" 'Use "/" as the separator.' "$hid")
    [ ${#reply[@]} -gt 0 ] && chain "$n" "${reply[@]}"
    serve_start || return
    wait_phase "$n" '^(planning|building|finishing|done)$' 900 >/dev/null; sleep 30
    local m q r; m=$(gh_markers "$n"); q=$(marker_count "$m" "hold:$hid"); r=$(marker_count "$m" "reply:comment-$cid")
    cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled|done' 600 >/dev/null; sleep 15; serve_stop
    end_cancelled "$n"; local ok=$?
    [ "$q" = 1 ] || ok=1; [ -z "$cid" ] || [ "$r" = 1 ] || ok=1
    record_chain $g $ok "question x$q${cid:+ reply x$r}; $EVID" "$t0" "${hold[@]}"
  fi

  # Cancel during CI on an open PR, then (if listed) re-run the cancelled Objective.
  if [ ${#cancel[@]} -gt 0 ] || [ ${#rerun[@]} -gt 0 ]; then
    t0=$(now); CH=()
    n=$(new_objective $g cancel2 "crash cancel/rerun" ID="$(uid)")
    serve_start || return
    local pr=""; local end=$(( $(now) + 2400 ))
    while [ "$(now)" -lt "$end" ] && [ -z "$pr" ]; do serve_tick; pr=$(gh_open_pr "$n"); [ -z "$pr" ] && sleep 10; done
    serve_stop
    if [ -z "$pr" ]; then
      for p in "${cancel[@]}" "${rerun[@]}"; do record "$g.$p" $g FAIL "#$n never opened a PR to cancel on" "$t0"; done
    else
      rm -f "$RUN_DIR/cp-cancel-sent"
      [ ${#cancel[@]} -gt 0 ] && CRASH_HOOK=cp_cancel_hook chain "$n" "${cancel[@]}"
      [ -f "$RUN_DIR/cp-cancel-sent" ] || { serve_start; cp_cancel_hook "$n"; }
      serve_alive || serve_start
      wait_phase "$n" 'cancelled' 1800 >/dev/null; sleep 20; serve_stop
      end_cancelled "$n"; local ok=$? pc; pc=$(marker_prefix_count "$(gh_markers "$n")" pr-cancelled:)
      [ "$pc" = 1 ] || ok=1
      [ ${#cancel[@]} -gt 0 ] && record_chain $g $ok "pr-cancelled x$pc; $EVID" "$t0" "${cancel[@]}"
      if [ ${#rerun[@]} -gt 0 ]; then
        t0=$(now); CH=()
        gh pr reopen "$pr" --repo "$REPO" >/dev/null 2>&1
        [[ " ${rerun[*]} " == *" rerun:reopen:"* ]] || gh issue reopen "$n" --repo "$REPO" >/dev/null 2>&1
        gh_card "$n" Queued
        chain "$n" "${rerun[@]}"
        serve_start || return
        wait_phase "$n" 'done|cancelled|failed' 2700 >/dev/null; sleep 20; serve_stop
        end_done "$n"; ok=$?; local rp; rp=$(marker_prefix_count "$(gh_markers "$n")" pr-replanned:)
        [ "$rp" = 1 ] || ok=1
        record_chain $g $ok "pr-replanned x$rp; $EVID" "$t0" "${rerun[@]}"
      fi
    fi
  fi

  # Withdraw a checked Objective waiting for the only slot.
  if [ ${#withdraw[@]} -gt 0 ]; then
    t0=$(now); CH=()
    CUR_CFG="$RUN_DIR/config.$g-withdraw.json"; cp "$base_cfg" "$CUR_CFG"; cfg_patch "$CUR_CFG" 'c["queue"]["maxActiveObjectives"]=1'
    local f w; f=$(new_objective $g filler "crash withdraw filler" ID="$(uid)")
    serve_start "${withdraw[0]}" || return
    wait_phase "$f" '^(planning|building|finishing)$|^hold:' 900 >/dev/null
    w=$(new_objective $g withdraw3 "crash withdraw target" ID="$(uid)")
    wait_for 300 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $w)\" = checking ]"
    gh_card "$w" Cancelled
    local end=$(( $(now) + 600 )); while [ "$(now)" -lt "$end" ] && [ ! -s "$SERVE_DIR/exit" ]; do serve_tick; sleep 3; done
    local code; code=$(cat "$SERVE_DIR/exit" 2>/dev/null); serve_stop
    [ "$code" = 137 ] && CH[${withdraw[0]}]="crashed $(ts)" || CH[${withdraw[0]}]="missed (exit ${code:-none})"
    serve_start || return; sleep 60
    local s mk; s=$(st status "$w"); mk=$(gh_markers "$w" | wc -l)
    cli_t 60 cancel "$f" >/dev/null 2>&1; wait_phase "$f" 'cancelled|done' 600 >/dev/null; sleep 15; serve_stop
    gh issue close "$w" --repo "$REPO" --reason "not planned" >/dev/null 2>&1
    local ok=1; [ "$s" = none ] && [ "$mk" = 0 ] && ok=0
    record_chain $g $ok "#$w state=$s factory markers=$mk card=$(gh_card_value "$w")" "$t0" "${withdraw[@]}"
    CUR_CFG=$base_cfg
  fi

  # Reset a done Objective, crashing around the rebuilt state's save.
  if [ ${#reset[@]} -gt 0 ]; then
    t0=$(now); CH=()
    if ! cli_has reset; then
      for p in "${reset[@]}"; do record "$g.$p" $g UNREACHABLE "this build's CLI has no reset command" "$t0"; done
    else
      n=$(new_objective $g happy "crash reset" ID="$(uid)")
      serve_start || return
      wait_phase "$n" 'done|cancelled|failed' 2700 >/dev/null; sleep 20; serve_stop
      local before; before=$(gh_prs "$n")
      for p in "${reset[@]}"; do
        reset_hook() { sleep 5; cli_t 60 reset "$1" >/dev/null 2>&1; }
        CRASH_HOOK=reset_hook chain "$n" "$p"
      done
      serve_start || return
      wait_for 600 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $n)\" = done ]"; sleep 20; serve_stop
      end_done "$n"; local ok=$?
      [ "$(gh_prs "$n")" = "$before" ] || ok=1
      record_chain $g $ok "PRs unchanged by reset; $EVID" "$t0" "${reset[@]}"
    fi
  fi

  # Plan data: a plan too big for one comment (bigplan.md, 48 Work Items),
  # crashed around its data parts, then cancelled once the plan is posted.
  if [ ${#plandata[@]} -gt 0 ]; then
    t0=$(now)
    if [ "${CP_PLAN_DATA:-1}" = 0 ]; then
      for p in "${plandata[@]}"; do record "$g.$p" $g UNREACHABLE "skipped (CP_PLAN_DATA=0)" "$t0"; done
    else cp_plan_data "${plandata[@]}"; fi
  fi

  # Remind: only with a human gate on main (added, and restored, with --allow-repo-changes).
  if [ ${#remind[@]} -gt 0 ]; then
    t0=$(now)
    if [ "$(gh_human_gate)" != true ] && [ -n "${ALLOW_REPO_CHANGES:-}" ]; then rc_human_gate_on || log "couldn't add a human gate to main"; fi
    if [ "$(gh_human_gate)" != true ]; then
      for p in "${remind[@]}"; do approved "$g.$p" $g "$t0" "a required review on main (human gate)" && record "$g.$p" $g UNREACHABLE "main has no required review (human gate), and none could be added" "$t0"; done
    else
      CH=(); build_has_env FACTORY_REMIND_MS && SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_REMIND_MS=20000"
      n=$(new_objective $g remind "crash remind" ID="$(uid)")
      chain "$n" "${remind[@]}"
      serve_start || return; sleep 120
      local rm; rm=$(gh_markers "$n" | awk '$1 ~ /remind/ && $2>1' | wc -l)
      cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled' 600 >/dev/null; sleep 15; serve_stop
      end_cancelled "$n"; local ok=$?; [ "$rm" = 0 ] || ok=1
      record_chain $g $ok "$EVID" "$t0" "${remind[@]}"
    fi
    restore_run
  fi

  # CRASH_POINTS: the hold -> cancel path, one hold Objective per point.
  for p in "${local_pts[@]}"; do
    t0=$(now); CH=()
    n=$(new_objective $g hold "crash local $p" ID="$(uid)") || continue
    serve_start "$p" || return
    local end=$(( $(now) + 1500 )) sent=""
    while [ "$(now)" -lt "$end" ] && [ ! -s "$SERVE_DIR/exit" ]; do
      serve_tick
      if [ -z "$sent" ] && [[ $(st phase "$n") == hold:* ]]; then sleep 20; cli_t 60 cancel "$n" >/dev/null 2>&1; sent=1; fi
      sleep 3
    done
    local code; code=$(cat "$SERVE_DIR/exit" 2>/dev/null); serve_stop
    [ "$code" = 137 ] && CH[$p]="crashed $(ts)" || CH[$p]="missed (exit ${code:-none})"
    serve_start || return
    if [ -z "$sent" ]; then wait_phase "$n" '^hold:|cancelled' 1200 >/dev/null; cli_t 60 cancel "$n" >/dev/null 2>&1; fi
    wait_phase "$n" 'cancelled' 900 >/dev/null; sleep 15; serve_stop
    end_cancelled "$n"; local ok=$?
    record_chain $g $ok "$EVID" "$t0" "$p"
  done
}
