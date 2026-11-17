# Routes off this machine, and moving between them

Asked what running off this machine takes, name all three:

- **The Action.** `.github/workflows/factory.yml` from `/factory:factory-setup`, the App's two secrets and a model credential. Jobs run on GitHub's runners (`timeout_minutes` under 360 on hosted ones) and open the PR; `--auto-merge` lands it, through a merge queue where GitHub offers one. Tests needing the user's machine (a database, a GPU) need a self-hosted runner (`--runs-on`) or local mode.
- **The cloud sandbox.** The same, rendered with `setup --sandbox vercel`, plus the `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` secrets. Each Objective gets a Vercel sandbox from an image the repository's `setup` command builds (no Dockerfile, no systemd); short Action jobs start each stage there; PRs land as on the Action. A stage's session is `timeout_minutes` plus about 16 minutes, up to the plan's cap (24 hours on Vercel Pro). Vercel bills the team; Factory books each stage's sandbox cost on the issue toward `daily_usd` and `max_usd` ([Cloud sandbox](https://github.com/clockgrove/factory/blob/v0.9.37/docs/ADAPTERS.md#cloud-sandbox)).
- **The harness cloud.** A scheduled session of the user's harness on their plan; it opens no PR (below).

## Moving an Objective between local and the Action

The `factory:local` label routes it: with it `factory serve` takes the Objective and the Action leaves it alone; without it the Action's next tick takes it (sooner by a dispatch, on the user's yes: SKILL.md). Move it between stages, not while one runs.

