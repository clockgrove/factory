# ---------- transient scratch repositories ----------
# Each run makes its own repositories in REPO_OWNER from fixtures/baseline/
# and deletes them when it passes, so every run starts from the same tree and
# none sees another's issues, PRs, assets, variables or holder records. Only
# a repository whose description starts with REPO_MARK is ever deleted.

REPO_MARK="Factory integration run (transient)"

# repo_create NAME: a private OWNER/NAME whose main is the baseline as one
# commit, with strict protection on the `test` check and no required review.
repo_create() {
  local repo=$REPO_OWNER/$1 dir
  gh repo create "$repo" --private --description "$REPO_MARK $RUN_ID" >/dev/null || return 1
  echo "$1" >>"$RUN_DIR/repos"
  dir=$(mktemp -d)
  cp -a "$SUITE/fixtures/baseline/." "$dir/" &&
    git -C "$dir" init -q -b main && git -C "$dir" add -A &&
    git -C "$dir" -c user.name="Factory integration" -c user.email=factory-integration@users.noreply.github.com \
      commit -q -m "Drill baseline" &&
    git -C "$dir" push -q "https://github.com/$repo.git" main
  local rc=$?
  rm -rf "$dir"
  [ "$rc" = 0 ] || return 1
  gh api -X PUT "repos/$repo/branches/main/protection" --input - >/dev/null <<'JSON' || return 1
{"required_status_checks":{"strict":true,"contexts":["test"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}
JSON
  log "created $repo"
}

# repo_delete NAME: delete OWNER/NAME, only when it carries REPO_MARK.
repo_delete() {
  local description
  description=$(gh api "repos/$REPO_OWNER/$1" --jq '.description // ""') || return 1
  [[ $description == "$REPO_MARK"* ]] || { log "not deleting $REPO_OWNER/$1: not a suite repository"; return 1; }
  gh repo delete "$REPO_OWNER/$1" --yes >/dev/null && log "deleted $REPO_OWNER/$1"
}

# repos_sweep: delete suite repositories created over a day ago (kept by a
# failed run, or left by one that was killed).
repos_sweep() {
  local cutoff r; cutoff=$(date -u -d '-24 hours' +%Y-%m-%dT%H:%M:%SZ)
  gh repo list "$REPO_OWNER" --limit 500 --json name,description,createdAt \
    --jq ".[] | select((.description // \"\") | startswith(\"$REPO_MARK\")) | select(.createdAt < \"$cutoff\") | .name" |
    while read -r r; do [ -n "$r" ] && repo_delete "$r"; done
}

# ---------- each repository's Project ----------
# One installation serves a Project (PRD 8), so each repository the run makes
# gets a Project of its own, with Factory's queue field (its six options) and
# order field, deleted with the repositories: no Project is shared with
# another run. GitHub gives a new Project the built-in Status field (Todo, In
# Progress, Done) and its default view and workflows. Only a Project whose
# title starts with REPO_MARK is deleted.

# project_create REPO: REPO's Project -> its node id (recorded by number in RUN_DIR/projects).
project_create() {
  local data number
  data=$(gh project create --owner "$REPO_OWNER" --title "$REPO_MARK $RUN_ID ${1#*/}" --format json) || return 1
  number=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["number"])' <<<"$data") || return 1
  echo "$number" >>"$RUN_DIR/projects"
  gh project field-create "$number" --owner "$REPO_OWNER" --name Factory --data-type SINGLE_SELECT \
    --single-select-options "Queued,Planning,Building,Needs you,Done,Cancelled" >/dev/null || return 1
  gh project field-create "$number" --owner "$REPO_OWNER" --name "Factory order" --data-type NUMBER >/dev/null || return 1
  log "created Project #$number for $1"
  python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])' <<<"$data"
}

# project_delete NUMBER: delete Project NUMBER, only when its title carries REPO_MARK.
project_delete() {
  local title
  title=$(gh project view "$1" --owner "$REPO_OWNER" --format json --jq .title) || return 1
  [[ $title == "$REPO_MARK"* ]] || { log "not deleting Project #$1: not a suite Project"; return 1; }
  gh project delete "$1" --owner "$REPO_OWNER" >/dev/null && log "deleted Project #$1"
}

# projects_sweep: delete suite Projects whose run (the RUN_ID in the title) began over a day ago.
projects_sweep() {
  local n
  gh project list --owner "$REPO_OWNER" --limit 200 --format json |
    python3 -c 'import datetime,json,re,sys
mark = sys.argv[1]; cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=24)
for p in json.load(sys.stdin).get("projects", []):
    t = p.get("title") or ""
    m = re.match(re.escape(mark) + r" (\d{4}-\d\d-\d\dT\d{6})", t)
    # RUN_ID is PDT/PST wall time; reading it as UTC-7 can only make a run look younger.
    if m and datetime.datetime.strptime(m.group(1), "%Y-%m-%dT%H%M%S").replace(tzinfo=datetime.timezone(datetime.timedelta(hours=-7))) < cutoff:
        print(p["number"])' "$REPO_MARK" |
    while read -r n; do [ -n "$n" ] && project_delete "$n"; done
}
