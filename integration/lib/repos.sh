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
