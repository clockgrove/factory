# GitHub helpers for the drill repository (gh CLI; its own login, never read here).
# Sourced; expects REPO OWNER NAME RUN_DIR CUR_CFG.

# Project id, field "Factory" and its options, from the config's queue.projectId.
gh_project() {
  local cache="$RUN_DIR/project.$INST.json"
  if [ ! -s "$cache" ]; then
    local pid; pid=$(cfg_get 'c["queue"]["projectId"]')
    gh api graphql -f id="$pid" -f query='query($id:ID!){node(id:$id){... on ProjectV2{id number owner{... on Organization{login} ... on User{login}} field(name:"Factory"){... on ProjectV2SingleSelectField{id options{id name}}}}}}' \
      --jq .data.node >"$cache" || { rm -f "$cache"; return 1; }
  fi
  cat "$cache"
}
gh_pj() { gh_project | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
gh_option_id() { gh_pj "next(o['id'] for o in d['field']['options'] if o['name']=='$1')"; }

# gh_enqueue ISSUE: add an existing issue to the Project, set Queued; prints it.
gh_enqueue() {
  local n=$1 item
  item=$(gh project item-add "$(gh_pj "d['number']")" --owner "$(gh_pj "d['owner']['login']")" \
    --url "https://github.com/$REPO/issues/$n" --format json --jq .id) || return 1
  gh project item-edit --project-id "$(gh_pj "d['id']")" --id "$item" --field-id "$(gh_pj "d['field']['id']")" \
    --single-select-option-id "$(gh_option_id Queued)" >/dev/null || return 1
  echo "$n"
}
gh_item() {
  gh api graphql -f query="query{repository(owner:\"$OWNER\",name:\"$NAME\"){issue(number:$1){projectItems(first:10){nodes{id project{id}}}}}}" \
    --jq ".data.repository.issue.projectItems.nodes[]|select(.project.id==\"$(gh_pj "d['id']")\")|.id"
}
# gh_card ISSUE OPTION ("" clears)
gh_card() {
  local item; item=$(gh_item "$1")
  [ -n "$item" ] || return 1
  if [ -z "$2" ]; then
    gh project item-edit --project-id "$(gh_pj "d['id']")" --id "$item" --field-id "$(gh_pj "d['field']['id']")" --clear >/dev/null
  else
    gh project item-edit --project-id "$(gh_pj "d['id']")" --id "$item" --field-id "$(gh_pj "d['field']['id']")" \
      --single-select-option-id "$(gh_option_id "$2")" >/dev/null
  fi
  log "card #$1 -> ${2:-<cleared>}"
}
gh_card_value() {
  gh api graphql -f query="query{repository(owner:\"$OWNER\",name:\"$NAME\"){issue(number:$1){projectItems(first:10){nodes{project{id} fieldValueByName(name:\"Factory\"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}" \
    --jq ".data.repository.issue.projectItems.nodes[]|select(.project.id==\"$(gh_pj "d['id']")\")|.fieldValueByName.name // \"\""
}
# PRs whose head is factory/N/... as JSON [{number,state}], from one listing of
# the newest 200 PRs, cached for 30 s per repository (no search API: its
# limit is 30 calls a minute).
gh_pulls_all() {
  local f="$RUN_DIR/pulls.${REPO//\//_}.json"
  if [ ! -s "$f" ] || [ $(( $(now) - $(stat -c %Y "$f") )) -ge "${PULLS_TTL:-30}" ]; then
    { gh api "repos/$REPO/pulls?state=all&sort=created&direction=desc&per_page=100" --jq '.[]|{number, state: (if .merged_at then "MERGED" elif .state=="open" then "OPEN" else "CLOSED" end), head: .head.ref}' 2>/dev/null
      gh api "repos/$REPO/pulls?state=all&sort=created&direction=desc&per_page=100&page=2" --jq '.[]|{number, state: (if .merged_at then "MERGED" elif .state=="open" then "OPEN" else "CLOSED" end), head: .head.ref}' 2>/dev/null; } >"$f.$$" && mv "$f.$$" "$f"
  fi
  cat "$f"
}
gh_prs() {
  gh_pulls_all | python3 -c 'import json,sys
n=sys.argv[1]; out=[]
for l in sys.stdin:
    r=json.loads(l)
    if r["head"].startswith("factory/%s/" % n): out.append({"number": r["number"], "state": r["state"]})
print(json.dumps(sorted(out, key=lambda x: x["number"])))' "$1"
}
gh_open_pr() { PULLS_TTL=${PULLS_TTL:-10} gh_prs "$1" | python3 -c 'import json,sys;p=[x for x in json.load(sys.stdin) if x["state"]=="OPEN"];print(p[0]["number"] if p else "")'; }
# Factory markers on the issue and its PRs: "marker count" lines.
gh_markers() {
  local n=$1 prs p
  prs=$(gh_prs "$n" | python3 -c 'import json,sys;print(" ".join(str(x["number"]) for x in json.load(sys.stdin)))')
  { gh api "repos/$REPO/issues/$n/comments" --paginate --jq '.[].body'
    for p in $prs; do gh api "repos/$REPO/issues/$p/comments" --paginate --jq '.[].body'; done; } \
    | grep -o "<!-- factory:$n:[^ ]* -->" | sed "s/<!-- factory:$n://; s/ -->//" | sort | uniq -c | awk '{print $2, $1}'
}
marker_count() { awk -v m="$2" '$1==m{print $2; f=1} END{if(!f) print 0}' <<<"$1"; }
marker_prefix_count() { awk -v m="$2" 'index($1,m)==1{s+=$2} END{print s+0}' <<<"$1"; }
marker_dupes() { awk '$2>1{printf "%s x%s ", $1, $2}' <<<"$1"; }
gh_issue_state() { gh issue view "$1" --repo "$REPO" --json state,stateReason --jq '"\(.state) \(.stateReason)"'; }
gh_comment() { gh api "repos/$REPO/issues/$1/comments" -f body="$2" --jq .id; }
gh_protection() { gh api "repos/$REPO/branches/main/protection" 2>/dev/null; }
gh_strict() { gh_protection | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("false"); sys.exit()
print(str(bool((d.get("required_status_checks") or {}).get("strict"))).lower())'; }
gh_human_gate() { gh_protection | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("false"); sys.exit()
r=(d.get("required_pull_request_reviews") or {}).get("required_approving_review_count",0)
print("true" if r and r>0 else "false")'; }
# File bytes on main (raw; LFS files come back as their pointer).
gh_file() { gh api "repos/$REPO/contents/$1?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null; }

# Branches factory/N/* left on the repository (count).
gh_branches_left() { gh api "repos/$REPO/git/matching-refs/heads/factory/$1/" --jq 'length' 2>/dev/null || echo "?"; }
# A build that deletes its own branches must leave none.
branch_rule() { build_has_token branch-kept; }

# ---------- standard end checks (set EVID; return 0 on pass) ----------
worktrees_for() { local co; co=$(cfg_get 'c["checkout"]'); git -C "$co" worktree list 2>/dev/null | grep -c "/work/$1/"; }
end_done() {
  local n=$1 s prs m iss wt
  s=$(st status "$n"); prs=$(gh_prs "$n"); m=$(gh_markers "$n"); iss=$(gh_issue_state "$n"); wt=$(worktrees_for "$n")
  local np nm; np=$(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1])))' "$prs")
  nm=$(python3 -c 'import json,sys;print(sum(1 for p in json.loads(sys.argv[1]) if p["state"]=="MERGED"))' "$prs")
  local plan rep d; plan=$(marker_count "$m" plan); d=$(marker_dupes "$m")
  # A report marker is `report`, or `report:<run>` (one per run).
  rep=$(( $(marker_count "$m" report) + $(marker_prefix_count "$m" report:) ))
  local br=0; branch_rule && br=$(gh_branches_left "$n")
  EVID="#$n status=$s prs=$np merged=$nm plan x$plan report x$rep issue=$iss worktrees=$wt$(branch_rule && echo " branches_left=$br")${d:+ DUPES: $d}"
  [ -s "$RUN_DIR/notes.$n" ] && EVID="$EVID; $(paste -sd';' "$RUN_DIR/notes.$n")"
  [ "$s" = done ] && [ "$np" -ge 1 ] && [ "$np" = "$nm" ] && [ "$plan" = 1 ] && [ "$rep" = 1 ] && [ -z "$d" ] \
    && [ "$iss" = "CLOSED COMPLETED" ] && [ "$wt" = 0 ] && [ "$br" = 0 ]
}
end_cancelled() {
  local n=$1 s prs m iss wt d op
  s=$(st status "$n"); prs=$(gh_prs "$n"); m=$(gh_markers "$n"); iss=$(gh_issue_state "$n"); wt=$(worktrees_for "$n")
  op=$(python3 -c 'import json,sys;print(sum(1 for p in json.loads(sys.argv[1]) if p["state"]=="OPEN"))' "$prs")
  d=$(marker_dupes "$m")
  local br=0; branch_rule && br=$(gh_branches_left "$n")
  EVID="#$n status=$s open_prs=$op issue=$iss worktrees=$wt$(branch_rule && echo " branches_left=$br") markers=[$(paste -sd' ' <<<"$m")]${d:+ DUPES: $d}"
  [ "$s" = cancelled ] && [ "$op" = 0 ] && [ -z "$d" ] && [ "$iss" = "CLOSED NOT_PLANNED" ] && [ "$wt" = 0 ] && { [ "$br" = 0 ] || [ -n "${KEEP_BRANCH_OK:-}" ]; }
}

# ---------- the review gate on factory-drill's main ----------
# Changed only through these two direct calls on the protection sub-resource,
# so the rest of main's protection stays as it was. The wave's end removes it.
gate_on() {
  gh api -X PUT "repos/$REPO/branches/main/protection/required_pull_request_reviews" -F required_approving_review_count=1 >/dev/null 2>"$RUN_DIR/gate-on.err" \
    && [ "$(gh_human_gate)" = true ] && { log "review gate ON (PUT)"; echo "$REPO" >"$RUN_DIR/gate-on"; return 0; }
  log "PUT required_pull_request_reviews failed: $(head -c 200 "$RUN_DIR/gate-on.err")"; return 1
}
gate_off() {
  [ "$(gh_human_gate)" = true ] || { rm -f "$RUN_DIR/gate-on"; return 0; }
  gh api -X DELETE "repos/$REPO/branches/main/protection/required_pull_request_reviews" >/dev/null 2>&1
  if [ "$(gh_human_gate)" = false ]; then log "review gate OFF (DELETE)"; rm -f "$RUN_DIR/gate-on"
  else log "RESTORE FAILED: review gate still on; run: gh api -X DELETE repos/$REPO/branches/main/protection/required_pull_request_reviews"; return 1; fi
}
