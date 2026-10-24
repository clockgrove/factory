# knowledge: repository memory, Dream playbooks, pins, Adaptive workflow.
# Local parts need no serve and no GitHub: they read (and for record/dream,
# write) the selected state's knowledge store. Model parts call the planner
# once per dream. The rest runs Objectives A, B, C and two negatives.
knowledge_needs() { echo "local: a state dir with a knowledge store and a config with planningContext (memory: true); model: the default provider's planner; github: drill repo + Project with docs/parse.md on main"; }
knowledge_cost() { echo "local: seconds; model: ~5 dream calls (~5-10 min); github: ~60-90 min, 3 Objectives to completion + 2 negatives held at check"; }
knowledge_minutes() { [ -n "${LOCAL_ONLY:-}" ] && echo 1 || echo 90; }
KDB() { echo "$ROOT/knowledge/knowledge.sqlite"; }
kq() { node "$SUITE/lib/kq.mjs" "$(KDB)" "$1" 2>/dev/null; }
kval() { kq "$1" | python3 -c 'import json,sys;r=json.load(sys.stdin);print(list(r[0].values())[0] if r else "")'; }
knowledge_plan() {
  echo "knowledge.store-integrity    [local] memory ids distinct, no duplicate records, playbook versions 1..N, pins only for unsettled Objectives"
  echo "knowledge.record-idempotent  [local] dream --record on a recorded settled Objective: recorded=false, rows unchanged"
  echo "knowledge.preview            [local] dream --preview: inputBytes <= maxBytes, no planner call"
  echo "knowledge.show               [local] dream --show: approved version = newest playbook row"
  echo "knowledge.crash-record       [local] knowledge:retain:before-commit on dream --record: exit 137, rows unchanged, rerun recorded=false"
  echo "knowledge.dream:*            [model] dream:submitted, dream:proposal:{before-commit,committed}, dream:approve:{before-commit,committed}, dream:reject:before-commit + stale-digest and already-decided refusals"
  echo "knowledge.memory-after-A     [github] A done; one episode, no pin left, record idempotent"
  echo "knowledge.planning-B         [github] B's planning text: playbook version V, Adaptive context line, Repository memory with A's records"
  echo "knowledge.pinning            [github] B pinned to V through a new version V+1; C gets V+1; B's pin gone once done"
  echo "knowledge.serve-sigkill      [github] SIGKILL serve while B plans: B goes on, pin and memory rows unchanged"
  echo "knowledge.negative-maybe     [github] 'maybe' holds at check with recheck/cancel"
  echo "knowledge.negative-noctx     [github] 'enabled' without planningContext holds at check; recheck passes once restored"
  echo "knowledge.stale-record       [github] a src/ or test/ file A's records cite changes on main before B plans: B's planning text shows A's record as stale $(pre)"
  echo "knowledge.all-done           [github] A, B and C each done (PRs merged, one plan and report), no duplicate marker on any $(pre)"
}
k_settled() { # a settled Objective with an episode row
  kq "select objective from memory where kind='episode' order by created desc" | python3 -c '
import json,sys,os
root=sys.argv[1]
for r in json.load(sys.stdin):
    s=None
    for d in ("objectives", "objectives/finished"):
        try: s=json.load(open(os.path.join(root,d,str(r["objective"])+".json")))["status"]; break
        except Exception: pass
    if s is None: continue
    if s in ("done","failed","cancelled"): print(r["objective"]); break' "$ROOT"
}
# k_dream [CRASH_POINT] ARGS...: run `factory dream`; stdout in $RUN_DIR/dream.out
# (read it with kout), exit code in K_EXIT. Not for $(...): K_EXIT must survive.
# Only the service writes the knowledge store, so dream needs a live serve.
# dream:submitted is in the CLI (FACTORY_CRASH_AT on the CLI). Every store point
# (dream:proposal|approve|reject:*, knowledge:retain:*) is in the serve: the serve
# starts with that point, the CLI runs plain, and K_EXIT is the serve's exit code.
k_dream() {
  local pt=$1 cpt="" spt=""; shift
  case $pt in "") ;; dream:submitted) cpt=$pt ;; *) spt=$pt ;; esac
  if [ -n "$spt" ]; then serve_stop; serve_start "$spt" || { K_EXIT=98; return; }; sleep 3
  else serve_alive || { serve_start || { K_EXIT=98; return; }; sleep 3; }; fi
  (cd "$BUILD" && env FACTORY_STATE_DIR="$STATE" FACTORY_CONFIG="$CUR_CFG" ${cpt:+FACTORY_CRASH_AT=$cpt} \
    timeout 900 node dist/cli.js dream "$@" --repo "$REPO" >"$RUN_DIR/dream.out" 2>"$RUN_DIR/dream.err"; exit $?)
  K_EXIT=$?
  if [ -n "$spt" ]; then
    local i; for i in $(seq 1 60); do [ -s "$SERVE_DIR/exit" ] && break; sleep 1; done
    if [ -s "$SERVE_DIR/exit" ]; then K_EXIT=$(cat "$SERVE_DIR/exit"); serve_reap; log "serve crashed at $spt (exit $K_EXIT)"
    else log "serve never reached $spt"; K_EXIT=97; serve_stop; fi
  fi
}
# k_restart: a clean serve applies any request a crashed one left; wait for it.
k_restart() { serve_stop; serve_start || return 1; sleep 25; }
kout() { cat "$RUN_DIR/dream.out"; }
jget() { python3 -c 'import json,sys
try: d=json.loads(sys.stdin.read())
except Exception: print(""); sys.exit()
for k in sys.argv[1].split("."): d=d.get(k) if isinstance(d,dict) else None
print("" if d is None else (d if isinstance(d,str) else json.dumps(d)))' "$1"; }

knowledge_local() {
  [ -n "${LOCAL_ONLY:-}" ] || serve_alive || serve_start || return
  local g=knowledge t0 r
  t0=$(now)
  if [ ! -s "$(KDB)" ]; then
    for r in store-integrity record-idempotent preview show crash-record; do record "knowledge.$r" $g UNREACHABLE "no knowledge store at $(KDB)" "$t0"; done; return
  fi
  # store-integrity
  local rows ids dup pv pins
  rows=$(kval "select count(*) n from memory"); ids=$(kval "select count(distinct id) n from memory")
  dup=$(kval "select count(*) n from (select kind, objective, run, item, summary, body, count(*) c from memory group by 1,2,3,4,5,6 having c>1)")
  pv=$(kval "select case when count(*)=0 or (min(version)=1 and max(version)=count(*)) then 'ok' else 'gap' end v from playbook")
  pins=$(kq "select objective from pins" | python3 -c '
import json,sys,os
bad=[]
for r in json.load(sys.stdin):
    s="none"
    for d in ("objectives", "objectives/finished"):
        try: s=json.load(open(os.path.join(sys.argv[1],d,str(r["objective"])+".json")))["status"]; break
        except Exception: pass
    if s in ("done","failed","cancelled","none"): bad.append(r["objective"])
print(" ".join(map(str,bad)))' "$ROOT")
  if [ "$rows" = "$ids" ] && [ "$dup" = 0 ] && [ "$pv" = ok ] && [ -z "$pins" ]; then record knowledge.store-integrity $g PASS "$rows rows, $ids distinct ids, 0 duplicates, playbook versions contiguous, no stale pins" "$t0"
  else record knowledge.store-integrity $g FAIL "rows=$rows ids=$ids duplicates=$dup playbook=$pv stale pins=[$pins]" "$t0"; fi
  # record-idempotent
  t0=$(now); local n out before after
  n=$(k_settled)
  if [ -z "$n" ]; then record knowledge.record-idempotent $g UNREACHABLE "no settled Objective with an episode in this store" "$t0"
  else
    before=$(kval "select count(*) n from memory"); k_dream "" --record --objective "$n"; out=$(kout); after=$(kval "select count(*) n from memory")
    if [ "$K_EXIT" = 0 ] && [ "$(jget recorded <<<"$out")" = false ] && [ "$before" = "$after" ]; then record knowledge.record-idempotent $g PASS "#$n recorded=false, rows $before=$after" "$t0"
    else record knowledge.record-idempotent $g FAIL "#$n exit=$K_EXIT recorded=$(jget recorded <<<"$out") rows $before->$after" "$t0"; fi
  fi
  # preview
  t0=$(now); local pc0 pc1
  pc0=$(( $(st events 0 event=planner-call) + $(st events 0 event=model-usage role=dream) ))
  k_dream "" --preview; out=$(kout); pc1=$(( $(st events 0 event=planner-call) + $(st events 0 event=model-usage role=dream) ))
  local ib mb; ib=$(jget inputBytes <<<"$out"); mb=$(jget bounds.maxBytes <<<"$out")
  if [ "$K_EXIT" = 0 ] && [ -n "$ib" ] && [ -n "$mb" ] && [ "$ib" -le "$mb" ] && [ "$pc0" = "$pc1" ]; then
    record knowledge.preview $g PASS "inputBytes $ib <= $mb; included $(jget included <<<"$out" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))'), deferred $(jget deferred <<<"$out"); no planner call" "$t0"
  else record knowledge.preview $g FAIL "exit=$K_EXIT inputBytes=$ib maxBytes=$mb model calls on issue 0 (planner-call, or model-usage role=dream) $pc0->$pc1" "$t0"; fi
  # show
  t0=$(now); k_dream "" --show; out=$(kout)
  local av mv; av=$(jget approved.version <<<"$out"); mv=$(kval "select coalesce(max(version),'') v from playbook")
  if [ "$K_EXIT" = 0 ] && [ "$av" = "$mv" ]; then record knowledge.show $g PASS "approved version ${av:-none} = newest playbook row" "$t0"
  else record knowledge.show $g FAIL "exit=$K_EXIT approved=$av newest row=$mv" "$t0"; fi
  # crash-record
  t0=$(now)
  if [ -z "$n" ]; then record knowledge.crash-record $g UNREACHABLE "no settled Objective with an episode in this store" "$t0"
  else
    before=$(kval "select count(*) n from memory"); k_dream knowledge:retain:before-commit --record --objective "$n"; local code=$K_EXIT
    after=$(kval "select count(*) n from memory"); k_dream "" --record --objective "$n"; out=$(kout)
    if [ "$code" = 137 ] && [ "$before" = "$after" ] && [ "$(jget recorded <<<"$out")" = false ]; then record knowledge.crash-record $g PASS "exit 137, rows $before=$after, rerun recorded=false" "$t0"
    elif [ "$code" = 0 ] || [ "$code" = 97 ]; then record knowledge.crash-record $g UNREACHABLE "#$n was already recorded, so the retain point is never reached (exit 0); needs an unrecorded settled Objective" "$t0"
    else record knowledge.crash-record $g FAIL "exit=$code rows $before->$after rerun recorded=$(jget recorded <<<"$out")" "$t0"; fi
  fi
}

knowledge_model() {
  serve_alive || serve_start || return
  local g=knowledge t0 out f v code
  local drafts=0 tries=0 sizes=""
  # k_new_draft: one dream call; sets f (draft file) and counts it for the budget re-check.
  k_new_draft() {
    tries=$((tries + 1)); k_dream ""; out=$(kout); f=$(jget file <<<"$out")
    if [ -n "$f" ] && [ -f "$f" ]; then drafts=$((drafts + 1))
      sizes="$sizes $(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(len(json.dumps(d.get("draft",d),separators=(",",":")).encode()))' "$f")/$(jget budgetBytes <<<"$out")"
      return 0; fi
    log "dream gave no draft (exit $K_EXIT: $(head -c 300 "$RUN_DIR/dream.err"))"; return 1
  }
  t0=$(now)
  k_dream dream:submitted; code=$K_EXIT
  k_dream "" --show; out=$(kout)
  [ "$code" = 137 ] && record knowledge.dream:submitted $g PASS "exit 137; show lists $(jget pending <<<"$out" | head -c 120)" "$t0" || record knowledge.dream:submitted $g FAIL "exit=$code; $(head -c 200 "$RUN_DIR/dream.err")" "$t0"
  # Store points crash the serve; a clean restart applies the left request at most once.
  t0=$(now); local p0 p1 p2; p0=$(kval "select count(*) n from proposals")
  tries=$((tries + 1)); k_dream dream:proposal:before-commit; code=$K_EXIT; p1=$(kval "select count(*) n from proposals"); k_restart; p2=$(kval "select count(*) n from proposals")
  [ "$code" = 137 ] && [ "$p0" = "$p1" ] && [ $((p2 - p0)) -le 1 ] && record knowledge.dream:proposal:before-commit $g PASS "serve exit 137; proposals $p0 at crash, $p2 after restart" "$t0" || record knowledge.dream:proposal:before-commit $g FAIL "exit=$code proposals $p0->$p1->$p2; $(head -c 160 "$RUN_DIR/dream.err")" "$t0"
  t0=$(now); p0=$(kval "select count(*) n from proposals")
  tries=$((tries + 1)); k_dream dream:proposal:committed; code=$K_EXIT; p1=$(kval "select count(*) n from proposals"); k_restart; p2=$(kval "select count(*) n from proposals")
  [ "$code" = 137 ] && [ "$p1" = $((p0 + 1)) ] && [ "$p2" = "$p1" ] && record knowledge.dream:proposal:committed $g PASS "serve exit 137; proposal committed once ($p0->$p1), $p2 after restart" "$t0" || record knowledge.dream:proposal:committed $g FAIL "exit=$code proposals $p0->$p1->$p2; $(head -c 160 "$RUN_DIR/dream.err")" "$t0"
  # Approve: stale digest refused; crash before the commit; the playbook ends exactly one version up.
  t0=$(now)
  if ! k_new_draft; then record knowledge.dream:approve:before-commit $g FAIL "dream gave no draft (exit $K_EXIT)" "$t0"
  else
    local v0 v1 v2 v3 stale again; v0=$(kval "select coalesce(max(version),0) v from playbook")
    k_dream "" --file "$f" --approve 0000000000000000000000000000000000000000000000000000000000000000; stale=$K_EXIT
    k_dream dream:approve:before-commit --file "$f" --approve "$(sha256sum "$f" | cut -d' ' -f1)"; code=$K_EXIT
    v1=$(kval "select coalesce(max(version),0) v from playbook"); k_restart; v2=$(kval "select coalesce(max(version),0) v from playbook")
    k_dream "" --file "$f" --approve "$(sha256sum "$f" | cut -d' ' -f1)"; again=$K_EXIT; v3=$(kval "select coalesce(max(version),0) v from playbook")
    [ "$stale" != 0 ] && [ "$code" = 137 ] && [ "$v1" = "$v0" ] && [ "$v3" = $((v0 + 1)) ] \
      && record knowledge.dream:approve:before-commit $g PASS "stale digest refused (exit $stale); serve exit 137, version $v0 at crash, $v2 after restart, $v3 after approving again (exit $again)" "$t0" \
      || record knowledge.dream:approve:before-commit $g FAIL "stale exit=$stale crash exit=$code versions $v0/$v1/$v2/$v3 again exit=$again" "$t0"
  fi
  t0=$(now)
  if ! k_new_draft; then record knowledge.dream:approve:committed $g FAIL "dream gave no draft (exit $K_EXIT)" "$t0"
  else
    local v0 v1 v2 v3 again; v0=$(kval "select coalesce(max(version),0) v from playbook")
    k_dream dream:approve:committed --file "$f" --approve "$(sha256sum "$f" | cut -d' ' -f1)"; code=$K_EXIT
    v1=$(kval "select coalesce(max(version),0) v from playbook"); k_restart; v2=$(kval "select coalesce(max(version),0) v from playbook")
    k_dream "" --file "$f" --approve "$(sha256sum "$f" | cut -d' ' -f1)"; again=$K_EXIT; v3=$(kval "select coalesce(max(version),0) v from playbook")
    [ "$code" = 137 ] && [ "$v1" = $((v0 + 1)) ] && [ "$v2" = "$v1" ] && [ "$again" != 0 ] && [ "$v3" = "$v1" ] \
      && record knowledge.dream:approve:committed $g PASS "serve exit 137; version $v0->$v1 once, $v2 after restart; re-approve refused (exit $again)" "$t0" \
      || record knowledge.dream:approve:committed $g FAIL "exit=$code versions $v0/$v1/$v2/$v3 re-approve exit=$again" "$t0"
  fi
  # Reject: crash before the commit; exactly one rejection in the end; again refused.
  t0=$(now)
  if ! k_new_draft; then record knowledge.dream:reject:before-commit $g FAIL "dream gave no draft (exit $K_EXIT)" "$t0"
  else
    local r0 r1 r2 r3 c1 c2; r0=$(kval "select count(*) n from rejections")
    k_dream dream:reject:before-commit --file "$f" --reject "$(sha256sum "$f" | cut -d' ' -f1)"; code=$K_EXIT; r1=$(kval "select count(*) n from rejections")
    k_restart; r2=$(kval "select count(*) n from rejections")
    k_dream "" --file "$f" --reject "$(sha256sum "$f" | cut -d' ' -f1)"; c1=$K_EXIT; r3=$(kval "select count(*) n from rejections")
    k_dream "" --file "$f" --reject "$(sha256sum "$f" | cut -d' ' -f1)"; c2=$K_EXIT
    [ "$code" = 137 ] && [ "$r1" = "$r0" ] && [ "$r3" = $((r0 + 1)) ] && [ "$c2" != 0 ] \
      && record knowledge.dream:reject:before-commit $g PASS "serve exit 137, rejections $r0 at crash, $r2 after restart, $r3 after rejecting again (exit $c1); a further reject refused (exit $c2)" "$t0" \
      || record knowledge.dream:reject:before-commit $g FAIL "crash=$code rejections $r0/$r1/$r2/$r3 again=$c1 further=$c2" "$t0"
  fi
  # Re-check (gate-drill defect 3): every clean dream call produced a draft within its budget.
  local over; over=$(tr ' ' '\n' <<<"$sizes" | awk -F/ 'NF==2 && $1>$2' | wc -l)
  if [ "$drafts" -ge 3 ] && [ "$over" = 0 ]; then record knowledge.dream-budget $g PASS "$drafts clean dream calls, every one a draft; draft bytes/budget:$sizes" "$t0"
  else record knowledge.dream-budget $g FAIL "drafts $drafts of 3 clean calls; draft bytes/budget:$sizes; over budget $over" "$t0"; fi
  serve_stop
}

k_hook() { # ISSUE [PLAYBOOK]
  (cd "$BUILD" && FACTORY_STATE_DIR="$STATE" FACTORY_CONFIG="$CUR_CFG" node "$SUITE/lib/plan-hook.mjs" "$BUILD/dist" "$REPO" "$1" "$(cfg_get 'c["checkout"]')" "$ROOT" "${2:-}" 2>&1)
}
k_approve_new() { # -> new version, or empty
  local out f; k_dream ""; out=$(kout); f=$(jget file <<<"$out")
  [ -n "$f" ] && [ -f "$f" ] || return 1
  k_dream "" --file "$f" --approve "$(sha256sum "$f" | cut -d' ' -f1)"
  kval "select max(version) v from playbook"
}

knowledge_github() {
  # A planner question (say, the error type's contract) takes its recommended answer.
  local g=knowledge t0 a b c id p HOLD_POLICY="$HOLD_POLICY decide"
  t0=$(now); id=$(uid)
  if ! gh_file docs/parse.md >/dev/null; then
    record knowledge.memory-after-A $g UNREACHABLE "docs/parse.md is not on main (queue objectives/fixtures.md first)" "$t0"; return
  fi
  a=$(new_objective $g knowA "knowledge A" ID="$id") || return
  serve_start || return
  p=$(wait_phase "$a" 'done|cancelled|failed' 3600); sleep 30
  local ep pin out
  ep=$(kval "select count(*) n from memory where kind='episode' and objective=$a"); pin=$(kval "select count(*) n from pins where objective=$a")
  k_dream "" --record --objective "$a"; out=$(kout)
  local kinds; kinds=$(kq "select kind, count(*) n from memory where objective=$a group by kind" | python3 -c 'import json,sys;print(" ".join("%s x%s"%(r["kind"],r["n"]) for r in json.load(sys.stdin)))')
  end_done "$a"; local ok=$?
  [ $ok = 0 ] && [ "$ep" = 1 ] && [ "$pin" = 0 ] && [ "$(jget recorded <<<"$out")" = false ] \
    && record knowledge.memory-after-A $g PASS "rows: $kinds; no pin; record again recorded=false; $EVID" "$t0" \
    || record knowledge.memory-after-A $g FAIL "episodes=$ep pins=$pin recorded=$(jget recorded <<<"$out") rows: $kinds; $EVID" "$t0"
  # change a src/ or test/ file A's records cite, before B plans.
  local st_path; st_path=$(kq "select digests from memory where objective=$a" | python3 -c 'import json,sys
ps=sorted({p for r in json.load(sys.stdin) for p in (json.loads(r["digests"] or "{}") or {}) if p.startswith(("src/","test/"))})
print(ps[0] if ps else "")')
  if [ -n "$st_path" ]; then
    local sha; sha=$(gh api "repos/$REPO/contents/$st_path?ref=main" --jq .sha 2>/dev/null)
    gh api -X PUT "repos/$REPO/contents/$st_path" -f message="drill: change a file A's memory cites" -f sha="$sha" \
      -f content="$( { gh_file "$st_path"; printf '\n// drill: stale-record check %s\n' "$RUN_ID"; } | base64 -w0)" >/dev/null && log "changed $st_path on main (cited by #$a)"
  fi
  # Version V for B.
  t0=$(now); local V; V=$(k_approve_new)
  b=$(new_objective $g knowB "knowledge B" ID="$id") || return
  wait_phase "$b" '^(planning|building)$|^hold:' 1200 >/dev/null; sleep 10
  local hook; hook=$(k_hook "$b")
  local hasv hasa hasm hasA; hasv=$(grep -c "Approved Dream playbook, version $V" <<<"$hook"); hasa=$(grep -c "Adaptive workflow: planning context is admitted" <<<"$hook")
  hasm=$(grep -c "Repository memory" <<<"$hook"); hasA=$(grep -c "#$a\b\|objective $a\b\|/issues/$a\b" <<<"$hook")
  echo "$hook" >"$RUN_DIR/hook-B-$b.txt"
  [ -n "$V" ] && [ "$hasv" -ge 1 ] && [ "$hasa" -ge 1 ] && [ "$hasm" -ge 1 ] && [ "$hasA" -ge 1 ] \
    && record knowledge.planning-B $g PASS "version $V, Adaptive line, memory section with A's records (hook text: $RUN_DIR/hook-B-$b.txt)" "$t0" \
    || record knowledge.planning-B $g FAIL "V=$V version=$hasv adaptive=$hasa memory=$hasm A-records=$hasA (hook text: $RUN_DIR/hook-B-$b.txt)" "$t0"
  # A's record citing the changed file reads stale in B's planning text.
  if [ -z "$st_path" ]; then record knowledge.stale-record $g UNREACHABLE "A (#$a) has no record citing src/ or test/" "$t0"
  else
    local stl; stl=$(grep -E '^- \[[a-z-]+, [a-z-]+, stale' <<<"$hook" | grep -c "Objective #$a\b")
    [ "$stl" -ge 1 ] && record knowledge.stale-record $g PASS "$st_path changed on main; $stl of A's records stale in B's planning text" "$t0" \
      || record knowledge.stale-record $g FAIL "$st_path changed on main; no stale record of #$a in B's planning text ($RUN_DIR/hook-B-$b.txt)" "$t0"
  fi
  # A's failure records reach B's planning text.
  {
    local fids; fids=$(kq "select id from memory where objective=$a and kind in ('failure','handoff')" | python3 -c 'import json,sys;print(" ".join(str(r["id"]) for r in json.load(sys.stdin)))')
    if [ -z "$fids" ]; then record knowledge.failure-memory-B $g UNREACHABLE "A (#$a) has no failure or handoff record (no repair happened)" "$t0"
    else
      local fsum miss=0 fi_
      for fi_ in $fids; do fsum=$(kval "select substr(summary,1,40) s from memory where id='$fi_'"); grep -qF "$fsum" <<<"$hook" || miss=$((miss + 1)); done
      [ "$miss" = 0 ] && record knowledge.failure-memory-B $g PASS "A's $(wc -w <<<"$fids") failure/handoff records all in B's planning text" "$t0" \
        || record knowledge.failure-memory-B $g FAIL "$miss of $(wc -w <<<"$fids") A failure/handoff records missing from B's planning text ($RUN_DIR/hook-B-$b.txt)" "$t0"
    fi
  }
  # SIGKILL serve while B plans.
  t0=$(now); local rows0 pinB0; rows0=$(kval "select count(*) n from memory"); pinB0=$(kval "select version from pins where objective=$b")
  if [ "$(st status "$b")" = planning ]; then
    local sp ss; sp=$(serve_pid); ss=$(starttime "$sp"); serve_tick; kill_exact "$sp" "$ss" KILL; sleep 3; serve_reap
    serve_start || return
    wait_phase "$b" '^(building|finishing|done)$|^hold:' 1800 >/dev/null
    local rows1 ids1 pinB1; rows1=$(kval "select count(*) n from memory"); ids1=$(kval "select count(distinct id) n from memory"); pinB1=$(kval "select version from pins where objective=$b")
    [ "$rows1" = "$ids1" ] && [ "$pinB0" = "$pinB1" ] && record knowledge.serve-sigkill $g PASS "B went on to $(st phase "$b"); pin $pinB0 kept; rows $rows0->$rows1, all distinct" "$t0" \
      || record knowledge.serve-sigkill $g FAIL "pin $pinB0->$pinB1 rows=$rows1 distinct=$ids1" "$t0"
  else record knowledge.serve-sigkill $g UNREACHABLE "B was $(st phase "$b"), not planning, when checked" "$t0"; fi
  # Pinning: V+1 while B runs; C gets V+1; B's pin gone when done.
  t0=$(now); local V2; V2=$(k_approve_new); local pinB; pinB=$(kval "select version from pins where objective=$b")
  c=$(new_objective $g knowC "knowledge C" ID="$id") || return
  wait_phase "$c" '^(planning|building)$|^hold:' 1200 >/dev/null; sleep 10
  local hookC; hookC=$(k_hook "$c"); echo "$hookC" >"$RUN_DIR/hook-C-$c.txt"
  wait_phase "$b" 'done|cancelled|failed' 3600 >/dev/null; sleep 20
  local pinBend; pinBend=$(kval "select count(*) n from pins where objective=$b")
  [ "$pinB" = "$V" ] && grep -q "Approved Dream playbook, version $V2" <<<"$hookC" && [ "$pinBend" = 0 ] \
    && record knowledge.pinning $g PASS "B pinned to $V through v$V2; C got v$V2; B's pin gone at $(st status "$b")" "$t0" \
    || record knowledge.pinning $g FAIL "B pin=$pinB (V=$V) C has v$V2=$(grep -c "version $V2" <<<"$hookC") B pin rows at end=$pinBend" "$t0"
  wait_phase "$c" 'done|cancelled|failed' 3600 >/dev/null; sleep 20
  # A, B and C all done, no duplicate marker on any.
  t0=$(now); local all_ok=0 evs="" o
  for o in "$a" "$b" "$c"; do end_done "$o" || all_ok=1; evs="$evs | $EVID"; done
  [ $all_ok = 0 ] && record knowledge.all-done $g PASS "${evs# | }" "$t0" || record knowledge.all-done $g FAIL "${evs# | }" "$t0"
  serve_stop
  # Negatives.
  t0=$(now)
  local nm; nm=$(new_objective $g negMaybe "knowledge negative maybe" ID="$(uid)")
  serve_start || return
  p=$(wait_phase "$nm" '^hold:' 600); local hm; hm=$(st hold "$nm")
  cli_t 60 cancel "$nm" >/dev/null 2>&1; wait_phase "$nm" cancelled 300 >/dev/null; serve_stop
  python3 -c 'import json,sys;h=json.loads(sys.argv[1]) or {};sys.exit(0 if h.get("step")=="check" and {"recheck","cancel"}<=set(h.get("answers",[])) else 1)' "$hm" \
    && record knowledge.negative-maybe $g PASS "held at check with recheck/cancel" "$t0" || record knowledge.negative-maybe $g FAIL "phase=$p hold=$(head -c 160 <<<"$hm")" "$t0"
  t0=$(now); local keep=$CUR_CFG
  CUR_CFG="$RUN_DIR/config.knowledge-noctx.json"; cp "$keep" "$CUR_CFG"; cfg_patch "$CUR_CFG" 'c.get("planning",{}).pop("context", None)'
  local nn; nn=$(new_objective $g negNoCtx "knowledge negative no context" ID="$(uid)")
  serve_start || return
  p=$(wait_phase "$nn" '^hold:' 600); local hn; hn=$(st hold "$nn"); serve_stop
  CUR_CFG=$keep; serve_start || return
  answer_t 60 "$nn" recheck >/dev/null 2>&1
  local p2; p2=$(wait_phase "$nn" '^(planning|building)$' 600)
  cli_t 60 cancel "$nn" >/dev/null 2>&1; wait_phase "$nn" cancelled 300 >/dev/null; sleep 10; serve_stop
  python3 -c 'import json,sys;h=json.loads(sys.argv[1]) or {};sys.exit(0 if h.get("step")=="check" and {"recheck","cancel"}<=set(h.get("answers",[])) else 1)' "$hn" && [[ $p2 =~ ^(planning|building)$ ]] \
    && record knowledge.negative-noctx $g PASS "held at check without planningContext; recheck passed once restored ($p2)" "$t0" \
    || record knowledge.negative-noctx $g FAIL "phase=$p after-recheck=$p2 hold=$(head -c 160 <<<"$hn")" "$t0"
}

# planning.context (memory on) for the Adaptive line and repository memory; a top-level planningContext is refused.
knowledge_cfg() { cfg_patch "$CUR_CFG" 'c.setdefault("planning",{})["context"]={"bounds":{"maxRounds":4,"maxRequestsPerRound":8,"maxResults":16,"maxBytes":65536,"maxElapsedMs":30000,"maxProviderCalls":5},"selectors":["src/","docs/"],"memory":True}'; }

# GitHub parts first (they fill a fresh store), then the local and model parts.
knowledge_run() {
  [ -n "${LOCAL_ONLY:-}" ] || knowledge_github
  knowledge_local
  [ -n "${NO_MODEL:-}" ] || knowledge_model
}
