# Routes off this machine, and moving between them

Asked what running off this machine takes, name all three:

- **The Action.** `.github/workflows/pendulum.yml` from `/pendulum:pendulum-setup`, the App's two secrets and a model credential. Jobs run on GitHub's runners (`timeout_minutes` under 360 on hosted ones) and open the PR; `--auto-merge` lands it, through a merge queue where GitHub offers one. Tests needing the user's machine (a database, a GPU) need a self-hosted runner (`--runs-on`) or local mode.
- **The cloud sandbox.** The same, rendered with `setup --sandbox vercel`, plus the `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` secrets. Each Objective gets a Vercel sandbox from an image the repository's `setup` command builds (no Dockerfile, no systemd); short Action jobs start each stage there; PRs land as on the Action. A stage's session is `timeout_minutes` plus about 16 minutes, up to the plan's cap (24 hours on Vercel Pro). Vercel bills the team; Pendulum books each stage's sandbox cost on the issue toward `daily_usd` and `max_usd` ([Cloud sandbox](https://github.com/clockgrove/pendulum/blob/v0.10.0/docs/ADAPTERS.md#cloud-sandbox)).
- **The harness cloud.** A scheduled session of the user's harness on their plan; it opens no PR (below).

## Moving an Objective between local and the Action

The `pendulum:local` label routes it: with it `pendulum serve` takes the Objective and the Action leaves it alone; without it the Action's next tick takes it (sooner by a dispatch, on the user's yes: SKILL.md). Move it between stages, not while one runs.

# Preview the picks

The exact preview is the dispatcher's own dry run, the one way to run that script from a session (a real run here marks issues Running with no worker job to run them): `node "<plugin root>/scripts/dispatch.mjs" --repo OWNER/NAME --dry-run`. It mints the App's installation token, so it needs the App's credentials in the user's own shell, as doctor's GitHub checks do: `PENDULUM_APP_TOKEN`, or `PENDULUM_APP_ID` and `PENDULUM_APP_PRIVATE_KEY="$(cat <path>.pem)"`; never read the key. It takes its caps from that shell's `PENDULUM_*` variables, not the workflow, so export the values the workflow sets first, or say its picks assume the defaults.

Without the App's credentials, list the candidates with `gh issue list --repo OWNER/NAME --label pendulum:objective --state open --json number,title,labels` and drop those labelled `pendulum:draft`, `pendulum:running`, `pendulum:in-review`, `pendulum:blocked` or `pendulum:question`. Say the list is approximate: it does not apply the blocking issues, the priority order or the caps.
