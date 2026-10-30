# Factory benchmarks

Replayable Objective benchmarks for testing and hill-climbing Factory: the same work, run the same way and scored the same way every time (#2200).

A benchmark replays a real Objective from its base commit in a fresh private test repository, with Factory's settings, memory, CI and rules as they were, and a scripted operator. Each run is scored into a JSON scorecard. Reports compare a run with the baseline, and a history page graphs the key metrics across runs and Factory versions with the spread of repeated runs.

What Factory is for: you file an Objective, walk away, and come back to correct, merged work, at a reasonable cost. So the scorecard scores outcomes first (#2223): whether the merged result is correct, judged by the benchmark's own grader; how much the operator had to do; how long delivery took; how much work was wasted; and which defects got past the stage meant to catch them, with cost as a guard. Tokens, time, repairs and first-pass rates stay as diagnostics. They can point the wrong way: a stricter review that catches a defect early adds a repair, yet saves a refusal and a hand fix.

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
  graders/                    optional: each benchmark's grader and its private checks
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

A pause is recorded and printed, and `run.mjs` exits 2. A scripted answer Factory refuses is recorded too; if its hold is still open at the next look, it pauses for the operator. Answer it with `node bench/run.mjs answer --run-dir DIR --question ID ANSWER [ARG] [--text-file F] [--as NAME]`, then run `run.mjs` again. `DIR/decisions.jsonl` records every decision (asked, answered, answer, by whom) and every time the service was seen down. When the Objective ends, the run is scored into the results directory the run record names, unless `--results DIR` or `--bench-home DIR` is given. An exported `FACTORY_BENCH_HOME` is used only for a record that names none, never over it. The run is then graded on the record's checkout ([Grader](#grader)). A grader that fails is recorded in the card and printed; `run.mjs` still exits 0 (done) or 1 (cancelled).

| `run.mjs` exits | When                                                          |
| --------------- | ------------------------------------------------------------- |
| 0               | the Objective is done, scored (and graded)                    |
| 1               | the Objective was cancelled, or `factory run` didn't queue it |
| 2               | paused for the operator                                       |
| 64              | usage: no results directory, no definition                    |
| 75              | the service isn't running, so nothing was queued              |

### 3. Score

A harness run scores itself at its end, or with `node bench/score.mjs --run-dir DIR` into the same results directory as `run.mjs`. To score any Objective, for example one Factory ran outside the harness:

```sh
node bench/score.mjs --benchmark acme-widgets-42 \
  --state-dir ~/.local/state/factory/acme__widgets --issue 42 \
  --run-id acme-widgets-42-backfill \
  --label "acme/widgets#42, Factory 0.5.7→0.5.8, operator-assisted"
```

Scoring only reads, so a live service's state can be scored. An Objective that hasn't ended scores a partial card (`partial: true`): its totals are lower only because the run is unfinished. `score.mjs` doesn't write a partial card into the results. Use `--print` or `--out FILE` to see one.

An ended run is graded when the definition has a grader ([Grader](#grader)). A harness run is graded on its record's checkout, at the default branch's last commit by the Objective's end, and its hand fixes are read from that history. A backfill names its repository and commit, and its hand fixes, since a real repository's history has other people's commits too:

```sh
node bench/score.mjs --benchmark acme-widgets-42 --state-dir ... --issue 42 --run-id ... --label ... \
  --grade-tree ~/work/widgets --grade-commit <end commit> --hand-fix <sha> --hand-fix <sha>
```

`--grade-tree DIR` is a clone of the run repository. It is only read: the grader runs in a fresh checkout that shares its objects. Without `--grade-commit`, its `origin` default branch at the end is graded. `--grade-only` grades an existing card again (the run's card in the results, or `--out FILE`) and rewrites its `grade` and `escapes`, scoring nothing else: after a grader fix, or for a card scored before the grader existed. An older card is scored again (score it, then it is graded): its state and run logs give every v3 number.

| `score.mjs` exits | When                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| 0                 | scored, and graded where the definition has a grader and there is a repository to grade |
| 64                | usage: a missing flag, a bad definition, no card for `--grade-only`, an older card      |
| 65                | the Objective hasn't ended: a partial card isn't written into the results               |
| 70                | the grader failed or timed out: the card is written, with `grade.error`                 |

### 4. Report and compare

```sh
node bench/report.mjs --benchmark acme-widgets-42            # every run's report and the history page
node bench/report.mjs compare --benchmark acme-widgets-42 --candidate "Factory 0.6.0"
```

A run report is one self-contained HTML file (inline CSS and SVG, no network assets, light and dark) plus a Markdown summary, written to the bench home's `reports/<id>/` (or `--out DIR`). The outcomes come first: grade, human effort, time to delivery, waste, stage escapes and cost, then the diagnostics. It has the comparison with the baseline's spread (outcomes, then diagnostics), the grader's verdict per criterion, every operator touch with its weight, waste by cause and by Work Item, cost per model, tokens per Work Item, a timeline with the excluded time and holds, holds by kind, every operator decision, telemetry, and the checks against Factory's diagnostics. The history page plots each metric per run, outcomes first, grouped by Factory build, with each group's median and min-to-max band.

A partial card in the results is reported and plotted, marked "partial" and drawn as a hollow dot. It is left out of its group's spread and out of every comparison, and `compare` warns about it. A version 2 card is reported with a warning to score it again: it has no outcome metrics, and it is left out of every comparison. A card of any other version is left out with a warning. `report.mjs` exits 0 when it wrote the reports, and `compare` exits 0 on accept and 3 on reject; both exit 64 on a usage error.

## Hill-climb

1. **Baseline.** Run the current release N times (N ≥ 3) with the same `--group`. The definition's `baseline` names the group.
2. **Candidate.** Make one change on a branch, build it, and provision N runs with `--factory <checkout>` and one `--group` for the candidate.
3. **Compare.** `report.mjs compare` compares the candidate group's median with the baseline group's spread, metric by metric. Better or worse means beyond the baseline's whole range, from min to max. Inside it is noise.
4. **Accept** only on outcomes:
   - `grade` is not worse;
   - `human` or `deliveryMs` is better;
   - `escapes` is not worse;
   - `cost` is not worse beyond the baseline's range.

   An unknown outcome (no run graded, no prices) never passes a rule. Waste is shown with the outcomes but doesn't decide, and the diagnostics (the definition's `hillClimb` metrics, or tokens, active time, repairs, holds and first-pass rates) never do. `compare` exits 0 on accept and 3 otherwise. It warns when either group has fewer than 3 runs: a single run's planner variance is larger than most effects.

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
| `hillClimb.primary`, `hillClimb.guards`                             | Optional: the diagnostics `compare` shows, as metric ids (`bench/lib/metrics.mjs`). They don't decide                                                                                                                                                                                         |
| `budget.tokens`, `budget.hours`                                     | The expected cost per run, `[low, high]`                                                                                                                                                                                                                                                      |
| `grader.command`, `grader.timeoutMinutes`                           | Optional: the benchmark's own grader of the merged result ([Grader](#grader)), and how long it may run                                                                                                                                                                                        |
| `scoring.questionChargeMinutes`                                     | Optional: what time to delivery charges per question for the operator; 15 by default                                                                                                                                                                                                          |
| `prices.<model>.uncachedInput`, `.cachedInput`, `.output`           | Optional: each model's price, US dollars per million tokens, for `cost`                                                                                                                                                                                                                       |

A definition written before scorecard v3, without the optional fields, still loads: its runs have no grade or cost, so `compare` can't accept a candidate on them until they are added.

## Scorecard

`<results>/<benchmark>/<run id>.json`, `schemaVersion` 3. It is built from the Objective's state, its run log, Factory's diagnostics of it (the same `--summary` and `--analyze` JSON that `factory diagnostics ISSUE --all-runs` prints), the run repository's history and the grader's verdicts. A count the logs can't give is `null`, with the reason in `unavailable`. It is never 0.

### Outcomes

In priority order. Each is read from the run log's events, the state and the run repository's history, never from the text of a finding or a question (`bench/lib/outcomes.mjs`, `bench/lib/grade.mjs`).

1. **`grade`: correct delivery, judged independently.** The grader's verdict on each of the Objective's criteria, on a fresh checkout of the run repository's default branch at the Objective's end commit (`endCommit`: the last first-parent commit made by `endedAt`): `{ graderVersion, commit, passed, failed, unknown, passRate, criteria[] }`, each criterion `{ id, text, verdict, method, evidence }` as the grader wrote it. `passRate` is `passed` over all criteria: an unknown verdict is not a pass. A grader that fails, times out or writes anything else records `grade.error`, with every number null: never a made-up rate. No grader, or nothing to grade: `grade` is null and `unavailable` says why.
2. **`human`: human effort.** Every operator touch, weighted:

   | Touch      | Weight | What                                                                                                                                                  |
   | ---------- | -----: | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `stamp`    |      1 | `more`, a plain `retry`, `adopt` or `continue` with no text; a `retry`, `pause`, `resume` or `drain` request                                          |
   | `judgment` |      5 | any other answer (an answer with text, `accept`, `refuse`, `replan`, `repair`, `cancel`, ...); any other request (`cancel`, `decline-discovery`, ...) |
   | `handFix`  |     25 | a commit on the run repository's default branch during the run that no Factory merge made                                                             |

   Each hold in `operator.decisions` and each `operator.actions` entry has its `touch`. A stamp the policy gives counts as an operator's would (`policyStamps` counts them): someone has to give it outside the benchmark. Hand fixes (`human.fixes`, each `{ sha, at, from, afterFinalReview }`): a harness run's are the default branch's first-parent commits from admission to the end, less Factory's merges (the merge commits its merge steps recorded in the state, with an item's earlier merges, and any merge commit whose other parent is a head Factory published). A backfill's are the `--hand-fix` commits given. `score` is the weighted sum; `unattended` is true when the Objective is done with no touch.

3. **`deliveryMs`: time to delivery.** Active wall time (outages, pauses and waits on an answer with nothing running left out, as below) plus a fixed charge, `scoring.questionChargeMinutes` (15 by default), for each hold of a kind the policy doesn't answer. The operator's speed stays out of it; asking still costs something. `delivery` breaks it down.
4. **`waste`.** The tokens and model time of calls whose work didn't reach the result, as a share of the totals (`tokensShare`, `modelMsShare`), by cause (`byCause`) and by Work Item (`byItem`, `objective` for calls of none; an amendment's calls are its proposing item's). A call has one cause at most, the first that holds:
   - `outage`: its step attempt had no outcome before its run file ended and a later one began: the service restarted or died under it. An attempt the engine stopped (an `aborted` event) isn't one.
   - `hedge`: one of a hedged pair, aborted as `hedged` because the other answered first.
   - `amendment`: a call of an amendment the plan rejected or left unchanged (the state's `amend:<id>` record).
   - `superseded`: a call of a result that a later attempt of the same step made again. A step's attempts up to one that ends `done` make one result; it is superseded when the step ends `done` again with no `repair` outcome sending work back to that step in between. A repair builds on the result it repairs (the worker's conversation and branch go on), so a repaired result is no waste; a review of a result its step then reviewed again, or an amendment's plan its review sent back, is.
5. **`escapes`: stage escapes.** Defects caught later than the stage meant to catch them: `finalReviewRefusals` (final review refused the integrated result: an `objective-review` event `refused`), `handFixesAfterFinalReview` (hand fixes made after final review first started), and `graderFailedPassed` (criteria the grader failed although final review passed the result, by `totals.final.reviewPassed`; null until graded). `total` sums them.
6. **`cost`, a guard.** Each call's uncached input, cached input and output tokens (child threads included; reasoning is output) at its model's price from `definition.prices`: `{ usd, byModel, unpriced, unknownCalls }`. Null without prices; `usd` is null when any model has no price, never a partial sum.

### Diagnostics

The rest of the card, unchanged from version 2: shown after the outcomes, never deciding.

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
- **`totals.final`.** Final validation runs and the final review: `review` is the last logged review's outcome, and `reviewPassed` whether final review passed, from the state (its step is done). They can differ: when the operator's `accept <n>` answers settle every criterion, final review passes without logging a review.
- **`items[]`.** The same numbers per Work Item, plus `activeWallMs` from its first step to its merge, less the excluded time. An amendment's calls count toward the Work Item whose worker proposed it. `objective` holds the calls of no Work Item.
- **`operator`.** Every hold with its kind, step, asked and answered times, answer, `by` and `as`. Also the other operator actions: pause, resume, decline-discovery.
- **`telemetry`.** The critical path, hedges, Factory's time breakdown, retries, validation commands, GitHub requests and cache rate per Work Item.
- **`checks`.** The scorecard's totals against Factory's diagnostics: tokens, child threads, calls, model time, holds, hold waits and repairs. Each one must agree.

## Grader

The benchmark's own judgment of the merged result, frozen with the benchmark, never Factory's reviewers. The grader and its private checks live in the bench home (`graders/`), outside this repository, like the definition. `definition.grader = { command, timeoutMinutes }`:

- The command runs in a shell, with its working directory in a fresh checkout of the run repository's default branch at the Objective's end commit (a clone sharing the repository's objects, so nothing is fetched; LFS files are pointers, and a grader that needs them runs `git lfs pull`).
- Its environment has `BENCH_TREE` (the checkout), `BENCH_COMMIT` (the commit), `BENCH_DEFINITION` (the definition file, so `$(dirname "$BENCH_DEFINITION")/../graders/...` finds the grader in the bench home) and `BENCH_OUT`.
- It writes `{ graderVersion, criteria: [{ id, text, verdict, method, evidence }] }` to `BENCH_OUT`, each `verdict` `pass`, `fail` or `unknown`.
- It is killed at `timeoutMinutes`, with everything it started. A non-zero exit, a timeout, or output without a `graderVersion`, criteria, or a valid verdict for each is `grade.error`.

The harness never interprets criteria itself. The checkout is removed after grading.

## The example

`bench/examples/acme-widgets-42.json` is an invented benchmark: an Objective, acme/widgets#42, that adds a query tokenizer, a query API, a CSV export and a read-only smoke check of the release. Nothing in it is real. The tests score an invented run of it, written by `test/fixtures/bench/generate.mjs` into `test/fixtures/bench/acme__widgets/`: three run files, Factory 0.5.7 and then 0.5.8, operator-assisted. `fixtureRepository` in the same file builds its run repository with Git, and `test/fixtures/bench/grader.mjs` is a stand-in grader. Its scorecard shows what each part of the scorecard counts:

|                                                    | Scorecard                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Grade                                              | 60%: 3 of 5 criteria pass, 1 fails (the CSV row limit), 1 unknown (the release build needs a display)                                          |
| Human effort                                       | 61: 11 stamps, 5 judgments (two diagnosis answers, two review accepts, a declined discovery) and the hand fix during final review's refusal    |
| Time to delivery                                   | 3 h 28 m: 1 h 43 m active and 7 questions for the operator at 15 min                                                                           |
| Waste                                              | 1,495,000 tokens (7.5%): a lost hedge 600,000, a rejected and an unchanged amendment 440,000, two superseded results 400,000, an outage 55,000 |
| Stage escapes                                      | 3: final review's refusal, the hand fix after it, and the row limit final review passed                                                        |
| Cost                                               | $6.25 at the example's prices                                                                                                                  |
| Tokens, own and child threads                      | `tokens.total` 19,914,000: own 18,144,000 and child threads 1,770,000                                                                          |
| Child threads, each resumed session's counted once | 1,770,000; summed naively over the resumed sessions' cumulative usage 3,540,000                                                                |
| The spend ledger                                   | 18,089,000: the call the first restart replaced logged 55,000 never charged                                                                    |
| Repairs                                            | 6 (3, 1, 1, 0, and final validation's after the operator's fix)                                                                                |
| Holds                                              | 13 (7 for the operator, 6 of the policy's kinds), of 8 kinds                                                                                   |
| Wall time, active                                  | 3 h 21 m; 1 h 43 m without the outages, the pause and 57 min waiting on answers                                                                |
| Results passing their first validation             | 5 of 8: the QA hold counts as the smoke check's result not passing                                                                             |
| CI first-pass                                      | 1 of 3: query-api's first push conflicted with its base before any check ran                                                                   |

The second restart falls inside the operator's pause, so it is excluded once. export-csv's spend hold in validation is no verdict: its next run is the result's first validation. query-api's first result review and worker-tokenizer-1's first plan are superseded; tokenizer's and export-csv's repaired work is not.

## Later

- A faster, cheaper tier for quick iterations, from the integration suite's per-case results.
- More than one benchmark, of different shapes, such as a backend-only Objective, so nothing gets tuned to one Objective.
