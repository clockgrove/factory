#!/bin/bash
# scripts/land-prep.sh [--no-push]: in a PR's worktree, rebase onto
# origin/main, run the quick checks (build, lint, format, notices; CI runs
# the tests), and push only if every step passed
# (docs/LANDING.md#before-you-push). Any failure stops
# with a non-zero exit before the push (set -euo pipefail: no step's
# failure is hidden by a pipe or a `;`).
set -euo pipefail
push=1
[ "${1:-}" = "--no-push" ] && push=0
branch=$(git symbolic-ref --short HEAD) || { echo "land-prep: not on a branch (a rebase in progress?)" >&2; exit 1; }
case "$branch" in main|master) echo "land-prep: refusing on $branch" >&2; exit 1;; esac
if [ -n "$(git status --porcelain)" ]; then echo "land-prep: uncommitted changes; commit or drop them first" >&2; git status --short >&2; exit 1; fi
# A stacked PR's base is the branch below it: rebasing it onto main would copy
# every lower layer into it. Stacks use gh stack rebase, then gh stack submit.
# Fails closed: a gh error stops here; only a branch with no open PR yet
# counts as based on main.
if ! base=$(gh pr list --head "$branch" --state open --json baseRefName -q '.[0].baseRefName // "main"'); then
  echo "land-prep: can't read $branch's pull request base (gh failed); not rebasing" >&2
  exit 1
fi
if [ "$base" != main ]; then echo "land-prep: $branch is stacked on $base; use gh stack rebase, then gh stack submit" >&2; exit 1; fi
git fetch -q origin main
if ! git rebase origin/main >/dev/null 2>&1; then
  echo "land-prep: rebase conflict; resolve, then run land-prep again:" >&2
  git diff --name-only --diff-filter=U >&2
  exit 1
fi
ahead=$(git rev-list --count origin/main..HEAD)
[ "$ahead" -gt 0 ] || { echo "land-prep: $branch has no commits of its own; nothing to push" >&2; exit 1; }
log=$(mktemp /tmp/land-prep.XXXXXX)
trap 'rm -f "$log"' EXIT
step() { echo "land-prep: $1"; shift; if ! "$@" >"$log" 2>&1; then echo "land-prep: FAILED: $*" >&2; tail -40 "$log" >&2; exit 1; fi; }
step build npm run build
step lint npm run lint
step format npm run format:check
step notices npm run notices:check
if git grep -n -e '^<<<<<<<' -e '^>>>>>>>' -- . >/dev/null; then echo "land-prep: conflict markers left" >&2; exit 1; fi
if [ "$push" = 1 ]; then
  git push --force-with-lease -u origin "$branch" >/dev/null 2>&1 || { echo "land-prep: push failed" >&2; exit 1; }
  echo "land-prep: pushed $branch at $(git rev-parse HEAD) ($ahead commit(s) on $(git rev-parse --short origin/main))"
else
  echo "land-prep: ready (not pushed): $(git rev-parse HEAD)"
fi
