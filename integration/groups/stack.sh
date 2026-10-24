# stack: native-stack delivery with a crash at each stack point, and the
# update-branch point when main requires up-to-date branches.
stack_needs() { echo "drill repo + Project; delivery.kind native-stack (set in the scratch config); deliver:update-branch:* needs strict protection (\"require branches up to date\") on main"; }
stack_cost() { echo "~45-75 min; 2 Objectives (3-item chain + independent item each) to completion"; }
stack_minutes() { echo 75; }
STACK_POINTS=${STACK_POINTS:-stack:create:before stack:create:after stack:merge:before stack:merge:after}
STACK_STRICT_POINTS=${STACK_STRICT_POINTS:-deliver:update-branch:before deliver:update-branch:after}
stack_plan() {
  local pt
  for pt in $STACK_POINTS; do echo "stack.$pt  chained on the stack Objectives; both finish done, every PR merged once [site: $(node "$SUITE/lib/crashpoints.mjs" "$BUILD" check "$pt" | cut -f2)]"; done
  for pt in $STACK_STRICT_POINTS; do echo "stack.$pt  same, with strict protection on main (present, or added with --allow-repo-changes) $(pre approval:strict-protection)"; done
  echo "stack.predecessor-merge  strict protection: a layer's web-flow merge of its predecessor's branch counts as Factory's; done with no hold $(pre approval:strict-protection)"
  echo "stack.lower-media-repair stackmedia.md: lower layer's select answered 'repair' once, then a set picked; the upper layer's change survives and merges $(pre)"
  echo "stack.episodes-merged    knowledge store after the stack Objectives: every Work Item of their episodes has merged=true $(pre)"
}
stack_cfg() { cfg_patch "$CUR_CFG" 'c["delivery"]={"kind":"native-stack"}' 'c["queue"]["maxActiveObjectives"]=3'; }

stack_run() {
  local g=stack t0 a b pt pts=() p1 p2 strict
  t0=$(now)
  strict=$(gh_strict)
  if [ "$strict" != true ] && [ -n "${ALLOW_REPO_CHANGES:-}" ]; then rc_strict_on && strict=true; fi
  for pt in $STACK_POINTS $STACK_STRICT_POINTS; do
    if [ "$(node "$SUITE/lib/crashpoints.mjs" "$BUILD" check "$pt" | cut -f2)" != yes ]; then
      record "stack.$pt" $g UNREACHABLE "no crashPoint site for $pt in this build" "$t0"; continue; fi
    if [[ " $STACK_STRICT_POINTS " == *" $pt "* ]] && [ "$strict" != true ]; then
      approved "stack.$pt" $g "$t0" "strict protection on main (require branches up to date)" && record "stack.$pt" $g UNREACHABLE "main has strict=false and it couldn't be turned on" "$t0"; continue; fi
    pts+=("$pt")
  done
  if [ ${#pts[@]} -eq 0 ]; then stack_more "" "$strict"; return; fi
  a=$(new_objective $g stack "stack chain" ID="$(uid)") || return
  b=$(new_objective $g stack2 "stack chain 2" ID="$(uid)") || return
  # The chain's crash points are process-wide: either Objective may reach them.
  CH=(); local pt2
  for pt2 in "${pts[@]}"; do
    crash_at "$a" "$pt2" 2400; [ "$CRASH_R" = 137 ] && CH[$pt2]="crashed $(ts)" || CH[$pt2]="missed ($CRASH_R)"
    sleep 2
  done
  serve_start || return
  p1=$(wait_phase "$a" 'done|cancelled|failed' 3600); p2=$(wait_phase "$b" 'done|cancelled|failed' 3600)
  sleep 20; serve_stop
  local ok=0 ev1 ev2
  end_done "$a" || ok=1; ev1=$EVID
  end_done "$b" || ok=1; ev2=$EVID
  record_chain $g $ok "$ev1 | $ev2" "$t0" "${pts[@]}"
  stack_more "$a $b" "$strict"
}

# The checks after the crash chain. STACK_NS: the stack Objectives that ran;
# STRICT: whether main had strict protection while they ran.
stack_more() {
  local ns=$1 strict=$2 g=stack t0; t0=$(now)
  # a predecessor merge into an upper layer counts as Factory's.
  if [ "$strict" != true ]; then approved stack.predecessor-merge $g "$t0" "strict protection on main" && record stack.predecessor-merge $g UNREACHABLE "main isn't strict" "$t0"
  elif [ -z "$ns" ]; then record stack.predecessor-merge $g UNREACHABLE "no stack Objective ran" "$t0"
  else
    local n pm=0 holds=0 ok=0 evs=""
    for n in $ns; do
      holds=$(( holds + $(st events "$n" event=outcome outcome=hold) ))
      [ "$(st status "$n")" = done ] || ok=1
      pm=$(( pm + $(stack_pred_merges "$n") ))
      evs="$evs #$n $(st status "$n")"
    done
    local ev="strict main;$evs; holds $holds; web-flow merges of a predecessor's head into an upper layer: $pm"
    if [ "$pm" = 0 ]; then record stack.predecessor-merge $g UNREACHABLE "no layer was updated from its predecessor; $ev" "$t0"
    elif [ $ok = 0 ] && [ "$holds" = 0 ]; then record stack.predecessor-merge $g PASS "$ev" "$t0"
    else record stack.predecessor-merge $g FAIL "$ev" "$t0"; fi
  fi
  restore_run
  stack_lower_media
  # episodes count every merged layer, lower ones included.
  t0=$(now)
  local all="$ns ${STACK_MEDIA_N:-}"
  if [ -z "${all// /}" ] || [ ! -s "$(KDB)" ]; then record stack.episodes-merged $g UNREACHABLE "no stack Objective or no knowledge store" "$t0"
  else
    local out; out=$(for n in $all; do kq "select objective, body from memory where kind='episode' and objective=$n"; done | python3 -c '
import json, sys
res = []
for line in sys.stdin:
    for r in json.loads(line or "[]"):
        try: b = json.loads(r["body"])
        except Exception: b = r["body"]
        flags = []
        def walk(x):
            if isinstance(x, dict):
                if "merged" in x: flags.append(bool(x["merged"]))
                for v in x.values(): walk(v)
            elif isinstance(x, list):
                for v in x: walk(v)
        if isinstance(b, str):
            flags += [True] * b.count("\"merged\":true") + [False] * b.count("\"merged\":false")
        else: walk(b)
        res.append("#%s %d/%d" % (r["objective"], sum(flags), len(flags)))
print(" ".join(res))')
    local bad; bad=$(tr ' ' '\n' <<<"$out" | grep -E '^[0-9]+/[0-9]+$' | awk -F/ '$1!=$2 || $2==0' | wc -l)
    if [ -z "$out" ]; then record stack.episodes-merged $g FAIL "no episode rows for #${all// /, #}" "$t0"
    elif [ "$bad" = 0 ]; then record stack.episodes-merged $g PASS "merged items per episode: $out" "$t0"
    else record stack.episodes-merged $g FAIL "merged items per episode: $out" "$t0"; fi
  fi
}
# Web-flow merge commits on N's PRs whose second parent is a commit of another of N's PRs.
stack_pred_merges() {
  local n=$1 prs p
  prs=$(gh_prs "$n" | python3 -c 'import json,sys;print(" ".join(str(x["number"]) for x in json.load(sys.stdin)))')
  for p in $prs; do gh api "repos/$REPO/pulls/$p/commits" --paginate --jq ".[]|{pr: $p, sha, committer: .committer.login, parents: [.parents[].sha]}"; done \
    | python3 -c '
import json, sys
rows = [json.loads(l) for l in sys.stdin if l.strip()]
by_pr = {}
for r in rows: by_pr.setdefault(r["pr"], set()).add(r["sha"])
n = 0
for r in rows:
    if r["committer"] == "web-flow" and len(r["parents"]) == 2:
        if any(r["parents"][1] in shas for pr, shas in by_pr.items() if pr != r["pr"]): n += 1
print(n)'
}
# a media repair on the lower layer keeps the upper layer's work.
STACK_MEDIA_N=""
stack_lower_media() {
  local g=stack t0 n id p reps=0 HOLD_POLICY="$HOLD_POLICY decide"; t0=$(now); id=$(uid)
  n=$(new_objective $g stackmedia "stack lower media repair" ID="$id") || return
  STACK_MEDIA_N=$n
  serve_alive || serve_start || return
  local end=$(( $(now) + 5400 ))
  while [ "$(now)" -lt "$end" ]; do
    serve_tick; p=$(st phase "$n")
    case $p in done|cancelled|failed) break ;; esac
    if [[ $p == hold:item:*:select ]]; then
      local hj hid; hj=$(st hold "$n" 'item:*:select'); hid=$(hold_field "$hj" id)
      if [ ! -f "$RUN_DIR/stsel.$hid" ]; then
        touch "$RUN_DIR/stsel.$hid"
        if [ $reps = 0 ]; then reps=1; answer_t 60 "$n" repair --question "$hid" --text "Make both candidate sets again, with different colours." >/dev/null 2>&1; log "#$n repair at select"
        else media_select "$n" "" ""; fi
      fi
    elif [[ $p == hold:* ]]; then auto_answer "$n" || { log "#$n held at $p"; break; }; fi
    sleep 10
  done
  sleep 20; serve_stop
  local up; up=$(gh_file "src/badge$id.js" | grep -c "badgePath$id")
  local sr; sr=$(st events "$n" event=outcome outcome=repair 'step=*:select')
  end_done "$n"; local ok=$?
  local ev="select repairs $sr (answered repair $reps); upper layer src/badge$id.js on main with badgePath$id: $up; $EVID"
  if [ "$reps" = 0 ]; then record stack.lower-media-repair $g UNREACHABLE "no select hold came (no candidate sets); $ev" "$t0"
  elif [ $ok = 0 ] && [ "$up" -ge 1 ] && [ "$sr" -ge 1 ]; then record stack.lower-media-repair $g PASS "$ev" "$t0"
  else record stack.lower-media-repair $g FAIL "$ev" "$t0"; fi
}
