# Integration tests

Factory has two kinds of tests:

- **CI tests** (`npm run test:core`, `core/test/`) are quick. They run the real `factory serve` on real Git repositories, processes and files, with no mocks and no GitHub.
- **Integration tests** (this directory) run real Objectives with real providers against scratch GitHub repositories, on demand, never in CI. They cover what needs real GitHub and real models to prove: delivery end to end, the queue, holds, sampled crash points, one installation per repository, a network cut and a killed model.

## Run

```sh
npm run build:core                                   # the suite runs core/dist/cli.js
npm run integration -- --dry-run                     # every case, what it checks, its expected minutes and the budget
npm run integration                                  # the main suite
npm run integration -- --suite edge                  # the edge suite: PRD requirements no main case covers
npm run integration -- --only claude,queue           # some cases
npm run integration -- --build ../other-checkout     # test another build (its core/dist/cli.js)
```

`--dry-run` is the one list of cases. Each case runs its own Objectives; every case of a suite starts at once and they run concurrently.

**Time limit.** A suite enforces 60 minutes of wall clock itself: at 55 minutes it stops its cases, cancels every unsettled Objective, then runs the end checks, the cleanup and the report.

**Results.** `integration/.runs/results/<PDT timestamp>.md` has the total wall time, each case's start, end and duration, and every check with its result and evidence. `integration/.runs/<timestamp>/` holds serve logs, configurations, rendered Objectives and the journal; `.runs/` is gitignored. Results are PASS, FAIL or UNREACHABLE (the build lacks the feature, or the moment didn't come within the wave). The suite exits 0 when nothing failed, 1 on any FAIL, 2 on bad usage and 3 when it refuses to start.

## Prerequisites

- `clockgrove/factory-drill`: a small Node.js project whose CI runs `npm test`, with Git LFS, strict branch protection on main ("require branches to be up to date") and no required review. `fixtures/review-image.mjs` and `fixtures/repo/*.yml` are what its main holds.
- `clockgrove/factory-drill-2`: a second scratch repository; an empty one is filled from factory-drill's main at setup.
- Project "Factory drill" with Factory's single-select field `Factory`; both repositories queue on it.
- A `gh` login with admin on both repositories; Codex and Claude logins (subscription, no API key); `pasta` and `unshare` for the network namespace; `git-lfs`.

Each run makes fresh state directories under `~/work/suite60-state-<time>/` and writes its own configuration there: plumbing runs on the fastest model and lowest effort each provider offers, and the cases whose check is a planner decision use the production planner.

## Safety

- The suite refuses to start while any `cli.js serve` for a scratch repository runs.
- Processes are killed by exact PID after checking their start time, never by pattern. Children of a crashed serve are snapshotted while it runs and killed if they outlive it.
- The EXIT/INT/TERM trap stops the cases, cancels unsettled Objectives, stops serves and proxies, checks the end state (factory-drill named factory-drill, no required review, no open PR, no serve or Factory unit left) and writes the results.
- Branch protection is never changed. The fault proxy (`lib/gh-fault-proxy.mjs`) never logs headers or bodies; every secret the suite uses is a generated dummy. The suite never reads credential files or other processes' environments.

## Layout

- `run-suite.sh`: the cases table, setup, the wave, the 55-minute stop, cleanup and the results.
- `cases/main.sh`: the cases on factory-drill's shared serve. `cases/crash.sh`: the factory-drill-2 lane. `cases/edge.sh`: the edge suite.
- `lib/common.sh`: installations, results, CLI, answers, waits, proxy rules, templates. `lib/serve.sh`: serves. `lib/gh.sh`: the Project, markers, PRs and end checks. `lib/st.py` reads state and run logs by structure only. `lib/crashpoints.mjs` finds a build's `crashPoint()` sites. `lib/netns-serve.sh` runs a serve in a network namespace.
- `objectives/`: Objective templates. `fixtures/`: files the scratch repository uses.
