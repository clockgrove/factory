# GitHub helpers for the drill repository (gh CLI; its own login, never read here).
# Sourced; expects REPO OWNER NAME RUN_DIR CUR_CFG.

# Project id, field "Factory" and its options, from the config's queue.projectId.
gh_project() {
  local cache="$RUN_DIR/project.json"
  if [ ! -s "$cache" ]; then
    local pid; pid=$(cfg_get 'c["queue"]["projectId"]')
    gh api graphql -f id="$pid" -f query='query($id:ID!){node(id:$id){... on ProjectV2{id number owner{... on Organization{login} ... on User{login}} field(name:"Factory"){... on ProjectV2SingleSelectField{id options{id name}}}}}}' \
      --jq .data.node >"$cache" || { rm -f "$cache"; return 1; }
  fi
  cat "$cache"
}
gh_pj() { gh_project | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
gh_option_id() { gh_pj "next(o['id'] for o in d['field']['options'] if o['name']=='$1')"; }

# gh_queue TITLE FILE -> issue number; added to the Project and set Queued.
gh_queue() {
  local n
  n=$(gh issue create --repo "$REPO" --title "$1" --body-file "$2" | grep -o '[0-9]*$') || return 1
  gh_enqueue "$n"
}
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
# PRs whose head is factory/N/... as JSON [{number,state}]
gh_prs() {
  gh pr list --repo "$REPO" --state all --search "head:factory/$1/" --json number,state,headRefName \
    --jq "[.[]|select(.headRefName|startswith(\"factory/$1/\"))|{number,state}]"
}
gh_open_pr() { gh_prs "$1" | python3 -c 'import json,sys;p=[x for x in json.load(sys.stdin) if x["state"]=="OPEN"];print(p[0]["number"] if p else "")'; }
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
branch_rule() { build_has_env branch-kept; }

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

# ---------- Project order field (queue.orderField, default "Factory order") ----------
gh_order_field() {
  local cache="$RUN_DIR/order-field.json" name
  if [ ! -s "$cache" ]; then
    name=$(cfg_get 'c["queue"].get("orderField","Factory order")')
    gh api graphql -f id="$(gh_pj "d['id']")" -f name="$name" -f query='query($id:ID!,$name:String!){node(id:$id){... on ProjectV2{field(name:$name){... on ProjectV2Field{id}}}}}' \
      --jq .data.node.field.id >"$cache" || { rm -f "$cache"; return 1; }
  fi
  cat "$cache"
}
# gh_order ISSUE NUMBER: set the card's order value (lower is admitted first).
gh_order() {
  local item; item=$(gh_item "$1"); [ -n "$item" ] || return 1
  gh project item-edit --project-id "$(gh_pj "d['id']")" --id "$item" --field-id "$(gh_order_field)" --number "$2" >/dev/null && log "order #$1 -> $2"
}

# ---------- comments by marker, with their authors ----------
gh_login() { [ -s "$RUN_DIR/login" ] || gh api user --jq .login >"$RUN_DIR/login"; cat "$RUN_DIR/login"; }
# gh_marker_comments ISSUE MARKER -> JSON [{id, login, created, updated, body}] of comments holding it.
gh_marker_comments() {
  gh api "repos/$REPO/issues/$1/comments" --paginate --jq '.[]|{id, login: .user.login, created: .created_at, updated: .updated_at, body}' \
    | python3 -c 'import json,sys
m=sys.argv[1]; out=[]
for l in sys.stdin:
    c=json.loads(l)
    if m in c["body"]: out.append(c)
print(json.dumps(out))' "<!-- factory:$1:$2 -->"
}
# A workflow on the drill repo's default branch (by file name).
gh_has_workflow() { gh api "repos/$REPO/actions/workflows/$1" --jq .state >/dev/null 2>&1; }

# ---------- repository changes the maintainer must approve (--allow-repo-changes) ----------
# Each one queues its exact undo first (restore_push); restore_run undoes it.
# Classic branch protection on main is changed through its sub-resources only,
# so everything else on it stays as it was.
rc_human_gate_on() { # require one approving review on main
  local was; was=$(gh_protection | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("noprot"); sys.exit()
r=d.get("required_pull_request_reviews")
print(r.get("required_approving_review_count",0) if r else "none")')
  [ "$was" = noprot ] && { log "main has no classic branch protection to add a review gate to"; return 1; }
  if [ "$was" = none ]; then restore_push "gh api -X DELETE repos/$REPO/branches/main/protection/required_pull_request_reviews >/dev/null"
  else restore_push "gh api -X PATCH repos/$REPO/branches/main/protection/required_pull_request_reviews -F required_approving_review_count=$was >/dev/null"; fi
  gh api -X PATCH "repos/$REPO/branches/main/protection/required_pull_request_reviews" -F required_approving_review_count=1 >/dev/null \
    && [ "$(gh_human_gate)" = true ] && log "human gate on: main requires 1 approving review (was: $was)"
}
rc_strict_on() { # require branches to be up to date before merging
  local was; was=$(gh_strict)
  [ -n "$(gh_protection)" ] || { log "main has no classic branch protection to make strict"; return 1; }
  restore_push "gh api -X PATCH repos/$REPO/branches/main/protection/required_status_checks -F strict=$was >/dev/null"
  gh api -X PATCH "repos/$REPO/branches/main/protection/required_status_checks" -F strict=true >/dev/null \
    && [ "$(gh_strict)" = true ] && log "strict protection on (was strict=$was)"
}
# rc_scratch_repo NAME: a private scratch repository OWNER/NAME, deleted afterwards
# (deleting needs the delete_repo scope; a failure is logged as RESTORE FAILED).
rc_scratch_repo() {
  gh repo view "$OWNER/$1" >/dev/null 2>&1 && { log "scratch repo $OWNER/$1 exists already; not touching it"; return 1; }
  gh repo create "$OWNER/$1" --private --description "Factory drill scratch repo ($RUN_ID); delete me" >/dev/null || return 1
  restore_push "gh repo delete $OWNER/$1 --yes"
  log "scratch repo $OWNER/$1 created"
}
# rc_rename NEWNAME: rename the drill repository; the undo renames it back.
rc_rename() {
  restore_push "gh api -X PATCH repos/$OWNER/$1 -f name=$NAME >/dev/null"
  gh api -X PATCH "repos/$REPO" -f name="$1" >/dev/null && log "renamed $REPO -> $OWNER/$1"
}

# gh_hold_comments_since ISSUE ISO: Factory question comments created at or after ISO.
gh_hold_comments_since() { gh api "repos/$REPO/issues/$1/comments" --paginate --jq ".[]|select((.body|startswith(\"<!-- factory:$1:hold:\")) and .created_at >= \"$2\")|.id" | wc -l; }
# gh_rerun_questions_withdrawn ISSUE: "n m": the re-run's question comments, and how many of them say they no longer apply (a withdrawal edits them).
gh_rerun_questions_withdrawn() { gh api "repos/$REPO/issues/$1/comments" --paginate --jq ".[]|select(.body|startswith(\"<!-- factory:$1:hold:rerun\"))|(.body|contains(\"This question no longer applies\"))" | awk '{n++; if($1=="true")m++} END{print n+0, m+0}'; }
