# Integration tests

Factory has two kinds of tests:

- **CI tests** (`npm test`, `test/`) are quick. They run the real `factory serve` on real Git repositories, processes and files, with no mocks and no GitHub.
- **Integration tests** (this directory) run real Objectives with real providers against scratch GitHub repositories, on demand, never in CI. They cover what needs real GitHub and real models to prove: delivery end to end, the queue, holds, sampled crash points, one installation per repository, a network cut and a killed model.

## Run

```sh
npm run build                                   # the suite runs dist/cli.js
npm run integration -- --dry-run                     # every case, what it checks, its expected minutes and the budget
npm run integration                                  # the main suite
npm run integration -- --suite edge                  # the edge suite: PRD requirements no main case covers
npm run integration -- --suite prd                   # the PRD suite: the requirements docs/PRD.md's Done still needs shown live
npm run integration -- --only claude,queue           # some cases
npm run integration -- --build ../other-checkout     # test another build (its dist/cli.js)
```

`--dry-run` is the one list of cases. Each case runs its own Objectives; every case of a suite starts at once and they run concurrently.

**Time limit.** A suite has 60 minutes of wall clock: at 55 minutes it stops its cases, cancels unsettled Objectives concurrently, then runs the end checks, cleanup and report. CLI and remote calls share the deadline. The crash lane advances through exact hooks against one shared deadline, with time reserved for terminal checks.

**Results.** `/tmp/factory-integration-runs/results/<PDT timestamp>.md` has the total wall time, each case's start, end and duration, and every check with its result and evidence. The matching run directory holds serve logs, configurations, rendered Objectives and the journal. The suite exits 0 only when every selected check has exactly one PASS and every case completed. Failed, missing, duplicate or unreachable checks fail the run. Exit 1 means qualification failed, 2 means bad usage, and 3 means a prerequisite prevented a start.

## Prerequisites

- No standing scratch repository. Each run creates its own private repositories under the scratch owner (`REPO_OWNER` in `run-suite.sh`), `fd-<time>-m` (installation M, or E in the edge suite) and, in the main suite, `fd-<time>-c` (the crash lane). Each one's main is `fixtures/baseline/` as one commit: a small Node.js project whose CI runs `npm test`, Git LFS rules for media, strict branch protection on main ("require branches to be up to date", check `test`) and no required review. A passing run deletes them; a failed run keeps them to inspect (as does `--keep-repos`), and a later run deletes those after 24 hours.
- Project "Factory drill" with Factory's single-select field `Factory` and number field `Factory order`: repository M queues on it. One installation serves a Project, so each run that needs repository C also creates a Project for it, with the same two fields, titled like its repositories and deleted with them.
- A `gh` login that is an owner of the scratch owner organization, with the `delete_repo` scope (`gh auth refresh -s delete_repo`); Codex and Claude logins (subscription, no API key); `pasta` and `unshare` for the network namespace; `git-lfs`.
- For the prd suite: systemd user services (its `prod` case runs repository C's installation with `factory setup --background` at production models and concurrency, then uninstalls it), `curl`, and the Project's `Factory order` number field. Lane Q queues on repository C's own Project, which the run creates. Its setup commits `fixtures/repo/drill-issue.yml`, `drill-comment.yml` (to file issues and comments as github-actions[bot], a non-writer) and `ROADMAP.md` (for `propose --source`) to repository M's main.

Each run makes fresh state directories under `/tmp/factory-integration/<time>/` and writes its own configuration there. An existing `--state-base` is refused. Plumbing runs on the fastest model and lowest effort each provider offers, and the cases whose check is a planner decision use the production planner.

## Safety

- The suite refuses to start while any `cli.js serve` for a scratch repository runs.
- Processes are killed by exact PID after checking their start time, never by pattern. Children of a crashed serve are snapshotted while it runs and killed if they outlive it.
- The EXIT/INT/TERM trap stops the cases, cancels unsettled Objectives, stops serves and proxies, checks the end state (the repository keeps its name, no required review, no open PR, no serve or Factory unit left), deletes the run's repositories when it passed, and writes the results.
- The suite deletes only a repository whose description starts with "Factory integration run (transient)", the mark it gives the ones it creates, and changes branch protection only on those. The fault proxy (`lib/gh-fault-proxy.mjs`) never logs headers or bodies; every secret the suite uses is a generated dummy. The suite never reads credential files or other processes' environments.

## Layout

- `run-suite.sh`: the cases table, setup, the wave, the 55-minute stop, cleanup and the results.
- `cases/main.sh`: the cases on repository M's shared serve. `cases/crash.sh`: the repository C lane. `cases/edge.sh`: the edge suite. `cases/prd.sh`: the PRD suite (lane P on repository M, lane Q on repository C at production settings).
- `lib/common.sh`: installations, results, CLI, answers, waits, proxy rules, templates. `lib/serve.sh`: serves. `lib/gh.sh`: the Project, markers, PRs and end checks. `lib/repos.sh`: the run's repositories (create, delete, sweep). `lib/st.py` reads state and run logs by structure only. `lib/crashpoints.mjs` finds a build's `crashPoint()` sites. `lib/netns-serve.sh` runs a serve in a network namespace.
- `objectives/`: Objective templates. `fixtures/baseline/`: the run repositories' starting tree.
