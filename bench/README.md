# Factory benchmarks

Replayable Objective benchmarks for testing and hill-climbing Factory: the same work, run the same way and scored the same way every time (#2200).

A benchmark replays a real Objective from its base commit in a fresh private test repository, with Factory's settings, memory, CI and rules as they were, and a scripted operator. Each run is scored into a JSON scorecard. Reports compare a run with the baseline, and a history page graphs the key metrics across runs and Factory versions with the spread of repeated runs.

```
bench/
  provision.mjs               set up one run: repository, Project, Factory, memory, Objective
  run.mjs                     follow the run to its end, applying the operator policy
  score.mjs                   score a run, or any Objective, into the results
  report.mjs                  run reports, the history page, the hill-climb decision
  examples/acme-widgets-42.json  an invented definition (schema below)
  lib/                        what the commands share
```

The scripts are plain Node. They use Factory's own build for what Factory already defines (child-thread accounting, the current plan, diagnostics), so run `npm run build` first.

## Where a benchmark's data lives

Not in this repository. A benchmark replays a real Objective of some repository, so its definition, its scorecards and its reports belong with that repository's owner, usually in a private repository of their own. A bench home holds them:

```
<bench home>/
  benchmarks/<id>.json        a benchmark definition (schema below)
  results/<id>/<run id>.json  scorecards
  reports/<id>/               generated HTML and Markdown
  private-words.txt           optional: words this repository must never contain
```

Every command takes `--bench-home DIR`, or `--benchmarks DIR` and `--results DIR` separately. Without them it reads `FACTORY_BENCH_HOME`, and with none of these it refuses: nothing is read from or written into this repository by default. `--benchmark` takes a definition's id (looked up in the definitions directory) or a path to its file. `bench/benchmarks/`, `bench/results/` and `bench/reports/` are gitignored, so a stray copy is never committed.

`test/bench-public.test.mjs` keeps a benchmark's private data out of this repository. It is an allow-list: every repository, issue, date and commit that `bench/`, its fixtures and the bench tests name must be an invented one (`acme/widgets#42`, dates in 2031) or Factory's own. With `FACTORY_BENCH_HOME` set, it also fails on any word in the home's `private-words.txt` (one per line, `#` comments): the names of the private repository, its Work Items and its people, which this repository never spells out.

## The loop

The examples use the invented definition, `acme-widgets-42`, in a bench home:

```sh
export FACTORY_BENCH_HOME=~/bench-home
```

### 1. Provision

```sh
node bench/provision.mjs --benchmark acme-widgets-42 --host ~/bench-host.json \
  --factory ~/.local/share/factory/bin/factory --dry-run
```

`--factory` is a Factory checkout, or the path of a Factory CLI. The kind comes from where the build lives. A package root that is a Git work tree (not under `node_modules`) is a candidate, recorded with its commit, branch and whether it has uncommitted changes, whether you pass the checkout or its `dist/cli.js`. Anything else, such as an installed package, is a release. `dist/` is gitignored, so the commit doesn't say which build ran: the run record also keeps `distSha256`, a digest of the build's `dist/`. Scoring computes it again and names a changed build in the scorecard's gaps. Don't rebuild a checkout while a run uses it. `--dry-run` prints every GitHub, Git and setup action and does none. Without it, provisioning:

1. Fetches the Objective's issue and checks its title and body against the definition's `bodySha256`. The body is never stored in the definition.
2. Clones the source (no LFS smudge) into the host's cache and fetches the base commit and the base tree's LFS objects.
3. Creates the private test repository `<owner>/<namePrefix>-<run id>` with Actions off, applies the merge settings, pushes the base as `main` without the LFS pre-push hook, then pushes the base tree's LFS objects by id.
4. Mirrors the named rulesets and copies the named Actions variables from the source. Then it turns Actions on and disables every workflow except `keepWorkflows`, before anything can trigger them. The workflow listing must succeed and must name every `.github/workflows/*.yml` of the base tree. After disabling, the workflows are listed again, and only kept ones may be active. If any of this fails, Actions is turned off again and provisioning stops.
5. Clones the test repository for Factory.
6. Creates a Project with Factory's fields (Factory, Factory order, Factory admission), links it and creates the Objective's labels.
7. Runs `factory setup` with its own `FACTORY_CONFIG` and `FACTORY_STATE_DIR` under the run directory, never `~/.config/factory`.
8. Seeds repository memory as it stood before the Objective: a copy of the source's knowledge store without the Objective's entries or any made at or after the instant `memory.before`.
9. Starts the background service (`setup --background`), files the Objective verbatim and checks the filed body against the digest.

Each step looks before it acts, so running provisioning again with the same `--run-id` carries on where it stopped. The run record, `<benchRoot>/<benchmark>/<run id>/run.json`, holds the repository, issue, Project, Factory (CLI, version, commit), environment, the definition file it ran and the results directory the run is scored into. Provisioning refuses before creating anything when no results directory is given.

### 2. Run

```sh
node bench/run.mjs --run-dir <benchRoot>/acme-widgets-42/<run id>
```

This queues the Objective and follows it. `factory run` follows the Objective itself once it asks the service to run it, so `run.mjs` stops it, as Ctrl-C would, once `factory status` shows the Objective admitted, and follows with `factory status`. Its "Queued #N" line comes before the service admits or refuses the request, so it isn't taken as queued. While the service isn't running nothing is queued: `run.mjs` says so and exits 75; start the service and run it again. A request the service refuses, or doesn't admit in 10 minutes, exits 1 without recording the run as queued; run it again once the cause is fixed. A status that fails while following, such as during a restart, counts as the service seen down and is tried again. The operator policy answers by hold kind, always through `factory answer --as "<policy as>"`:

| Hold kind   | Asked when                                       | Policy                 |
| ----------- | ------------------------------------------------ | ---------------------- |
| `spend`     | a spend limit is reached                         | `more`                 |
| `allowance` | a repair, rereview or planning allowance ran out | `more`                 |
| `config`    | the configuration changed since admission        | `adopt`                |
| any other   | diagnosis, review, amendment, CI, QA, …          | pause for the operator |

These three are the only answers a policy may script. A definition that scripts any other kind or answer, such as `accept` or `cancel`, is refused, and the follower never gives one.

A pause is recorded and printed, and `run.mjs` exits 2. A scripted answer Factory refuses is recorded too; if its hold is still open at the next look, it pauses for the operator. Answer it with `node bench/run.mjs answer --run-dir DIR --question ID ANSWER [ARG] [--text-file F] [--as NAME]`, then run `run.mjs` again. `DIR/decisions.jsonl` records every decision (asked, answered, answer, by whom) and every time the service was seen down. When the Objective ends, the run is scored into the results directory the run record names, unless `--results DIR` or `--bench-home DIR` is given. An exported `FACTORY_BENCH_HOME` is used only for a record that names none, never over it.

### 3. Score

A harness run scores itself at its end, or with `node bench/score.mjs --run-dir DIR` into the same results directory as `run.mjs`. To score any Objective, for example one Factory ran outside the harness:

```sh
node bench/score.mjs --benchmark acme-widgets-42 \
  --state-dir ~/.local/state/factory/acme__widgets --issue 42 \
  --run-id acme-widgets-42-backfill \
  --label "acme/widgets#42, Factory 0.5.7→0.5.8, operator-assisted"
```

Scoring only reads, so a live service's state can be scored. An Objective that hasn't ended scores a partial card (`partial: true`): its totals are lower only because the run is unfinished. `score.mjs` doesn't write a partial card into the results. Use `--print` or `--out FILE` to see one.

### 4. Report and compare

```sh
node bench/report.mjs --benchmark acme-widgets-42            # every run's report and the history page
node bench/report.mjs compare --benchmark acme-widgets-42 --candidate "Factory 0.6.0"
```

A run report is one self-contained HTML file (inline CSS and SVG, no network assets, light and dark) plus a Markdown summary, written to the bench home's `reports/<id>/` (or `--out DIR`). It has the headline numbers, the comparison with the baseline's spread, tokens per Work Item, a timeline with the excluded time and holds, holds by kind, every operator decision, telemetry, and the checks against Factory's diagnostics. The history page plots each key metric per run, grouped by Factory build, with each group's median and min-to-max band.

A partial card in the results is reported and plotted, marked "partial" and drawn as a hollow dot. It is left out of its group's spread and out of every comparison, and `compare` warns about it. A card of an older scorecard version is left out with a warning: score it again.

## Hill-climb

1. **Baseline.** Run the current release N times (N ≥ 3) with the same `--group`. The definition's `baseline` names the group.
2. **Candidate.** Make one change on a branch, build it, and provision N runs with `--factory <checkout>` and one `--group` for the candidate.
3. **Compare.** `report.mjs compare` compares the candidate group's median with the baseline group's spread, metric by metric. Better or worse means beyond the baseline's whole range, from min to max. Inside it is noise.
4. **Accept** only when every primary metric (`hillClimb.primary`, such as total tokens and active wall time) is better and no guard (`hillClimb.guards`, such as done, repairs, holds for the operator, validation and CI pass rates) is worse. `compare` exits 0 on accept and 3 otherwise. It warns when either group has fewer than 3 runs: a single run's planner variance is larger than most effects.
5. An accepted candidate is released. Its runs become the next baseline: set `baseline` to their group.

**Cost.** A definition's `budget` gives one run's expected tokens and hours. Set its spend cap well above that, so a run never stops on a limit the original Objective had to raise. A baseline and a candidate of 3 runs each cost six runs' budget. Runs can overlap, since each has its own repository, service and state, but they share the host's capacity and the provider's rate limits, which then show in their times.

## Host profile

Machine-specific values stay out of the definition. Pass them with `--host FILE`:

```json
{
  "benchRoot": "/home/me/.local/state/factory-bench",
  "workDir": "/home/me/work/bench",
  "cacheDir": "/home/me/work/bench-cache",
  "sourceState": "/home/me/.local/state/factory",
  "toolchain": "/home/me/.local/opt/toolchain",
  "path": ["/home/me/.local/bin", "/usr/local/bin", "/usr/bin", "/bin"],
  "githubApp": { "id": "123456", "keyPath": "/path/to/app-key.pem" },
  "operator": "github-login"
}
```

`benchRoot` holds run directories, `workDir` the checkouts, `cacheDir` the source clones, and `sourceState` the Factory state memory is seeded from. `path` is the service's PATH; the definition's toolchain paths go first. Without `githubApp`, setup uses `--github-login`. `${name}` in a definition's Factory settings is the host's `name`.

## Definition schema

A definition is checked when it is loaded: `bench/lib/definition.mjs` names every field that is wrong. A field the schema doesn't have, such as a misspelled optional one, is refused too. `bench/examples/acme-widgets-42.json` has every field.

| Field                                                               | Meaning                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                                                     | `1`                                                                                                                                                                                                                                                                                           |
| `id`, `title`                                                       | The benchmark's id (the file name) and a short name                                                                                                                                                                                                                                           |
| `source.repository`, `source.base`, `source.lfs`                    | The repository the Objective ran in, the full base commit, and whether to carry its LFS objects                                                                                                                                                                                               |
| `objective.issue`, `.title`, `.bodySha256`, `.labels`               | The Objective. Its body is fetched at provision time and must match the SHA-256                                                                                                                                                                                                               |
| `repository.owner`, `.namePrefix`, `.description`, `.mergeSettings` | The test repository: `<owner>/<namePrefix>-<run id>`, and GitHub's `allow_*`, `delete_branch_on_merge` and `has_*` settings                                                                                                                                                                   |
| `ci.rulesets`, `ci.variables`, `ci.keepWorkflows`                   | Rulesets mirrored and Actions variables copied from the source by name, and the only workflow files left enabled                                                                                                                                                                              |
| `memory.seed`, `memory.before`                                      | `before-objective`: the source's memory without the Objective's entries or any made at or after `before`, a UTC time written `YYYY-MM-DDTHH:MM:SS[.mmm]Z`; or `none`                                                                                                                          |
| `factory`                                                           | Provider, planner, worker (`kind`, `model`, `effort`, codex `network`), planner and reviewer models, sandbox (network, read-only paths, environment), toolchain (paths, executables), format, required and CI-only commands, allowances and spend caps: each maps to a `factory setup` option |
| `operatorPolicy.as`, `.answers`, `.otherwise`                       | Who scripted answers are given as, the answer per hold kind (only `spend: more`, `allowance: more`, `config: adopt`), and `pause` for the rest                                                                                                                                                |
| `baseline`                                                          | The result group runs are compared with                                                                                                                                                                                                                                                       |
| `hillClimb.primary`, `hillClimb.guards`                             | Metric ids (`bench/lib/metrics.mjs`)                                                                                                                                                                                                                                                          |
| `budget.tokens`, `budget.hours`                                     | The expected cost per run, `[low, high]`                                                                                                                                                                                                                                                      |

## Scorecard

`<results>/<benchmark>/<run id>.json`, `schemaVersion` 2. It is built from the Objective's state, its run log, and Factory's diagnostics of it: the same `--summary` and `--analyze` JSON that `factory diagnostics ISSUE --all-runs` prints. A count the logs can't give is `null`, with the reason in `unavailable`. It is never 0.

- **`run`, `factory`, `models`, `startedAt`, `endedAt`, `outcome`, `partial`.** The run's id, label, group and source, and for a harness run the Factory build (kind, commit, `distSha256` at provisioning and at scoring). Factory's versions from the run headers, with the commit each release was tagged at (or a candidate's commit), and each run file and how it ended. Model calls by role, provider, model and effort. Admission to end, and `done`, `held`, `running` or `cancelled`. `partial` is true unless the Objective is done or cancelled.
- **`totals.wallMs`, `activeWallMs`, `outages`, `pauses`, `holdBlocked`.** Wall time runs from admission to the end. Active time leaves out three kinds of time, each once where they overlap:
  - an outage, the gap from one run file's last event to the next run file's first (a service restart);
  - a pause, from the operator's `pause` to `resume`;
  - waiting on an answer: a hold is open and no step is in progress, so Factory has nothing to do until someone answers. A step is in progress from its start to its outcome. A plain `retry` (a CI poll, a provider backoff) keeps it in progress; a `retry` with progress hands the work to other steps.

  `downtimeMs` is the outages and pauses, and `holdBlockedMs` the waiting beyond them. Each kind is listed. A Work Item's active time also leaves out its own waits on an answer while none of its steps ran (`holdBlockedMs` per item).

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
- **`totals.holds`.** Holds by kind, with wait: asked to answered, less the outages and pauses inside it. `rawWaitMs` keeps asked to answered, which is checked against Factory's diagnostics. `scripted` holds are of a kind the policy answers. `operator` holds are the rest, and `operatorWaitMs` sums their waits.
- **`totals.validation`.** Factory's validate step.
  - `runs`: its verdicts (done, repair, fail); `passed`: the done ones; `passRate`: `passed` over `runs`; `holds`: runs that stopped for a question.
  - `results`: each result's first validation, the first after the work that made it. An operator's `retry` validates the same result again and isn't counted. A hold for a spend limit or a config change isn't a verdict. Any other hold counts as the result not passing.
  - `firstPassRate`: `passedFirstTime` over `results`.
- **`totals.ci`.**
  - `published`: pushes of a result.
  - `rounds`: pushes and reruns.
  - `conflicts`: pushes that conflicted with their base branch before any check failed. They are rebased, not CI results.
  - `passedFirstTime`: pushes whose checks passed with no rerun, repair or hold.
  - `firstPassRate`: `passedFirstTime` over `published` less `conflicts`.
- **`totals.final`.** Final validation runs and the final review.
- **`items[]`.** The same numbers per Work Item, plus `activeWallMs` from its first step to its merge, less the excluded time. An amendment's calls count toward the Work Item whose worker proposed it. `objective` holds the calls of no Work Item.
- **`operator`.** Every hold with its kind, step, asked and answered times, answer, `by` and `as`. Also the other operator actions: pause, resume, decline-discovery.
- **`telemetry`.** The critical path, hedges, Factory's time breakdown, retries, validation commands, GitHub requests and cache rate per Work Item.
- **`checks`.** The scorecard's totals against Factory's diagnostics: tokens, child threads, calls, model time, holds, hold waits and repairs. Each one must agree.

## The example

`bench/examples/acme-widgets-42.json` is an invented benchmark: an Objective, acme/widgets#42, that adds a query tokenizer, a query API, a CSV export and a read-only smoke check of the release. Nothing in it is real. The tests score an invented run of it, written by `test/fixtures/bench/generate.mjs` into `test/fixtures/bench/acme__widgets/`: three run files, Factory 0.5.7 and then 0.5.8, operator-assisted. Its scorecard shows what each part of the scorecard counts:

|                                                    | Scorecard                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Tokens, own and child threads                      | `tokens.total` 19,614,000: own 17,844,000 and child threads 1,770,000           |
| Child threads, each resumed session's counted once | 1,770,000; summed naively over the resumed sessions' cumulative usage 3,540,000 |
| The spend ledger                                   | 17,789,000: the call the first restart replaced logged 55,000 never charged     |
| Repairs                                            | 5 (3, 1, 1, 0)                                                                  |
| Holds                                              | 12 (6 for the operator, 6 of the policy's kinds), of 7 kinds                    |
| Wall time, active                                  | 3 h 02 m; 1 h 34 m without the outages, the pause and 47 min waiting on answers |
| Results passing their first validation             | 5 of 8: the QA hold counts as the smoke check's result not passing              |
| CI first-pass                                      | 1 of 3: query-api's first push conflicted with its base before any check ran    |

The second restart falls inside the operator's pause, so it is excluded once. export-csv's spend hold in validation is no verdict: its next run is the result's first validation.

## Later

- A faster, cheaper tier for quick iterations, from the integration suite's per-case results.
- More than one benchmark, of different shapes, such as a backend-only Objective, so nothing gets tuned to one Objective.
