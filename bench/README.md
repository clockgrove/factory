# Factory benchmarks

Replayable Objective benchmarks for testing and hill-climbing Factory: the same work, run the same way and scored the same way every time (#2200).

A benchmark replays a real Objective from its base commit in a fresh private test repository, with Factory's settings, memory, CI and rules as they were, and a scripted operator. Each run is scored into a JSON scorecard. Reports compare a run with the baseline, and a history page graphs the key metrics across runs and Factory versions with the spread of repeated runs.

```
bench/
  benchmarks/<id>.json        a benchmark definition (schema below)
  provision.mjs               set up one run: repository, Project, Factory, memory, Objective
  run.mjs                     follow the run to its end, applying the operator policy
  score.mjs                   score a run, or any Objective, into results/
  report.mjs                  run reports, the history page, the hill-climb decision
  results/<id>/<run id>.json  scorecards (committed)
  reports/<id>/               generated HTML and Markdown (not committed)
  lib/                        what the commands share
```

The scripts are plain Node. They use Factory's own build for what Factory already defines (child-thread accounting, the current plan, diagnostics), so run `npm run build` first.

## The loop

### 1. Provision

```sh
node bench/provision.mjs --benchmark clockgrove-800 --host ~/bench-host.json \
  --factory ~/.local/share/clockgrove-factory/bin/factory --dry-run
```

`--factory` is an installed Factory CLI (a release) or a Factory checkout with a build (a candidate: its branch and commit are recorded). `--dry-run` prints every GitHub, Git and setup action and does none. Without it, provisioning:

1. Fetches the Objective's issue and checks its title and body against the definition's `bodySha256`. The body is never stored in this repository.
2. Clones the source (no LFS smudge) into the host's cache and fetches the base commit and the base tree's LFS objects.
3. Creates the private test repository `<owner>/<namePrefix>-<run id>` with Actions off, applies the merge settings, pushes the base as `main` without the LFS pre-push hook, then pushes the base tree's LFS objects by id.
4. Mirrors the named rulesets and copies the named Actions variables from the source. Then it turns Actions on and disables every workflow except `keepWorkflows`, before anything can trigger them.
5. Clones the test repository for Factory.
6. Creates a Project with Factory's fields (Factory, Factory order, Factory admission), links it and creates the Objective's labels.
7. Runs `factory setup` with its own `FACTORY_CONFIG` and `FACTORY_STATE_DIR` under the run directory, never `~/.config/factory`.
8. Seeds repository memory as it stood before the Objective: a copy of the source's knowledge store without the Objective's entries or any made at or after `memory.before`.
9. Starts the background service (`setup --background`), files the Objective verbatim and checks the filed body against the digest.

Each step looks before it acts, so running provisioning again with the same `--run-id` carries on where it stopped. The run record, `<benchRoot>/<benchmark>/<run id>/run.json`, holds the repository, issue, Project, Factory (CLI, version, commit) and environment.

### 2. Run

```sh
node bench/run.mjs --run-dir <benchRoot>/clockgrove-800/<run id>
```

This queues the Objective and follows it. The operator policy answers by hold kind, always through `factory answer --as "<policy as>"`:

| Hold kind   | Asked when                                       | Policy                 |
| ----------- | ------------------------------------------------ | ---------------------- |
| `spend`     | a spend limit is reached                         | `more`                 |
| `allowance` | a repair, rereview or planning allowance ran out | `more`                 |
| `config`    | the configuration changed since admission        | `adopt`                |
| any other   | diagnosis, review, amendment, CI, QA, …          | pause for the operator |

A pause is recorded and printed, and `run.mjs` exits 2. Answer it with `node bench/run.mjs answer --run-dir DIR --question ID ANSWER [ARG] [--text-file F] [--as NAME]`, then run `run.mjs` again. `DIR/decisions.jsonl` records every decision (asked, answered, answer, by whom) and every time the service was seen down. When the Objective ends, the run is scored into `results/`.

### 3. Score

A harness run scores itself at its end, or with `node bench/score.mjs --run-dir DIR`. To score any Objective, for example one Factory ran outside the harness:

```sh
node bench/score.mjs --benchmark clockgrove-800 \
  --state-dir ~/.local/state/factory/clockgrove__clockgrove --issue 800 \
  --run-id clockgrove-800-backfill \
  --label "clockgrove#800, Factory 0.5.7→0.5.8, operator-assisted"
```

Scoring only reads, so a live service's state can be scored.

### 4. Report and compare

```sh
node bench/report.mjs --benchmark clockgrove-800            # every run's report and the history page
node bench/report.mjs compare --benchmark clockgrove-800 --candidate "Factory 0.6.0"
```

A run report is one self-contained HTML file (inline CSS and SVG, no network assets, light and dark) plus a Markdown summary. It has the headline numbers, the comparison with the baseline's spread, tokens per Work Item, a timeline with outages, pauses and holds, holds by kind, every operator decision, telemetry, and the checks against Factory's diagnostics. The history page plots each key metric per run, grouped by Factory build, with each group's median and min-to-max band.

## Hill-climb

1. **Baseline.** Run the current release N times (N ≥ 3) with the same `--group`. The definition's `baseline` names the group.
2. **Candidate.** Make one change on a branch, build it, and provision N runs with `--factory <checkout>` and one `--group` for the candidate.
3. **Compare.** `report.mjs compare` compares the candidate group's median with the baseline group's spread, metric by metric. Better or worse means beyond the baseline's whole range, from min to max. Inside it is noise.
4. **Accept** only when every primary metric (`hillClimb.primary`: total tokens and active wall time for clockgrove-800) is better and no guard (`hillClimb.guards`: done, repairs, holds for the operator, validation and CI pass rates) is worse. `compare` exits 0 on accept and 3 otherwise. It warns when either group has fewer than 3 runs: a single run's planner variance is larger than most effects.
5. An accepted candidate is released. Its runs become the next baseline: set `baseline` to their group.

**Cost.** One clockgrove-800 run costs about 60 to 100M tokens and 4 to 8 hours (`budget` in the definition). The spend cap is 200M, so a run never stops on the 25M limit #800 had to raise three times. A baseline and a candidate of 3 runs each cost about 360 to 600M tokens. Runs can overlap, since each has its own repository, service and state, but they share the host's capacity and the provider's rate limits, which then show in their times.

## Host profile

Machine-specific values stay out of the definition. Pass them with `--host FILE`:

```json
{
  "benchRoot": "/home/me/.local/state/factory-bench",
  "workDir": "/home/me/work/bench",
  "cacheDir": "/home/me/work/bench-cache",
  "sourceState": "/home/me/.local/state/factory",
  "toolchain": "/home/me/.local/opt/clockgrove-toolchain",
  "path": ["/home/me/.local/bin", "/usr/local/bin", "/usr/bin", "/bin"],
  "githubApp": { "id": "123456", "keyPath": "/path/to/app-key.pem" },
  "operator": "github-login"
}
```

`benchRoot` holds run directories, `workDir` the checkouts, `cacheDir` the source clones, and `sourceState` the Factory state memory is seeded from. `path` is the service's PATH; the definition's toolchain paths go first. Without `githubApp`, setup uses `--github-login`. `${name}` in a definition's Factory settings is the host's `name`.

## Definition schema

A definition is checked when it is loaded: `bench/lib/definition.mjs` names every field that is wrong.

| Field                                                               | Meaning                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                                                     | `1`                                                                                                                                                                                                                                                                                           |
| `id`, `title`                                                       | The benchmark's id (the file name) and a short name                                                                                                                                                                                                                                           |
| `source.repository`, `source.base`, `source.lfs`                    | The repository the Objective ran in, the full base commit, and whether to carry its LFS objects                                                                                                                                                                                               |
| `objective.issue`, `.title`, `.bodySha256`, `.labels`               | The Objective. Its body is fetched at provision time and must match the SHA-256                                                                                                                                                                                                               |
| `repository.owner`, `.namePrefix`, `.description`, `.mergeSettings` | The test repository: `<owner>/<namePrefix>-<run id>`, and GitHub's `allow_*`, `delete_branch_on_merge` and `has_*` settings                                                                                                                                                                   |
| `ci.rulesets`, `ci.variables`, `ci.keepWorkflows`                   | Rulesets mirrored and Actions variables copied from the source by name, and the only workflow files left enabled                                                                                                                                                                              |
| `memory.seed`, `memory.before`                                      | `before-objective`: the source's memory without the Objective's entries or any made at or after `before`; or `none`                                                                                                                                                                           |
| `factory`                                                           | Provider, planner, worker (`kind`, `model`, `effort`, codex `network`), planner and reviewer models, sandbox (network, read-only paths, environment), toolchain (paths, executables), format, required and CI-only commands, allowances and spend caps: each maps to a `factory setup` option |
| `operatorPolicy.as`, `.answers`, `.otherwise`                       | Who scripted answers are given as, the answer per hold kind, and `pause` for the rest                                                                                                                                                                                                         |
| `baseline`                                                          | The result group runs are compared with                                                                                                                                                                                                                                                       |
| `hillClimb.primary`, `hillClimb.guards`                             | Metric ids (`bench/lib/metrics.mjs`)                                                                                                                                                                                                                                                          |
| `budget.tokens`, `budget.hours`                                     | The expected cost per run, `[low, high]`                                                                                                                                                                                                                                                      |

## Scorecard

`results/<benchmark>/<run id>.json`, `schemaVersion` 1. It is built from the Objective's state, its run log, and Factory's diagnostics of it: the same `--summary` and `--analyze` JSON that `factory diagnostics ISSUE --all-runs` prints. A count the logs can't give is `null`, with the reason in `unavailable`. It is never 0.

- **`run`, `factory`, `models`, `startedAt`, `endedAt`, `outcome`.** The run's id, label, group and source. Factory's versions from the run headers, with the commit each release was tagged at (or a candidate's commit), and each run file and how it ended. Model calls by role, provider, model and effort. Admission to end, and `done`, `held`, `running` or `cancelled`.
- **`totals.wallMs`, `activeWallMs`, `outages`, `pauses`.** Wall time runs from admission to the end. An outage is the gap from one run file's last event to the next run file's first, a service restart. A pause runs from the operator's `pause` to `resume`. Both are listed, and both are left out of active time once, where they overlap.
- **`totals.modelMs`.** Summed over model calls, so parallel calls add up.
- **`totals.tokens`.**
  - `total` is a call's own tokens plus its child threads (Codex sub-agents). A resumed session's cumulative child usage counts only what it added: Factory's `ChildThreads`, #2168.
  - `own` and `childThreads` split it. `counted` is what that Factory version's spend limit counted: own tokens before 0.5.9, own and child threads since.
  - `input`, `cached`, `uncached`, `output` and `reasoning` break it down. `spendLedger` is the state's spend record. `unknownCalls` are calls that reported no count.
- **`totals.tokensPerCriterion`.** Total tokens over the current plan's acceptance criteria.
- **`totals.repairs`, `planning`, `amendments`.**
  - Repairs come from the state, which survives log rotation.
  - Planning counts its rounds. Revisions are counted as Factory's allowance counts them: each plan round, plus each amendment's planner answers.
  - Amendments are proposed, accepted, rejected or unchanged.
- **`totals.holds`.** Holds by kind, with wait (asked to answered). `scripted` holds are of a kind the policy answers. `operator` holds are the rest, and `operatorWaitMs` sums their waits.
- **`totals.validation`.** Factory's validate step runs and how many passed. Each run checks a new result, so `firstPassRate` is the share of results that passed on their first validation.
- **`totals.ci`.**
  - `published`: pushes of a result.
  - `rounds`: pushes and reruns.
  - `passedFirstTime`: pushes whose checks passed with no rerun, repair or hold.
  - `firstPassRate`: `passedFirstTime` over `published`.
- **`totals.final`.** Final validation runs and the final review.
- **`items[]`.** The same numbers per Work Item, plus `activeWallMs` from its first step to its merge. An amendment's calls count toward the Work Item whose worker proposed it. `objective` holds the calls of no Work Item.
- **`operator`.** Every hold with its kind, step, asked and answered times, answer, `by` and `as`. Also the other operator actions: pause, resume, decline-discovery.
- **`telemetry`.** The critical path, hedges, Factory's time breakdown, retries, validation commands, GitHub requests and cache rate per Work Item.
- **`checks`.** The scorecard's totals against Factory's diagnostics: tokens, child threads, calls, model time, holds, hold waits and repairs. Each one must agree.

## The baseline: Clockgrove #800

`results/clockgrove-800/clockgrove-800-backfill.json` scores #800 itself: three run files, Factory 0.5.7 and then 0.5.8, operator-assisted. Its headline numbers match the final post-mortem:

|                                                     | Post-mortem        | Scorecard                                          |
| --------------------------------------------------- | ------------------ | -------------------------------------------------- |
| Counted tokens                                      | 89.29M             | `tokens.counted` 89,291,214                        |
| Child threads, after the resumed-session correction | 16.88M             | `tokens.childThreads` 16,881,100                   |
| Repairs                                             | 25 (12, 11, 2)     | 25 (12, 11, 2, 0)                                  |
| Holds                                               | 38                 | 38 (23 for the operator, 15 of the policy's kinds) |
| Wall time, excluding the 0.5.8 pause                | 12 h 9 m, 8 h 34 m | 12 h 09 m, active 8 h 34 m                         |

Where the numbers differ, the scorecard is right:

- **The spend ledger.** The state records 89,227,422 tokens, 63,792 fewer than the log. That difference is the recorded-why call aborted by the first restart ("replaced"). Its tokens were logged, but the ledger never charged them. `tokens.spendLedger` keeps both numbers.
- **Child threads per Work Item.** The post-mortem's per-item table gave 3.85M and 9.78M child-thread tokens for living-scene and entity-selection. Those figures still counted each resumed session's cumulative children twice. Corrected, they are 3.35M and 8.71M; the 16.88M total was already corrected.
- **Waits.** The 3 h 35 m pause holds the second outage (65 s, the 0.5.8 restart), so it is excluded once. The first outage, 4 s at the network-host restart, is excluded too.

## Later

- A faster, cheaper tier for quick iterations, from the integration suite's per-case results.
- A second benchmark of a different shape, such as a backend-only Objective, so nothing gets tuned to one Objective.
- The 0.5.9 replay (`clockgrove/clockgrove-replay-800#1`), scored once it finishes as the first run of the `Factory 0.5.9` group.
