# bounded1: withdrawal, a lower-layer media repair and a stuck planner
# question, all in one serve so they fit 30 minutes. B1_LIMIT (s, default 1800) is a hard stop:
# anything unsettled then is recorded INCOMPLETE and cancelled.
#   queue.dequeue-held-cleanup  held rerun:cleanup withdrawn when its card is cleared; status comment ends "Withdrawn before planning"
#   queue.withdraw-cancel       a checking card moved to Cancelled: withdrawn; status comment ends the same way
#   crash-points.serve:withdrawn crash after the state goes: the comment already shows the final line, nothing else posted
#   stack.lower-media-repair    a select `repair` gives a new select hold with new candidate sets
#   plan.stuck-question         sources.md without localAssetRoots, `answer` each time: stops at planningRevisions (4) with a `more` hold; cancel at 8 planner calls
bounded1_needs() { echo "drill repo + Project; native-stack; github-api proxy"; }
bounded1_cost() { echo "<=30 min; 5 Objectives, 2 withdrawn before planning"; }
bounded1_minutes() { echo 30; }
bounded1_plan() {
  echo "queue.dequeue-held-cleanup, queue.withdraw-cancel, crash-points.serve:withdrawn, stack.lower-media-repair, plan.stuck-question (one serve, ${B1_LIMIT:-1800} s limit)"
}
bounded1_cfg() {
  cfg_patch "$CUR_CFG" 'c["delivery"]={"kind":"native-stack"}' 'c["queue"]["maxActiveObjectives"]=3' 'c["queue"]["pollSeconds"]=10' \
    'c.get("media",{}).pop("localAssetRoots",None)'
}
B1_PORT=${B1_PORT:-18570}
WITHDRAWN_LINE="Withdrawn before planning; queue it again to start afresh."
# The newest Factory status comment's body on issue N (any run).
b_status_last() {
  gh api "repos/$REPO/issues/$1/comments" --paginate --jq ".[]|select(.body|startswith(\"<!-- factory:$1:status:\"))|{created: .created_at, body}" \
    | python3 -c 'import json,sys
rows=[json.loads(l) for l in sys.stdin if l.strip()]
rows.sort(key=lambda r: r["created"])
print(json.dumps(rows[-1]["body"]) if rows else "")'
}
b_status_count() { gh api "repos/$REPO/issues/$1/comments" --paginate --jq ".[]|select(.body|startswith(\"<!-- factory:$1:status:\"))|.id" | wc -l; }
b_ends_withdrawn() { python3 -c 'import json,sys;b=json.loads(sys.argv[1]) if sys.argv[1] else "";sys.exit(0 if b.rstrip().endswith(sys.argv[2]) else 1)' "$1" "$WITHDRAWN_LINE"; }
b_planner_calls() { st events "$1" event=model-usage role=planner; }
# Rules on the b1 proxy: W delays plus C's reopen refusal.
B1_RULES=()
b1_rules() { proxy_rules b1 "${B1_RULES[@]}"; }

# One pass over the three running Objectives (A media, B stuck question, C held cleanup).
b1_tick() {
  local p
  # ---- A: stack media repair
  if [ -z "$A_DONE" ]; then
    p=$(st phase "$A")
    case $p in
      done|cancelled|failed) A_DONE=$p ;;
      hold:item:*:select)
        local hj hid; hj=$(st hold "$A" 'item:*:select'); hid=$(hold_field "$hj" id)
        if [ -n "$hid" ] && [ ! -f "$RUN_DIR/b1sel.$hid" ]; then
          touch "$RUN_DIR/b1sel.$hid"; A_SELECTS=$((A_SELECTS + 1))
          echo "$hj" >"$RUN_DIR/b1sel.$hid.json"
          if [ "$A_REPAIRS" = 0 ]; then A_REPAIRS=1; A_REPAIR_AT=$(now)
            answer_t 60 "$A" repair --question "$hid" --text "Make both candidate sets again, with different colours." >/dev/null 2>&1; log "#$A repair at select ($hid)"
          else media_select "$A" "" ""; fi
        fi ;;
      hold:*) if ! HOLD_POLICY="d2 review decide" auto_answer "$A"; then
                [ -z "$A_OPHOLD" ] && { A_OPHOLD=$p; log "#$A held at $p (no auto answer)"; st hold "$A" >"$RUN_DIR/b1-A-ophold.json"; }
              fi ;;
    esac
  fi
  # ---- B: stuck planner question
  if [ -z "$B_DONE" ]; then
    p=$(st phase "$B")
    local calls; calls=$(b_planner_calls "$B")
    case $p in
      done|cancelled|failed) B_DONE=$p ;;
      building|finishing) B_DONE="past planning ($p)" ;;
      hold:*)
        local hs; hs=$(st holds "$B")
        local kind hid; read -r kind hid < <(python3 -c 'import json,sys
for h in json.loads(sys.argv[1]):
    a=h.get("answers") or []; s=h.get("step","")
    if not s.startswith("decide:"): print("other", h.get("id","")); break
    if "answer" in a: print("answer", h["id"]); break
    if "more" in a: print("more", h["id"]); break
    print("other", h.get("id",""))
    break' "$hs")
        if [ "$kind" = more ]; then echo "$hs" >"$RUN_DIR/b1-B-more.json"; B_DONE="more-hold"; B_MORE=$hid; log "#$B more hold $hid after $B_ANSWERS answers, $calls planner calls"
        elif [ "$kind" = answer ] && [ ! -f "$RUN_DIR/b1ans.$hid" ]; then
          if [ "$B_ANSWERS" -ge 4 ]; then echo "$hs" >"$RUN_DIR/b1-B-5th.json"; B_DONE="5th question"; log "#$B a 5th planner question after 4 answers: $hid"
          else touch "$RUN_DIR/b1ans.$hid"; B_ANSWERS=$((B_ANSWERS + 1))
            answer_t 60 "$B" answer --question "$hid" --text "Take your recommended option." >/dev/null 2>&1; log "#$B answered 'answer' #$B_ANSWERS ($hid)"; fi
        elif [ "$kind" = other ]; then HOLD_POLICY="d2 review" auto_answer "$B" >/dev/null || { [ -z "$B_OTHER" ] && { B_OTHER=$p; echo "$hs" >"$RUN_DIR/b1-B-other.json"; log "#$B held at $p"; }; }
        fi ;;
    esac
    if [ -z "$B_DONE" ] && [ "${calls:-0}" -ge 8 ]; then B_DONE="8 planner calls"; log "#$B reached 8 planner calls without a more hold"; fi
  fi
  # ---- C: held rerun:cleanup dequeue
  case $C_ST in
    c0) if [[ $(st phase "$C") == hold:* ]]; then cli_t 60 cancel "$C" >/dev/null 2>&1; log "#$C held: cancel sent"; C_ST=c1; fi ;;
    c1) if [ "$(st status "$C")" = cancelled ] && [ "$(st has "$C" done.cancel:cleanup)" = 1 ]; then
          sleep 20; C_Q0=$(marker_prefix_count "$(gh_markers "$C")" hold:)
          B1_RULES+=("PATCH ^/repos/$REPO/issues/$C\$ status=403"); b1_rules
          gh_card "$C" Queued; C_ST=c2; fi ;;
    c2) if [ "$(st events "$C" event=start 'step=rerun:*')" -ge 1 ]; then C_T=$(now); C_ST=c3; fi ;;
    c3) if [ $(( $(now) - C_T )) -ge 60 ]; then C_PH=$(st phase "$C"); C_HOLDS=$(st holds "$C"); C_TDQ=$(date -u +%Y-%m-%dT%H:%M:%SZ); gh_card "$C" ""; C_T=$(now); C_ST=c4; fi ;;
    c4) if [ $(( $(now) - C_T )) -ge 120 ]; then C_ST=c5; b1_eval_c; fi ;;
  esac
}
b1_eval_c() {
  local s w card q1 sb sc ok=0
  s=$(st status "$C"); w=$(st events "$C" event=withdrawn); card=$(gh_card_value "$C"); q1=$(marker_prefix_count "$(gh_markers "$C")" hold:)
  sb=$(b_status_last "$C"); sc=$(b_status_count "$C")
  b_ends_withdrawn "$sb" || ok=1
  local ev="#$C re-queued with its reopen refused (403s served $(proxy_count b1 PATCH "/issues/$C\$" 403)); phase before the dequeue $C_PH (holds $(python3 -c 'import json,sys;print([h.get("step") for h in json.loads(sys.argv[1] or "[]")])' "$C_HOLDS")); after: status $s, withdrawn events $w, card '$card', question comments $C_Q0 -> $q1, status comments $sc, newest ends: $(python3 -c 'import json,sys;b=json.loads(sys.argv[1]) if sys.argv[1] else "";print(repr(b.strip().splitlines()[-1][:90]) if b.strip() else "none")' "$sb")"
  local qa rq rw; qa=$(gh_hold_comments_since "$C" "$C_TDQ"); read -r rq rw < <(gh_rerun_questions_withdrawn "$C")
  ev="$ev; questions after the dequeue $qa; re-run questions $rq, edited to no longer apply $rw"
  if [ "$w" -ge 1 ] && [ -z "$card" ] && [ "$qa" = 0 ] && [ "$rq" = "$rw" ] && [ "$s" = cancelled ] && [ $ok = 0 ] && [[ $C_PH == hold:rerun* ]]; then record queue.dequeue-held-cleanup queue PASS "$ev" "$C_T0"
  else record queue.dequeue-held-cleanup queue FAIL "$ev" "$C_T0"; fi
}
# b1_wait SECS CMD...: like wait_for, ticking the three Objectives.
b1_wait() {
  local secs=$1; shift; local end=$(( $(now) + secs ))
  while [ "$(now)" -lt "$end" ] && [ "$(now)" -lt "$B1_END" ]; do serve_tick; b1_tick; "$@" && return 0; [ -n "$SERVE_DIR" ] && [ -s "$SERVE_DIR/exit" ] && return 2; sleep 5; done
  return 1
}
b_has_status() { [ "$(b_status_count "$1")" -ge 1 ]; }
b_checking() { [ "$(st status "$1")" = checking ]; }

bounded1_run() {
  local g=bounded1 t0; t0=$(now); B1_END=$(( t0 + ${B1_LIMIT:-1800} ))
  A_DONE=""; A_SELECTS=0; A_REPAIRS=0; A_REPAIR_AT=""; A_OPHOLD=""
  B_DONE=""; B_ANSWERS=0; B_MORE=""; B_OTHER=""
  C_ST=c0; C_Q0=""; C_T=""; C_PH=""; C_HOLDS=""; C_T0=$t0
  proxy_start b1 "$B1_PORT"
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV $PROXY_ENV"
  local aid; aid=$(uid)
  A=$(new_objective stack stackmedia "bounded1 lower media repair" ID="$aid") || return
  B=$(new_objective plan sources "bounded1 stuck question" ID="$(uid)") || return
  C=$(new_objective queue hold "bounded1 held cleanup" ID="$(uid)") || return
  local W1 W2
  W1=$(new_issue crash-points withdraw3 "bounded1 crash withdrawn" ID="$(uid)") || return
  W2=$(new_issue queue withdraw2 "bounded1 withdraw-cancel" ID="$(uid)") || return
  B1_RULES=("GET ^/repos/$REPO/issues/$W1\$ delay=240000" "GET ^/repos/$REPO/issues/$W2\$ delay=240000"); b1_rules
  # ---- serve:withdrawn: W1 checking (its issue read slowed), card -> Cancelled, crash after the state goes.
  local tw=$(now)
  serve_start serve:withdrawn || return
  b1_wait 300 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' phase $A)\" != none ]"
  gh_enqueue "$W1" >/dev/null; log "queued #$W1 (withdraw target, crash at serve:withdrawn)"
  b1_wait 240 b_checking "$W1"; b1_wait 120 b_has_status "$W1"
  local w1pre; w1pre=$(st status "$W1"); local w1sc; w1sc=$(b_status_count "$W1")
  gh_card "$W1" Cancelled
  b1_wait 300 false; local code; code=$(cat "$SERVE_DIR/exit" 2>/dev/null)
  serve_stop
  serve_start || return
  b1_wait 40 false
  local s mk sb; s=$(st status "$W1"); mk=$(gh_markers "$W1"); sb=$(b_status_last "$W1")
  local nonstatus; nonstatus=$(awk '$1 !~ /^status:/' <<<"$mk" | paste -sd' ')
  local ev="#$W1 was $w1pre with $w1sc status comment(s) when its card went Cancelled; serve exit ${code:-none}; after restart: state=$s, markers [$(paste -sd' ' <<<"$mk")], card $(gh_card_value "$W1"), status comment ends withdrawn: $(b_ends_withdrawn "$sb" && echo yes || echo no)"
  if [ "$code" = 137 ] && [ "$s" = none ] && [ -z "$nonstatus" ] && b_ends_withdrawn "$sb"; then record crash-points.serve:withdrawn crash-points PASS "$ev" "$tw"
  else record crash-points.serve:withdrawn crash-points FAIL "$ev" "$tw"; fi
  gh issue close "$W1" --repo "$REPO" --reason "not planned" >/dev/null 2>&1
  # ---- withdraw-cancel: W2 checking, card -> Cancelled.
  tw=$(now)
  gh_enqueue "$W2" >/dev/null; log "queued #$W2 (withdraw-cancel)"
  b1_wait 240 b_checking "$W2"; b1_wait 120 b_has_status "$W2"
  local w2pre; w2pre=$(st status "$W2"); local w2sc; w2sc=$(b_status_count "$W2")
  gh_card "$W2" Cancelled
  b1_wait 240 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' status $W2)\" = none ]"; b1_wait 20 false
  s=$(st status "$W2"); mk=$(gh_markers "$W2"); sb=$(b_status_last "$W2"); nonstatus=$(awk '$1 !~ /^status:/' <<<"$mk" | paste -sd' ')
  local c2; c2=$(gh_card_value "$W2"); local pl; pl=$(st started "$W2" 'plan:*')
  ev="#$W2 was $w2pre with $w2sc status comment(s); after Cancelled: state=$s plan_started=$pl card '$c2' markers [$(paste -sd' ' <<<"$mk")], status comment ends withdrawn: $(b_ends_withdrawn "$sb" && echo yes || echo no)"
  if [ "$s" = none ] && [ "$pl" = 0 ] && [ "$c2" = Cancelled ] && [ -z "$nonstatus" ] && b_ends_withdrawn "$sb"; then record queue.withdraw-cancel queue PASS "$ev" "$tw"
  else record queue.withdraw-cancel queue FAIL "$ev" "$tw"; fi
  gh issue close "$W2" --repo "$REPO" --reason "not planned" >/dev/null 2>&1
  B1_RULES=("${B1_RULES[@]:2}"); b1_rules
  # ---- the rest until all three settle or the limit.
  while [ "$(now)" -lt "$B1_END" ]; do
    [ -n "$A_DONE" ] && [ -n "$B_DONE" ] && [ "$C_ST" = c5 ] && break
    # A's purpose is met once the repair gave a second select hold; it needn't run to done within the limit.
    serve_tick; b1_tick
    if [ -n "$SERVE_DIR" ] && [ -s "$SERVE_DIR/exit" ]; then log "serve exited $(cat "$SERVE_DIR/exit"): restarting"; serve_stop; serve_start || return; fi
    sleep 8
  done
  # ---- results
  [ "$C_ST" = c5 ] || record queue.dequeue-held-cleanup queue INCOMPLETE "limit reached at step $C_ST (#$C)" "$C_T0"
  local calls; calls=$(b_planner_calls "$B")
  local bev="#$B answered 'answer' x$B_ANSWERS, planner calls $calls, end: ${B_DONE:-limit}"
  [ -n "$B_MORE" ] && bev="$bev; more hold $B_MORE options $(python3 -c 'import json,sys;print([h.get("answers") for h in json.load(open(sys.argv[1]))])' "$RUN_DIR/b1-B-more.json")"
  [ -n "$B_OTHER" ] && bev="$bev; other hold $B_OTHER"
  if [ "$B_DONE" = more-hold ] && [ "$B_ANSWERS" -le 4 ] && [ "$calls" -le 6 ]; then record plan.stuck-question plan PASS "$bev" "$t0"
  elif [[ $B_DONE == "past planning"* ]]; then record plan.stuck-question plan UNREACHABLE "the planner didn't get stuck; $bev" "$t0"
  elif [ -z "$B_DONE" ]; then record plan.stuck-question plan INCOMPLETE "$bev" "$t0"
  else record plan.stuck-question plan FAIL "$bev" "$t0"; fi
  local sr; sr=$(st events "$A" event=outcome outcome=repair 'step=*:select')
  local aev="#$A phase $(st phase "$A"); select holds $A_SELECTS (repair answered $A_REPAIRS), select repair outcomes $sr${A_OPHOLD:+, operator hold at $A_OPHOLD}"
  if [ "$A_SELECTS" -ge 2 ] && [ -z "$A_OPHOLD" ]; then
    local sets; sets=$(for f in "$RUN_DIR"/b1sel.*.json; do hold_field "$(cat "$f")" answers; done | paste -sd'|')
    record stack.lower-media-repair stack PASS "$aev; a new select hold came after the repair (answers per hold: $sets)${A_DONE:+; ended $A_DONE}" "$t0"
  elif [ "$A_REPAIRS" = 0 ]; then record stack.lower-media-repair stack INCOMPLETE "$aev; no select hold within the limit" "$t0"
  elif [ -n "$A_OPHOLD" ]; then record stack.lower-media-repair stack FAIL "$aev" "$t0"
  else record stack.lower-media-repair stack INCOMPLETE "$aev; no second select hold within the limit" "$t0"; fi
  # Cancel everything left (the limit is hard).
  local n; for n in "$A" "$B" "$C"; do case $(st status "$n") in done|cancelled|failed|none) ;; *) cli_t 60 cancel "$n" >/dev/null 2>&1; log "#$n cancelled at the end" ;; esac; done
  for n in "$A" "$B" "$C"; do wait_phase "$n" 'cancelled|done|failed|none' 300 >/dev/null; done
  sleep 15; serve_stop; proxy_stop b1
}
