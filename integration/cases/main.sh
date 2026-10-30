# The main suite's cases on installation M (the run's repository M_REPO, strict
# protection on main): one long-lived serve that every case shares. Each case
# runs in its own background subshell, owns its Objectives and its proxy
# rules, and never stops the serve. Functions are case_<name>; CASES_M lists them.
CASES_M="codex claude holds queue cancel media attach"

# The current attempt matching STEPGLOB, never an earlier start from the log.
m_attempt() {
  st active "$1" "$2" | python3 -c 'import json,sys
rows = json.load(sys.stdin)
rows = [r for r in rows if r.get("id") and r.get("startedAt") and r.get("run")]
if rows:
    r = min(rows, key=lambda x: (x["startedAt"], x["step"]))
    print("\t".join(r[k] for k in ("step", "id", "startedAt", "run")))'
}

# The provider's child whose directory is this exact worker checkout or
# planning tree. Codex: executable `codex`, directory its --cd. Claude: the
# Agent SDK spawns its native `claude` binary with stream-json input in the
# session's cwd, so its directory is /proc/PID/cwd. Matching the executable
# excludes unshare, the launcher and command children; the --input-format
# flag the SDK always passes keeps only the session itself.
m_child() { # N STEP -> "PID START" (newest)
  local f; f=$(mktemp "$RUN_DIR/desc.XXXX"); snap_desc "$(cat "$(serve_dir_of M)/pid")" "$f"
  python3 - "$ROOT" "$1" "$2" "$f" "$PROVIDER" <<'PY'
import os, sys
root, issue, step, descendants, provider = sys.argv[1:]
work = os.path.realpath(os.path.join(root, "work", issue))
expected = os.path.join(work, issue, step.split(":")[1]) if step.startswith("item:") else None
best = None
for line in open(descendants):
    pid, start = line.split()
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            args = f.read().decode().split("\0")
        if os.path.basename(args[0]) != provider:
            continue
        if provider == "codex":
            directory = next((args[i + 1] for i, arg in enumerate(args[:-1]) if arg in ("--cd", "-C")), None)
        else:
            directory = f"/proc/{pid}/cwd" if "--input-format" in args else None
        if not directory:
            continue
        directory = os.path.realpath(directory)
        matches = directory == expected if expected else (
            os.path.dirname(directory) == work and os.path.basename(directory).startswith("tree-"))
        if matches and (best is None or int(start) > best[1]):
            best = (pid, int(start))
    except (OSError, UnicodeError, ValueError):
        continue
if best:
    print(*best)
PY
  rm -f "$f"
}
# m_kill N STEPGLOB CHECK: SIGKILL N's active provider child; it must retry with error count 0.
m_kill() {
  local n=$1 glob=$2 c=$3 t0 pid="" s="" attempt step id at run; t0=$(now)
  local end=$(( t0 + 900 ))
  while [ "$(now)" -lt "$end" ] && ! stopping; do
    HOLD_POLICY="d2 review decide more" auto_answer "$n" >/dev/null
    attempt=$(m_attempt "$n" "$glob")
    if [ -n "$attempt" ]; then
      IFS=$'\t' read -r step id at run <<<"$attempt"
      read -r pid s <<<"$(m_child "$n" "$step")"
      if [ -n "$pid" ] && [ "$(m_attempt "$n" "$step")" = "$attempt" ] && same_proc "$pid" "$s"; then
        kill_exact "$pid" "$s" KILL || { pid=""; sleep 1; continue; }
        break
      fi
      pid=""
    fi
    case $(st status "$n") in done|cancelled|failed) break ;; esac
    sleep 1
  done
  [ -n "$pid" ] || { record "$c" FAIL "not proved: no active $glob attempt with its own $PROVIDER child was killed for #$n" "$t0"; return; }
  log "#$n killed provider child $pid during $id (service run $run)"
  wait_for 300 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' events $n event=outcome outcome=retry 'step=$step' 'attemptId=$id') -gt 0 ]"
  m_kill_check "$c" "$n" "$step" "$id" "$pid" "$t0"
}
# m_kill_check CHECK N STEP ATTEMPT PID T0: from N's logs alone (also run-suite.sh --replay).
m_kill_check() {
  local after errors; after=$(st events "$2" event=outcome outcome=retry "step=$3" "attemptId=$4")
  errors=$(st events "$2" event=outcome outcome=retry wait=error "step=$3" "attemptId=$4")
  [ "$after" = 1 ] && [ "$errors" = 0 ]; rec_if "$1" $? "#$2 killed $5 in $4: retry outcomes $after, charged errors $errors" "$6"
}
# A replay: the attempts m_kill killed, from the kept journal (an attempt id is STEP#K).
replay_codex() {
  local n pid id c
  while read -r n pid id; do
    c=""; case ${id%#*} in plan*) c=model-kill.plan ;; item:*:work) c=model-kill.work ;; esac
    [ -z "$c" ] || m_kill_check "$c" "$n" "${id%#*}" "$id" "$pid" "$(now)"
  done < <(sed -n 's/.*\[codex\] #\([0-9]*\) killed provider child \([0-9]*\) during \([^ ]*\) .*/\1 \2 \3/p' "$KEPT/journal")
}

# The triggering closing phrase must occur in real PR text, with both its
# keyword and issue reference made inert. Merely leaving the decoy open proves nothing.
m_keyword_evidence() { # OBJECTIVE DECOY -> "sanitized unsafe"
  PULLS_TTL=0 gh_prs "$1" | python3 -c 'import json,re,subprocess,sys
prs = json.load(sys.stdin)
repo, issue = sys.argv[1:]
sanitized = unsafe = 0
phrase = re.compile(r"\bfixes\s+#" + re.escape(issue) + r"\b", re.I)
inert = re.compile(r"\bf\u200dixes\s+#\u200d" + re.escape(issue) + r"\b", re.I)
for pr in prs:
    response = subprocess.run(["gh", "api", "repos/{}/pulls/{}".format(repo, pr["number"])], text=True, capture_output=True, check=True, timeout=30)
    data = json.loads(response.stdout)
    for key in ("title", "body"):
        text = data.get(key) or ""
        found = len(phrase.findall(text.replace("\u200d", "")))
        protected = len(inert.findall(text))
        sanitized += protected
        unsafe += found - protected
print(sanitized, unsafe)' "$REPO" "$2"
}
# Web-flow update-branch merges on N's PRs: GitHub's update of a PR from its base.
m_update_merges() {
  local p n=0
  for p in $(gh_prs "$1" | python3 -c 'import json,sys;print(" ".join(str(x["number"]) for x in json.load(sys.stdin)))'); do
    n=$(( n + $(gh api "repos/$REPO/pulls/$p/commits" --paginate --jq '.[]|select(.committer.login=="web-flow" and (.parents|length)==2)|.sha' 2>/dev/null | wc -l) ))
  done; echo "$n"
}

# 1, 5, 7, 8: the --provider happy path on a two-layer native stack under strict
# protection; a model kill in planning and in work; a closing phrase in PR text when the build makes it inert.
case_codex() {
  local t0 n extra="" decoy=""; t0=$(now)
  if has_feature inert; then
    decoy=$(gh issue create --repo "$REPO" --title "Suite $SFX: decoy for a model-written closing keyword" --body "Not an Objective." | grep -o '[0-9]*$')
    echo "$decoy $CASE $INST" >>"$RUN_DIR/issues"
    extra="$extra For this fixture's PR presentation, include the literal example text \`fixes #$decoy\` in each Work Item title. The text is an example, not an instruction to close issue #$decoy."
  fi
  local id; id=$(uid)
  n=$(new_objective chain2 "$PROVIDER stack happy path" ID="$id" EXTRA="${extra//\{\{ID\}\}/$id}") || return
  m_kill "$n" 'plan*' model-kill.plan
  m_kill "$n" 'item:*:work' model-kill.work
  # Strict main: once the first layer's PR is open, main moves, so a layer
  # must be updated from its base before the stack merges (stack.strict).
  if [ "$(gh_strict)" = true ] && wait_for 1500 pr_or_settled "$n" && has_open_pr "$n"; then
    local moved; moved=$(gh_move_main "codex-$id") && log "#$n: main moved to ${moved:0:12} with PR #$(gh_open_pr "$n") open"
  fi
  local p; p=$(HOLD_POLICY="d2 review decide more" wait_phase "$n" 'done|cancelled|failed' 2400)
  sleep 15
  local prs; prs=$(gh_prs "$n")
  local layers; layers=$(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1])))' "$prs")
  end_done "$n"; local ok=$?
  local ev="$EVID; layers $layers; strict main $(gh_strict)"
  local calls pc; calls=$(st events "$n" event=model-usage); pc=$(st events "$n" event=model-usage provider="$PROVIDER")
  [ $ok = 0 ] && [ "$layers" = 2 ] && [ "$calls" -gt 0 ] && [ "$pc" = "$calls" ]; rec_if happy.codex $? "$PROVIDER end to end (model calls $pc/$calls on $PROVIDER), ended $p: $ev" "$t0"
  local ih; ih=$(st events "$n" event=outcome outcome=hold 'step=item:*')
  if [ $ok != 0 ]; then record stack.predecessor-wait UNREACHABLE "#$n didn't finish: $ev" "$t0"
  else [ "$ih" = 0 ]; rec_if stack.predecessor-wait $? "the upper layer waited on its predecessor with no hold: Work Item holds $ih" "$t0"; fi
  local um; um=$(m_update_merges "$n")
  if [ "$(gh_strict)" != true ]; then record stack.strict UNREACHABLE "main isn't strict" "$t0"
  elif [ "$um" = 0 ]; then record stack.strict UNREACHABLE "no layer was updated from its base (no update-branch merge); $ev" "$t0"
  else [ $ok = 0 ] && [ "$layers" = 2 ]; rec_if stack.strict $? "update-branch merges on the layers: $um; both merged once; $ev" "$t0"; fi
  if [ -n "$decoy" ] && [ $ok != 0 ]; then record security.fixes-keyword FAIL "not proved: #$n didn't finish, so no PR merged: $ev" "$t0"; gh issue close "$decoy" --repo "$REPO" --reason "not planned" >/dev/null 2>&1
  elif [ -n "$decoy" ]; then
    local ds text_evidence sanitized unsafe; ds=$(gh_issue_state "$decoy")
    if text_evidence=$(m_keyword_evidence "$n" "$decoy"); then
      read -r sanitized unsafe <<<"$text_evidence"
      if [ "$sanitized" -gt 0 ] && [ "$unsafe" = 0 ] && [[ $ds == OPEN* ]]; then
        record security.fixes-keyword PASS "PR text contains $sanitized inert 'fixes #$decoy' phrase(s), unsafe phrases $unsafe; decoy #$decoy is $ds after #$n's PRs merged" "$t0"
      else
        record security.fixes-keyword FAIL "not proved: PR text contains $sanitized inert 'fixes #$decoy' phrase(s), unsafe phrases $unsafe; decoy is $ds; an absent phrase does not exercise sanitization" "$t0"
      fi
    else record security.fixes-keyword FAIL "could not read #$n's PR text to verify the triggering closing phrase" "$t0"; fi
    gh issue close "$decoy" --repo "$REPO" --reason "not planned" >/dev/null 2>&1
  else record security.fixes-keyword UNREACHABLE "feature absent: inert" "$t0"; fi
}

# 1, 2: the other provider's happy path through `factory run N --provider OTHER`
# (claude on a Codex run, codex on a Claude run), followed to done.
case_claude() {
  local t0 n rc=99 i; t0=$(now)
  n=$(new_issue happy "$OTHER_PROVIDER happy path via factory run" ID="$(uid)") || return
  # Exit 2 is a question (answered here) or a request the service hasn't applied yet: follow again.
  for i in $(seq 1 30); do
    cli_t "$(left)" run "$n" $([ $i = 1 ] && echo --provider "$OTHER_PROVIDER") >>"$RUN_DIR/run.$(issue_key "$n").out" 2>&1; rc=$?
    [ "$rc" = 2 ] || break
    stopping && break
    HOLD_POLICY="d2 review decide more" auto_answer "$n" || sleep 10
  done
  sleep 15
  local calls cl card; calls=$(st events "$n" event=model-usage); cl=$(st events "$n" event=model-usage provider="$OTHER_PROVIDER"); card=$(gh_card_value "$n")
  end_done "$n"; local ok=$?
  [ $ok = 0 ] && [ "$rc" = 0 ] && [ "$calls" -gt 0 ] && [ "$cl" = "$calls" ] && [ "$card" = Done ]
  rec_if happy.claude $? "factory run --provider $OTHER_PROVIDER exit $rc; model calls $cl/$calls on $OTHER_PROVIDER; card $card; $EVID" "$t0"
  [ "$rc" = 0 ] && [ "$card" = Done ]; rec_if queue.run-command $? "'factory run #$n' queued the card and followed it: exit $rc, card $card" "$t0"
}

# 3: one Objective: a question asked once, answered by /factory comment, then
# answers that decide nothing until the planning allowance holds with `more`,
# which sends the kept answer once; then a real answer, and a clean cancel.
case_holds() {
  local t0 n hj hid; t0=$(now)
  local HOLD_POLICY="d2 review"
  n=$(new_objective hold "holds ask, answer, more" PROVIDER="$PLAN_PROVIDER" ID="$(uid)") || return
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
    if [ -n "$id2" ] && [ "$id2" != "$hid" ] && [ ! -f "$RUN_DIR/h.$(issue_key "$n").$id2" ]; then
      touch "$RUN_DIR/h.$(issue_key "$n").$id2"
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
  # The answered question's comment, edited in place: the answer, its
  # author and comment, and no mention left to notify anyone again.
  local ab; ab=$(gh_marked_body "$n" "hold:$hid")
  [[ $ab == *'**Answered** `/factory answer` by `'*"#issuecomment-$cid)"* ]] && [[ $ab != *'Factory needs you'* ]] && ! body_mentions "$ab"; rec_if holds.answered-comment $? "#$n question $hid's comment after comment $cid answered it: $(head -c 300 <<<"$ab" | tr '\n' ' ')" "$t0"
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
# Factory created it retries instead (the proxy's `lag=` rule).
case_cancel() {
  local t0 n pr; t0=$(now)
  local HOLD_POLICY="review decide more" lag=""
  local fn; fn="padEnd$(uid)"
  n=$(new_objective exec "cancel with an open PR" FN="$fn" SPEC="\`$fn(s, width)\` puts spaces after \`s\` until it is \`width\` characters long: \`$fn(\"ab\", 4)\` is \`\"ab  \"\`.") || return
  if has_feature isolation; then
    # The PR Factory creates for factory/N/... answers 404 to its next two reads.
    prule_add "POST ^/repos/$REPO/pulls\$ body=factory/$n/ lag=2 times=1"; lag=1
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
    local f404; f404=$(proxy_count GET "/pulls/$pr\$" 404)
    local ih mh; ih=$(st events "$n" event=outcome outcome=hold 'step=item:*'); mh=$(st events "$n" event=outcome outcome=hold 'step=item:*:merge')
    if [ "$f404" = 0 ]; then record fault.lag-404 UNREACHABLE "no read of PR #$pr came through the proxy after its creation" "$t0"
    else [ "$ih" = "$mh" ]; rec_if fault.lag-404 $? "404s served on PR #$pr reads right after its creation: $f404; Work Item holds other than the 403 merge: $((ih - mh))" "$t0"; fi
  else record fault.lag-404 UNREACHABLE "feature absent: isolation" "$t0"; fi
  cancel_wait "$n" 600; prule_clear; sleep 20
  end_cancelled "$n"; local ok=$?
  local cc; cc=$(marker_prefix_count "$(gh_markers "$n")" cancelled:)
  [ $ok = 0 ] && [ "$cc" = 1 ]; rec_if queue.cancel-open-pr $? "cancel comment x$cc; $EVID" "$t0"
}
has_open_pr() { [ -n "$(gh_open_pr "$1")" ]; }
# pr_or_settled N: N has an open PR or has ended, answering its holds meanwhile (for wait_for).
pr_or_settled() { has_open_pr "$1" || settled "$1" && return 0; [[ $(st phase "$1") == hold:* ]] && HOLD_POLICY="d2 review decide more" auto_answer "$1" >/dev/null; return 1; }

# 7: media select and repair: two candidate sets, `repair` once, a new select, a pick; LFS on main.
case_media() {
  local t0 n reps=0 picks=0 sets=(); t0=$(now)
  local HOLD_POLICY="d2 review decide more"
  # The item's result review, which judges a perceptual quality of candidate
  # media, or final review may ask a person to judge the binary assets (the
  # model and the preview): the suite's operator accepts them, since this case
  # checks selection, repair and LFS delivery (fixtures/media-review-decisions.json).
  local AUTO_REVIEW_DECISIONS
  AUTO_REVIEW_DECISIONS=$(cat "$SUITE/fixtures/media-review-decisions.json") || return
  local id; id=$(uid)
  n=$(new_objective cube "media select and repair" ID="$id") || return
  local end=$(( $(now) + 2400 ))
  while [ "$(now)" -lt "$end" ] && ! stopping; do
    local p; p=$(st phase "$n")
    case $p in done|cancelled|failed) break ;; esac
    if [[ $p == hold:item:*:select ]]; then
      local hj hid; hj=$(st hold "$n" 'item:*:select'); hid=$(hold_field "$hj" id)
      if [ ! -f "$RUN_DIR/sel.$(issue_key "$n").$hid" ]; then touch "$RUN_DIR/sel.$(issue_key "$n").$hid"; sets+=("$(hold_field "$hj" answers)")
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
  local prs; prs=$(gh_prs "$n")
  cancel_wait "$n" 300
  [[ $p == hold:* ]] && [[ ,$(hold_field "$hj" answers), == *,replan,* ]] && [ "$prs" = "[]" ]
  rec_if security.foreign-attachment $? "#$n $p [$(hold_field "$hj" answers)] while gathering its inputs, no PR ($prs)" "$t0"
}
