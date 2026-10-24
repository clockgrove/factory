# bounded-cost: every GitHub call goes through gh-count-proxy.mjs (headers,
# and so the token, never logged). Idle polls must be exactly the two queue
# reads; one unfinished Objective adds about one comments read per poll.
bounded_cost_needs() { echo "drill repo + Project; a build that honours FACTORY_GITHUB_API; nothing else queued on the Project"; }
bounded_cost_cost() { echo "~15 min; idle 5 min + 5 min with one held Objective (one planner call), then cancelled"; }
bounded_cost_minutes() { echo 20; }
BOUNDED_IDLE_SECS=${BOUNDED_IDLE_SECS:-300}
BOUNDED_PORT=${BOUNDED_PORT:-18555}
bounded_cost_plan() {
  echo "bounded-cost.idle       ${BOUNDED_IDLE_SECS}s idle: every poll is exactly 2 GraphQL queue reads, nothing else"
  echo "bounded-cost.one-held   ${BOUNDED_IDLE_SECS}s with one held Objective: per poll <= 2 queue reads + 1 comments read (+1 slack)"
  echo "bounded-cost.scale-idle ${BOUNDED_IDLE_SECS}s idle on BC_SCALE_PROJECT (~1,200 cards, none queued): every poll <= 2 queue reads, nothing else"
}
# Per-poll request counts in a proxy log window: polls are split at each queue:items read.
bc_polls() { # LOG FROM_ISO TO_ISO -> JSON {polls, max, median, other}
  python3 - "$@" <<'PY'
import json, sys, statistics
log, a, b = sys.argv[1:4]
rows = [json.loads(l) for l in open(log) if l.strip()]
rows = [r for r in rows if a <= r["at"] <= b]
polls, cur = [], None
other = 0
for r in rows:
    if r.get("gql") == "queue:items":
        if cur is not None: polls.append(cur)
        cur = 0
    if cur is not None: cur += 1
    if r.get("gql") not in ("queue:items", "queue:issues") and not r["path"].endswith("/comments"): other += 1
print(json.dumps({"polls": len(polls), "max": max(polls or [0]), "median": statistics.median(polls or [0]), "other": other}))
PY
}
BC_PROXY=""
bounded_cost_stop_proxy() { [ -n "$BC_PROXY" ] && { read -r p s <<<"$BC_PROXY"; kill_exact "$p" "$s" TERM; BC_PROXY=""; }; }
bounded_cost_run() {
  local g=bounded-cost t0 log a b r
  t0=$(now)
  if ! build_has_env FACTORY_GITHUB_API; then
    record bounded-cost.idle $g UNREACHABLE "this build has no FACTORY_GITHUB_API override, so calls can't be counted" "$t0"
    record bounded-cost.one-held $g UNREACHABLE "same" "$t0"; return
  fi
  log="$RUN_DIR/gh-calls.jsonl"; : >"$log"
  node "$SUITE/lib/gh-count-proxy.mjs" "$BOUNDED_PORT" "$log" </dev/null >"$RUN_DIR/proxy.out" 2>&1 &
  local pp=$!; track $pp; BC_PROXY="$pp $(starttime $pp)"; sleep 1
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_GITHUB_API=http://127.0.0.1:$BOUNDED_PORT"
  serve_start || { bounded_cost_stop_proxy; return; }
  sleep 30; a=$(date -u +%Y-%m-%dT%H:%M:%S); sleep "$BOUNDED_IDLE_SECS"; b=$(date -u +%Y-%m-%dT%H:%M:%S)
  r=$(bc_polls "$log" "$a" "$b")
  if python3 -c 'import json,sys;d=json.loads(sys.argv[1]);sys.exit(0 if d["polls"]>0 and d["max"]==2 and d["median"]==2 and d["other"]==0 else 1)' "$r"
  then record bounded-cost.idle $g PASS "$r" "$t0"; else record bounded-cost.idle $g FAIL "$r" "$t0"; fi
  t0=$(now)
  local n; n=$(new_objective $g hold "bounded-cost held" ID="$(uid)")
  wait_phase "$n" '^hold:' 1200 >/dev/null; sleep 30
  a=$(date -u +%Y-%m-%dT%H:%M:%S); sleep "$BOUNDED_IDLE_SECS"; b=$(date -u +%Y-%m-%dT%H:%M:%S)
  r=$(bc_polls "$log" "$a" "$b")
  cli_t 60 cancel "$n" >/dev/null 2>&1; wait_phase "$n" cancelled 600 >/dev/null; sleep 15
  serve_stop; bounded_cost_stop_proxy
  if python3 -c 'import json,sys;d=json.loads(sys.argv[1]);sys.exit(0 if d["polls"]>0 and d["max"]<=4 and d["median"]<=3 and d["other"]==0 else 1)' "$r"
  then record bounded-cost.one-held $g PASS "$r; total $(wc -l <"$log") calls" "$t0"; else record bounded-cost.one-held $g FAIL "$r" "$t0"; fi
  bc_scale
}
# At scale: the same idle measure on a Project of ~1,200 cards, none queued
# (BC_SCALE_PROJECT, a ProjectV2 node id with the Factory and Factory order fields).
bc_scale() {
  local g=bounded-cost t0 log a b r keep=$CUR_CFG; t0=$(now)
  [ -n "${BC_SCALE_PROJECT:-}" ] || { record bounded-cost.scale-idle $g UNREACHABLE "no BC_SCALE_PROJECT (a ~1,200-card scratch Project)" "$t0"; return; }
  local items; items=$(gh api graphql -f id="$BC_SCALE_PROJECT" -f query='query($id:ID!){node(id:$id){... on ProjectV2{items{totalCount}}}}' --jq .data.node.items.totalCount)
  log="$RUN_DIR/gh-calls-scale.jsonl"; : >"$log"
  node "$SUITE/lib/gh-count-proxy.mjs" "$BOUNDED_PORT" "$log" </dev/null >"$RUN_DIR/proxy-scale.out" 2>&1 &
  local pp=$!; track $pp; BC_PROXY="$pp $(starttime $pp)"; sleep 1
  CUR_CFG="$RUN_DIR/config.bounded-scale.json"; cp "$keep" "$CUR_CFG"; cfg_patch "$CUR_CFG" "c['queue']['projectId']='$BC_SCALE_PROJECT'"
  local SERVE_EXTRA_ENV="$SERVE_EXTRA_ENV FACTORY_GITHUB_API=http://127.0.0.1:$BOUNDED_PORT"
  serve_start || { bounded_cost_stop_proxy; CUR_CFG=$keep; return; }
  sleep 30; a=$(date -u +%Y-%m-%dT%H:%M:%S); sleep "$BOUNDED_IDLE_SECS"; b=$(date -u +%Y-%m-%dT%H:%M:%S)
  serve_stop; bounded_cost_stop_proxy; CUR_CFG=$keep
  r=$(bc_polls "$log" "$a" "$b")
  local ms; ms=$(python3 -c 'import json,sys,statistics
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
rows=[x for x in rows if sys.argv[2]<=x["at"]<=sys.argv[3]]
print("calls %d, median ms %s" % (len(rows), statistics.median([x.get("ms",0) for x in rows] or [0])))' "$log" "$a" "$b")
  if python3 -c 'import json,sys;d=json.loads(sys.argv[1]);sys.exit(0 if d["polls"]>0 and d["max"]<=2 and d["other"]==0 else 1)' "$r"
  then record bounded-cost.scale-idle $g PASS "$items cards, none queued: $r; $ms" "$t0"; else record bounded-cost.scale-idle $g FAIL "$items cards, none queued: $r; $ms" "$t0"; fi
}
