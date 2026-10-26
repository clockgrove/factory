# The PRD suite (run-suite.sh --suite prd): requirements no main or edge case
# shows live. Two lanes on the run's own repositories, every case at once:
#   P  repository M, installation P behind the fault proxy, the suite's fast
#      models, sandbox.network host and one CI-only command;
#   Q  repository C, installation Q written by `factory setup` with
#      production defaults and run by `setup --background` as a user
#      service: one lane case, `prod`, at production models and concurrency.
# Functions are case_<name>, as in main.sh.

HOSTNET_PORT=18650

setup_prd() {
  clone $M_REPO "$STATE_BASE/checkout-p" || return 1
  # Repository C and installation Q exist only when lane Q's case runs.
  if [ -n "$NEEDS_C" ]; then clone $C_REPO "$STATE_BASE/checkout-q" || return 1; fi
  # Repository M's main also holds what lane P's cases read there: the
  # workflows that file issues and comments as github-actions[bot] (a
  # non-writer), and the roadmap `propose --source` drafts from.
  local co="$STATE_BASE/checkout-p"
  mkdir -p "$co/.github/workflows" "$co/drill"
  cp "$SUITE/fixtures/repo/drill-issue.yml" "$SUITE/fixtures/repo/drill-comment.yml" "$co/.github/workflows/"
  cp "$SUITE/fixtures/repo/ROADMAP.md" "$co/drill/ROADMAP.md"
  git -C "$co" add .github/workflows/drill-issue.yml .github/workflows/drill-comment.yml drill/ROADMAP.md &&
    git -C "$co" -c user.name="Factory integration" -c user.email=factory-integration@users.noreply.github.com \
      commit -q -m "Drill: the prd suite's fixtures" && git -C "$co" push -q origin HEAD:main || return 1
  write_config "$STATE_BASE/config-p.json" $M_REPO "$co" 12 \
    'c["sandbox"]={"network":"host"}' 'c["finalValidation"]={"ciOnlyCommands":["npm run ci-only"]}'
  inst_define P $M_REPO "$STATE_BASE/config-p.json"
  [ -z "$NEEDS_C" ] || inst_define Q $C_REPO "$STATE_BASE/config-q.json"
  inst P
  [ "$(gh_human_gate)" = false ] || { log "required review must be OFF before the run"; return 1; }
  proxy_start P 18613
  printf '%s\n' "FACTORY_GITHUB_API=$PROXY_URL" "FACTORY_BACKOFF_MS=10000" "FACTORY_DISPLAY_TIMEZONE=America/Los_Angeles" >"$RUN_DIR/inst/P/extra_env"
  [ -z "$NEEDS_C" ] || : >"$RUN_DIR/inst/Q/extra_env"
  serve_up && serve_ready
}

# ---------- helpers ----------
# p_items N: the accepted plan's Work Items, "ID KIND DEP,DEP" per line (KIND work
# when absent), from `factory status --json`.
p_items() {
  cli_t 60 status "$1" --json 2>/dev/null | python3 -c 'import json,sys
seen = {}
def walk(o):
    if isinstance(o, dict):
        if isinstance(o.get("id"), str) and isinstance(o.get("dependencies"), list):
            seen.setdefault(o["id"], (o.get("kind") or "work", o["dependencies"]))
        for v in o.values(): walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
walk(json.load(sys.stdin))
for i, (k, d) in seen.items(): print(i, k, ",".join(d) or "-")'
}
# p_pr N ITEM [STATE]: the PR of Work Item ITEM (head factory/N/ITEM), optionally only in STATE.
p_pr() {
  local rows; rows=$(PULLS_TTL=10 gh_pulls_all "$1") || return 1
  python3 -c 'import json,sys
head, state = "factory/%s/%s" % (sys.argv[1], sys.argv[2]), sys.argv[3]
for l in sys.stdin:
    if not l.strip(): continue
    r = json.loads(l)
    if r["head"] == head and (not state or r["state"] == state):
        print(r["number"]); break' "$1" "$2" "${3:-}" <<<"$rows"
}
# p_ended N: when N's last step (report) finished; empty if it never did.
# (`run-end` is the service run's end, logged at shutdown, not the Objective's.)
p_ended() { st at "$1" last event=outcome outcome=done step=report; }
# p_ignored N: /factory comments the service ignored on N (an author without write access).
p_ignored() { echo $(( $(st events "$1" event=comment-ignored) + $(st events "$1" event=ignored) )); }
# p_amend_ready N GLOB [ASKED]: amendment GLOB's review is done, N settled, or a
# question HOLD_POLICY doesn't answer is open, other than ASKED (one the case
# answered, on its way out); answers N's holds by HOLD_POLICY meanwhile (for wait_for).
p_amend_ready() {
  [ "$(st events "$1" event=outcome outcome=done "step=$2:review")" -gt 0 ] && return 0
  settled "$1" && return 0
  local hj; hj=$(st hold "$1"); [ "$hj" != null ] || return 1
  [ -n "${3:-}" ] && [ "$(hold_field "$hj" id)" = "$3" ] && return 1
  auto_answer "$1" >/dev/null; [ $? = 2 ]
}
# p_amendment N ISO: "ID STATUS" of the first amendment N took in at or after ISO (`st amendments`).
p_amendment() { st amendments "$1" "$2" | head -1; }
# p_amend_settled N ISO: that amendment has a result (for wait_for).
p_amend_settled() { [[ $(p_amendment "$1" "$2") != *" pending" ]]; }
# p_hold_since N ISO: N's oldest open hold asked at or after ISO (its askedAt), as JSON, or null.
p_hold_since() {
  st holds "$1" | python3 -c 'import json,sys
h = [x for x in json.load(sys.stdin) if str(x.get("askedAt", "")) >= sys.argv[1]]
print(json.dumps(h[0] if h else None))' "$2"
}
# p_held_since N ISO: N settled, or a hold asked at or after ISO is open (for wait_for).
p_held_since() { settled "$1" || [ "$(p_hold_since "$1" "$2")" != null ]; }
# p_close N...: close issues the suite filed but never ran.
p_close() { local n; for n; do gh issue close "$n" --repo "$REPO" --reason "not planned" >/dev/null 2>&1; done; }
# p_bot_issue TITLE BODYFILE: file an issue as github-actions[bot] (drill-issue.yml) -> its number.
p_bot_issue() {
  local since; since=$(iso)
  gh workflow run drill-issue.yml --repo "$REPO" -f title="$1" -f body="$(cat "$2")" >/dev/null || return 1
  local end=$(( $(now) + 240 )) n=""
  while [ "$(now)" -lt "$end" ] && [ -z "$n" ] && ! stopping; do
    sleep 10
    n=$(gh api "repos/$REPO/issues?creator=github-actions%5Bbot%5D&since=$since&state=open&per_page=50" \
      --jq ".[]|select(.title==\"$1\")|.number" 2>/dev/null | head -1)
  done
  [ -n "$n" ] || return 1
  echo "$n $CASE $INST" >>"$RUN_DIR/issues"; log "filed #$n as github-actions[bot]"; echo "$n"
}

# ---------- lane P ----------

# PRD 2: `factory propose` from an intent and from a roadmap section; an approved
# draft creates its issues once however often it is approved, with blocked-by links.
case_propose() {
  local t0 id f1 f2 out; t0=$(now); id=$(uid)
  f1="$RUN_DIR/propose-intent-$id.json"; f2="$RUN_DIR/propose-roadmap-$id.json"
  cli_t 900 propose "Add \`padStart$id(s, width)\` in its own file \`src/padStart$id.js\` as a named export, with its own test: it puts spaces before \`s\` until it is \`width\` characters long." --file "$f1" >"$RUN_DIR/propose.1.out" 2>&1
  local r1=$? i1="" i1b=""
  if [ $r1 = 0 ] && [ -s "$f1" ]; then
    local s1; s1=$(sha256sum "$f1" | cut -d' ' -f1)
    i1=$(cli_t 120 propose --file "$f1" --approve "$s1" 2>/dev/null | head -1 | python3 -c 'import json,sys;print(" ".join(str(x["issue"]) for x in json.load(sys.stdin)["issues"]))')
    i1b=$(cli_t 120 propose --file "$f1" --approve "$s1" 2>/dev/null | head -1 | python3 -c 'import json,sys;print(" ".join(str(x["issue"]) for x in json.load(sys.stdin)["issues"]))')
  fi
  [ $r1 = 0 ] && [ -n "$i1" ] && [ "$(wc -w <<<"$i1")" = 1 ] && [ "$i1" = "$i1b" ]
  rec_if propose.intent $? "draft exit $r1; approved: issues [$i1]; approved again: [$i1b]" "$t0"
  cli_t 900 propose --source "drill/ROADMAP.md#Suite roadmap" --file "$f2" >"$RUN_DIR/propose.2.out" 2>&1
  local r2=$? i2="" blocked=""
  if [ $r2 = 0 ] && [ -s "$f2" ]; then
    local s2; s2=$(sha256sum "$f2" | cut -d' ' -f1)
    i2=$(cli_t 120 propose --file "$f2" --approve "$s2" 2>/dev/null | head -1 | python3 -c 'import json,sys;print(" ".join(str(x["issue"]) for x in json.load(sys.stdin)["issues"]))')
    local n; for n in $i2; do blocked="$blocked $(gh api "repos/$REPO/issues/$n/dependencies/blocked_by" --jq '.[].number' 2>/dev/null | paste -sd, -)"; done
  fi
  local linked; linked=$(python3 -c 'import sys
issues = set(sys.argv[1].split()); links = [set(x.split(",")) - {""} for x in sys.argv[2].split()]
print(sum(1 for l in links if l & issues))' "$i2" "$blocked")
  [ $r2 = 0 ] && [ "$(wc -w <<<"$i2")" = 2 ] && [ "$linked" -ge 1 ]
  rec_if propose.roadmap $? "draft exit $r2; approved: issues [$i2]; blocked-by [$blocked]; linked to a sibling: $linked" "$t0"
  p_close $i1 $i2
}

# PRD 2, 14: a check that fails (a Source missing at the default branch) holds
# naming it; after the issue is fixed, `recheck` plans. The Objective asks for a
# CI-only command to pass: no plan round may give it to validation.
case_recheck() {
  local t0 n id fn; t0=$(now); id=$(uid); fn="reverse$id"
  n=$(new_objective recheck "recheck after a failed check" ID="$id" FN="$fn") || return
  local p; p=$(HOLD_POLICY="" wait_phase "$n" '^hold:' 600)
  local hj; hj=$(st hold "$n"); local hid; hid=$(hold_field "$hj" id)
  local q; q=$(hold_field "$hj" question)
  local src=0; [[ $q == *"missing$id"* ]] && src=1
  local planned_before; planned_before=$(st events "$n" event=start 'step=plan*')
  if [[ $p != hold:* ]] || [[ ,$(hold_field "$hj" answers), != *,recheck,* ]]; then
    record intake.recheck FAIL "#$n $p, no recheck offered [$(hold_field "$hj" answers)]" "$t0"
    record toolchain.ci-only FAIL "#$n never planned" "$t0"; cancel_wait "$n"; return
  fi
  # The fix drops the missing Source and keeps the CI-only criterion.
  local fixed="$RUN_DIR/objectives/$CASE-fixed-$id.md"
  render recheck "$fixed" ID="$id" FN="$fn" || return
  python3 - "$fixed" <<'EOF' || return
import sys; p = sys.argv[1]; t = open(p).read()
open(p, "w").write(t[: t.index("## Sources")].rstrip() + "\n")
EOF
  gh issue edit "$n" --repo "$REPO" --body-file "$fixed" >/dev/null || { record intake.recheck FAIL "couldn't edit #$n" "$t0"; cancel_wait "$n"; return; }
  sleep 10
  answer_t 60 "$n" recheck --question "$hid" >/dev/null 2>&1
  wait_for 900 started "$n" 'plan*'; local planned; planned=$(st events "$n" event=start 'step=plan*')
  [ "$src" = 1 ] && [ "$planned_before" = 0 ] && [ "$planned" -ge 1 ]
  rec_if intake.recheck $? "#$n held naming the missing Source: $src; plan starts before recheck $planned_before, after $planned" "$t0"
  # Planning ends in an accepted plan or a question; the accepted plan never runs the CI-only command.
  wait_for 900 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' has $n done.plan)\" = 1 ] || [[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' phase $n)\" == hold:* ]]"
  # Either the accepted plan leaves the command out, or planning asks the
  # operator about it (a hold of the decide step); any other hold proves nothing.
  local accepted; accepted=$(st has "$n" done.plan)
  local step; step=$(hold_field "$(st hold "$n")" step)
  local cmds; cmds=$(st validation-commands "$n" done.plan | sort -u | paste -sd'|')
  { [ "$accepted" = 1 ] || [[ $step == decide:* ]]; } && ! st validation-commands "$n" done.plan | grep -qx 'npm run ci-only'
  rec_if toolchain.ci-only $? "#$n plan accepted: $accepted, hold step '${step}'; accepted plan's validation commands: [${cmds}]" "$t0"
  settled "$n" || cancel_wait "$n" 300
}

# PRD 2, 7: an Objective a non-writer filed waits for a writer's approve; the
# non-writer's own /factory approve is ignored; an edit after approval asks again.
case_outsider() {
  local t0 id body n; t0=$(now); id=$(uid)
  body="$RUN_DIR/objectives/$CASE-outsider-$id.md"; mkdir -p "$RUN_DIR/objectives"
  render happy "$body" ID="$id" || return
  n=$(p_bot_issue "Suite $SFX: non-writer Objective $id" "$body") || { record intake.non-writer FAIL "drill-issue.yml filed no issue" "$t0"; return; }
  queue_issue "$n"
  local p; p=$(HOLD_POLICY="" wait_phase "$n" '^hold:' 600)
  local hj; hj=$(st hold "$n"); local hid; hid=$(hold_field "$hj" id)
  if [[ $p != hold:* ]] || [[ ,$(hold_field "$hj" answers), != *,approve,* ]]; then
    record intake.non-writer FAIL "#$n $p [$(hold_field "$hj" answers)]: no approve question" "$t0"; cancel_wait "$n"; return
  fi
  gh workflow run drill-comment.yml --repo "$REPO" -f issue="$n" -f body="/factory approve --question $hid" >/dev/null
  wait_for 300 bash -c "[ \$(( \$(python3 '$SUITE/lib/st.py' '$ROOT' events $n event=comment-ignored) + \$(python3 '$SUITE/lib/st.py' '$ROOT' events $n event=ignored) )) -gt 0 ]"
  local ignored; ignored=$(p_ignored "$n"); local still; still=$(st phase "$n")
  answer_t 60 "$n" approve --question "$hid" >/dev/null 2>&1
  wait_for 900 started "$n" 'plan*'; local planned; planned=$(st events "$n" event=start 'step=plan*')
  local edited="$RUN_DIR/objectives/$CASE-outsider-edit-$id.md"
  { cat "$body"; printf '\n%s\n' "- \`countChar$id(\"aaa\", \"a\")\` is \`3\`."; } >"$edited"
  gh issue edit "$n" --repo "$REPO" --body-file "$edited" >/dev/null
  local p2; p2=$(HOLD_POLICY="" wait_phase "$n" '^hold:' 600)
  [ "$ignored" -ge 1 ] && [[ $still == hold:* ]] && [ "$planned" -ge 1 ] && [[ $p2 == hold:* ]]
  rec_if intake.non-writer $? "#$n by github-actions[bot]: $p [approve offered]; the bot's /factory approve ignored x$ignored, still $still; writer's approve: plan starts $planned; after an edit: $p2" "$t0"
  settled "$n" || cancel_wait "$n" 300
}

# PRD 3: an operator's amendment is planned and reviewed again; an edit after
# planning holds, and `replan` plans again from the issue.
case_amend() {
  local t0 id n; t0=$(now); id=$(uid)
  local HOLD_POLICY="d2 review decide more"
  n=$(new_objective happy "amendment and replan" ID="$id") || return
  wait_for 1500 started_or_answer "$n" 'item:*:work' || { record plan.amendment FAIL "#$n never started building ($(st phase "$n"))" "$t0"; record plan.replan FAIL "not reached" "$t0"; cancel_wait "$n"; return; }
  local f="$RUN_DIR/amend-$id.json"
  python3 - "$f" "$id" <<'PY'
import json, sys
f, id = sys.argv[1:]
json.dump({"scope": "in-scope", "reason": f"Callers also need a case-insensitive count beside countChar{id}.",
           "evidence": [f"The Objective's callers compare letters regardless of case; countChar{id} is case-sensitive."],
           "ownership": [f"src/countCharFold{id}.js", f"test/countCharFold{id}.test.js"],
           "acceptance": [f"countCharFold{id}(\"Banana\", \"b\") is 1."], "dependencies": []}, open(f, "w"))
PY
  local at; at=$(iso_ms)
  cli_t 60 propose-amendment "$n" --file "$f" >"$RUN_DIR/amend.$n.out" 2>&1; local rc=$?
  # The Objective names none of the amendment's files, so its planner may ask
  # whether to plan them: the operator who proposed it answers once, with
  # that authority. A second question, or a refused answer, is the outcome.
  wait_for 1200 p_amend_ready "$n" 'amend:*'
  local asked=none hj; hj=$(st hold "$n" 'amend:*:plan')
  if [ "$hj" != null ] && [[ ,$(hold_field "$hj" answers), == *,answer,* ]]; then
    local qid text choice qa; qid=$(hold_field "$hj" id); qa=$(iso_ms)
    text="In scope: I proposed this amendment and authorise its new files. Plan countCharFold$id in its own files src/countCharFold$id.js and test/countCharFold$id.test.js, owned by a new Work Item; the files the Objective names stay as they are."
    choice=$(python3 -c 'import json,sys;print(json.dumps({"id": sys.argv[1], "answer": "answer", "text": sys.argv[2]}))' "$qid" "$text")
    if ! answer_t 60 "$n" answer --question "$qid" --text "$text" >"$RUN_DIR/answer.$n.out" 2>&1; then asked="answer refused"
    else
      wait_for 600 p_amend_ready "$n" 'amend:*' "$qid"
      local next; next=$(st hold "$n" 'amend:*:plan')
      if [ "$(st answer-state "$n" "$choice" "$qa")" = refused ]; then asked="answer refused"
      elif [ "$next" != null ] && [ "$(hold_field "$next" id)" != "$qid" ]; then asked="answered, asked again"
      else asked=answered; fi
    fi
  fi
  local rv; rv=$(st events "$n" event=outcome outcome=done 'step=amend:*:review'); local pl; pl=$(st starts-since "$n" "$at" 'amend:*:plan')
  # The verdict is the amendment's result once reviewed, from Factory's
  # ledger: the review may reject it (it adds files the Objective doesn't
  # name), and `continue` runs the plan without it.
  local amd verdict="no review: $(st phase "$n")"
  if [ "$rv" -ge 1 ]; then
    wait_for 180 p_amend_settled "$n" "$at"
    read -r amd verdict <<<"$(p_amendment "$n" "$at")"; [ -n "$verdict" ] || verdict="reviewed, not in the ledger"
  fi
  if [ "$verdict" = rejected ]; then
    wait_for 120 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' hold $n 'amend:$amd:continue')\" != null ]"
    local ah; ah=$(st hold "$n" "amend:$amd:continue")
    if [ "$ah" != null ]; then
      answer_t 60 "$n" continue --question "$(hold_field "$ah" id)" >/dev/null 2>&1
      wait_for 180 bash -c "[ \"\$(python3 '$SUITE/lib/st.py' '$ROOT' hold $n 'amend:*:continue')\" = null ]"
    fi
  fi
  [ "$rc" = 0 ] && [ "$pl" -ge 1 ] && [ "$rv" -ge 1 ]
  rec_if plan.amendment $? "#$n propose-amendment exit $rc: amendment plan starts $pl, planner question: $asked, reviews done $rv, $verdict" "$t0"
  if settled "$n"; then record plan.replan FAIL "#$n finished before the edit ($(st status "$n"))" "$t0"; return; fi
  # An amendment question still open would be the hold the edit's wait finds.
  local open; open=$(st hold "$n" 'amend:*')
  if [ "$open" != null ]; then record plan.replan FAIL "#$n amendment question still open ($(hold_field "$open" step))" "$t0"; cancel_wait "$n" 300; return; fi
  local edited="$RUN_DIR/objectives/$CASE-amend-edit-$id.md"
  render happy "$edited" ID="$id" || return; printf '\n%s\n' "- \`countChar$id(\"aaa\", \"a\")\` is \`3\`." >>"$edited"
  local ed; ed=$(iso_ms)
  gh issue edit "$n" --repo "$REPO" --body-file "$edited" >/dev/null
  # Only a hold asked after the edit (its askedAt) is the edit's.
  wait_for 600 p_held_since "$n" "$ed"; hj=$(p_hold_since "$n" "$ed")
  local p; if [ "$hj" != null ]; then p="hold:$(hold_field "$hj" step)"; else p="no hold since the edit: $(st phase "$n")"; fi
  local ra; ra=$(iso_ms)
  [[ ,$(hold_field "$hj" answers), == *,replan,* ]] && answer_t 60 "$n" replan --question "$(hold_field "$hj" id)" >/dev/null 2>&1
  wait_for 600 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' starts-since $n $ra 'plan*') -gt 0 ]"
  local again; again=$(st starts-since "$n" "$ra" 'plan*')
  [[ $p == hold:* ]] && [ "$again" -ge 1 ]
  rec_if plan.replan $? "#$n edited after planning: $p [$(hold_field "$hj" answers)]; plan starts after replan $again" "$t0"
  settled "$n" || cancel_wait "$n" 300
}

# PRD 3: a worker's in-scope discovery becomes an amendment and is reviewed.
# The plan's one Work Item covers a criterion on files it doesn't own, so its
# worker can pass only by proposing them (the worker's discovery rule).
case_discovery() {
  local t0 id n; t0=$(now); id=$(uid)
  local HOLD_POLICY="d2 review decide more"
  n=$(new_objective discovery "worker discovery" ID="$id") || return
  wait_for 2400 p_amend_ready "$n" 'amend:worker-*'
  discovery_check "$n" "$t0"
  # It may have finished without a discovery: Factory refuses to cancel a finished Objective.
  settled "$n" || cancel_wait "$n" 300
}
# discovery_check N T0: from N's logs alone (also run-suite.sh --replay).
discovery_check() {
  local pl rv; pl=$(st events "$1" event=start 'step=amend:worker-*:plan'); rv=$(st events "$1" event=outcome outcome=done 'step=amend:worker-*:review')
  [ "$pl" -ge 1 ] && [ "$rv" -ge 1 ]
  rec_if plan.discovery $? "#$1: worker discovery amendment plan starts $pl, reviews done $rv ($(st phase "$1"))" "$2"
}
replay_discovery() { local n; n=$(case_issues | head -1); [ -z "$n" ] || discovery_check "$n" "$(now)"; }

# PRD 7: a Work Item's question stops only that item and its dependents: with
# the base's merge refused (lasting 403), the independent item merges and the
# dependent never starts; after the refusal ends, retry finishes the Objective.
case_scope() {
  local t0 id n; t0=$(now); id=$(uid)
  local HOLD_POLICY="d2 review decide more"
  n=$(new_objective scope3 "item question scope" ID="$id") || return
  wait_for 1500 started_or_answer "$n" 'item:*:work' || { record holds.item-scope FAIL "#$n never built ($(st phase "$n"))" "$t0"; cancel_wait "$n"; return; }
  # The plan's roles among its three work items: top depends on base; solo
  # depends on nothing and nothing on it. Any other item must be read-only QA
  # (`npm test` passes may be proved by one after all three).
  local items base top solo; items=$(p_items "$n")
  read -r base top solo <<<"$(python3 -c 'import sys
rows = [l.split() for l in sys.argv[1].splitlines() if l.strip()]
deps = {i: ([] if d == "-" else d.split(",")) for i, k, d in rows if k == "work"}
tops = [i for i in deps if deps[i]]
bases = sorted({d for i in tops for d in deps[i]})
solos = [i for i in deps if not deps[i] and i not in bases]
ok = len(deps) == 3 and len(tops) == 1 and len(bases) == 1 and len(solos) == 1 and all(k in ("work", "qa") for _, k, _ in rows)
print(*(bases[:1] + tops[:1] + solos[:1])) if ok else print()' "$items")"
  [ -n "$solo" ] || { record holds.item-scope FAIL "#$n plan isn't base/top/solo work items and QA (ID KIND DEPS): $(paste -sd';' <<<"$items")" "$t0"; record holds.item-scope-after FAIL "not reached" "$t0"; cancel_wait "$n"; return; }
  local pr=""; local end=$(( $(now) + 1500 ))
  while [ -z "$pr" ] && [ "$(now)" -lt "$end" ] && ! stopping; do pr=$(p_pr "$n" "$base" OPEN); [ -n "$pr" ] || sleep 10; done
  [ -n "$pr" ] || { record holds.item-scope FAIL "#$n: $base never opened a PR" "$t0"; cancel_wait "$n"; return; }
  prule_add "PUT ^/repos/$REPO/pulls/$pr/merge\$ status=403"
  local p; p=$(HOLD_POLICY="" wait_phase "$n" "^hold:item:$base:" 900)
  local hj; hj=$(st hold "$n" "item:$base:*")
  local merged=""; end=$(( $(now) + 1200 ))
  while [ -z "$merged" ] && [ "$(now)" -lt "$end" ] && ! stopping; do merged=$(p_pr "$n" "$solo" MERGED); [ -n "$merged" ] || sleep 15; done
  local top_work; top_work=$(st events "$n" event=start "step=item:$top:work"); local still; still=$(st hold "$n" "item:$base:*")
  [[ $p == hold:item:$base:* ]] && [ -n "$merged" ] && [ "$top_work" = 0 ] && [ "$still" != null ]
  rec_if holds.item-scope $? "#$n base $base held ($p) on PR #$pr's refused merge; independent $solo merged as PR #${merged:-none}; dependent $top work starts $top_work; base still held: $([ "$still" != null ] && echo yes || echo no)" "$t0"
  prule_clear
  [ "$still" != null ] && answer_t 60 "$n" retry --question "$(hold_field "$still" id)" >/dev/null 2>&1
  wait_phase "$n" 'done|cancelled|failed' 1500 >/dev/null
  end_done "$n"; local ok=$?
  rec_if holds.item-scope-after $ok "after retry: $EVID" "$t0"
}

# PRD 1: two Objectives that own the same file take turns: the later one's
# Work Items start only after the first is done.
case_paths() {
  local t0 id a b; t0=$(now); id=$(uid)
  local HOLD_POLICY="d2 review decide more"
  a=$(new_objective overlap "owned paths overlap A" ID="$id" FN="overlapA$id" SPEC="\`overlapA$id(s)\` returns \`s + \"!\"\`.") || return
  b=$(new_objective overlap "owned paths overlap B" ID="$id" FN="overlapB$id" SPEC="\`overlapB$id(s)\` returns \`\"?\" + s\`.") || return
  wait_phase "$a" 'done|cancelled|failed' 2400 >/dev/null; wait_phase "$b" 'done|cancelled|failed' 2400 >/dev/null
  end_done "$a"; local oa=$? ea_="$EVID"; end_done "$b"; local ob=$?
  paths_check "$a" "$b" "$t0" "$(( oa || ob ))" "$ea_ | $EVID"
}
# paths_check A B T0 [ENDS ENDS_EVIDENCE]: the turns and both done from the
# state and logs; ENDS is end_done's exit over both (GitHub, live only).
paths_check() {
  local a=$1 b=$2 wa wb ea eb; wa=$(st at "$a" first event=start 'step=item:*:work'); wb=$(st at "$b" first event=start 'step=item:*:work')
  ea=$(p_ended "$a"); eb=$(p_ended "$b")
  local turns=1
  if [ -n "$wa" ] && [ -n "$wb" ]; then
    if [[ $wa < $wb ]]; then [ -n "$ea" ] && [[ ! $wb < $ea ]] && turns=0; else [ -n "$eb" ] && [[ ! $wa < $eb ]] && turns=0; fi
  fi
  [ "$turns" = 0 ] && [ "$(st status "$a")" = done ] && [ "$(st status "$b")" = done ]
  rec_part queue.paths-take-turns $? "${4:-}" "#$a work from $wa, ended $ea; #$b work from $wb, ended $eb${5:+; $5}" "$3"
}
replay_paths() { local a b; read -r a b <<<"$(case_issues | paste -sd' ')"; [ -z "$b" ] || paths_check "$a" "$b" "$(now)"; }

# PRD 14: shared main: a person's change to the same file lands on main while
# Factory's PR is open; Factory repairs the conflict and merges, and the
# person's commit stays on main (nothing force-pushed).
case_shared() {
  local t0 id n fn; t0=$(now); id=$(uid); fn="shared$id"
  local HOLD_POLICY="d2 review decide more"
  n=$(new_objective exec "shared main conflict" FN="$fn" SPEC="\`$fn(s)\` returns \`s\` repeated twice: \`$fn(\"ab\")\` is \`\"abab\"\`.") || return
  wait_for 1500 pr_or_settled "$n"
  has_open_pr "$n" || { record delivery.shared-main FAIL "#$n never opened a PR ($(st phase "$n"))" "$t0"; cancel_wait "$n"; return; }
  local person; person=$(gh api -X PUT "repos/$REPO/contents/src/$fn.js" -f message="Person: a $fn of my own" \
    -f content="$(printf 'export function %s(s) {\n  return `${s}${s}`;\n}\n' "$fn" | base64 -w0)" --jq .commit.sha) || { record delivery.shared-main FAIL "couldn't land the person's change" "$t0"; cancel_wait "$n"; return; }
  log "#$n: a person's src/$fn.js landed on main as ${person:0:12} with PR #$(gh_open_pr "$n") open"
  wait_phase "$n" 'done|cancelled|failed' 2400 >/dev/null; sleep 15
  local cmp; cmp=$(gh api "repos/$REPO/compare/$person...main" --jq .status 2>/dev/null)
  local reps; reps=$(st events "$n" event=outcome outcome=repair 'step=item:*')
  end_done "$n"; local ok=$?
  [ $ok = 0 ] && [[ $cmp == ahead || $cmp == identical ]] && [ "$reps" -ge 1 ] && [ "$reps" -le 3 ]
  rec_if delivery.shared-main $? "person's commit ${person:0:12} vs main: $cmp; Work Item repairs $reps; $EVID" "$t0"
}

# PRD 14: with sandbox.network host, final validation reaches a service on the host's loopback.
case_hostnet() {
  local t0 id n fn dir; t0=$(now); id=$(uid); fn="double$id"
  dir="$RUN_DIR/hostnet"; mkdir -p "$dir"; echo ready >"$dir/hostnet-$id"
  python3 -m http.server --bind 127.0.0.1 "$HOSTNET_PORT" --directory "$dir" >"$RUN_DIR/hostnet.log" 2>&1 </dev/null &
  local hp=$!; track $hp; local hs; hs=$(starttime $hp)
  local HOLD_POLICY="d2 review decide more"
  n=$(new_objective hostnet "host network in validation" FN="$fn" URL="http://127.0.0.1:$HOSTNET_PORT/hostnet-$id") || { kill_exact "$hp" "$hs" TERM; return; }
  wait_phase "$n" 'done|cancelled|failed' 2400 >/dev/null; sleep 10
  kill_exact "$hp" "$hs" TERM
  local hits; hits=$(grep -c "GET /hostnet-$id " "$RUN_DIR/hostnet.log")
  end_done "$n"; local ok=$?
  [ $ok = 0 ] && [ "$hits" -ge 1 ]
  rec_if worker.host-network $? "requests from validation to the host's loopback: $hits; $EVID" "$t0"
}

# ---------- lane Q: production settings ----------
q_order() { # N VALUE: set the card's "Factory order" number
  local item fid; item=$(gh_item "$1") || return 1
  fid=$(gh api graphql -f id="$(gh_pj "d['id']")" -f query='query($id:ID!){node(id:$id){... on ProjectV2{field(name:"Factory order"){... on ProjectV2Field{id}}}}}' --jq .data.node.field.id) || return 1
  gh project item-edit --project-id "$(gh_pj "d['id']")" --id "$item" --field-id "$fid" --number "$2" >/dev/null && log "order #$1 -> $2"
}
q_mode() { python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("mode","running"))
except (OSError, ValueError): print("running")' "$ROOT/queue.json"; }
q_uninstall() { cli_t 60 setup --uninstall --json >"$RUN_DIR/q.uninstall.out" 2>&1; }
# q_late N,CHECKED,PLANNED...: Objectives highest Project order first, with their
# check's end and first planning start. Prints each that never planned and each
# that started planning while one above it was checked and still waiting.
q_late() {
  python3 -c 'import sys
rows = [a.split(",") for a in sys.argv[1:]]
out = [f"#{x[0]} never planned" for x in rows if not x[2]]
out += [f"#{y[0]} before #{x[0]}" for i, x in enumerate(rows) for y in rows[i + 1:]
        if x[1] and y[2] and x[1] <= y[2] and not (x[2] and x[2] <= y[2])]
print("; ".join(out))' "$@"
}
# q_overlap "START END"...: the most slots (`st slot`) held at once; an empty END still holds one.
q_overlap() {
  python3 -c 'import sys
edges = []
for a in sys.argv[1:]:
    s, _, e = a.partition(" ")
    if s: edges += [(s, 1), (e or "~", -1)]
cur = best = 0
for _, d in sorted(edges): cur += d; best = max(best, cur)
print(best)' "$@"
}
# PRD 1, 10, 12, 13, 14 at production settings: `factory setup` writes the
# configuration with no model call and `--background` runs it; a pause from
# GitHub admits nothing until resume; checked Objectives plan in Project
# order, at most 3 at once; two independent Work Items build at once; nothing
# asks a person; a check-in from GitHub alone shows the run; an Objective on a
# file an earlier Objective pinned is shown repository memory; dream changes the
# playbook only on approval.
case_prod() {
  local t0 id; t0=$(now); id=$(uid)
  local HOLD_POLICY="d2 review decide more"
  local co="$STATE_BASE/checkout-q"
  # --default: on a fresh configuration setup keeps codex first and default otherwise.
  cli_t 120 setup --checkout "$co" --project-id "$C_PROJECT_ID" --provider "$PROVIDER" --planner "$PROVIDER" --worker "$PROVIDER" --default --json >"$RUN_DIR/q.setup.out" 2>&1; local rs=$?
  local sj; sj=$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
node=[c for c in (d.get("readiness") or {}).get("checks", []) if c.get("name")=="node version"]
print(d.get("status"), (node[0].get("status") if node else "absent"))' "$RUN_DIR/q.setup.out" 2>/dev/null)
  local calls; calls=$(cat "$ROOT"/logs/*/*.jsonl 2>/dev/null | grep -c '"event":"model-usage"')
  [ "$rs" = 0 ] && [[ $sj == "configured "* ]] && [[ $sj != *absent ]] && [ "$calls" = 0 ]
  rec_if setup.config $? "factory setup exit $rs: status and node-version check: $sj; model calls $calls" "$t0"
  cli_t 120 setup --background --json >"$RUN_DIR/q.background.out" 2>&1; local rb=$?
  cli_t 60 setup --check --json >"$RUN_DIR/q.check.out" 2>&1; local rc=$?
  [ "$rb" = 0 ] && [ "$rc" = 0 ]; local bg=$?
  [ $bg = 0 ] || { record setup.background FAIL "setup --background exit $rb, --check exit $rc" "$t0"; q_uninstall; return; }

  # The first Objective runs; a /factory queue pause comment on it stops admission.
  # It pins README.md's heading as a Source: its planning keeps that section
  # as a reference record (source README.md#<heading>), which the order-3
  # Objective's roles aren't supplied (knowledge.memory below).
  local n1; n1=$(new_objective happy "production: first" ID="${id}a" EXTRA=$'\n\n## Sources\n\n- `README.md#Factory integration drill`') || { q_uninstall; return; }
  wait_for 600 bash -c "[ \$(python3 '$SUITE/lib/st.py' '$ROOT' events $n1 event=admitted) -gt 0 ]"
  local pc; pc=$(gh_comment "$n1" "/factory queue pause"); local pause_at; pause_at=$(iso_ms)
  wait_for 180 bash -c "[ \"\$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get(\"mode\"))' '$ROOT/queue.json' 2>/dev/null)\" = paused ]"
  local paused; paused=$(q_mode)
  local a b c; a=$(new_issue readme "production: order 3" ID="${id}b") && b=$(new_issue happy "production: order 2" ID="${id}c") && c=$(new_issue pair "production: order 1, two items" ID="${id}d") || { q_uninstall; return; }
  local x; for x in "$a" "$b" "$c"; do gh_enqueue "$x" >/dev/null; done
  q_order "$a" 3; q_order "$b" 2; q_order "$c" 1
  sleep 90
  local admitted_paused=0; for x in "$a" "$b" "$c"; do [ "$(st events "$x" event=admitted)" = 0 ] || admitted_paused=1; done
  local starts_paused; starts_paused=$(st starts-since "$n1" "$(python3 -c 'import datetime,sys;t=datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00"))+datetime.timedelta(seconds=45);print(t.isoformat(timespec="milliseconds").replace("+00:00","Z"))' "$pause_at")" '*')
  local rcm; rcm=$(gh_comment "$n1" "/factory queue resume"); local resume_at; resume_at=$(iso_ms)
  wait_for 180 bash -c "[ \"\$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get(\"mode\"))' '$ROOT/queue.json' 2>/dev/null)\" = running ]"
  local resumed; resumed=$(q_mode)
  local m1; m1=$(gh_markers "$n1")
  [ "$paused" = paused ] && [ "$resumed" = running ] && [ "$admitted_paused" = 0 ] && [ "$starts_paused" = 0 ] && [ "$(marker_count "$m1" "reply:comment-$pc")" = 1 ] && [ "$(marker_count "$m1" "reply:comment-$rcm")" = 1 ]
  rec_if queue.pause-github $? "'/factory queue pause' on #$n1: mode $paused, replies x$(marker_count "$m1" "reply:comment-$pc"); queued while paused admitted: $admitted_paused; #$n1 steps started while paused (after 45 s): $starts_paused; '/factory queue resume': mode $resumed, replies x$(marker_count "$m1" "reply:comment-$rcm")" "$t0"

  # A hold the policy can't answer ends a wait at once (prod.no-holds fails on
  # it), so the checks after it still run in the time left.
  for x in "$n1" "$c" "$b" "$a"; do wait_phase "$x" 'done|cancelled|failed' "$(left)" >/dev/null; done
  sleep 20
  local all=0 ev=""; for x in "$n1" "$c" "$b" "$a"; do end_done "$x" || all=1; ev="$ev | $EVID"; done
  prod_checks "$n1" "$c" "$b" "$a" "$t0" "$all" "${ev# | }"

  # A check-in from GitHub alone, and the CLI's detail. Every Work Item of the
  # accepted plan, a QA item too, has its own issue.
  local subs; subs=$(gh api "repos/$REPO/issues/$c/sub_issues" --jq '[.[]|{state, reason: .state_reason, wi: ([.labels[].name]|index("factory:work-item") != null)}]' 2>/dev/null)
  local mc; mc=$(gh_markers "$c"); local card; card=$(gh_card_value "$c")
  local planned; planned=$(st get "$c" done.plan.items | python3 -c 'import json,sys;print(len(json.load(sys.stdin) or []))')
  local vis; vis=$(python3 -c 'import json,sys;s=json.loads(sys.argv[1] or "[]");print(len(s), all(x["wi"] and x["state"]=="closed" and x["reason"]=="completed" for x in s))' "$subs")
  [ "$(marker_prefix_count "$mc" status)" -ge 1 ] && [ "$planned" -ge 1 ] && [[ $vis == "$planned True" ]] && [ "$card" = Done ]
  rec_if visibility.github $? "#$c: status comment markers $(marker_prefix_count "$mc" status); Work Item issues (count, all labelled and closed completed): $vis, of $planned planned; card $card" "$t0"
  local lg dg xg; cli_t 60 log "$c" --tail 20 >"$RUN_DIR/q.log.out" 2>&1; lg=$?
  cli_t 60 diagnostics "$c" --summary >"$RUN_DIR/q.diag.out" 2>&1; dg=$?
  cli_t 60 export-captures "$c" >"$RUN_DIR/q.export.out" 2>&1; xg=$?
  [ $lg = 0 ] && [ -s "$RUN_DIR/q.log.out" ] && [ $dg = 0 ] && [ -s "$RUN_DIR/q.diag.out" ] && [ $xg = 0 ]
  rec_if visibility.cli $? "factory log exit $lg, diagnostics --summary exit $dg, export-captures exit $xg" "$t0"

  # dream: a proposal changes nothing until it is approved.
  for x in "$n1" "$c" "$b" "$a"; do cli_t 120 dream --record --objective "$x" >/dev/null 2>&1; done
  local before; before=$(cli_t 60 dream --show 2>/dev/null | python3 -c 'import json,sys;a=json.load(sys.stdin).get("approved");print(a["version"] if a else 0)')
  cli_t 600 dream >"$RUN_DIR/q.dream.out" 2>&1; local rd=$?
  local shown; shown=$(cli_t 60 dream --show 2>/dev/null)
  local draft mid; draft=$(python3 -c 'import json,sys;p=json.loads(sys.argv[1]).get("pendingProposals") or [];print(p[-1]["draft"] if p else "")' "$shown" 2>/dev/null)
  mid=$(python3 -c 'import json,sys;a=json.loads(sys.argv[1]).get("approved");print(a["version"] if a else 0)' "$shown" 2>/dev/null)
  local after="$mid"
  if [ -n "$draft" ] && [ -s "$draft" ]; then
    cli_t 120 dream --file "$draft" --approve "$(sha256sum "$draft" | cut -d' ' -f1)" >"$RUN_DIR/q.approve.out" 2>&1
    after=$(cli_t 60 dream --show 2>/dev/null | python3 -c 'import json,sys;a=json.load(sys.stdin).get("approved");print(a["version"] if a else 0)')
  fi
  [ "$rd" = 0 ] && [ -n "$draft" ] && [ "$mid" = "$before" ] && [ "${after:-0}" -gt "${before:-0}" ]
  rec_if knowledge.dream $? "dream exit $rd, draft ${draft:-none}; playbook version before $before, after the proposal $mid, after approval $after" "$t0"

  # Only Q's running service applies a cancel: settle what's left before stopping it.
  for x in "$n1" "$c" "$b" "$a"; do settled "$x" || cancel_wait "$x" 120; done
  cli_t 60 setup --stop --json >"$RUN_DIR/q.stop.out" 2>&1; local rst=$?
  cli_t 60 setup --check --json >/dev/null 2>&1; local rck=$?
  q_uninstall; local ru=$?
  local units; units=$(run_bounded 5 systemctl --user list-units --all --no-legend 'factory-*' | grep -c .)
  [ "$rst" = 0 ] && [ "$rck" != 0 ] && [ "$ru" = 0 ] && [ "$units" = 0 ]
  rec_if setup.background $? "setup --background exit $rb, --check exit $rc; --stop exit $rst, then --check exit $rck; --uninstall exit $ru; factory units left $units" "$t0"
}
# prod_checks N1 C B A T0 [ENDS ENDS_EVIDENCE]: lane Q's checks from Q's state
# and logs (also run-suite.sh --replay). C, B and A are Project order 1, 2 and 3;
# ENDS is end_done's exit over all four (GitHub, live only).
prod_checks() {
  local n1=$1 c=$2 b=$3 a=$4 t0=$5 x
  # Order and the cap of 3: every queued card is admitted at once and checked
  # with no slot; planning and building take one of 3 slots, in Project order
  # among the Objectives whose check is done (docs/reference/queue.md).
  local ord=() late; for x in "$c" "$b" "$a"; do ord+=("$x,$(st at "$x" first event=outcome outcome=done step=check),$(st at "$x" first event=start 'step=plan:*')"); done
  late=$(q_late "${ord[@]}")
  [ -z "$late" ]
  rec_if queue.order $? "#$c order 1, #$b order 2, #$a order 3 as issue,check done,first planning: ${ord[*]}; out of order: ${late:-none}" "$t0"
  local sl=() cap; for x in "$n1" "$c" "$b" "$a"; do sl+=("$(st slot "$x")"); done
  cap=$(q_overlap "${sl[@]}")
  [ "$cap" = 3 ]
  rec_if queue.concurrency-3 $? "most planning or building at once: $cap; slots (first planning to report or hold): #$n1 ${sl[0]:-none}, #$c ${sl[1]:-none}, #$b ${sl[2]:-none}, #$a ${sl[3]:-none}" "$t0"
  local par; par=$(st maxconc 'item:*:work' "$c")
  [ "$par" -ge 2 ]; rec_if exec.parallel-items $? "#$c's Work Items working at once: $par" "$t0"
  local holds=0 h s each="" fin=0; for x in "$n1" "$c" "$b" "$a"; do
    h=$(st events "$x" event=hold); s=$(st status "$x"); holds=$(( holds + h )); each="$each, #$x $s holds $h"; [ "$s" = done ] || fin=1
  done
  [ "$holds" = 0 ] && [ "$fin" = 0 ]
  rec_part prod.no-holds $? "${6:-}" "four Objectives at production settings, holds $holds (${each#, })${7:+ | $7}" "$t0"
  # Memory is path-scoped: the order-3 Objective also changes README.md, so its
  # roles are shown the first Objective's README.md#<heading> reference. (Every
  # planning call's whole README.md reference is left out: each role is
  # supplied README.md itself, and memory drops a Source the role already has.)
  local mem shown0; mem=$(st events "$a" event=memory); shown0=$(st events "$a" event=memory shown=0)
  [ "$(( mem - shown0 ))" -ge 1 ]; rec_if knowledge.memory $? "#$a (owns README.md): memory sections $mem, with entries shown $(( mem - shown0 ))" "$t0"
}
# A replay: the case filed N1, A, B, C in that order.
replay_prod() { local n1 a b c; read -r n1 a b c <<<"$(case_issues | paste -sd' ')"; [ -z "$c" ] || prod_checks "$n1" "$c" "$b" "$a" "$(now)"; }
