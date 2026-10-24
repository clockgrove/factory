# bounded3: retained conversations, retire-command, accept, amendments, split,
# blame, work conditions, recipes, propose and execution profiles, all in one
# serve under a hard limit (B3_LIMIT s, default 2700).
# Config: fixtures/bounded3-config.json (profiles, planning.context + adaptiveGraph, reviewArtifacts, codex + claude providers).
#   RT  hold.md (codex)        retained conversations: planner question answered after >5 min idle -> resumed planner turn
#   RTC hold.md (claude, run)  same on Claude, for costUsd
#   RE  b3retire.md            a failing Acceptance command -> retire-command <n> -> validated again without it
#   DE  b3decide.md            a needs-human criterion -> accept <n> -> no new reviewer call
#   AM  happy.md               propose-amendment after the plan is accepted; a second one is refused
#   SP  b3split.md             child Objective split
#   BL  b3blame.md             predecessor blame (stack)
#   CO  b3cond.md              work condition: skipped item
#   RC  b3recipe.md            recipe: discovery + expansion envelope children
#   propose                    factory propose / --approve (wrong digest refused) / --enqueue
#   profiles                   every plan item has an executionProfile; the worker ran on its provider
# The scratch config plus fixtures/bounded3-config.json, merged one level deep.
bounded3_cfg() {
  cfg_patch "$CUR_CFG" 'import json
for k, v in json.load(open("'"$SUITE"'/fixtures/bounded3-config.json")).items():
    c[k] = {**c[k], **v} if isinstance(v, dict) and isinstance(c.get(k), dict) else v' 'c["queue"]["maxActiveObjectives"]=10'
}
bounded3_needs() { echo "drill repo + Project; codex and claude subscription logins"; }
bounded3_cost() { echo "<=45 min; ~10 Objectives plus split children and proposals"; }
bounded3_minutes() { echo 45; }
bounded3_plan() { echo "retained, retire-command, accept, amendment, split, blame, condition, recipe/expansion, propose, profiles (${B3_LIMIT:-2700} s)"; }
B3=$RUN_DIR/b3
b3_state() { cat "$ROOT/objectives/$1.json" 2>/dev/null || cat "$ROOT/objectives/finished/$1.json" 2>/dev/null; }
# The first open hold's option of FAMILY: "id answer arg".
b3_option() {
  python3 -c 'import json,sys
for h in json.loads(sys.argv[1]):
    for o in h.get("options") or []:
        if o.get("family")==sys.argv[2] or o.get("answer")==sys.argv[2]:
            print(h["id"], o.get("answer"), o.get("arg") or ""); sys.exit()' "$(st holds "$1")" "$2"
}
b3_note() { echo "$*" >>"$RUN_DIR/notes.$1"; log "#$*"; }
b3_auto() { [[ $(st phase "$1") == hold:* ]] && HOLD_POLICY="d2 review decide" auto_answer "$1" >/dev/null; }

b3_tick() {
  local n p id a arg
  # RT/RTC: answer the planner question only after 6 min idle.
  for n in $RT $RTC; do
    p=$(st phase "$n")
    if [[ $p == hold:decide:* ]] && [ ! -f "$RUN_DIR/b3rt.$n" ]; then
      [ -f "$RUN_DIR/b3rt0.$n" ] || { now >"$RUN_DIR/b3rt0.$n"; b3_note "$n question open; answering after 6 min idle"; }
      if [ $(( $(now) - $(cat "$RUN_DIR/b3rt0.$n") )) -ge 360 ]; then
        read -r id a arg < <(b3_option "$n" answer)
        if [ -n "$id" ]; then touch "$RUN_DIR/b3rt.$n"; answer_t 60 "$n" answer --question "$id" --text 'Use "/" as the separator.' >/dev/null 2>&1; b3_note "$n answered after $(( $(now) - $(cat "$RUN_DIR/b3rt0.$n") )) s idle"; fi
      fi
    elif [[ $p == hold:* ]] && [ -f "$RUN_DIR/b3rt.$n" ]; then b3_auto "$n"; fi
  done
  # RE: retire-command / retire when offered, else the usual answers.
  p=$(st phase "$RE")
  if [[ $p == hold:* ]]; then
    read -r id a arg < <(b3_option "$RE" retire)
    if [ -n "$id" ] && [ ! -f "$RUN_DIR/b3re.$id" ]; then touch "$RUN_DIR/b3re.$id"; st holds "$RE" >"$RUN_DIR/b3re-hold.json"
      answer_t 60 "$RE" "$a" $arg --question "$id" --text "lint-drill is not a script in this repository; the drill retires it." >"$RUN_DIR/b3re-answer.out" 2>&1; b3_note "$RE answered $a $arg at $p"
    elif [ -z "$id" ]; then b3_auto "$RE"; fi
  fi
  # DE: accept each open criterion decision.
  p=$(st phase "$DE")
  if [[ $p == hold:* ]]; then
    read -r id a arg < <(b3_option "$DE" accept)
    if [ -n "$id" ] && [ ! -f "$RUN_DIR/b3de.$id.$arg" ]; then touch "$RUN_DIR/b3de.$id.$arg"; st holds "$DE" >"$RUN_DIR/b3de-hold.json"
      DE_REV0=$(st events "$DE" event=model-usage role=reviewer); DE_AT=$(date -u +%Y-%m-%dT%H:%M:%S)
      answer_t 60 "$DE" accept $arg --question "$id" --text "The JSDoc reads naturally (drill operator)." >"$RUN_DIR/b3de-answer.out" 2>&1; b3_note "$DE accept $arg at $p (reviewer calls so far $DE_REV0)"
    elif [ -z "$id" ]; then b3_auto "$DE"; fi
  fi
  # AM: amendment once the plan is accepted.
  if [ -z "$AM_SENT" ] && [[ $(st phase "$AM") =~ ^(building)$ ]]; then
    AM_SENT=1
    python3 -c 'import json,sys;json.dump({"scope":"in-scope","reason":"The operator also wants a companion helper the plan lacks.","evidence":["The Objective is about a string helper; a sibling isUpper helper is wanted with it."],"ownership":["src/isUpper'"$AM_ID"'.js","test/isUpper'"$AM_ID"'.test.js"],"acceptance":["isUpper'"$AM_ID"'(s) is true when s has at least one character and every letter in it is upper case: isUpper'"$AM_ID"'(\"AB\") is true, isUpper'"$AM_ID"'(\"Ab\") is false.","npm test"],"dependencies":[]},open(sys.argv[1],"w"))' "$B3/amend.json"
    cli_t 60 propose-amendment "$AM" --file "$B3/amend.json" >"$RUN_DIR/b3am-1.out" 2>&1; AM_RC1=$?
    cli_t 60 propose-amendment "$AM" --file "$B3/amend.json" >"$RUN_DIR/b3am-2.out" 2>&1; AM_RC2=$?
    b3_note "$AM propose-amendment rc $AM_RC1, second rc $AM_RC2 ($(grep -o '"code":"[a-z_]*"' "$RUN_DIR/b3am-2.out" | head -1))"
  fi
  for n in $AM $SP $BL $CO $RC $PROPOSED; do b3_auto "$n"; done
}
b3_wait() { local secs=$1; shift; local end=$(( $(now) + secs )); [ "$end" -gt "$B3_END" ] && end=$B3_END
  while [ "$(now)" -lt "$end" ]; do serve_tick; b3_tick; "$@" && return 0
    [ -s "$SERVE_DIR/exit" ] && { log "serve exited $(cat "$SERVE_DIR/exit"): restarting"; serve_stop; serve_start || return 1; }
    sleep 8; done; return 1; }

bounded3_run() {
  local g=bounded3 t0; t0=$(now); B3_END=$(( t0 + ${B3_LIMIT:-2700} )); mkdir -p "$B3"
  AM_SENT=""; AM_ID=$(uid); DE_REV0=""; DE_AT=""; PROPOSED=""
  RT=$(new_objective $g hold "bounded3 retained (codex)" ID="$(uid)") || return
  RTC=$(new_issue $g hold "bounded3 retained (claude)" ID="$(uid)") || return
  RE=$(new_objective $g b3retire "bounded3 retire-command" ID="$(uid)") || return
  DE=$(new_objective $g b3decide "bounded3 accept" ID="$(uid)") || return
  AM=$(new_objective $g happy "bounded3 amendment" ID="$AM_ID") || return
  SP=$(new_objective $g b3split "bounded3 split" ID="$(uid)") || return
  BL=$(new_objective $g b3blame "bounded3 predecessor blame" ID="$(uid)") || return
  CO=$(new_objective $g b3cond "bounded3 condition" ID="$(uid)") || return
  local rid; rid=$(uid); render b3recipe "$B3/recipe.md" ID="$rid"
  cli_t 60 recipe --file "$B3/recipe.md" >"$RUN_DIR/b3-recipe-preview.json" 2>&1; local rprev=$?
  RC=$(new_objective $g b3recipe "bounded3 recipe" ID="$rid") || return
  serve_start || return
  # Claude retained run: factory run N --provider claude (request + follower; the follower is stopped, the run goes on).
  cli_t 40 run "$RTC" --provider claude >"$RUN_DIR/b3-run-claude.out" 2>&1; log "factory run #$RTC --provider claude: rc $?"
  echo "$RTC $g" >>"$RUN_DIR/issues"
  # propose: draft, refused wrong digest, approve + enqueue.
  local tp; tp=$(now)
  cli_t 600 propose "Add a small string helper src/initials$(uid).js exporting initials(s), which returns the upper-case first letter of each space-separated word, with its own test under test/." --file "$B3/draft.json" >"$RUN_DIR/b3-propose.out" 2>&1; local prc=$?
  local sha; sha=$(sha256sum "$B3/draft.json" 2>/dev/null | cut -d' ' -f1)
  cli_t 60 propose --file "$B3/draft.json" --approve 0000000000000000000000000000000000000000000000000000000000000000 >"$RUN_DIR/b3-propose-bad.out" 2>&1; local brc=$?
  cli_t 120 propose --file "$B3/draft.json" --approve "$sha" --enqueue >"$RUN_DIR/b3-propose-approve.out" 2>&1; local arc=$?
  cli_t 120 propose --file "$B3/draft.json" --approve "$sha" --enqueue >"$RUN_DIR/b3-propose-again.out" 2>&1; local arc2=$?
  PROPOSED=$(grep -o 'issues/[0-9]*\|#[0-9][0-9]*' "$RUN_DIR/b3-propose-approve.out" | grep -o '[0-9]*' | sort -u | paste -sd' ')
  for n in $PROPOSED; do echo "$n $g" >>"$RUN_DIR/issues"; done
  log "propose: draft rc $prc, bad digest rc $brc, approve rc $arc, again rc $arc2, issues: $PROPOSED"
  local pev="draft rc $prc ($(stat -c %s "$B3/draft.json" 2>/dev/null || echo 0) bytes); wrong digest rc $brc $(grep -o '"code":"[a-z_]*"' "$RUN_DIR/b3-propose-bad.out" | head -1); approve --enqueue rc $arc -> issues [$PROPOSED]; again rc $arc2"
  local pm=""; for n in $PROPOSED; do pm="$pm #$n marker=$(gh issue view "$n" --repo "$REPO" --json body --jq '.body' | head -1 | grep -c 'factory:0:proposal:') card=$(gh_card_value "$n")"; done
  pev="$pev;$pm; planner propose calls $(st events 0 event=model-usage phase=propose)"
  if [ $prc = 0 ] && [ $brc != 0 ] && [ $arc = 0 ] && [ -n "$PROPOSED" ] && [[ $pm != *"marker=0"* ]]; then record propose bounded3 PASS "$pev" "$tp"
  else record propose bounded3 FAIL "$pev" "$tp"; fi
  # Let everything run until the limit, or all settle.
  local all="$RT $RTC $RE $DE $AM $SP $BL $CO $RC"
  b3_wait 99999 b3_all_settled
  b3_results
  local n; for n in $all $PROPOSED $(b3_children); do case $(st status "$n") in done|cancelled|failed|none) ;; *) cli_t 60 cancel "$n" >/dev/null 2>&1; log "#$n cancelled at the end" ;; esac; done
  B3_END=$(( $(now) + 300 )); b3_wait 300 b3_all_settled
  sleep 15; serve_stop
}
b3_children() { gh issue list --repo "$REPO" --state all --search "factory:parent=$SP in:body" --json number --jq '.[].number' 2>/dev/null; }
b3_all_settled() { local n; for n in $RT $RTC $RE $DE $AM $SP $BL $CO $RC $PROPOSED; do case $(st status "$n") in done|cancelled|failed) ;; *) return 1 ;; esac; done; }

# ---------- results ----------
b3_mu() { # N: model-usage rows as "role phase step sessionMode sessionTurn input cached costUsd at"
  python3 - "$ROOT" "$1" <<'PY'
import json, glob, sys, os
root, n = sys.argv[1], sys.argv[2]
for f in sorted(glob.glob(os.path.join(root, "logs", n, "*.jsonl"))):
    for l in open(f):
        try: e = json.loads(l)
        except ValueError: continue
        if e.get("event") != "model-usage": continue
        t = e.get("tokens") or {}
        print(e.get("role"), e.get("phase") or "-", e.get("step"), e.get("sessionMode"), e.get("sessionTurn"), t.get("input"), t.get("cached"), e.get("costUsd"), e.get("at"), e.get("provider"))
PY
}
b3_results() {
  local t=$(now) n
  # retained conversations
  local sum="" ok=0 resumed_idle=""
  for n in $RT $RTC; do
    b3_mu "$n" >"$RUN_DIR/b3-mu.$n"
    resumed_idle+=$(python3 - "$RUN_DIR/b3-mu.$n" <<'PY'
import sys, datetime
rows = [l.split() for l in open(sys.argv[1]) if l.strip()]
def ts(s): return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
plan = [r for r in rows if r[0] == "planner" and r[1] == "plan"]
out = []
for a, b in zip(plan, plan[1:]):
    gap = (ts(b[8]) - ts(a[8])).total_seconds()
    out.append(f"{a[2]}->{b[2]} gap {int(gap)}s {b[3]} turn {b[4]} input {a[5]}->{b[5]} cost {a[7]}->{b[7]}")
fresh = [int(r[5]) for r in rows if r[3] == "fresh" and r[5] not in ("None",)]
res = [int(r[5]) for r in rows if r[3] == "resumed" and r[5] not in ("None",)]
print(f"[{rows[0][9] if rows else '?'}: {'; '.join(out) or 'one plan call'}; fresh avg input {sum(fresh)//len(fresh) if fresh else '-'} (n={len(fresh)}), resumed avg input {sum(res)//len(res) if res else '-'} (n={len(res)})] ")
PY
)
  done
  local idle_ok; idle_ok=$(grep -c "gap \(3[6-9][0-9]\|[4-9][0-9][0-9]\|[0-9]\{4,\}\)s resumed" <<<"$resumed_idle")
  if [ "$idle_ok" -ge 1 ]; then record retained.resume-after-idle bounded3 PASS "$resumed_idle" "$t0"
  elif grep -q "gap" <<<"$resumed_idle"; then record retained.resume-after-idle bounded3 FAIL "no resumed plan turn after >5 min idle: $resumed_idle" "$t0"
  else record retained.resume-after-idle bounded3 INCOMPLETE "$resumed_idle" "$t0"; fi
  # all Objectives: fresh vs resumed per role
  local agg; agg=$(for n in $RT $RTC $RE $DE $AM $SP $BL $CO $RC $PROPOSED; do b3_mu "$n"; done | python3 -c '
import sys, collections
d = collections.defaultdict(list); c = collections.defaultdict(list)
for l in sys.stdin:
    r = l.split()
    if len(r) < 10 or r[5] == "None": continue
    d[(r[9], r[0], r[3])].append(int(r[5]))
    if r[7] != "None": c[(r[9], r[0], r[3])].append(float(r[7]))
print("; ".join(f"{k[0]} {k[1]} {k[2]}: n={len(v)} avg input {sum(v)//len(v)}" + (f" avg cost ${sum(c[k])/len(c[k]):.3f}" if c[k] else "") for k, v in sorted(d.items())))')
  record retained.fresh-vs-resumed bounded3 INFO "$agg" "$t0"
  # retire-command
  local rs; rs=$(cli_t 30 status "$RE" --json 2>/dev/null | python3 -c 'import json,sys
d=json.load(sys.stdin)
for r in d.get("objectives",[]):
    p=(r.get("plan") or {}); print(json.dumps(p.get("retired"))[:300]); break' 2>/dev/null)
  local rev="#$RE $(st status "$RE"); $(paste -sd';' "$RUN_DIR/notes.$RE" 2>/dev/null); retired: ${rs:-none}; answer: $(head -c 200 "$RUN_DIR/b3re-answer.out" 2>/dev/null)"
  if [ ! -f "$RUN_DIR/b3re-hold.json" ]; then record retire-command bounded3 INCOMPLETE "no retire option offered within the limit; $rev" "$t0"
  elif [ "$(st status "$RE")" = done ] || { [ -n "$rs" ] && [ "$rs" != null ]; }; then record retire-command bounded3 PASS "$rev" "$t0"
  else record retire-command bounded3 FAIL "$rev" "$t0"; fi
  # accept
  local dev="#$DE $(st status "$DE"); $(paste -sd';' "$RUN_DIR/notes.$DE" 2>/dev/null)"
  if [ -z "$DE_AT" ]; then record accept-criterion bounded3 INCOMPLETE "no accept option offered; $dev" "$t0"
  else
    local after; after=$(python3 - "$ROOT" "$DE" "$DE_AT" <<'PY'
import json, glob, sys, os
root, n, at = sys.argv[1:4]; k = 0; first_review_after = None
for f in sorted(glob.glob(os.path.join(root, "logs", n, "*.jsonl"))):
    for l in open(f):
        e = json.loads(l)
        if e.get("at", "") >= at and e.get("event") == "model-usage" and e.get("role") == "reviewer": k += 1
print(k)
PY
)
    dev="$dev; reviewer calls after the accept: $after; decisions: $(cli_t 30 status "$DE" --json 2>/dev/null | python3 -c 'import json,sys;d=json.load(sys.stdin);print(json.dumps([r.get("decisions") for r in d.get("objectives",[])])[:300])' 2>/dev/null)"
    if [ "$(st status "$DE")" = done ] && [ "$after" = 0 ]; then record accept-criterion bounded3 PASS "$dev" "$t0"
    elif [ "$after" = 0 ]; then record accept-criterion bounded3 PASS "$dev (not yet done at the limit)" "$t0"
    else record accept-criterion bounded3 FAIL "$dev" "$t0"; fi
  fi
  # amendment
  local aev="#$AM $(st status "$AM"); $(paste -sd';' "$RUN_DIR/notes.$AM" 2>/dev/null); proposal fact $(b3_state "$AM" | grep -o 'amend:[^"]*:proposal' | head -1); amendment events $(st events "$AM" 'event=amendment*'); plan items $(b3_state "$AM" | grep -o 'isUpper' | wc -l)"
  if [ -z "$AM_SENT" ]; then record amendment bounded3 INCOMPLETE "plan never accepted within the limit; $aev" "$t0"
  elif [ "${AM_RC1:-1}" = 0 ] && [ "${AM_RC2:-0}" != 0 ]; then record amendment bounded3 PASS "$aev" "$t0"
  else record amendment bounded3 FAIL "$aev" "$t0"; fi
  # split
  local ch; ch=$(b3_children | paste -sd' ')
  local sev="#$SP $(st status "$SP"); split steps started $(st started "$SP" 'build:split*'); children [$ch]; markers [$(gh_markers "$SP" | paste -sd' ')]"
  if [ -n "$ch" ]; then record split bounded3 PASS "$sev" "$t0"; elif [ "$(st started "$SP" 'build:split*')" = 0 ]; then record split bounded3 UNREACHABLE "the planner did not split; $sev" "$t0"; else record split bounded3 FAIL "$sev" "$t0"; fi
  # blame
  local bev; bev="#$BL $(st status "$BL"); predecessor decisions $(grep -c '"predecessor"' "$ROOT"/logs/$BL/*.jsonl 2>/dev/null | awk -F: '{s+=$2} END{print s+0}'); free repairs $(b3_state "$BL" | grep -o '"free"' | wc -l); holds $(st holds "$BL" | head -c 200)"
  if grep -q '"predecessor"' "$ROOT"/logs/$BL/*.jsonl 2>/dev/null; then record predecessor-blame bounded3 PASS "$bev" "$t0"
  else record predecessor-blame bounded3 UNREACHABLE "no diagnosis chose predecessor; $bev" "$t0"; fi
  # condition
  local cev; cev="#$CO $(st status "$CO"); skipped items $(b3_state "$CO" | grep -o '"settled": *"skipped"' | wc -l); adaptive-graph-off events $(st events "$CO" event=adaptive-graph-off); conditions in plan $(b3_state "$CO" | grep -o '"conditionId"\|"condition"' | wc -l)"
  if [ "$(b3_state "$CO" | grep -o '"settled": *"skipped"' | wc -l)" -ge 1 ]; then record condition bounded3 PASS "$cev" "$t0"
  else record condition bounded3 UNREACHABLE "no item settled skipped; $cev" "$t0"; fi
  # recipe / expansion
  local xev; xev="#$RC $(st status "$RC"); preview $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("status"))' "$RUN_DIR/b3-recipe-preview.json" 2>/dev/null); expansion markers $(gh_markers "$RC" | grep -c '^expansion:'); envelope children $(b3_state "$RC" | grep -oE '"[a-z0-9-]+-[0-9a-f]{12}"' | sort -u | wc -l)"
  if [ "$(gh_markers "$RC" | grep -c '^expansion:')" -ge 1 ]; then record recipe-expansion bounded3 PASS "$xev" "$t0"
  else record recipe-expansion bounded3 INCOMPLETE "$xev" "$t0"; fi
  # profiles
  local pf; pf=$(for n in $RT $RE $DE $AM $BL $CO; do b3_state "$n"; done | python3 -c '
import sys, json, re
txt = sys.stdin.read()
ids = re.findall(r"\"executionProfile\": *\{[^}]*\"id\": *\"([^\"]+)\"", txt)
print(len(ids), sorted(set(ids)))')
  record execution-profiles bounded3 INFO "plan items with executionProfile: $pf" "$t0"
}
