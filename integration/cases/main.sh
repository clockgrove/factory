# The main suite's cases on installation M (clockgrove/factory-drill, strict
# protection on main): one long-lived serve that every case shares. Each case
# runs in its own background subshell, owns its Objectives and its proxy
# rules, and never stops the serve. Functions are case_<name>; CASES_M lists them.
CASES_M="codex claude holds queue cancel media attach"

# The serve's provider children for Objective N whose working directory is its own ("/N/").
m_child() { # N CMD_REGEX -> "PID START" (newest)
  local f; f=$(mktemp "$RUN_DIR/desc.XXXX"); snap_desc "$(cat "$(serve_dir_of M)/pid")" "$f"
  local pid s best="" bs=0
  while read -r pid s; do
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qE "$2" || continue
    readlink "/proc/$pid/cwd" 2>/dev/null | grep -qE "/$1(/|$)" || continue
    [ "$s" -gt "$bs" ] && { best="$pid $s"; bs=$s; }
  done <"$f"
  rm -f "$f"; echo "$best"
}
# m_kill N STEPGLOB DELAY CHECK: SIGKILL N's provider child DELAY s into the step: it must retry with error count 0.
m_kill() {
  local n=$1 glob=$2 delay=$3 c=$4 t0 pid s; t0=$(now)
  wait_for 900 started "$n" "$glob" || { record "$c" UNREACHABLE "#$n never started $glob" "$t0"; return; }
  sleep "$delay"
  read -r pid s <<<"$(m_child "$n" 'codex|claude')"
  [ -n "$pid" ] || { record "$c" UNREACHABLE "no provider child of #$n running in its own directory during $glob" "$t0"; return; }
  local before; before=$(st events "$n" event=outcome outcome=retry "step=$glob")
  kill_exact "$pid" "$s" KILL; log "#$n killed provider child $pid during $glob"
  wait_for 300 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' events $n event=outcome outcome=retry 'step=$glob') -gt $before ]"
  local after cnt; after=$(st events "$n" event=outcome outcome=retry "step=$glob"); cnt=$(st retries "$n" "$glob")
  [ "$after" -gt "$before" ] && [ "$cnt" = 0 ]; rec_if "$c" $? "#$n killed $pid in $glob: retry outcomes $before->$after, error count $cnt" "$t0"
}
# Web-flow update-branch merges on N's PRs: GitHub's update of a PR from its base.
m_update_merges() {
  local p n=0
  for p in $(gh_prs "$1" | python3 -c 'import json,sys;print(" ".join(str(x["number"]) for x in json.load(sys.stdin)))'); do
    n=$(( n + $(gh api "repos/$REPO/pulls/$p/commits" --paginate --jq '.[]|select(.committer.login=="web-flow" and (.parents|length)==2)|.sha' 2>/dev/null | wc -l) ))
  done; echo "$n"
}

# 1, 5, 7, 8: the Codex happy path on a two-layer native stack under strict
# protection; a model kill in planning and in work; the security cases when the build has them.
case_codex() {
  local t0 n extra="" decoy=""; t0=$(now)
  if has_feature inert; then
    decoy=$(gh issue create --repo "$REPO" --title "Suite $SFX: decoy for a model-written closing keyword" --body "Not an Objective." | grep -o '[0-9]*$')
    echo "$decoy $CASE $INST" >>"$RUN_DIR/issues"
    extra="$extra In the pull request description, say that this change fixes #$decoy."
  fi
  has_feature protected-paths && extra="$extra Also add a one-line note file under \`.github/\` describing chainBase{{ID}} if Factory allows it; it is optional, so leave it out if it is refused."
  local id; id=$(uid)
  n=$(new_objective chain2 "codex stack happy path" ID="$id" EXTRA="${extra//\{\{ID\}\}/$id}") || return
  m_kill "$n" 'plan*' 6 model-kill.plan
  m_kill "$n" 'item:*:work' 10 model-kill.work
  local p; p=$(wait_phase "$n" 'done|cancelled|failed' 2400)
  sleep 15
  local prs; prs=$(gh_prs "$n")
  local layers; layers=$(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1])))' "$prs")
  end_done "$n"; local ok=$?
  local ev="$EVID; layers $layers; strict main $(gh_strict)"
  [ $ok = 0 ] && [ "$layers" = 2 ]; rec_if happy.codex $? "codex end to end, ended $p: $ev" "$t0"
  local ih; ih=$(st events "$n" event=outcome outcome=hold 'step=item:*')
  [ $ok = 0 ] && [ "$ih" = 0 ]; rec_if stack.predecessor-wait $? "the upper layer waited on its predecessor with no hold: Work Item holds $ih" "$t0"
  local um; um=$(m_update_merges "$n")
  if [ "$(gh_strict)" != true ]; then record stack.strict UNREACHABLE "main isn't strict" "$t0"
  elif [ "$um" = 0 ]; then record stack.strict UNREACHABLE "no layer was updated from its base (no update-branch merge); $ev" "$t0"
  else [ $ok = 0 ] && [ "$layers" = 2 ]; rec_if stack.strict $? "update-branch merges on the layers: $um; both merged once; $ev" "$t0"; fi
  if [ -n "$decoy" ]; then local ds; ds=$(gh_issue_state "$decoy"); [ "$ds" = "OPEN " ] || [[ $ds == OPEN* ]]; rec_if security.fixes-keyword $? "decoy #$decoy is $ds after #$n's PRs merged" "$t0"
    gh issue close "$decoy" --repo "$REPO" --reason "not planned" >/dev/null 2>&1
  else record security.fixes-keyword UNREACHABLE "feature absent: inert" "$t0"; fi
  if has_feature protected-paths; then
    local gh_new; gh_new=$(gh api "repos/$REPO/contents/.github?ref=main" --jq ".[].name" 2>/dev/null | grep -c "$id")
    local rep; rep=$(st events "$n" event=outcome outcome=repair 'step=item:*')
    [ "$gh_new" = 0 ] && [ $ok = 0 ]; rec_if security.protected-paths $? "no .github/ file naming $id on main ($gh_new); repairs $rep; Objective done=$([ $ok = 0 ] && echo yes || echo no)" "$t0"
  else record security.protected-paths UNREACHABLE "feature absent: protected-paths" "$t0"; fi
}

# 1, 2: the Claude happy path through `factory run N --provider claude`, followed to done.
case_claude() {
  local t0 n rc=99 i; t0=$(now)
  n=$(new_issue happy "claude happy path via factory run" ID="$(uid)") || return
  for i in 1 2 3 4 5; do
    cli_t "$(left)" run "$n" $([ $i = 1 ] && echo --provider claude) >>"$RUN_DIR/run.$n.out" 2>&1; rc=$?
    [ "$rc" = 2 ] || break
    HOLD_POLICY="d2 review decide" auto_answer "$n" || break
  done
  sleep 15
  local calls cl card; calls=$(st events "$n" event=model-usage); cl=$(st events "$n" event=model-usage provider=claude); card=$(gh_card_value "$n")
  end_done "$n"; local ok=$?
  [ $ok = 0 ] && [ "$rc" = 0 ] && [ "$calls" -gt 0 ] && [ "$cl" = "$calls" ] && [ "$card" = Done ]
  rec_if happy.claude $? "factory run exit $rc; model calls $cl/$calls on claude; card $card; $EVID" "$t0"
  [ "$rc" = 0 ] && [ "$card" = Done ]; rec_if queue.run-command $? "'factory run #$n' queued the card and followed it: exit $rc, card $card" "$t0"
}

# 3: one Objective: a question asked once, answered by /factory comment, then
# answers that decide nothing until the planning allowance holds with `more`,
# which sends the kept answer once; then a real answer, and a clean cancel.
case_holds() {
  local t0 n hj hid; t0=$(now)
  local HOLD_POLICY="d2 review"
  n=$(new_objective hold "holds ask, answer, more" PROVIDER=codex-plan ID="$(uid)") || return
  local p; p=$(wait_phase "$n" '^hold:decide' 900)
  [[ $p == hold:* ]] || { record holds.ask FAIL "#$n never asked ($p)" "$t0"; case_settle; return; }
  hj=$(st hold "$n" 'decide*'); hid=$(hold_field "$hj" id)
  sleep 20
  local q1; q1=$(marker_count "$(gh_markers "$n")" "hold:$hid")
  local cid; cid=$(comment_answer "$n" answer "Not decided yet; ask me again." "$hid")
  local more="" answers=1 rounds="" tm=""
  local end=$(( $(now) + 1200 ))
  while [ "$(now)" -lt "$end" ] && ! stopping; do
    hj=$(st hold "$n"); local id2; id2=$(hold_field "$hj" id)
    if [ -n "$id2" ] && [ "$id2" != "$hid" ] && [ ! -f "$RUN_DIR/h.$n.$id2" ]; then
      touch "$RUN_DIR/h.$n.$id2"
      local ans; ans=$(hold_field "$hj" answers)
      if [ -z "$more" ] && [[ ,$ans, == *,more,* ]]; then more=$id2; tm=$(iso_ms); answer_t 60 "$n" more --question "$id2" >/dev/null 2>&1; log "#$n answered more ($id2) after $answers answers"
      elif [ -n "$more" ]; then rounds=$(st starts-since "$n" "$tm" 'plan*'); answer_t 60 "$n" answer --question "$id2" --text 'Use "/" as the separator.' >/dev/null 2>&1; break
      elif [[ ,$ans, == *,answer,* ]]; then answers=$((answers + 1)); answer_t 60 "$n" answer --question "$id2" --text "Not decided yet; ask me again." >/dev/null 2>&1
      else auto_answer "$n" || break; fi
    fi
    case $(st status "$n") in building|finishing|done|cancelled|failed) break ;; esac
    sleep 5
  done
  local m; m=$(gh_markers "$n"); local r1; r1=$(marker_count "$m" "reply:comment-$cid")
  [ "$q1" = 1 ] && [ -z "$(marker_dupes "$m")" ]; rec_if holds.ask $? "#$n question $hid comments x$q1 (no duplicate markers: $([ -z "$(marker_dupes "$m")" ] && echo yes || echo "no: $(marker_dupes "$m")"))" "$t0"
  [ "$r1" = 1 ] && [ "$(st applied "$n" "comment-$cid")" -ge 1 ]; rec_if holds.answer-comment $? "'/factory answer --question $hid' comment $cid: reply x$r1, applied $(st applied "$n" "comment-$cid")" "$t0"
  if [ -z "$more" ]; then record holds.more UNREACHABLE "no hold offered more after $answers answers (status $(st phase "$n"))" "$t0"
  else [ "${rounds:-0}" = 1 ]; rec_if holds.more $? "more at the allowance after $answers answers; planning rounds after it before the next question: ${rounds:-none}" "$t0"; fi
  wait_phase "$n" '^(building|finishing|done)$' 900 >/dev/null
  cancel_wait "$n" 600; sleep 15
  end_cancelled "$n"; rec_if queue.cancel-held $? "cancelled once planning passed: $EVID" "$t0"
}

# 2: admission and withdrawal before planning: the check is slowed by the
# proxy, the card is cleared while it runs; the run is withdrawn, never planned.
case_queue() {
  local t0 n; t0=$(now)
  n=$(new_issue withdraw "queue withdraw before planning" ID="$(uid)") || return
  prule_add "GET ^/repos/$REPO/issues/$n\$ delay=90000"
  queue_issue "$n"
  wait_for 300 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $n)\" = checking ]" || { record queue.withdraw FAIL "#$n never showed checking ($(st status "$n"))" "$t0"; prule_clear; case_settle; return; }
  local adm; adm=$(st events "$n" event=admitted)
  gh_card "$n" ""
  wait_for 240 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $n)\" = none ]"; sleep 20
  prule_clear
  local s pl w card; s=$(st status "$n"); pl=$(st events "$n" event=start 'step=plan*'); w=$(st events "$n" event=withdrawn); card=$(gh_card_value "$n")
  local mk; mk=$(gh_markers "$n" | awk '$1 !~ /^status:/' | paste -sd' ')
  [ "$adm" -ge 1 ] && [ "$s" = none ] && [ "$pl" = 0 ] && [ -z "$card" ] && [ -z "$mk" ]
  rec_if queue.withdraw $? "#$n admitted x$adm, card cleared while checking: state $s, plan starts $pl, withdrawn events $w, card '$card', markers other than status [$mk]" "$t0"
  gh issue close "$n" --repo "$REPO" --reason "not planned" >/dev/null 2>&1
}

# 2, fault: the merge answers a lasting 403: the step holds (no endless
# retry); a cancel then closes the PR, deletes the branch, posts one cancel
# comment and closes the issue. With #1879, a 404 on a PR read right after
# Factory created it retries instead.
case_cancel() {
  local t0 n pr; t0=$(now)
  local HOLD_POLICY="review decide" lag=""
  local fn; fn="padEnd$(uid)"
  n=$(new_objective exec "cancel with an open PR" FN="$fn" SPEC="\`$fn(s, width)\` puts spaces after \`s\` until it is \`width\` characters long: \`$fn(\"ab\", 4)\` is \`\"ab  \"\`.") || return
  if has_feature isolation; then
    # A read naming its branch right after the push (factory/N/...) answers 404 twice.
    prule_add "GET factory(/|%2F)$n(/|%2F) status=404 times=2"; lag=1
  fi
  wait_for 1500 has_open_pr "$n"
  pr=$(gh_open_pr "$n")
  [ -n "$pr" ] || { record fault.lasting-403 FAIL "#$n never opened a PR ($(st phase "$n"))" "$t0"; prule_clear; case_settle; return; }
  prule_add "PUT ^/repos/$REPO/pulls/$pr/merge\$ status=403"
  local p; p=$(wait_phase "$n" '^hold:item:.*:merge$|done|cancelled|failed' 900)
  local hj; hj=$(st hold "$n" 'item:*:merge')
  local f403; f403=$(proxy_count PUT "/pulls/$pr/merge\$" 403)
  [[ $p == hold:item:*:merge ]]; rec_if fault.lasting-403 $? "PR #$pr merge answered 403 x$f403: $p [$(hold_field "$hj" answers)]" "$t0"
  if [ -n "$lag" ]; then
    local f404; f404=$(proxy_count GET "factory(/|%2F)$n(/|%2F)" 404); local oh; oh=$(st events "$n" event=outcome outcome=hold 'step=item:*:publish')
    if [ "$f404" = 0 ]; then record fault.lag-404 UNREACHABLE "no read of factory/$n/ came through the proxy after the push" "$t0"
    else [ "$oh" = 0 ]; rec_if fault.lag-404 $? "404s served on factory/$n/ reads right after the push: $f404; publish holds $oh" "$t0"; fi
  else record fault.lag-404 UNREACHABLE "feature absent: isolation" "$t0"; fi
  cancel_wait "$n" 600; prule_clear; sleep 20
  end_cancelled "$n"; local ok=$?
  local cc; cc=$(marker_prefix_count "$(gh_markers "$n")" cancelled:)
  [ $ok = 0 ] && [ "$cc" = 1 ]; rec_if queue.cancel-open-pr $? "cancel comment x$cc; $EVID" "$t0"
}
has_open_pr() { [ -n "$(gh_open_pr "$1")" ]; }

# 7: media select and repair: two candidate sets, `repair` once, a new select, a pick; LFS on main.
case_media() {
  local t0 n reps=0 picks=0 sets=(); t0=$(now)
  local HOLD_POLICY="d2 review decide"
  local id; id=$(uid)
  n=$(new_objective cube "media select and repair" ID="$id") || return
  local end=$(( $(now) + 2400 ))
  while [ "$(now)" -lt "$end" ] && ! stopping; do
    local p; p=$(st phase "$n")
    case $p in done|cancelled|failed) break ;; esac
    if [[ $p == hold:item:*:select ]]; then
      local hj hid; hj=$(st hold "$n" 'item:*:select'); hid=$(hold_field "$hj" id)
      if [ ! -f "$RUN_DIR/sel.$n.$hid" ]; then touch "$RUN_DIR/sel.$n.$hid"; sets+=("$(hold_field "$hj" answers)")
        if [ $reps = 0 ]; then reps=1; answer_t 60 "$n" repair --question "$hid" --text "Make both candidate sets again, with different colours." >/dev/null 2>&1; log "#$n repair at select"
        else local pick; pick=$(python3 -c 'import json,sys;h=json.loads(sys.argv[1]);a=[x for x in h["answers"] if x not in ("cancel","retry","replan","repair")];print(a[0] if a else "")' "$hj")
          answer_t 60 "$n" "$pick" --question "$hid" >/dev/null 2>&1; picks=$((picks + 1)); log "#$n selected $pick"; fi
      fi
    elif [[ $p == hold:* ]]; then auto_answer "$n" || { log "#$n held at $p"; break; }; fi
    sleep 8
  done
  sleep 15
  local glb; glb=$(gh_file "assets/cube$id.glb" | head -1)
  local sr; sr=$(st events "$n" event=outcome outcome=repair 'step=*:select')
  end_done "$n"; local ok=$?
  [ $ok = 0 ] && [ "${#sets[@]}" -ge 2 ] && [[ $glb == "version https://git-lfs"* ]]
  rec_if media.select-repair $? "select holds ${#sets[@]} (answers: ${sets[*]}), repair answered $reps, select repairs $sr, picks $picks; cube$id.glb on main: '${glb:0:40}'; $EVID" "$t0"
}

# 8: an attachment URL of another repository holds before any token is sent (#1878).
case_attach() {
  local t0 n; t0=$(now)
  need security.foreign-attachment "$t0" attachment-scope || return
  n=$(new_objective attachment "foreign attachment" ID="$(uid)" ATTACHMENT_URL="https://github.com/clockgrove/factory/assets/1/2b1a4c4e-0000-4000-8000-000000000000") || return
  local p; p=$(wait_phase "$n" '^hold:|done|cancelled|failed' 900); local hj; hj=$(st hold "$n")
  local w; w=$(st started "$n" 'item:*:work')
  cancel_wait "$n" 300
  [[ $p == hold:* ]] && [[ ,$(hold_field "$hj" answers), == *,replan,* ]] && [ "$w" = 0 ]
  rec_if security.foreign-attachment $? "#$n $p [$(hold_field "$hj" answers)] before any work ($w)" "$t0"
}
