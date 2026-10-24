# followups: what GitHub shows, secret scans, branch deletion and repairs.
#   issueform  an issue-form body with blank optional fields plans with no check hold
#   testsource an unbackticked Sources path GitHub renders as bold is pinned exactly
#   golden     non-writer golden bodies: approval digest = visible text; hidden text never reaches the planner
#   pem        dummy multi-line PEM: armor publishes; a key line holds; `publish` pushes once; a new commit asks again
#   branches   regular done and cancel leave no factory/N/*; a branch with a foreign commit is kept (branch-kept)
#   d3         SIGKILL during work, main advances, restart: no work-step repair, done
#   media      select `repair` twice and a publish LFS-missing repair; neither ends as "no repository change"
#   proxy-noscheme  a proxy URL without a scheme is read as http:// before its credential is stripped
# end_done and end_cancelled require no factory/N/* branch on a build that
# deletes its branches.
followups_needs() { echo "a build with branch deletion (branch-kept) and the key-material secret scan; drill-issue.yml on main; FACTORY_GITHUB_API"; }
followups_cost() { echo "~2.5-3.5 h; golden: 4 bot issues to their first plan step; pem: 2 Objectives to done (3 publish answers); branches: 1 twin Objective cancelled; d3: 1 to done; media: 2 to done"; }
followups_minutes() { echo 210; }
FU_ONLY=${FU_ONLY:-issueform testsource golden pem branches d3 media proxy-noscheme}
FU_GOLDEN_KINDS=${FU_GOLDEN_KINDS:-backtick divfence refdef unclosed footnote}
FU_CONNECT_PORT=${FU_CONNECT_PORT:-18561}
FU_PORT=${FU_PORT:-18557}
followups_plan() {
  echo "followups.issueform        issue-form body (### headings) with blank optional fields (_No response_): no check hold, planning starts"
  echo "followups.testsource       Sources line '- src/__tests__/x.test.js' unbackticked (GitHub shows __tests__ as bold): no check hold, the pinned source is that exact path"
  echo "followups.golden-{${FU_GOLDEN_KINDS// /,}}  bot issue; approve; kept digest = sha256(done.check.body); HIDDEN absent, VISIBLE present (footnote: an unreferenced [^x]: definition)"
  echo "followups.pem-armor        armor lines only: done with no secret hold"
  echo "followups.pem-key          key line: hold (publish among answers) at item 1, publish -> pushed once; item 2 (new commit, same finding) asks again"
  echo "followups.branch-delete-cancel  twin, merges blocked (502), one branch gets a foreign commit, cancel: clean branch deleted, foreign one kept with branch-kept"
  echo "followups.d3               SIGKILL during work, main advances, restart: no work-step repair, done, no branch left"
  echo "followups.select-repair    cube: answer repair at select twice, then select: done, repairs at select >= 2, no other hold"
  echo "followups.lfs-missing      ghost pointer: publish repair for the missing LFS object, then done"
  echo "followups.proxy-noscheme   serve with HTTPS_PROXY=user:dummy-pass@127.0.0.1:port (no scheme; lib/connect-proxy.mjs): done; the dummy password in no worker shell output, log or comment $(pre proxy-policy)"
}
followups_cfg() {
  cfg_patch "$CUR_CFG" 'c["queue"]["maxActiveObjectives"]=4' \
    'c.setdefault("policy",{}); n=c["policy"].setdefault("allowedSecretNames",[]); "DRILL_DUMMY_PEM" in n or n.append("DRILL_DUMMY_PEM")'
}

fu_issue_by_title() { # TITLE -> number of the open bot-filed issue
  gh issue list --repo "$REPO" --state open --search "\"$1\" in:title" --json number,author,title \
    --jq ".[]|select(.title==\"$1\" and .author.is_bot)|.number" | head -1
}
sha16() { python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()[:16])'; }

# An Objective checked and planned without a hold at check; cancelled once planning starts.
fu_checks_ok() { # NAME TEMPLATE TITLE [KEY=VALUE...] -> records followups.NAME
  local g=followups t0 name=$1 tpl=$2 title=$3 n p; shift 3
  t0=$(now)
  n=$(new_objective $g "$tpl" "$title" "$@") || return
  serve_alive || serve_start || return
  p=$(wait_phase "$n" '^hold:|^planning$|^building$' 900)
  local pl; wait_for 300 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' started $n 'plan:*') = 1 ]"; pl=$(st started "$n" 'plan:*')
  local hs; hs=$(st hold "$n" | python3 -c 'import json,sys;h=json.load(sys.stdin) or {};print(h.get("step",""))')
  FU_CHECK=$(st get "$n" done.check)
  cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled|done' 600 >/dev/null; sleep 10
  FU_N=$n; FU_P=$p; FU_PL=$pl; FU_HS=$hs; FU_T0=$t0
}
fu_issueform() {
  fu_checks_ok issueform issueform "followups issue form, blank optional fields" ID="$(uid)"
  end_cancelled "$FU_N"; local ok=$?
  [ "$FU_HS" != check ] && [ "$FU_CHECK" != null ] && [ "$FU_PL" = 1 ] && [ $ok = 0 ] \
    && record followups.issueform followups PASS "#$FU_N checked with blank fields, went to $FU_P, plan started; $EVID" "$FU_T0" \
    || record followups.issueform followups FAIL "#$FU_N phase=$FU_P held at '${FU_HS}' plan started=$FU_PL; $EVID" "$FU_T0"
}
fu_testsource() {
  local t0; t0=$(now)
  if ! gh_file src/__tests__/x.test.js >/dev/null; then
    gh api -X PUT "repos/$REPO/contents/src/__tests__/x.test.js" -f message="drill: fixture for an unbackticked __tests__ Source" \
      -f content="$(printf '%s\n' "import { test } from 'node:test';" "import assert from 'node:assert/strict';" "" "test('fixture', () => { assert.equal(1 + 1, 2); });" | base64 -w0)" >/dev/null \
      || { record followups.testsource followups UNREACHABLE "couldn't add src/__tests__/x.test.js to main" "$t0"; return; }
    sleep 10
  fi
  fu_checks_ok testsource testsource "followups unbackticked __tests__ Source" ID="$(uid)"
  local lit; lit=$(grep -c 'src/__tests__/x.test.js' <<<"$FU_CHECK")
  local bad; bad=$(grep -c 'src/tests/x.test.js' <<<"$FU_CHECK")
  end_cancelled "$FU_N"; local ok=$?
  [ "$FU_HS" != check ] && [ "$FU_PL" = 1 ] && [ "$lit" -ge 1 ] && [ "$bad" = 0 ] && [ $ok = 0 ] \
    && record followups.testsource followups PASS "#$FU_N no check hold; checked text keeps src/__tests__/x.test.js; plan started; $EVID" "$FU_T0" \
    || record followups.testsource followups FAIL "#$FU_N phase=$FU_P held at '${FU_HS}' plan started=$FU_PL; literal path x$lit, mangled src/tests/ x$bad; $EVID" "$FU_T0"
}

fu_golden() {
  local g=followups t0 kind id f title n
  t0=$(now)
  declare -A num=() ids=()
  for kind in $FU_GOLDEN_KINDS; do
    id=$(uid); ids[$kind]=$id
    f="$RUN_DIR/objectives/golden-$kind-$id.md"; mkdir -p "$RUN_DIR/objectives"; render "golden-$kind" "$f" ID="$id" || return
    title="Suite $RUN_ID: golden $kind"
    gh workflow run drill-issue.yml --repo "$REPO" -f title="$title" -f body="$(cat "$f")" >/dev/null 2>&1
  done
  for kind in $FU_GOLDEN_KINDS; do
    n=""
    local end=$(( $(now) + 300 ))
    while [ "$(now)" -lt "$end" ] && [ -z "$n" ]; do n=$(fu_issue_by_title "Suite $RUN_ID: golden $kind"); [ -z "$n" ] && sleep 10; done
    [ -n "$n" ] || { record "followups.golden-$kind" $g FAIL "the workflow never filed the issue" "$t0"; continue; }
    num[$kind]=$n; echo "$n $g" >>"$RUN_DIR/issues"; gh_enqueue "$n" >/dev/null; log "queued #$n (golden $kind, bot-authored)"
  done
  serve_alive || serve_start || return
  for kind in "${!num[@]}"; do
    n=${num[$kind]}
    local p; p=$(wait_phase "$n" '^hold:' 600)
    echo "$p" >"$RUN_DIR/golden-hold.$n"
    answer_t 60 "$n" approve >/dev/null 2>&1
  done
  for kind in "${!num[@]}"; do
    n=${num[$kind]}; id=${ids[$kind]}
    wait_for 600 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' get $n done.check)\" != null ]"
    local body kept dig hidden vis fence ok=0
    # The planned Objective is done.check.shown: its body, blocks
    # and spans; the approval digest is shownDigest = sha256(JSON [blocks, spans, body]).
    local check; check=$(st get "$n" done.check)
    body=$(python3 -c 'import json,sys;c=json.loads(sys.argv[1]) or {};print((c.get("shown") or {}).get("body", c.get("body","")),end="")' "$check")
    kept=$(st get "$n" kept.objective:author-approval | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("digest",""))')
    dig=$(python3 -c 'import json,sys,hashlib;c=json.loads(sys.argv[1]) or {};sh=c.get("shown")
s=json.dumps([sh["blocks"],sh["spans"],sh["body"]],separators=(",",":"),ensure_ascii=False).encode() if sh else c.get("body","").encode()
print(hashlib.sha256(s).hexdigest()[:16])' "$check")
    hidden=$(grep -c "HIDDEN$id\|leaked$id" <<<"$check"); vis=$(grep -c "VISIBLE$id" <<<"$body")
    fence=1; [ "$kind" = divfence ] && fence=$(grep -c "VISIBLEFENCE$id" <<<"$body")
    cli_t 60 cancel "$n" >/dev/null 2>&1
    [[ $(cat "$RUN_DIR/golden-hold.$n") == hold:* ]] || ok=1
    [ -n "$kept" ] && [ "$kept" = "$dig" ] || ok=1
    [ "$hidden" = 0 ] && [ "$vis" -ge 1 ] && [ "$fence" -ge 1 ] || ok=1
    echo "$body" >"$RUN_DIR/golden-$kind-$n.body"
    local ev="#$n first hold $(cat "$RUN_DIR/golden-hold.$n"); kept digest $kept, sha256(planned text) $dig; hidden lines $hidden, visible $vis$([ "$kind" = divfence ] && echo ", fenced comment $fence"); planned text: $RUN_DIR/golden-$kind-$n.body"
    [ $ok = 0 ] && record "followups.golden-$kind" $g PASS "$ev" "$t0" || record "followups.golden-$kind" $g FAIL "$ev" "$t0"
  done
  for kind in "${!num[@]}"; do wait_phase "${num[$kind]}" 'cancelled|done|failed' 600 >/dev/null; done
  sleep 15; serve_stop
}

fu_pem() {
  local g=followups t0 n p id HOLD_POLICY="$HOLD_POLICY decide"
  local -x DRILL_DUMMY_PEM
  DRILL_DUMMY_PEM=$(python3 -c 'import base64,os
print("-----BEGIN DRILL DUMMY PRIVATE KEY-----")
for _ in range(3): print(base64.b64encode(os.urandom(48)).decode())
print("-----END DRILL DUMMY PRIVATE KEY-----", end="")')
  local keyline; keyline=$(sed -n 2p <<<"$DRILL_DUMMY_PEM")
  serve_stop
  # Armor only: never a finding.
  t0=$(now); id=$(uid)
  n=$(new_objective $g pem-armor "followups pem armor" ID="$id") || return
  serve_start || return
  p=$(wait_phase "$n" 'done|cancelled|failed|^hold:item' 3600); sleep 20
  local sh; sh=$(st events "$n" event=outcome outcome=hold 'step=*:publish')
  if [[ $p == hold:* ]]; then cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled' 600 >/dev/null; fi
  end_done "$n"; local ok=$?
  [ $ok = 0 ] && [ "$sh" = 0 ] && record followups.pem-armor $g PASS "no publish hold; $EVID" "$t0" || record followups.pem-armor $g FAIL "phase=$p publish holds=$sh; $EVID" "$t0"
  # A key line: holds; publish lets exactly it through once; a new commit asks again.
  t0=$(now); id=$(uid)
  n=$(new_objective $g pem-key "followups pem key line" ID="$id") || return
  local seen=() end=$(( $(now) + 5400 )) hold step ans
  while [ "$(now)" -lt "$end" ]; do
    serve_tick; p=$(st phase "$n")
    case $p in done|cancelled|failed) break ;; esac
    if [[ $p == hold:item:*:publish ]]; then
      hold=$(st hold "$n"); read -r step ans < <(python3 -c 'import json,sys;h=json.loads(sys.argv[1]);print(h["step"], ",".join(h["answers"]))' "$hold")
      seen+=("$step[$ans]")
      [[ ,$ans, == *,publish,* ]] || break
      answer_t 60 "$n" publish --question "$(hold_field "$hold" id)" >/dev/null 2>&1; sleep 20; continue
    fi
    [[ $p == hold:* ]] && { auto_answer "$n" || break; }
    sleep 5
  done
  sleep 20
  local items pushes1 leaked; items=$(st get "$n" done.plan.items | python3 -c 'import json,sys;print(" ".join(i["id"] for i in (json.load(sys.stdin) or [])))')
  local first; first=$(cut -d' ' -f1 <<<"$items")
  pushes1=$(st events "$n" event=outcome outcome=done "step=item:$first:publish")
  local holds1; holds1=$(st events "$n" event=outcome outcome=hold "step=item:$first:publish")
  local onmain=0; gh_file "docs/keyline$id-a.md" | grep -qF "$keyline" && onmain=1
  [[ $p =~ ^(done|cancelled|failed)$ ]] || { cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled' 600 >/dev/null; }
  serve_stop
  end_done "$n"; local ok=$?
  local nh=${#seen[@]}
  local ev="holds: ${seen[*]}; item $first: publish holds $holds1, publish done x$pushes1; key line on main=$onmain; $EVID"
  if [ $ok = 0 ] && [ "$nh" = 2 ] && [ "$holds1" = 1 ] && [ "$pushes1" = 1 ] && [ "$(cut -d'[' -f1 <<<"${seen[1]:-}")" != "item:$first:publish" ]; then
    record followups.pem-key $g PASS "$ev" "$t0"
  else record followups.pem-key $g FAIL "$ev" "$t0"; fi
}

FU_PROXY=""
fu_stop_proxy() { [ -n "$FU_PROXY" ] && { read -r p s <<<"$FU_PROXY"; kill_exact "$p" "$s" TERM; FU_PROXY=""; }; }
fu_branches() {
  local g=followups t0 n id
  t0=$(now); id=$(uid)
  local rules="$RUN_DIR/fu-rules" log="$RUN_DIR/fu-calls.jsonl"; : >"$log"
  echo "PUT ^/repos/$REPO/pulls/[0-9]+/merge\$" >"$rules"
  node "$SUITE/lib/gh-fault-proxy.mjs" "$FU_PORT" "$log" "$rules" </dev/null >"$RUN_DIR/fu-proxy.out" 2>&1 &
  local pp=$!; track $pp; FU_PROXY="$pp $(starttime $pp)"; sleep 1
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_GITHUB_API=http://127.0.0.1:$FU_PORT"
  serve_stop
  n=$(new_objective $g twin "followups branches" ID="$id") || { fu_stop_proxy; return; }
  serve_start || { fu_stop_proxy; return; }
  wait_for 3600 bash -c "[ \$(gh api 'repos/$REPO/git/matching-refs/heads/factory/$n/' --jq length) -ge 2 ] && [ \$(gh pr list --repo $REPO --state open --search 'head:factory/$n/' --json number --jq length) -ge 2 ]"
  serve_stop
  local branches; branches=$(gh api "repos/$REPO/git/matching-refs/heads/factory/$n/" --jq '.[].ref' | sed 's#refs/heads/##')
  local foreign; foreign=$(head -1 <<<"$branches")
  gh api -X PUT "repos/$REPO/contents/notes/foreign-$id.md" -f branch="$foreign" -f message="drill: a commit Factory didn't make" \
    -f content="$(printf 'foreign %s\n' "$RUN_ID" | base64 -w0)" >/dev/null
  serve_start || { fu_stop_proxy; return; }
  cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled' 900 >/dev/null; sleep 20; serve_stop; fu_stop_proxy
  local left kept; left=$(gh api "repos/$REPO/git/matching-refs/heads/factory/$n/" --jq '.[].ref' | sed 's#refs/heads/##' | paste -sd' ')
  kept=$(st events "$n" event=branch-kept)
  KEEP_BRANCH_OK=1 end_cancelled "$n"; local ok=$?
  local ev="branches at cancel: $(paste -sd' ' <<<"$branches"); foreign commit on $foreign; left after cancel: [$left]; branch-kept events=$kept; $EVID"
  if [ $ok = 0 ] && [ "$left" = "$foreign" ] && [ "$kept" -ge 1 ]; then record followups.branch-delete-cancel $g PASS "$ev" "$t0"
  else record followups.branch-delete-cancel $g FAIL "$ev" "$t0"; fi
  # Leave the repo clean: the kept branch goes by hand.
  [ -n "$left" ] && for b in $left; do gh api -X DELETE "repos/$REPO/git/refs/heads/$b" >/dev/null 2>&1; done
}

fu_d3() {
  local g=followups t0 n fn id p HOLD_POLICY="$HOLD_POLICY decide"
  t0=$(now); id=$(uid); fn="dropDigits$id"
  n=$(new_objective $g exec "followups d3 $fn" FN="$fn" SPEC="\`$fn(s)\` returns \`s\` with every digit 0-9 removed: \`$fn(\"a1b22c\")\` is \`\"abc\"\`.") || return
  serve_alive || serve_start || return
  wait_for 2400 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' started $n 'item:*:work') = 1 ]" || { record followups.d3 $g FAIL "#$n never started work" "$t0"; return; }
  sleep 30
  local sp ss; sp=$(serve_pid); ss=$(starttime "$sp"); serve_tick; kill_exact "$sp" "$ss" KILL; sleep 3; serve_reap
  gh api -X PUT "repos/$REPO/contents/notes/d3-$id.md" -f message="drill: main moves while work is interrupted" \
    -f content="$(printf 'd3 %s\n' "$RUN_ID" | base64 -w0)" >/dev/null
  serve_start || return
  p=$(wait_phase "$n" 'done|cancelled|failed|^hold:' 2700); sleep 20; serve_stop
  local wr holds; wr=$(st events "$n" event=outcome outcome=repair 'step=*:work'); holds=$(st events "$n" event=outcome outcome=hold)
  end_done "$n"; local ok=$?
  [ $ok = 0 ] && [ "$wr" = 0 ] && [ "$holds" = 0 ] && record followups.d3 $g PASS "killed during work, main advanced; work repairs 0, holds 0; $EVID" "$t0" \
    || record followups.d3 $g FAIL "phase=$p work repairs=$wr holds=$holds; $EVID" "$t0"
}

fu_media() {
  local g=followups t0 nc ng p HOLD_POLICY="$HOLD_POLICY decide"
  t0=$(now)
  nc=$(new_objective $g cube "followups select repair" ID="$(uid)") || return
  ng=$(new_objective $g ghost "followups lfs missing" ID="$(uid)" OID="$(python3 -c 'import os;print(os.urandom(32).hex())')") || return
  serve_alive || serve_start || return
  local reps=0 end=$(( $(now) + 7200 )) other=""
  while [ "$(now)" -lt "$end" ]; do
    serve_tick; local left=0
    p=$(st phase "$nc")
    case $p in
      done|cancelled|failed) ;;
      hold:item:*:select)
        left=1
        local hid; hid=$(st hold "$nc" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
        if [ ! -f "$RUN_DIR/fu-sel.$hid" ]; then
          touch "$RUN_DIR/fu-sel.$hid"
          if [ $reps -lt 2 ]; then reps=$((reps + 1)); answer_t 60 "$nc" repair --question "$hid" --text "Make both candidate sets again, with different colours from the last ones." >/dev/null 2>&1; log "#$nc repair at select ($reps)"
          else media_select "$nc" "" ""; fi
        fi ;;
      hold:*) left=1; auto_answer "$nc" || other="$p" ;;
      *) left=1 ;;
    esac
    p=$(st phase "$ng")
    case $p in done|cancelled|failed) ;; hold:*) left=1; auto_answer "$ng" || other="$other #$ng:$p" ;; *) left=1 ;; esac
    [ $left = 0 ] && break
    [ -n "$other" ] && { log "followups media: held at $other"; break; }
    sleep 10
  done
  sleep 20
  local sr; sr=$(st events "$nc" event=outcome outcome=repair 'step=*:select')
  local hs; hs=$(( $(st events "$nc" event=outcome outcome=hold) - $(st events "$nc" event=outcome outcome=hold 'step=*:select') - $(st events "$nc" event=outcome outcome=hold 'step=*review') ))
  end_done "$nc"; local ok=$?
  [ $ok = 0 ] && [ "$sr" -ge 2 ] && [ "$hs" = 0 ] && record followups.select-repair $g PASS "repairs at select $sr, no other hold; $EVID" "$t0" \
    || record followups.select-repair $g FAIL "repairs at select $sr, other holds $hs ${other:+(held $other)}; $EVID" "$t0"
  local pr; pr=$(st events "$ng" event=outcome outcome=repair 'step=*:publish')
  local hg; hg=$(( $(st events "$ng" event=outcome outcome=hold) - $(st events "$ng" event=outcome outcome=hold 'step=*review') ))
  end_done "$ng"; ok=$?
  [ $ok = 0 ] && [ "$pr" -ge 1 ] && [ "$hg" = 0 ] && record followups.lfs-missing $g PASS "publish repairs $pr, no hold; $EVID" "$t0" \
    || record followups.lfs-missing $g FAIL "publish repairs $pr, holds $hg; $EVID" "$t0"
  serve_stop
}

# a proxy URL without a scheme is read as http:// before its credential is
# stripped. The serve gets one (dummy credential) through a local CONNECT proxy;
# the worker writes the proxy variables its shell sees to a file.
FU_CONNECT=""
fu_stop_connect() { [ -n "$FU_CONNECT" ] && { read -r p s <<<"$FU_CONNECT"; kill_exact "$p" "$s" TERM; FU_CONNECT=""; }; }
fu_proxy_noscheme() {
  local g=followups t0 n id p; t0=$(now); id=$(uid)
  need followups.proxy-noscheme $g "$t0" proxy-policy || return
  local pass="drill-dummy-proxy-pass-$id" log="$RUN_DIR/connect-proxy.jsonl"; : >"$log"
  node "$SUITE/lib/connect-proxy.mjs" "$FU_CONNECT_PORT" "$log" </dev/null >"$RUN_DIR/connect-proxy.out" 2>&1 &
  local pp=$!; track $pp; FU_CONNECT="$pp $(starttime $pp)"; sleep 1
  local url="drilluser:$pass@127.0.0.1:$FU_CONNECT_PORT"
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV HTTPS_PROXY=$url https_proxy=$url HTTP_PROXY=$url http_proxy=$url" HOLD_POLICY="$HOLD_POLICY decide"
  serve_stop
  n=$(new_objective $g proxyenv "followups proxy without a scheme" ID="$id") || { fu_stop_connect; return; }
  serve_start || { fu_stop_connect; return; }
  p=$(wait_phase "$n" 'done|cancelled|failed' 3600); sleep 20; serve_stop; fu_stop_connect
  local doc inlog incm used net
  doc=$(gh_file "docs/proxy-env$id.md")
  inlog=$(grep -rlF -- "$pass" "$ROOT/logs/$n" 2>/dev/null | wc -l)
  incm=$({ gh api "repos/$REPO/issues/$n/comments" --paginate --jq '.[].body'
           for pr in $(gh_prs "$n" | python3 -c 'import json,sys;print(" ".join(str(x["number"]) for x in json.load(sys.stdin)))'); do
             gh pr view "$pr" --repo "$REPO" --json body --jq .body; gh api "repos/$REPO/issues/$pr/comments" --paginate --jq '.[].body'; done; } | grep -cF -- "$pass")
  used=$(grep -c '"CONNECT"' "$log"); net=$(cfg_get 'c.get("providers",{}).get(c.get("defaultProvider","codex"),{}).get("worker",{}).get("network","off")')
  end_done "$n"; local ok=$?
  local lines; lines=$(grep -ci '_proxy=' <<<"$doc")
  local ev="worker network=$net; proxy CONNECTs $used; docs/proxy-env$id.md: $lines proxy lines, password in it $(grep -cF -- "$pass" <<<"$doc"); in logs $inlog files; in comments/PRs $incm; $EVID"
  if [ $ok = 0 ] && [ -n "$doc" ] && ! grep -qF -- "$pass" <<<"$doc" && [ "$inlog" = 0 ] && [ "$incm" = 0 ]; then record followups.proxy-noscheme $g PASS "$ev" "$t0"
  else record followups.proxy-noscheme $g FAIL "$ev" "$t0"; fi
}

followups_run() {
  if ! build_has_env branch-kept; then log "followups: skipped: this build doesn't delete its branches (no branch-kept)"; return; fi
  local t
  for t in $FU_ONLY; do
    case $t in issueform) fu_issueform ;; testsource) fu_testsource ;; golden) fu_golden ;; pem) fu_pem ;; branches) fu_branches ;; d3) fu_d3 ;; media) fu_media ;; proxy-noscheme) fu_proxy_noscheme ;; esac
    serve_stop
  done
}
