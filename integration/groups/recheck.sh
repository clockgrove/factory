# recheck: planner item kinds, hold options, bare answers, the director skill and replan while building.
#   qa-not-offered     the planner's prompt lists only the kinds this build runs (no qa); no plan item is qa
#   hold-options       status --json holds[].options is structured data: answer/family/consequence, one recommended, needsText on `answer`
#   bare-answer        a bare `answer` (no text) to a planner question is refused (invalid_answer), by CLI and by comment; the hold stays
#   skill-options      the director skill, given status --json, offers exactly the hold's options (recommended first) and the bound command
#   replan-build       an edit while building holds with replan; `replan` plans again once, the hold isn't re-raised, done
# The dream budget re-check is knowledge.dream:proposal:committed / dream:approve:* (knowledge group).
recheck_needs() { echo "drill repo + Project; default provider (codex) with FACTORY_PROVIDER_TRACE; claude CLI logged in for skill-options (one call)"; }
recheck_cost() { echo "~40-70 min; 1 hold Objective to done (2 plannings), 1 Claude call"; }
recheck_minutes() { echo 70; }
recheck_plan() {
  echo "recheck.qa-not-offered  traced planner prompt: 'Item kinds:' has work and aggregate, no qa role; no plan item has kind qa"
  echo "recheck.hold-options    status --json holds[].options: answer/family/consequence each, exactly one recommended, 'answer' needsText"
  echo "recheck.bare-answer     'answer' without --text refused (exit 1, invalid_answer); '/factory answer --question ID' comment changes nothing"
  echo "recheck.skill-options   claude with skills/director/SKILL.md and the status JSON: choices = options, recommended first, bound command"
  echo "recheck.replan-build    issue edited while building: hold offers replan; 'replan' starts planning again once, hold not re-raised, done"
}

rc_status_json() { cli_t 30 status "$1" --json 2>/dev/null; }
rc_row() { python3 -c 'import json,sys
d=json.loads(sys.stdin.read())
for r in d.get("objectives",[]):
    if str(r.get("issue"))==sys.argv[1]: print(json.dumps(r)); break' "$1"; }

recheck_run() {
  local g=recheck t0 n id hold hid
  t0=$(now); id=$(uid)
  local trace="$RUN_DIR/trace"; mkdir -p "$trace"
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_PROVIDER_TRACE=$trace"
  local HOLD_POLICY="d2 review"   # the planner question is answered by hand here
  n=$(new_objective $g hold "recheck owed checks" ID="$id") || { record recheck.hold-options $g FAIL "could not queue" "$t0"; return; }
  serve_start || return
  local p; p=$(wait_phase "$n" '^hold:decide|^hold:|done|cancelled|failed' 1500)
  hold=$(st hold "$n" 'decide*'); hid=$(hold_field "$hold" id)
  if [ -z "$hid" ]; then
    for c in hold-options bare-answer skill-options; do record recheck.$c $g FAIL "#$n never asked its planner question (phase $p)" "$t0"; done
  else
    sleep 30   # the question comment posts
    # --- hold-options
    local sj row; sj=$(rc_status_json "$n"); row=$(rc_row "$n" <<<"$sj")
    echo "$sj" >"$RUN_DIR/recheck-status.$n.json"
    local ho; ho=$(python3 - "$row" "$hid" <<'PY'
import json, sys
r = json.loads(sys.argv[1] or "{}"); hid = sys.argv[2]
hs = [h for h in r.get("holds", []) if h.get("id") == hid]
if not hs: print("FAIL no hold " + hid + " in status --json"); sys.exit()
o = hs[0].get("options")
bad = []
if not isinstance(o, list) or not o: print("FAIL no options list"); sys.exit()
for x in o:
    if not (isinstance(x.get("answer"), str) and isinstance(x.get("family"), str) and isinstance(x.get("consequence"), str) and x["consequence"].strip()):
        bad.append("incomplete " + json.dumps(x)[:80])
rec = [x["answer"] for x in o if x.get("recommended")]
if len(rec) != 1: bad.append(f"{len(rec)} recommended")
ans = [x for x in o if x.get("answer") == "answer"]
if not ans or not ans[0].get("needsText"): bad.append("'answer' lacks needsText")
na = (r.get("nextAction") or {}).get("command") or ""
if f"--question {hid}" not in na: bad.append("nextAction not bound: " + na[:80])
summary = "options " + ",".join(x["answer"] + ("*" if x.get("recommended") else "") + ("+text" if x.get("needsText") else "") for x in o) + f"; nextAction '{na}'"
print(("FAIL " + "; ".join(bad) + "; " if bad else "PASS ") + summary)
PY
)
    record recheck.hold-options $g "${ho%% *}" "#$n hold $hid: ${ho#* }" "$t0"
    # --- bare-answer (CLI, then comment)
    t0=$(now)
    local out code; out=$(cli_t 60 answer "$n" answer --question "$hid" 2>&1); code=$?
    local rcode; rcode=$(head -1 <<<"$out" | python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read()).get("code",""))
except Exception: print("")')
    sleep 20
    local still; still=$(hold_field "$(st hold "$n" 'decide*')" id)
    local s0; s0=$(st events "$n" event=start step='decide*')
    local cid; cid=$(gh_comment "$n" "/factory answer --question $hid")
    sleep 90
    local still2 s1; still2=$(hold_field "$(st hold "$n" 'decide*')" id); s1=$(st events "$n" event=start step='decide*')
    local ev="CLI bare answer exit $code code '$rcode'; hold after CLI $still; comment $cid '/factory answer --question $hid': hold after $still2, decide starts $s0->$s1"
    if [ "$code" = 1 ] && [ "$rcode" = invalid_answer ] && [ "$still" = "$hid" ] && [ "$still2" = "$hid" ] && [ "$s0" = "$s1" ]; then record recheck.bare-answer $g PASS "$ev" "$t0"
    else record recheck.bare-answer $g FAIL "$ev" "$t0"; fi
    # --- skill-options
    t0=$(now); rc_skill "$n" "$hid" "$row"
    # answer properly
    answer_t 60 "$n" answer --question "$hid" --text "Join with a forward slash '/'." >/dev/null 2>&1
  fi
  # --- replan-build: edit once a Work Item's work step runs
  t0=$(now)
  if ! wait_for 2400 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' started $n 'item:*:work') = 1 ]"; then
    record recheck.replan-build $g FAIL "#$n never started building ($(st phase "$n"))" "$t0"
  else
    rc_qa "$n"
    gh issue edit "$n" --repo "$REPO" --body "$(gh issue view "$n" --repo "$REPO" --json body --jq .body)

Drill edit while building: the separator is '/'." >/dev/null
    local end=$(( $(now) + 2400 )) asked=0 rhid="" ta="" re=0 hj
    local HOLD_POLICY="d2 review decide"
    while [ "$(now)" -lt "$end" ]; do
      serve_tick; p=$(st phase "$n")
      case $p in done|cancelled|failed) break ;; esac
      if [[ $p == hold:* ]]; then
        hj=$(st hold "$n")
        if [[ ,$(hold_field "$hj" answers), == *,replan,* ]] && [[ ,$(hold_field "$hj" answers), == *,continue,* ]]; then
          if [ -z "$rhid" ]; then rhid=$(hold_field "$hj" id); ta=$(iso_ms); asked=1; answer_t 60 "$n" replan --question "$rhid" >/dev/null 2>&1; log "#$n replan to edit hold $rhid"
          elif [ "$(hold_field "$hj" id)" != "$rhid" ] && [ ! -f "$RUN_DIR/rc-re.$(hold_field "$hj" id)" ]; then touch "$RUN_DIR/rc-re.$(hold_field "$hj" id)"; re=$((re + 1)); answer_t 60 "$n" continue --question "$(hold_field "$hj" id)" >/dev/null 2>&1; fi
        else auto_answer "$n" || { log "#$n held at $p"; break; }; fi
      fi
      sleep 10
    done
    sleep 20
    local pl=0; [ -n "$ta" ] && pl=$(st starts-since "$n" "$ta" 'plan*')
    end_done "$n"; local ok=$?
    local ev="edit while building; replan hold $rhid answered at $ta; plan starts since $pl; edit question re-raised $re; $EVID"
    if [ "$asked" = 0 ]; then record recheck.replan-build $g UNREACHABLE "no edit question while building; $ev" "$t0"
    elif [ $ok = 0 ] && [ "$pl" -ge 1 ] && [ "$re" = 0 ]; then record recheck.replan-build $g PASS "$ev" "$t0"
    else record recheck.replan-build $g FAIL "$ev" "$t0"; fi
  fi
  serve_stop
}
iso_ms() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }

# qa-not-offered: the traced planner prompt and the accepted plan.
rc_qa() {
  local g=recheck n=$1 t0; t0=$(now)
  # The kinds this build runs (dist/planning/types.js EXECUTABLE_KINDS).
  local kinds; kinds=$(node -e 'import(process.argv[1]).then(m=>console.log((m.EXECUTABLE_KINDS||[]).join(",")))' "$BUILD/dist/planning/types.js" 2>/dev/null)
  local case=recheck.qa-not-offered; [[ ,$kinds, == *,qa,* ]] && case=recheck.qa-offered
  local r; r=$(python3 - "$RUN_DIR/trace" "$ROOT" "$n" "$kinds" <<'PY'
import json, os, re, sys
trace, root, n, exe = sys.argv[1:5]; exe = set(exe.split(",")) if exe else {"work", "aggregate"}
lines = set()
for dp, _, fs in os.walk(trace):
    for f in fs:
        try: txt = open(os.path.join(dp, f), errors="replace").read()
        except OSError: continue
        for m in re.finditer(r"Item kinds: (.*?)\. Children", txt.replace("\\n", "\n")):
            lines.add(m.group(1)[:300])
st = None
for d in ("objectives", "objectives/finished"):
    try: st = json.load(open(os.path.join(root, d, n + ".json"))); break
    except Exception: pass
items = ((st or {}).get("done", {}).get("plan") or {}).get("items") or []
kinds = sorted({i.get("kind", "work") for i in items})
qa_prompt = [l for l in lines if re.search(r"(^|; )qa ", l)]
want_qa = "qa" in exe
ok = bool(lines) and all("work" in l and "aggregate" in l for l in lines) and (bool(qa_prompt) == want_qa and len(qa_prompt) in (0, len(lines))) and set(kinds) <= exe and bool(items)
print(("PASS" if ok else "FAIL") + f" build kinds {sorted(exe)}; prompt kinds lines {len(lines)}: {sorted(lines)[:2]}; plan item kinds {kinds}")
PY
)
  record $case $g "${r%% *}" "#$n ${r#* }" "$t0"
}

# skill-options: Claude reads the director skill and the status JSON, and
# returns the AskUserQuestion it would ask plus the command for the recommended choice.
rc_skill() {
  local g=recheck n=$1 hid=$2 row=$3 t0; t0=$(now)
  command -v claude >/dev/null || { record recheck.skill-options $g UNREACHABLE "no claude CLI" "$t0"; return; }
  local skill="$BUILD/skills/director/SKILL.md" sj="$RUN_DIR/recheck-status.$n.json" out="$RUN_DIR/recheck-skill.$n.json"
  local prompt
  prompt="You are operating Factory with the director skill below. The operator asked you to handle the open question on Objective #$n of $REPO. This is the output of \`factory status $n --json --repo $REPO\`:

$(cat "$sj")

Do not run any command. Reply with ONLY one JSON object, no prose and no code fence: {\"questions\":[{\"question\":string,\"options\":[{\"label\":string,\"description\":string}]}],\"commandForRecommended\":string}, where questions is exactly what you would pass to AskUserQuestion per the skill, and commandForRecommended is the exact factory command you would run if the operator picks the recommended option with the text 'slash'.

--- SKILL.md ---
$(cat "$skill")"
  (cd "$RUN_DIR" && timeout 300 claude -p "$prompt" --output-format json --disallowedTools "Bash Edit Write Read Glob Grep WebFetch WebSearch Task" </dev/null >"$out" 2>"$out.err")
  local r; r=$(python3 - "$out" "$row" "$hid" "$n" <<'PY'
import json, re, sys
out, row, hid, n = sys.argv[1:5]
try:
    res = json.load(open(out)); txt = res.get("result", "")
    m = re.search(r"\{.*\}", txt, re.S); a = json.loads(m.group(0))
except Exception as e:
    print(f"FAIL unreadable reply ({e})"); sys.exit()
r = json.loads(row); h = [x for x in r["holds"] if x["id"] == hid][0]
opts = h["options"]; rec = [o for o in opts if o.get("recommended")][0]
q = a["questions"][0]["options"]
labels = [re.sub(r"\s*\(recommended\)\s*", "", o["label"], flags=re.I).strip() for o in q]
want = [o["answer"] + (" " + o["arg"] if o.get("arg") else "") for o in opts]
bad = []
if len(opts) <= 4 and sorted(labels) != sorted(want): bad.append(f"labels {labels} != options {want}")
if labels and labels[0] != want[opts.index(rec)]: bad.append(f"first {labels[0]} is not the recommended {rec['answer']}")
cmd = a.get("commandForRecommended", "")
toks = cmd.split()
if not (len(toks) >= 4 and toks[1] == "answer" and toks[2] == n and toks[3] == rec["answer"] and f"--question {hid}" in cmd): bad.append("command not bound to the recommended option: " + cmd)
if rec.get("needsText") and "--text" not in cmd: bad.append("needsText option without --text")
print(("FAIL " + "; ".join(bad) if bad else "PASS") + f" | labels {labels}; command {cmd}")
PY
)
  record recheck.skill-options $g "${r%% *}" "#$n ${r#* }" "$t0"
}
