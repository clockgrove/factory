# Landing changes

How changes reach `main` when several agents work at once. The goal is no merge churn: no serial rebasing, no shared file that every change has to edit, and no layer of a large refactor that a reviewer must take on trust.

## Merge queue

`main` lands through a merge queue. A pull request is enqueued, never merged directly:

```sh
gh pr merge --auto --squash N   # enqueue once CI is green; GitHub merges it
gh stack merge --yes             # a stack: queues every layer, bottom first
```

The queue runs the checks on each pull request on top of `main` and on everything queued ahead of it, then squashes it in. So two green pull requests can't break `main` together, and nobody rebases just to catch up.

**Why:** with direct merges, every landing made every other open branch stale. Lanes spent their time rebasing and re-running CI, and a rebase sometimes went wrong and was pushed anyway.

### Settings

If the repository is ever recreated, rebuild these settings. Quality must keep its `merge_group:` trigger, or queued pull requests wait forever for `package-gate`.

- **Repository:** auto-merge on; squash merge allowed; delete branches on merge.
- **Ruleset on the default branch** ("main requires a pull request and Quality"):
  - no deletion; no force push; a pull request, with no required approvals;
  - required check `package-gate`, from GitHub Actions;
  - merge queue: squash, all green, build and merge up to 5 entries, minimum 1, no wait, 60-minute check timeout.

```sh
gh api -X PATCH repos/OWNER/REPO -F allow_auto_merge=true -F delete_branch_on_merge=true
gh api -X POST repos/OWNER/REPO/rulesets --input - <<'JSON'
{
  "name": "main requires a pull request and Quality",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false, "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "package-gate", "integration_id": 15368 }] } },
    { "type": "merge_queue", "parameters": {
        "merge_method": "SQUASH", "grouping_strategy": "ALLGREEN",
        "max_entries_to_build": 5, "max_entries_to_merge": 5, "min_entries_to_merge": 1,
        "min_entries_to_merge_wait_minutes": 0, "check_response_timeout_minutes": 60 } }
  ]
}
JSON
```

## Stacks

Changes that build on each other are one stack of small pull requests, each based on the one below. Use [gh-stack](https://github.com/github/gh-stack) (`gh extension install github/gh-stack`, v0.2.1 or later):

```sh
gh stack init first-branch       # from main
gh stack add next-branch         # one per layer; commit on each
gh stack submit --auto --open    # push every layer and open its pull request
gh stack rebase                  # after main moves: rebase every layer in order
gh stack merge --yes             # queue every layer; run again if layers drop out
```

- **One layer, one reviewable change.** A reader should be able to approve a layer without reading the ones above it.
- **Never rebase a stacked branch onto `main` yourself.** That copies every lower layer into it: GitHub shows the pull request as conflicting and runs no CI on it. Use `gh stack rebase`. After repointing layers, check with `git range-diff` that their patches didn't change.
- **Check that the whole stack landed.** The queue merges the layers one at a time, and a layer can drop out when the branch below it is deleted on merge. If `gh stack view` still shows open layers, run `gh stack merge --yes` again.
- **Independent changes are separate pull requests,** not layers of one stack.

## Before you push

`scripts/land-prep.sh` gates a pull request's branch and pushes it only if every step passed. It refuses on `main`, with uncommitted changes, on a rebase conflict, on a branch with no commits of its own, and on a stacked branch (use `gh stack` there). It also refuses when it can't read the branch's pull request base, rather than guess `main`. It rebases onto `origin/main`, then runs what CI runs (build, Biome, lint, format, notices and `test:core`), and pushes with `--force-with-lease`. Pass `--no-push` to gate only.

**Why:** chaining the steps by hand (`git rebase … | tail && git push`) hides a failed step's exit code. That once pushed a conflicted rebase and a format failure.

## Hot files

A file that most changes must edit turns every pair of parallel changes into a conflict. Keep none:

- **No status documents or changelogs in the repository.** Progress lives in issues: a gap the work still owes is an issue (during a rewrite, labelled `cutover-gap`), and a milestone gate is "no such issue open". Release notes record changes.
- **One topic, one file.** The design is split by topic under `docs/reference/`, and a change edits only the topics it changes.
- **One unit, one module.** A CLI command is `core/src/commands/<name>.ts` (its options, help, check and implementation), a phase's step is its own module under `core/src/work/`, and the service tests are split by area in `core/test/` with shared setup in `helpers.mjs`. Add a file rather than grow a shared one.
- **Lists that every change adds to stay sorted,** such as the `RefusalCode` union. Two additions then land in different places instead of both appending at the end.

Find hot files at each checkpoint, and split whichever one is at the top:

```sh
git log --since="1 week ago" --name-only --format= -- core docs | sort | uniq -c | sort -rn | head
```

## Large refactors

Splitting a hot file or moving code between modules is a refactor stack.

1. **Freeze** new pull requests to the touched area until the stack lands. Then each lane rebases its open branches once.
2. **Generate each layer with a script, never by hand.** When `main` moves under the stack, re-run the script on the new `main` instead of resolving conflicts by hand.
3. **Prove each layer is a pure move,** and put the proof in its pull request.
4. **Land the stack** with `gh stack merge --yes` after one read of the proofs, and check that every layer merged.

### Prove a split

```sh
git worktree add --detach /tmp/before COMMIT_BELOW
git worktree add --detach /tmp/after LAYER_COMMIT
node scripts/split-proof.mjs /tmp/before /tmp/after core/src/cli.ts core/src/commands/
```

`scripts/split-proof.mjs` compares the paths before and after:

- **Code:** each top-level declaration's full text, doc comment included, is compared with formatting normalized away. Tests are keyed by title. A name declared in several files is matched by its text first, so a whole directory can be given.
- **Markdown:** compared as a multiset of lines, with links reduced to their anchors. A missing line fails. New lines (a new file's title, an index) are listed for review instead, so read them, and run a link check: the proof ignores link targets.
- **Output:** it prints what is identical, moved, removed, added or changed, with word-level hunks for each change, and exits 1 when a declaration differs or a Markdown line is missing.

A pure move shows nothing removed, added or changed. A layer that also makes small intended changes (such as a new parameter) shows exactly those hunks, and nothing else.

Where a layer moves entry points, also compare behaviour. Run the built CLI from both commits over its help and its usage refusals, and diff the output and exit codes.

**Why:** a reviewer can't read a 5,000-line move. The proof turns it into a short list of real changes, and it catches the errors that scripts make, such as a doc comment that landed in the wrong module.
