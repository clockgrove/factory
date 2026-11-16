# Setup reference

## Landing the workflow file

The workflow does nothing until `.github/workflows/factory.yml` is on the default branch: its cron and its triggers start there. Land it through a pull request, so the repository's own checks and rules apply:

1. Start from the default branch as GitHub has it: `git fetch origin`, then `git switch -c setup-factory origin/<default branch>`. Never use a `factory/` branch name; those are Objectives' branches.
2. Stage that one file only (`git add .github/workflows/factory.yml`) and check `git status` shows nothing else staged. Commit it as `Add the Clockgrove Factory workflow`.
3. Push the branch and open the pull request: `gh pr create --title "Add the Clockgrove Factory workflow" --body-file <file>`. The body says, in a few lines: what Clockgrove Factory does (an issue labelled `factory:objective` becomes a merged pull request), what this file adds (the jobs and their triggers, never from a fork), the Action tag it pins, and that the cron starts once this merges.
4. A push GitHub refuses for the workflow scope is fixed by `gh auth refresh -s workflow`, run by the user; say so and try again after it.
5. Print the pull request's URL. Merging is the user's: do not merge it or turn on auto-merge unless they ask.

A re-render on an upgrade lands the same way, on a branch `upgrade-factory`, with the release notes linked in the body.

## Skills in the repository

Offer to commit the Factory skills and agent definitions, which only vendors' cloud sessions need: copy this plugin's `skills/*` to `.agents/skills/` and `.claude/skills/`, and `agents/<harness>/*` to `.claude/agents/`, `.codex/agents/` or `.github/agents/`, then commit. Say plainly: committed copies override the plugin's and never update; copy again on every upgrade.

## Several accounts

Several subscriptions or keys of one harness can share the work as accounts. Each stage runs on one account for its whole run: its harness's default, or the one a trusted `factory:account:<name>` label pins. With automatic choice on, a stage with no pin starts on the free account with the most quota left instead (as Claude Code and Codex last reported it; Copilot reports none, so its accounts take turns): a usage limit sets aside only the account that met it, stages go on on the others, and that account comes back into use on its own. Automatic choice is off by default.

**GitHub Actions and the cloud sandbox:**

- Add the accounts to the workflow's env block, each harness's names in order, the first its default: `FACTORY_ACCOUNTS: '{"claude": ["claude", "claude-2"]}'`. For automatic choice, add `FACTORY_AUTO_ACCOUNT: "1"` beside it. Only the workflow file sets these, never a repository variable, since they steer which credential a stage gets. Then re-render the workflow: setup names each declared account's secrets in its jobs, so every change to `FACTORY_ACCOUNTS` needs a re-render, which keeps both lines.
- Each account's credential is its own secret: the harness's usual secret name, then `_` and the account's name upper-cased, each hyphen an underscore (`claude-2`: `ANTHROPIC_API_KEY_CLAUDE_2`, or `CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2` with `--credential plan`; `codex-2`: `CODEX_API_KEY_CODEX_2` or `FACTORY_CODEX_GATEWAY_KEY_CODEX_2`; Copilot: `COPILOT_GITHUB_TOKEN_<NAME>`). The user sets each with `gh secret set`. An account named after its harness (`claude`) uses the usual secrets.
- A Codex ChatGPT login is refused on these routes (OpenAI advises an API key for CI): run that account in local mode.
- With automatic choice on, holds live as comments on Factory's own closed, locked holds issue, which Factory makes at the first usage limit; no other App permission is needed.
- Doctor checks the declaration and each account's secret by name.

**Local mode** ([local.md](local.md), Several accounts):

- The user declares each account in `~/.config/factory/accounts.json`, on this machine only: a name and a Claude Code config folder or Codex home (`home`), or a Copilot `token_file` inside `~/.config/factory`. Show the example from [local.md](local.md); never open the file or a login in it.
- For automatic choice, the user starts `factory serve` with `FACTORY_LOCAL_AUTO_ACCOUNT=1` in its shell. Only that shell sets it.
- Doctor with `--local` (the factory-doctor skill) checks each account by name: declared validly, owner-only, hidden from every sandbox, and logged in.
