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

# gh_item_add ISSUE: put an existing issue on the Project (an issue already
# there keeps its card); prints the card's item id.
gh_item_add() {
  gh project item-add "$(gh_pj "d['number']")" --owner "$(gh_pj "d['owner']['login']")" \
    --url "https://github.com/$REPO/issues/$1" --format json --jq .id
}
# gh_item_archive ITEM: archive a card on the Project.
gh_item_archive() { gh project item-archive "$(gh_pj "d['number']")" --owner "$(gh_pj "d['owner']['login']")" --id "$1" >/dev/null; }
# gh_enqueue ISSUE: add an existing issue to the Project, set Queued; prints it.
gh_enqueue() {
  local n=$1 item
  item=$(gh_item_add "$n") && [ -n "$item" ] || return 1
  gh project item-edit --project-id "$(gh_pj "d['id']")" --id "$item" --field-id "$(gh_pj "d['field']['id']")" \
    --single-select-option-id "$(gh_option_id Queued)" >/dev/null || return 1
  echo "$n"
}
# gh_issue_file TITLE BODY_FILE: file an issue in REPO; prints its number.
# GitHub can fail a create for a moment (run 2026-10-28T181930PDT-fb54: `Post
# "https://api.github.com/graphql": EOF` ended the codex case before it began),
# and a create that failed may still have filed the issue. So it is tried up
# to three times, and before each retry the newest issues are searched for one
# with this title and body the run hasn't recorded: found, that is the issue,
# never a second copy. Each failure is logged; the last error stays in
# RUN_DIR/file.INST.CASE.err.
gh_issue_file() {
  local title=$1 body=$2 err="$RUN_DIR/file.$INST.${CASE:-suite}.err" try n
  for try in 1 2 3; do
    if [ "$try" -gt 1 ]; then
      sleep $(( (try - 1) * 5 ))
      if ! n=$(gh_issue_filed "$title" "$body" 2>"$err"); then
        log "looking for issue '$title' failed (try $try): $(head -c 300 "$err")"; continue
      fi
      [ -z "$n" ] || { log "issue '$title' was filed by the failed try: #$n"; echo "$n"; return 0; }
    fi
    n=$(gh issue create --repo "$REPO" --title "$title" --body-file "$body" 2>"$err" | grep -o '[0-9]*$' | tail -n 1)
    [[ $n =~ ^[0-9]+$ ]] && { echo "$n"; return 0; }
    log "filing issue '$title' failed (try $try): $(head -c 300 "$err")"
  done
  return 1
}
# gh_issue_filed TITLE BODY_FILE: the oldest of REPO's 100 newest issues with
# this title and body that RUN_DIR/issues doesn't hold for this installation;
# prints nothing when there is none.
gh_issue_filed() {
  local data; data=$(gh api "repos/$REPO/issues?state=all&sort=created&direction=desc&per_page=100") || return 1
  python3 -c '
import json, sys
title, body_file, issues, inst = sys.argv[1:5]
norm = lambda s: (s or "").replace("\r\n", "\n").strip()
body = norm(open(body_file).read())
known = set()
try:
    for line in open(issues):
        f = line.split()
        if len(f) >= 3 and f[2] == inst: known.add(f[0])
except FileNotFoundError:
    pass
hits = sorted(i["number"] for i in json.load(sys.stdin)
              if "pull_request" not in i and i.get("title") == title
              and norm(i.get("body")) == body and str(i["number"]) not in known)
if hits: print(hits[0])' "$1" "$2" "$RUN_DIR/issues" "$INST" <<<"$data"
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
# PRs since this Objective was filed, cached for 30 s. Paginate until the
# creation boundary, so a busy scratch repository cannot hide active PRs
# behind an arbitrary count, and progress never scans older history.
gh_pulls_all() (
  local n=$1 f="$RUN_DIR/pulls.${REPO//\//_}.$1.json" created page data stop temporary
  flock 9 || return 1
  if [ ! -f "$f" ] || [ $(( $(now) - $(stat -c %Y "$f") )) -ge "${PULLS_TTL:-30}" ]; then
    created=$(gh api "repos/$REPO/issues/$n" --jq .created_at) || return 1
    temporary=$(mktemp "$f.XXXXXX") || return 1
    trap 'rm -f "$temporary"' EXIT
    page=1
    while :; do
      data=$(gh api "repos/$REPO/pulls?state=all&sort=created&direction=desc&per_page=100&page=$page" \
        --jq '[.[]|{number, state: (if .merged_at then "MERGED" elif .state=="open" then "OPEN" else "CLOSED" end), head: .head.ref, createdAt: .created_at}]') || return 1
      stop=$(python3 - "$data" "$created" "$temporary" <<'PY'
import datetime,json,sys
rows=json.loads(sys.argv[1]); cutoff=datetime.datetime.fromisoformat(sys.argv[2].replace("Z","+00:00"))
if not isinstance(rows,list): raise ValueError("GitHub PR collection is not a list")
older=False
with open(sys.argv[3],"a") as out:
    for row in rows:
        at=datetime.datetime.fromisoformat(row["createdAt"].replace("Z","+00:00"))
        if at < cutoff: older=True
        else: out.write(json.dumps(row)+"\n")
print("stop" if older or len(rows)<100 else "next")
PY
) || return 1
      [ "$stop" = stop ] && break
      page=$((page + 1))
    done
    # Empty is a successful collection too; the cache marker is its mtime.
    mv "$temporary" "$f" || return 1
  fi
  cat "$f"
 ) 9>"$RUN_DIR/pulls.${REPO//\//_}.$1.lock"
gh_prs() {
  local rows; rows=$(gh_pulls_all "$1") || return 1
  python3 -c 'import json,sys
n=sys.argv[1]; out=[]
for l in sys.stdin:
    if not l.strip(): continue
    r=json.loads(l)
    if r["head"].startswith("factory/%s/" % n): out.append({"number": r["number"], "state": r["state"]})
print(json.dumps(sorted(out, key=lambda x: x["number"])))' "$1" <<<"$rows"
}
gh_open_pr() {
  local prs; prs=$(PULLS_TTL=${PULLS_TTL:-10} gh_prs "$1") || return 1
  python3 -c 'import json,sys;p=[x for x in json.loads(sys.argv[1]) if x["state"]=="OPEN"];print(p[0]["number"] if p else "")' "$prs"
}
# Factory markers on the issue and its PRs: "marker count" lines.
gh_markers() {
  local n=$1 prs=${2:-} numbers p data counts="" part
  [ -n "$prs" ] || prs=$(gh_prs "$n") || return 1
  numbers=$(python3 -c 'import json,sys;print(" ".join(str(x["number"]) for x in json.loads(sys.argv[1])))' "$prs") || return 1
  for p in "$n" $numbers; do
    data=$(gh api "repos/$REPO/issues/$p/comments?per_page=100" --paginate --slurp) || return 1
    part=$(python3 -c '
import collections,json,re,sys
counts=collections.Counter()
for page in json.load(sys.stdin):
    for comment in page:
        counts.update(re.findall(r"<!-- factory:"+re.escape(sys.argv[1])+r":([^\s]+) -->",comment["body"]))
print(json.dumps(counts))
 ' "$n" <<<"$data"
) || return 1
    counts+="$part"$'\n'
  done
  python3 -c 'import collections,json,sys
c=collections.Counter()
for line in sys.argv[1].splitlines(): c.update(json.loads(line))
for marker,count in sorted(c.items()): print(marker,count)' "$counts"
}
# The body of issue N's comment that starts with Factory's marker for KIND:ID ("hold:<id>"); empty when none.
gh_marked_body() {
  local data; data=$(gh api "repos/$REPO/issues/$1/comments?per_page=100" --paginate --slurp) || return 1
  python3 -c 'import json,sys
for page in json.load(sys.stdin):
    for comment in page:
        if comment["body"].startswith(sys.argv[1]): print(comment["body"]); sys.exit(0)' "<!-- factory:$1:$2 -->" <<<"$data"
}
# Whether comment BODY @-mentions anyone, as GitHub would notify them: an @
# that starts a login at the start or after a character no login or code span
# ends with. The leading Factory marker is not text, and the @ in a hold id's
# timestamp (decide:1:1@2026-...) follows a digit, so neither is a mention.
body_mentions() {
  local body=${1#'<!-- factory:'*' -->'} re='(^|[^[:alnum:]_`])@[[:alnum:]]'
  [[ $body =~ $re ]]
}
marker_count() { awk -v m="$2" '$1==m{print $2; f=1} END{if(!f) print 0}' <<<"$1"; }
marker_prefix_count() { awk -v m="$2" 'index($1,m)==1{s+=$2} END{print s+0}' <<<"$1"; }
marker_dupes() { awk '$2>1{printf "%s x%s ", $1, $2}' <<<"$1"; }
gh_issue_state() { gh issue view "$1" --repo "$REPO" --json state,stateReason --jq '"\(.state) \(.stateReason)"'; }
gh_comment() { gh api "repos/$REPO/issues/$1/comments" -f body="$2" --jq .id; }
gh_protection() { gh api "repos/$REPO/branches/main/protection"; }
gh_strict() { local data; data=$(gh_protection) || return 1; python3 -c 'import json,sys
d=json.loads(sys.argv[1]); print(str(bool((d.get("required_status_checks") or {}).get("strict"))).lower())' "$data"; }
gh_human_gate() { local data; data=$(gh_protection) || return 1; python3 -c 'import json,sys
d=json.loads(sys.argv[1])
r=(d.get("required_pull_request_reviews") or {}).get("required_approving_review_count",0)
print("true" if r and r>0 else "false")' "$data"; }
# gh_move_main NAME: commit drill/moves/NAME.txt to main, a path no Objective
# owns, so open PRs fall behind a strict main; prints the commit.
gh_move_main() { gh api -X PUT "repos/$REPO/contents/drill/moves/$1.txt" -f message="Drill: move main ($1)" -f content="$(printf '%s\n' "$1" | base64 -w0)" --jq .commit.sha; }
# File bytes on main (raw; LFS files come back as their pointer).
gh_file() { gh api "repos/$REPO/contents/$1?ref=main" -H 'Accept: application/vnd.github.raw' 2>/dev/null; }

# Branches factory/N/* left on the repository (count).
gh_branches_left() { gh api "repos/$REPO/git/matching-refs/heads/factory/$1/" --jq 'length'; }
# A build that deletes its own branches must leave none.
branch_rule() { build_has_token branch-kept; }

# ---------- standard end checks (set EVID; return 0 on pass) ----------
worktrees_for() {
  local co rows; co=$(cfg_get 'c["checkout"]') || return 1
  rows=$(git -C "$co" worktree list --porcelain) || return 1
  python3 -c 'import sys;print(sum(1 for line in sys.argv[2].splitlines() if line.startswith("worktree ") and "/work/"+sys.argv[1]+"/" in line))' "$1" "$rows"
}
end_done() {
  local n=$1 s prs m iss wt
  EVID="#$n evidence unavailable: local state"; s=$(st status "$n") || return 1
  EVID="#$n evidence unavailable: PR collection"; prs=$(PULLS_TTL=0 gh_prs "$n") || return 1
  EVID="#$n evidence unavailable: comments"; m=$(gh_markers "$n" "$prs") || return 1
  EVID="#$n evidence unavailable: issue state"; iss=$(gh_issue_state "$n") || return 1
  EVID="#$n evidence unavailable: worktree listing"; wt=$(worktrees_for "$n") || return 1
  local np nm; np=$(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1])))' "$prs")
  nm=$(python3 -c 'import json,sys;print(sum(1 for p in json.loads(sys.argv[1]) if p["state"]=="MERGED"))' "$prs")
  local plan rep d; plan=$(marker_count "$m" plan); d=$(marker_dupes "$m")
  # A report marker is `report`, or `report:<run>` (one per run).
  rep=$(( $(marker_count "$m" report) + $(marker_prefix_count "$m" report:) ))
  local br=0
  if branch_rule; then EVID="#$n evidence unavailable: branch listing"; br=$(gh_branches_left "$n") || return 1; fi
  EVID="#$n status=$s prs=$np merged=$nm plan x$plan report x$rep issue=$iss worktrees=$wt$(branch_rule && echo " branches_left=$br")${d:+ DUPES: $d}"
  [ -s "$RUN_DIR/notes.$n" ] && EVID="$EVID; $(paste -sd';' "$RUN_DIR/notes.$n")"
  [ "$s" = done ] && [ "$np" -ge 1 ] && [ "$np" = "$nm" ] && [ "$plan" = 1 ] && [ "$rep" = 1 ] && [ -z "$d" ] \
    && [ "$iss" = "CLOSED COMPLETED" ] && [ "$wt" = 0 ] && [ "$br" = 0 ]
}
end_cancelled() {
  local n=$1 s prs m iss wt d op
  EVID="#$n evidence unavailable: local state"; s=$(st status "$n") || return 1
  EVID="#$n evidence unavailable: PR collection"; prs=$(PULLS_TTL=0 gh_prs "$n") || return 1
  EVID="#$n evidence unavailable: comments"; m=$(gh_markers "$n" "$prs") || return 1
  EVID="#$n evidence unavailable: issue state"; iss=$(gh_issue_state "$n") || return 1
  EVID="#$n evidence unavailable: worktree listing"; wt=$(worktrees_for "$n") || return 1
  op=$(python3 -c 'import json,sys;print(sum(1 for p in json.loads(sys.argv[1]) if p["state"]=="OPEN"))' "$prs")
  d=$(marker_dupes "$m")
  local br=0
  if branch_rule; then EVID="#$n evidence unavailable: branch listing"; br=$(gh_branches_left "$n") || return 1; fi
  EVID="#$n status=$s open_prs=$op issue=$iss worktrees=$wt$(branch_rule && echo " branches_left=$br") markers=[$(paste -sd' ' <<<"$m")]${d:+ DUPES: $d}"
  [ "$s" = cancelled ] && [ "$op" = 0 ] && [ -z "$d" ] && [ "$iss" = "CLOSED NOT_PLANNED" ] && [ "$wt" = 0 ] && { [ "$br" = 0 ] || [ -n "${KEEP_BRANCH_OK:-}" ]; }
}

# ---------- the review gate on the run repository's main ----------
# Changed only through these two direct calls on the protection sub-resource,
# so the rest of main's protection stays as it was. The wave's end removes it.
gate_on() {
  gh api -X PUT "repos/$REPO/branches/main/protection/required_pull_request_reviews" -F required_approving_review_count=1 >/dev/null 2>"$RUN_DIR/gate-on.err" \
    && [ "$(gh_human_gate)" = true ] && { log "review gate ON (PUT)"; echo "$REPO" >"$RUN_DIR/gate-on"; return 0; }
  log "PUT required_pull_request_reviews failed: $(head -c 200 "$RUN_DIR/gate-on.err")"; return 1
}
gate_off() {
  local gate; gate=$(gh_human_gate) || return 1
  [ "$gate" = true ] || { rm -f "$RUN_DIR/gate-on"; return 0; }
  gh api -X DELETE "repos/$REPO/branches/main/protection/required_pull_request_reviews" >/dev/null || return 1
  if [ "$(gh_human_gate)" = false ]; then log "review gate OFF (DELETE)"; rm -f "$RUN_DIR/gate-on"
  else log "RESTORE FAILED: review gate still on; run: gh api -X DELETE repos/$REPO/branches/main/protection/required_pull_request_reviews"; return 1; fi
}
