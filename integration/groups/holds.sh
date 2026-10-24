# holds: per-item holds on real GitHub: one question comment per hold, the edit to the bound form when a
# second hold opens, and `/factory <answer> --question <id>` comments, with an
# unbound comment refused while two holds are open.
# Two holds at once: a twin Objective (two independent items) whose PR
# creation fails (502 from the fault proxy) with a short transient budget
# (FACTORY_WAIT_MS), so each item's publish step holds on its own.
holds_needs() { echo "drill repo + Project; default provider; a build with bound answers (holds-v2) with FACTORY_GITHUB_API and FACTORY_WAIT_MS"; }
holds_cost() { echo "~30-45 min; 1 twin Objective (planner + 2 workers) to two publish holds, then cancelled"; }
holds_minutes() { echo 45; }
HOLDS_PORT=${HOLDS_PORT:-18558}
holds_plan() {
  local t; t=$(pre holds-v2 github-api wait-ms)
  echo "holds.one-comment-per-hold  twin, POST /pulls fails (502), FACTORY_WAIT_MS=120000: two publish holds open at once; exactly one hold:<id> comment each $t"
  echo "holds.bound-edit            the first question's comment, posted in the short form while alone, is edited in place (no new comment) to '--question <id>'; state shortForm off $t"
  echo "holds.bound-answers         '/factory <a>' (unbound) while two are open: refused, both stay open; then '/factory <a> --question <id>' per hold: each closes only its own $t"
}
holds_cfg() { cfg_patch "$CUR_CFG" 'c["queue"]["maxActiveObjectives"]=1' 'c["queue"]["pollSeconds"]=10'; }

# A pick for hold JSON: its recommended answer unless that is cancel, else the first other.
holds_pick() { python3 -c 'import json,sys;h=json.loads(sys.argv[1]);a=[x for x in h["answers"] if x!="cancel"];print(h["recommended"] if h["recommended"]!="cancel" else (a[0] if a else "cancel"))' "$1"; }

holds_run() {
  # Planner questions only: d2 would answer the very publish holds this group needs open.
  local g=holds t0 n HOLD_POLICY="decide"
  t0=$(now)
  local c ok=0
  for c in holds.one-comment-per-hold holds.bound-edit holds.bound-answers; do need "$c" $g "$t0" holds-v2 github-api wait-ms || ok=1; done
  [ $ok = 0 ] || return
  proxy_start holds "$HOLDS_PORT"
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV $PROXY_ENV FACTORY_WAIT_MS=120000 FACTORY_BACKOFF_MS=10000"
  proxy_rules holds "POST ^/repos/$REPO/pulls\$"
  n=$(new_objective $g twin "holds two at once" ID="$(uid)") || return
  serve_start || return
  # Until two holds are open; note whether the first was ever alone in the short form.
  local end=$(( $(now) + 3600 )) hs cnt alone="" first=""
  while [ "$(now)" -lt "$end" ]; do
    serve_tick
    case $(st status "$n") in done|cancelled|failed) break ;; esac
    hs=$(st holds "$n"); cnt=$(python3 -c 'import json,sys;print(len([h for h in json.loads(sys.argv[1]) if h["step"].startswith("item:")]))' "$hs")
    if [ "$cnt" = 1 ] && [ -z "$alone" ]; then
      first=$(python3 -c 'import json,sys;h=[h for h in json.loads(sys.argv[1]) if h["step"].startswith("item:")][0];print(h["id"] if h.get("shortForm") is True else "")' "$hs")
      [ -n "$first" ] && alone=$first
    fi
    [ "$cnt" -ge 2 ] && break
    auto_answer "$n"
    sleep 5
  done
  if [ "${cnt:-0}" -lt 2 ]; then
    for c in holds.one-comment-per-hold holds.bound-edit holds.bound-answers; do record "$c" $g FAIL "#$n never had two item holds open (holds now: $(head -c 300 <<<"$hs"); 502s served $(proxy_count holds POST /pulls 502))" "$t0"; done
    proxy_rules holds; cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled|done|failed' 900 >/dev/null; serve_stop; proxy_stop holds; return
  fi
  local ids; ids=$(python3 -c 'import json,sys;print(" ".join(h["id"] for h in json.loads(sys.argv[1]) if h["step"].startswith("item:")))' "$hs")
  local id1 id2; read -r id1 id2 <<<"$ids"
  sleep 60   # both question comments post, and the first is edited
  # exactly one comment per hold id.
  local m q1 q2; m=$(gh_markers "$n"); q1=$(marker_count "$m" "hold:$id1"); q2=$(marker_count "$m" "hold:$id2")
  if [ "$q1" = 1 ] && [ "$q2" = 1 ]; then record holds.one-comment-per-hold $g PASS "#$n holds $id1 and $id2 open at once; question comments x$q1, x$q2" "$t0"
  else record holds.one-comment-per-hold $g FAIL "#$n holds $id1 x$q1, $id2 x$q2 (markers: $(paste -sd' ' <<<"$m"))" "$t0"; fi
  # the one shown alone in the short form is edited, in place, to the bound form.
  t0=$(now)
  if [ -z "$alone" ]; then record holds.bound-edit $g UNREACHABLE "both holds opened before the first question was shown alone in the short form (nothing to edit)" "$t0"
  else
    local cm sf; cm=$(gh_marker_comments "$n" "hold:$alone")
    sf=$(st holds "$n" | python3 -c 'import json,sys;h=[x for x in json.load(sys.stdin) if x["id"]==sys.argv[1]];print(h[0].get("shortForm") if h else "closed")' "$alone")
    local ev; ev=$(python3 -c 'import json,sys
c=json.loads(sys.argv[1]); q=sys.argv[2]
if len(c)!=1: print(f"comments={len(c)}"); sys.exit()
c=c[0]; print("comments=1 edited=%s bound=%s" % (c["updated"] > c["created"], ("--question " + q) in c["body"]))' "$cm" "$alone")
    if [ "$ev" = "comments=1 edited=True bound=True" ] && [ "$sf" != True ]; then record holds.bound-edit $g PASS "#$n question $alone: $ev; state shortForm=$sf" "$t0"
    else record holds.bound-edit $g FAIL "#$n question $alone: $ev; state shortForm=$sf" "$t0"; fi
  fi
  # an unbound comment is refused while two are open; bound ones close only their own.
  t0=$(now)
  proxy_rules holds   # PR creation works again once answered
  local h1 a1 h2 a2; h1=$(st holds "$n" | python3 -c 'import json,sys;print(json.dumps(next(h for h in json.load(sys.stdin) if h["id"]==sys.argv[1])))' "$id1")
  h2=$(st holds "$n" | python3 -c 'import json,sys;print(json.dumps(next(h for h in json.load(sys.stdin) if h["id"]==sys.argv[1])))' "$id2")
  a1=$(holds_pick "$h1"); a2=$(holds_pick "$h2")
  local cu; cu=$(gh_comment "$n" "/factory $a1")
  sleep 60
  local after_u ru; after_u=$(st holds "$n" | python3 -c 'import json,sys;print(" ".join(sorted(h["id"] for h in json.load(sys.stdin))))'); ru=$(marker_count "$(gh_markers "$n")" "reply:comment-$cu")
  local cb1; cb1=$(gh_comment "$n" "/factory $a1 --question $id1")
  wait_for 180 bash -c "! python3 '$SUITE/lib/st.py' '$ROOT' holds $n | grep -q '\"$id1\"'"
  local mid; mid=$(st holds "$n" | python3 -c 'import json,sys;print(" ".join(sorted(h["id"] for h in json.load(sys.stdin))))')
  local cb2; cb2=$(gh_comment "$n" "/factory $a2 --question $id2")
  wait_for 180 bash -c "! python3 '$SUITE/lib/st.py' '$ROOT' holds $n | grep -q '\"$id2\"'"
  local fin; fin=$(st holds "$n" | python3 -c 'import json,sys;print(" ".join(sorted(h["id"] for h in json.load(sys.stdin))))')
  sleep 30; m=$(gh_markers "$n")
  local r1 r2; r1=$(marker_count "$m" "reply:comment-$cb1"); r2=$(marker_count "$m" "reply:comment-$cb2")
  local want; want=$(tr ' ' '\n' <<<"$id1 $id2" | sort | paste -sd' ')
  local ev3="unbound '/factory $a1' (comment $cu): open after 60 s [$after_u], reply x$ru; bound $id1: open after [$mid], reply x$r1; bound $id2: open after [$fin], reply x$r2"
  if [ "$after_u" = "$want" ] && [ "$ru" = 1 ] && [[ " $mid " != *" $id1 "* ]] && [[ " $mid " == *" $id2 "* ]] && [[ " $fin " != *" $id2 "* ]] && [ "$r1" = 1 ] && [ "$r2" = 1 ]; then
    record holds.bound-answers $g PASS "$ev3" "$t0"
  else record holds.bound-answers $g FAIL "$ev3" "$t0"; fi
  cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" 'cancelled|done|failed' 900 >/dev/null; sleep 15
  serve_stop; proxy_stop holds
}
