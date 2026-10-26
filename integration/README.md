# Integration tests

Factory has two kinds of tests:

- **CI tests** (`npm test`, `test/`) are quick. They run the real `factory serve` on real Git repositories, processes and files, with no mocks and no GitHub.
- **Integration tests** (this directory) run real Objectives with real providers against scratch GitHub repositories, on demand, never in CI. They cover what needs real GitHub and real models to prove: delivery end to end, the queue, holds, sampled crash points, one installation per repository, a network cut and a killed model.

## Run

```sh
npm run build                                   # the suite runs dist/cli.js
npm run integration -- --dry-run                     # every case, what it checks, its minutes and the run's budget
npm run integration                                  # the main suite
npm run integration -- --suite edge                  # the edge suite: PRD requirements no main case covers
npm run integration -- --suite prd                   # the PRD suite: the requirements docs/PRD.md's Done still needs shown live
npm run integration -- --provider claude             # the main suite on Claude (default: --provider codex)
npm run integration -- --only claude,queue           # some cases
npm run integration -- --build ../other-checkout     # test another build (its dist/cli.js)
npm run integration -- --replay 2026-10-25T101058PDT --suite prd --only prod   # a kept run's checks again, nothing live
```

`--dry-run` is the one list of cases. Each case runs its own Objectives; every case of a suite starts at once and they run concurrently.

**Provider.** `--provider codex|claude` (default `codex`) is the run's default provider: every case except the cross-provider `claude` case runs on it, and the cases whose check is a planner decision use its `-plan` variant (`codex-plan` or `claude-plan`). The `codex` case (`happy.codex`, `stack.strict`, `model-kill.*`) is the chosen provider's end-to-end stack run, and `model-kill.*` kills that provider's own child: `codex` by its `--cd`, `claude` (the Agent SDK's native binary) by its working directory. The `claude` case (`happy.claude`, `queue.run-command`) runs `factory run N --provider` with the other one, so a Claude run proves Codex there. Dry runs and the results file name the provider. A minor version qualifies only when main, edge and prd pass on both (see [RELEASING.md](../docs/RELEASING.md)).

**Time limit.** A suite has 60 minutes of wall clock: at 55 minutes it stops its cases, cancels unsettled Objectives concurrently, then runs the end checks, cleanup and report. Each case also has its own budget, its minutes in the cases table (`--dry-run` shows them): its deadline is its start plus those minutes, never past the 55-minute stop, and every wait, CLI call and polling loop in the case ends there. A case out of time records its unfinished checks as failed or leaves them unrecorded (`incomplete.*`), as at the suite's stop, and its unsettled Objectives are cancelled; the other cases keep their time. A wait for an Objective to end returns at once (`held:<step>`) when it holds on a question the case's hold policy can't answer; waits that expect a question still return it. Remote calls share the suite's deadline. The crash lane advances through exact hooks against its budget, with time reserved for terminal checks.

**Results.** `/tmp/factory-integration-runs/results/<PDT timestamp>.md` has the total wall time, each case's start, end and duration, and every check with its result and evidence. The matching run directory holds serve logs, configurations, rendered Objectives and the journal. The suite exits 0 only when every selected check has exactly one PASS and every case completed. Failed, missing, duplicate or unreachable checks fail the run. Exit 1 means qualification failed, 2 means bad usage, and 3 means a prerequisite prevented a start.

**Replay.** `--replay RUN_ID` (with that run's `--suite`, and optionally `--only`) proves a check fixed in code in seconds instead of a new live run. It re-evaluates the kept run's checks with this checkout's code over what the run left in `/tmp/factory-integration/RUN_ID/` (state, logs) and `/tmp/factory-integration-runs/RUN_ID/` (issues, journal), and writes a new results file headed "Replay of RUN_ID" with the same check names. It creates no repository, starts no serve, runs no CLI command, makes no GitHub call and no model call, and changes nothing in the kept run. A replayable check is one function over those files that the live case calls too, so the two can't drift apart; a case's `replay_<case>` finds its Objectives in the kept `issues` file (in filing order) and journal and calls it:

- `model-kill.plan`, `model-kill.work`: the killed attempt's retry outcomes and charged errors (the attempt from the journal).
- `netcut.plan`, `netcut.ci`: holds after each cut, over the window the live check used (the journal's cut and restore lines, written from this change on; an older run's serve `cuts.log` has the cut itself, but not the moment the suite saw the restore, so it isn't used).
- `queue.order`, `queue.concurrency-3`, `exec.parallel-items`, `knowledge.memory`.
- `plan.discovery`: the worker amendment's plan and review, each work attempt (outcome, whether the worker left `.factory-discovery.json`, files it changed outside its owned paths, transcript), and whether the discovering item's kept base holds the person's test commit, which the case lands on main once the drained Objective's plan is accepted (its sha in the run's `discovery-person.N`, checked in the run's kept checkout).
- `prod.no-holds`, `queue.paths-take-turns`: their state part (holds, the turns, every Objective done). Their end checks read GitHub, so a replay can fail them but never pass them: a passing state part is NOT-REPLAYABLE.

Every other check is NOT-REPLAYABLE, never PASS: it reads live GitHub (PRs, comments, markers, cards, branch protection), drives the run (answers, crash points, the moment of a pause or a reset) or reads a command's exit. A replay reads the files as the run left them, after its own end-of-run cancellations, not as they stood when the live check ran. It exits 1 on any FAIL, and refuses (exit 2) a `--suite` other than the kept run's, which would find none of its lanes and pass empty.

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
