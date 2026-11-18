# Setup reference

## Workflow settings

A first setup asks only the harness and its credential, the caps and auto-merge (SKILL.md); the rest take these defaults. After the file is written, list the ones it took as "You can change these later". Each changes later by a re-render, `--apply workflow --<flag> <value>`, landed by pull request like the first file; one with a variable also changes, with no pull request, by `gh variable set <variable> --body <value>` (anyone with write access can set one, so the others stay in the reviewed file). A re-render keeps the file's settings: pass only changes (`--name=` clears one), and show the kept and changed lines. The workflow never triggers from a fork.

| Flag | Default | Variable | What |
| --- | --- | --- | --- |
| `--harness` | `claude` | `PENDULUM_HARNESS` | The coding agent: `claude`, `codex` or `copilot`. |
| `--credential` | `api` | no | `api`, or `plan` for Claude on a subscription (Claude on a subscription, below). |
| `--model` | the harness's | `PENDULUM_MODEL` | The worker's model; an Objective's `pendulum:model:<id>` label overrides it. |
| `--subagent-model` | the harness's | `PENDULUM_SUBAGENT_MODEL` | The implementer sub-agents' model. |
| `--reviewer-model` | `--model`'s | `PENDULUM_REVIEWER_MODEL` | The reviewer's model. |
| `--max-usd` | `25` | `PENDULUM_MAX_USD` | The per-job dollar cap. |
| `--max-objective-usd` | none | `PENDULUM_MAX_OBJECTIVE_USD` | The dollar cap on one Objective across all its stages and parts; unset or 0 is no cap. |
| `--daily-usd` | `100` | `PENDULUM_DAILY_USD` | Nothing starts once today's spend passes it (UTC day). |
| `--max-concurrent` | `3` | `PENDULUM_MAX_CONCURRENT` | Worker jobs at once. |
| `--timeout-minutes` | `240` | `PENDULUM_TIMEOUT_MINUTES` | Each job's wall clock; under 360 on hosted runners; on Actions a variable can lower it, not raise it. |
| `--auto-merge` | `true` | no | `true`: Pendulum merges the reviewed head once its required checks pass, gated by CI, the reviewer and the merge queue, unread. `false`: its PRs wait for a person's merge. |
| `--publish-transcripts` | `false` | no | `false`: on a public repository the usage artifacts carry the agent's event stream and saved sessions sealed, so only the workflow's jobs open them (to resume a session). `true`: readable to anyone signed in to GitHub for 90 days (the files it read, the commands it ran, their output), and doctor warns. A private repository's carry them readable either way. |
| `--notify` | none | no | The GitHub handle Blocked and Question reach; setup pins it as `login#id`. |
| `--setup` | none | no | The toolchain command run before the worker. |
| `--install` | `auto` | no | `auto` installs from the lockfiles, `none`, or a command. |
| `--validation` | none | `PENDULUM_VALIDATION` | The validation commands, comma-separated. List the test runner among them as a command that takes a test file or filter, not only lint or a typecheck (`npm run lint, npx vitest run`): an answer round settles a finding by test only when a reply can name one of these commands with arguments that run one test; a reproduction in a reply's prose is never run. |
| `--budget-command` | none | no | The repository's test-budget command. |
| `--regenerate` | none | no | The command that writes the files `.gitattributes` marks `pendulum-generated`, in place; their rebase conflicts take the default branch's side and the command runs again. |
| `--protected-paths` | none | no | Paths added to the protected list; workers' commits may not touch them. |
| `--ci-checks` | none | no | The CI's required check names, also the protection step's; only this flag writes them into the workflow, and `--ci-checks=` clears them. Without it the protection step keeps the default branch's existing required checks, else requires none, and its preview lists candidates: the checks that passed on the latest pull request, else the job names of the workflows on pull_request, each marked when its workflow has no `merge_group` trigger (with a merge queue) or a `paths` filter. The user picks; pass exactly those. |
| `--node-version` | `22` | no | The Node.js the runner sets up; match your CI's. |
| `--time-zone` | the machine's in local mode, else UTC | `PENDULUM_TIME_ZONE` | The IANA zone (`America/Los_Angeles`) of the times Pendulum writes for people; an Objective's own zone line wins. |
| `--runs-on` | the CI's Linux runner | no | The work and review jobs' runner. |
| `--preset first-run` | none | no | `max_usd` 5, `max_concurrent` 1, `auto_merge` false; `daily_usd` stays at its own value ($100 by default); a flag beside it wins. A `PENDULUM_MAX_USD` or `PENDULUM_MAX_CONCURRENT` repository variable sets its value over the preset: setup warns of one. |
| `--sandbox vercel` | none | no | The cloud-sandbox jobs instead of runner jobs (Cloud sandbox, below). |

Raising the first-run preset later: `gh variable set PENDULUM_MAX_USD --body 25` and `gh variable set PENDULUM_MAX_CONCURRENT --body 3`, or a re-render with `--max-usd 25 --max-concurrent 3`; auto-merge only by a re-render with `--auto-merge true`.

## Model credentials

The user saves one with `gh secret set <name>`, pasting at the prompt (never `--body`, which leaves it in shell history): Claude `ANTHROPIC_API_KEY` (`CLAUDE_CODE_OAUTH_TOKEN` with `--credential plan`; none with workload identity federation); Codex `PENDULUM_CODEX_GATEWAY_KEY` (a Vercel AI Gateway key) or `CODEX_API_KEY`; Copilot `COPILOT_GITHUB_TOKEN`, a fine-grained token with only the Copilot Requests permission (doctor fails without it).

## The App

`--apply app` posts a pre-filled App, `Pendulum (<repo>)`, webhook off, with exactly: contents, pull requests, issues, projects: write; checks, commit statuses: read; actions: read, optional (cloud-sandbox logs and session restore); nothing else, never workflows. `--secret-scope org` saves its secrets as organization secrets shared with this repository only. If the browser cannot load the 127.0.0.1 address after Create, `curl` the address its page shows from setup's shell.

## Labels and board

These run as the App when the user exported `PENDULUM_APP_TOKEN`, or `PENDULUM_APP_ID` and `PENDULUM_APP_PRIVATE_KEY="$(cat <path>.pem)"`; never read the key.

## Landing the workflow file

The workflow does nothing until `.github/workflows/pendulum.yml` is on the default branch: its cron and its triggers start there. Land it through a pull request, so the repository's own checks and rules apply:

1. Start from the default branch as GitHub has it: `git fetch origin`, then `git switch -c setup-pendulum origin/<default branch>`. Never use a `pendulum/` branch name; those are Objectives' branches.
2. Stage that one file only (`git add .github/workflows/pendulum.yml`) and check `git status` shows nothing else staged. Commit it as `Add the Pendulum workflow`.
3. Push the branch and open the pull request: `gh pr create --title "Add the Pendulum workflow" --body-file <file>`. The body says, in a few lines: what Pendulum does (an issue labelled `pendulum:objective` becomes a merged pull request), what this file adds (the jobs and their triggers, never from a fork), the Action tag it pins, and that the cron starts once this merges.
4. A push GitHub refuses for the workflow scope is fixed by `gh auth refresh -s workflow`, run by the user; say so and try again after it.
5. Print the pull request's URL. Merging is the user's: do not merge it or turn on auto-merge unless they ask.

A re-render on an upgrade lands the same way, on a branch `upgrade-pendulum`, with the release notes linked in the body.

## The App by hand

When the user declines `--apply app` or it fails:

1. Open `https://github.com/settings/apps/new` (an organization's: `/organizations/<org>/settings/apps/new`). Name it `Pendulum (<repo>)`, uncheck webhooks, and grant exactly the permissions The App names. Projects is under Organization permissions, and a repository a user owns needs none (no App reaches a personal board); the rest are Repository permissions.
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

**GitHub Actions and the cloud sandbox.** To add an account ("add a second Claude account"):

1. Ask together: its name (lowercase letters, digits and hyphens, such as `claude-2`; another harness's as `codex:codex-2`), and whether to turn on automatic choice.
2. Preview `--apply workflow --add-account <name>`, with `--auto-account on` on a yes to automatic choice. Show its note: the accounts, each one's default, and each new secret to save. On a yes, write it with `--yes` and land it through a pull request as on first setup (After).
3. Name the secret the note gives: the harness's usual secret name, then `_` and the account's name upper-cased, each hyphen an underscore. For `claude-2` that is `ANTHROPIC_API_KEY_CLAUDE_2`, or `CLAUDE_CODE_OAUTH_TOKEN_CLAUDE_2` with `--credential plan`. For `codex-2` it is `CODEX_API_KEY_CODEX_2` or `PENDULUM_CODEX_GATEWAY_KEY_CODEX_2`, and for Copilot `COPILOT_GITHUB_TOKEN_<NAME>`. The user runs `gh secret set <NAME>` and pastes the value at its prompt, which does not echo it; never `--body`, which leaves it in shell history. Never ask for or read the value.
4. Once the pull request is merged, run the pendulum-doctor skill: it checks the declaration, that the workflow names each account's secret, and each secret by name.

To remove one, use `--remove-account <name>`; its note names the secrets the jobs no longer name, which the user may delete with `gh secret delete`. A stage on an account Blocks until its secret is saved. `--auto-account off` turns automatic choice off, and `--accounts '<JSON>'` sets the whole list. A re-render without these options keeps the file's accounts. Setup refuses a set the jobs would refuse, with the reason. What holds:

- Only the workflow file sets the accounts and automatic choice, never a repository variable, since they steer which credential a stage gets.
- An account named after its harness (`claude`) uses the usual secrets. A harness's first account is its default; adding to a harness with none keeps its usual account first.
- All Claude accounts use one credential kind, `--credential` (`api` or `plan`).
- A Codex ChatGPT login is refused on these routes (OpenAI advises an API key for CI): run that account in local mode.
- With automatic choice on, holds live as comments on Pendulum's own closed, locked holds issue, which Pendulum makes at the first usage limit; no other App permission is needed.

**Local mode** ([local.md](local.md), Several accounts):

- The user declares each account in `~/.config/pendulum/accounts.json`, on this machine only: a name and a Claude Code config folder or Codex home (`home`), or a Copilot `token_file` inside `~/.config/pendulum`. Show the example from [local.md](local.md); never open the file or a login in it.
- For automatic choice, the user starts `pendulum serve` with `PENDULUM_LOCAL_AUTO_ACCOUNT=1` in its shell. Only that shell sets it.
- Doctor with `--local` (the pendulum-doctor skill) checks each account by name: declared validly, owner-only, hidden from every sandbox, and logged in.

## Cloud sandbox

`--sandbox vercel` writes the cloud-sandbox jobs instead ([Cloud sandbox](https://github.com/clockgrove/pendulum/blob/v0.10.0/docs/ADAPTERS.md#cloud-sandbox)). The user saves `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` with `gh secret set`; only the launcher reads them. A stage's session is `timeout_minutes` plus about 16 minutes, up to the plan's cap (24 hours on Pro). Vercel bills the team for active CPU, provisioned memory, creations and snapshot storage; Pendulum books each stage's cost on the issue toward `daily_usd` and `max_usd`.
