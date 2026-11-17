# Setup reference

## Landing the workflow file

The workflow does nothing until `.github/workflows/pendulum.yml` is on the default branch: its cron and its triggers start there. Land it through a pull request, so the repository's own checks and rules apply:

1. Start from the default branch as GitHub has it: `git fetch origin`, then `git switch -c setup-pendulum origin/<default branch>`. Never use a `pendulum/` branch name; those are Objectives' branches.
2. Stage that one file only (`git add .github/workflows/pendulum.yml`) and check `git status` shows nothing else staged. Commit it as `Add the Clockgrove Pendulum workflow`.
3. Push the branch and open the pull request: `gh pr create --title "Add the Clockgrove Pendulum workflow" --body-file <file>`. The body says, in a few lines: what Clockgrove Pendulum does (an issue labelled `pendulum:objective` becomes a merged pull request), what this file adds (the jobs and their triggers, never from a fork), the Action tag it pins, and that the cron starts once this merges.
4. A push GitHub refuses for the workflow scope is fixed by `gh auth refresh -s workflow`, run by the user; say so and try again after it.
5. Print the pull request's URL. Merging is the user's: do not merge it or turn on auto-merge unless they ask.

A re-render on an upgrade lands the same way, on a branch `upgrade-pendulum`, with the release notes linked in the body.

## The App by hand

When the user declines `--apply app` or it fails:

1. Open `https://github.com/settings/apps/new` (an organization's: `/organizations/<org>/settings/apps/new`). Name it `Pendulum (<repo>)`, uncheck webhooks, and grant exactly the permissions SKILL.md names. Projects is under Organization permissions, and a repository a user owns needs none (no App reaches a personal board); the rest are Repository permissions.
2. Create it, generate a private key, note the App ID.
3. Install it on this repository only.
4. The user saves the two secrets: `gh secret set PENDULUM_APP_ID` and `gh secret set PENDULUM_APP_PRIVATE_KEY < path.pem`, the path given as text.

## Claude on a subscription

When the user picks Claude and has no Anthropic API key, offer `--credential plan`: stages run on their Claude subscription (Pro, Max, Ultra, Team or Enterprise) through a `CLAUDE_CODE_OAUTH_TOKEN` secret. Say plainly: it is for their own repository only, never for a product; Pendulum does not check whose repository it is, every Objective in it runs on their subscription, and doctor warns of this on every check.

1. The user runs `claude setup-token` on their own machine: a browser sign-in, then a long-lived token printed to their terminal. Never run it, ask for the token or read it.
2. The user saves it with `gh secret set CLAUDE_CODE_OAUTH_TOKEN`, pasting at the prompt, which does not echo it (not `--body`, which leaves it in shell history).
3. Render the workflow with `--credential plan`; only the workflow file sets it. An `ANTHROPIC_API_KEY` secret beside it goes unused.

## Skills in the repository

Offer to commit the skills Pendulum's workers load and the agent definitions, which only vendors' cloud sessions need: copy the five worker and reviewer skill directories, whole, from `<plugin root>/skills/` (`pendulum-objective-plan`, `pendulum-implement-split`, `pendulum-prove-acceptance`, `pendulum-deliver-pr` and `pendulum-review-pr`; no other skill runs in a worker) to `.agents/skills/` and `.claude/skills/`, and `<plugin root>/agents/<harness>/*` to `.claude/agents/`, `.codex/agents/` or `.github/agents/`, then commit. Say plainly: committed copies override the plugin's and never update; copy again on every upgrade.

## Several accounts

Several subscriptions or keys of one harness can share the work as accounts. Each stage runs on one account for its whole run: its harness's default, or the one a trusted `pendulum:account:<name>` label pins. With automatic choice on, a stage with no pin starts on the free account with the most quota left instead (as Claude Code and Codex last reported it; Copilot reports none, so its accounts take turns): a usage limit sets aside only the account that met it, stages go on on the others, and that account comes back into use on its own. Automatic choice is off by default.

**GitHub Actions and the cloud sandbox:**

- Add the accounts to the workflow's env block, each harness's names in order, the first its default: `PENDULUM_ACCOUNTS: '{"claude": ["claude", "claude-2"]}'`. For automatic choice, add `PENDULUM_AUTO_ACCOUNT: "1"` beside it. Only the workflow file sets these, never a repository variable, since they steer which credential a stage gets. Then re-render the workflow: setup names each declared account's secrets in its jobs, so every change to `PENDULUM_ACCOUNTS` needs a re-render, which keeps both lines.
- Each account's credential is its own secret: the harness's usual secret name, then `_` and the account's name upper-cased, each hyphen an underscore (`claude-2`: `ANTHROPIC_API_KEY_CLAUDE_2`, or `CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2` with `--credential plan`; `codex-2`: `CODEX_API_KEY_CODEX_2` or `PENDULUM_CODEX_GATEWAY_KEY_CODEX_2`; Copilot: `COPILOT_GITHUB_TOKEN_<NAME>`). The user sets each with `gh secret set`. An account named after its harness (`claude`) uses the usual secrets.
- A Codex ChatGPT login is refused on these routes (OpenAI advises an API key for CI): run that account in local mode.
- With automatic choice on, holds live as comments on Pendulum's own closed, locked holds issue, which Pendulum makes at the first usage limit; no other App permission is needed.
- Doctor checks the declaration and each account's secret by name.

**Local mode** ([local.md](local.md), Several accounts):

- The user declares each account in `~/.config/pendulum/accounts.json`, on this machine only: a name and a Claude Code config folder or Codex home (`home`), or a Copilot `token_file` inside `~/.config/pendulum`. Show the example from [local.md](local.md); never open the file or a login in it.
- For automatic choice, the user starts `pendulum serve` with `PENDULUM_LOCAL_AUTO_ACCOUNT=1` in its shell. Only that shell sets it.
- Doctor with `--local` (the pendulum-doctor skill) checks each account by name: declared validly, owner-only, hidden from every sandbox, and logged in.

## Cloud sandbox

`--sandbox vercel` writes the cloud-sandbox jobs instead ([Cloud sandbox](https://github.com/clockgrove/pendulum/blob/v0.10.0/docs/ADAPTERS.md#cloud-sandbox)). The user saves `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` with `gh secret set`; only the launcher reads them. A stage's session is `timeout_minutes` plus about 16 minutes, up to the plan's cap (24 hours on Pro). Vercel bills the team for active CPU, provisioned memory, creations and snapshot storage; Pendulum books each stage's cost on the issue toward `daily_usd` and `max_usd`.
