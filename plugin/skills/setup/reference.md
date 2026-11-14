# Setup reference

## Landing the workflow file

The workflow does nothing until `.github/workflows/factory.yml` is on the default branch: its cron and its triggers start there. Land it through a pull request, so the repository's own checks and rules apply:

1. Start from the default branch as GitHub has it: `git fetch origin`, then `git switch -c setup-factory origin/<default branch>`. Never use a `factory/` branch name; those are Objectives' branches.
2. Stage that one file only (`git add .github/workflows/factory.yml`) and check `git status` shows nothing else staged. Commit it as `Add the Factory workflow`.
3. Push the branch and open the pull request: `gh pr create --title "Add the Factory workflow" --body-file <file>`. The body says, in a few lines: what Factory does (an issue labelled `factory:objective` becomes a merged pull request), what this file adds (the jobs and their triggers, never from a fork), the Action tag it pins, and that the cron starts once this merges.
4. A push GitHub refuses for the workflow scope is fixed by `gh auth refresh -s workflow`, run by the user; say so and try again after it.
5. Print the pull request's URL. Merging is the user's: do not merge it or turn on auto-merge unless they ask.

A re-render on an upgrade lands the same way, on a branch `upgrade-factory`, with the release notes linked in the body.
