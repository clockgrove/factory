# Local mode

Factory's worker and reviewer, run on your own machine instead of a GitHub runner. Same task card, same skills, same exits, same GitHub state; only the sandbox differs. Use it when your tests need your machine (a database, a GPU, a big toolchain), when you want runs to bill your own harness login, or to try Factory before you install the App.

## What runs where

- The harness CLI (Claude Code, Codex or Copilot) runs on your machine on its own login. Every command the model runs goes through that harness's own sandbox: bubblewrap on Linux and WSL2, Seatbelt on macOS.
- Factory's own commands (setup, install, validation) run in `srt`, Anthropic's sandbox runtime, with the same reach as the model, since they run on a tree the model edited.
- In every sandbox:
  - **Credential stores are unreadable:** `~/.ssh`, `~/.aws`, `~/.config/gh`, the harness logins, `~/.config/factory`, and the rest.
  - **Writes are limited:** the Objective's clone, its stage directories and its own package caches (npm, pnpm) only. The clone's `.git/hooks`, `.git/config` and the stage's `bin` are read-only. `TMPDIR` and `XDG_RUNTIME_DIR` point at the stage's private temp directory.
  - **The network is limited:** GitHub and the npm registry, plus your `FACTORY_LOCAL_DOMAINS`.
- The model reaches GitHub with one fine-grained token for this one repository, never your `gh` login.
- Each Objective gets its own clone under `<your clone>/.factory/<issue>/`, which is git-excluded.
- GitHub holds all state. A claim comment with a heartbeat marks an Objective a local loop is running, so the Action and other loops leave it alone.
- Each local run writes its dollars into its progress comment, so the `daily_usd` cap counts local and Actions spend together, on any machine.

## Platforms

| Platform | Supported | Needs |
| --- | --- | --- |
| Linux, WSL2 | yes | `bubblewrap`, `socat`, `ripgrep`; for Copilot also `slirp4netns`, `iptables` |
| macOS | yes | `ripgrep` (Seatbelt is built in); no `FACTORY_LOCAL_DB` (its sandbox shares the machine's network) |
| Windows | inside WSL2 only | native Windows has no sandbox for the harness; local mode refuses and says so |

`node bench/sandbox-check.mjs` probes the sandbox on your machine for each harness and exits non-zero if any check fails.

## Set it up

1. Install `git`, `gh`, Node 22 or newer, the harness CLI you use (logged in), and `srt`: `npm i -g @anthropic-ai/sandbox-runtime`. Add the platform packages above, for example `sudo apt-get install -y bubblewrap socat ripgrep`.
2. Create a fine-grained token on GitHub (Settings, Developer settings, Fine-grained tokens):
   - **Repository access:** this one repository only.
   - **Permissions:** Contents, Issues and Pull requests read and write; Actions read.
   - **Optional, for the Project board:** when the repository belongs to an organization, make the organization the token's resource owner and add Organization permissions → Projects: Read and write. Local runs then move board cards the way the Action does; without it, labels carry the state and doctor says so.

   Save it with `mkdir -p ~/.config/factory/tokens/OWNER && (umask 077; read -rsp 'token: ' t && printf '%s' "$t" > ~/.config/factory/tokens/OWNER/NAME)`, or export `FACTORY_LOCAL_TOKEN`. Local mode refuses a classic token or `gh` login, and refuses a token that can write to any other repository.
3. For Copilot only: create a fine-grained token with the Copilot Requests permission (Read) from a user with a Copilot seat, and save it to `~/.config/factory/copilot-token`, or export `COPILOT_GITHUB_TOKEN`. Copilot's sandbox reads its policy from a home Factory owns, so your own `copilot login` is not used there.
4. Run it from a clone of the repository: `node <factory>/plugin/scripts/local.mjs serve`. On its first start it creates the `factory:local` label.

## Run it

```sh
node plugin/scripts/local.mjs serve [--once] [--all] [--interval 30]   # a loop: the dispatcher's rules, every 30 s
node plugin/scripts/local.mjs run <issue> [--wait]                     # one Objective, work then review (and, with --wait, to merged)
node plugin/scripts/local.mjs review <pr> [--wait]                     # a review re-run
```

- **Routing:** label an Objective `factory:local` and the local loop takes it, while the Action leaves it alone. `--all` (or `FACTORY_LOCAL_ALL=1`) takes every Objective.
- **Stopping:** stop `serve` with Ctrl-C. It ends its stages and releases their claims. An Objective left Running is Blocked by the dispatcher after 15 minutes, and re-applying its label brings it back.

## Configuration

Local mode reads the repository's `.github/workflows/factory.yml` `env:` block: harness, models, validation, protected paths, budgets. Your own environment wins for these:

| Variable | Effect |
| --- | --- |
| `FACTORY_HARNESS`, `FACTORY_MODEL`, `FACTORY_SUBAGENT_MODEL`, `FACTORY_REVIEWER_MODEL`, `FACTORY_EFFORT` | pick another harness or model; another harness drops the workflow's models for its own defaults |
| `FACTORY_RESUME_POLICY`, `FACTORY_COMPACTION_WINDOW` | the session settings, as on the Action |
| `FACTORY_LOCAL_DOMAINS` | more hosts the sandboxes may reach, space or comma separated |
| `FACTORY_LOCAL_ENV` | names of more variables the stage may see (the stage env is an allow-list, not your shell) |
| `FACTORY_LOCAL_SETUP` | the setup command for your machine (the workflow's assumes a fresh runner) |
| `FACTORY_LOCAL_DB=1`, `FACTORY_LOCAL_DB_INIT`, `FACTORY_PG_BIN` | a throwaway Postgres per validation command (below) |

## Databases

A sandbox has no route to the machine's services. With `FACTORY_LOCAL_DB=1` (Linux and WSL2), each validation command runs through `plugin/bin/factory-db`. It works in five steps:
1. starts a fresh Postgres on the sandbox's own loopback, with no unix socket;
2. runs `FACTORY_LOCAL_DB_INIT`, for example `psql -qc 'create extension if not exists vector'`;
3. sets `DATABASE_URL` and the `PG*` variables;
4. runs the command;
5. removes the database.

The task card tells the model to do the same. It needs the Postgres server binaries (`initdb`, `pg_ctl`). In local mode the validation commands run first and the required checks after, so the heavy suites run on your machine and CI stays light.

## Known limits

- Without the optional Projects permission, the token cannot move Project cards, so labels carry the state.
- `FACTORY_LOCAL_DB` is Linux and WSL2 only.
- Each Objective downloads its packages into its own caches, since a cache shared between Objectives would let one plant code in another. Your own caches are not used.
- Your default pnpm must be the version the repository pins in `packageManager` (pnpm 12.9 or newer): inside the sandbox pnpm can neither download nor switch to another version.
