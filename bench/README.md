# Factory benchmarks

Replayable Objective benchmarks for testing and hill-climbing Factory: the same work, run the same way and scored the same way every time (#2200).

A benchmark replays a real Objective from its base commit in a fresh private test repository, with Factory's settings, memory, CI and rules as they were, and a scripted operator. Each run is scored into a JSON scorecard. Reports compare a run with the baseline, and a history page graphs the key metrics across runs and Factory versions with the spread of repeated runs.

What Factory is for: you file an Objective, walk away, and come back to correct, merged work, at a reasonable cost. So the scorecard scores outcomes first (#2223): whether the merged result is correct, judged by the benchmark's own grader; how much the operator had to do; how long delivery took; how much work was wasted; and which defects got past the stage meant to catch them, with cost as a guard. Tokens, time, repairs and first-pass rates stay as diagnostics. They can point the wrong way: a stricter review that catches a defect early adds a repair, yet saves a refusal and a hand fix.

A result can meet every criterion literally and still miss the Objective's intent, or be code nobody wants to maintain. So `compare` can also ask the benchmark's own judge, blind, which of two runs' results it would rather have, on intent and on code quality, and checks that judge against a person's choices (#2224).

```
bench/
  provision.mjs               set up one run: repository, Project, Factory, memory, Objective
  run.mjs                     follow the run to its end, applying the operator policy; stop or start its service
  score.mjs                   score a run, or any Objective, into the results
  report.mjs                  run reports, the history page, the hill-climb decision, the judge's calibration
  grade-auto.mjs              a generic grader of any Objective's result, and its roles' prompts in grade-auto/
  review-replay.mjs           replay recorded result reviews with a build's reviewer, and score it
  examples/acme-widgets-42.json  an invented definition (schema below)
  lib/                        what the commands share
```

The scripts are plain Node. They use Factory's own build for what Factory already defines (child-thread accounting, the current plan, diagnostics, review artifact selectors), so run `npm run build` first.

## Where a benchmark's data lives

Not in this repository. A benchmark replays a real Objective of some repository, so its definition, its scorecards and its reports belong with that repository's owner, usually in a private repository of their own. A bench home holds them:

```
<bench home>/
  benchmarks/<id>.json        a benchmark definition (schema below)
  results/<id>/<run id>.json  scorecards
  results/<id>/judgments/     the pairwise judge's judgments, one file per pair of runs
  reports/<id>/               generated HTML and Markdown
  graders/                    optional: each benchmark's grader and judge, and their private checks
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
2. Clones the source (no LFS smudge) into the host's cache and fetches the base commit, the definition's `basePatches` and their LFS objects, holding `<cacheDir>/<owner>__<name>.lock` meanwhile, so runs provisioned at once take turns with the shared clone. Then it applies each base patch onto the base, in order, as `git cherry-pick -x` would. A patch keeps its author, committer and dates, so a rerun makes the same commits. A patch that doesn't apply cleanly, a merge commit, or one the base already has stops provisioning before anything is pushed.
3. Creates the private test repository `<owner>/<namePrefix>-<run id>` with Actions off, applies the merge settings, pushes the base, with its patches, as `main` without the LFS pre-push hook, then pushes the tree's LFS objects by id.
4. Mirrors the named rulesets and copies the named Actions variables from the source. Then it turns Actions on and disables every workflow except `keepWorkflows`, before anything can trigger them. The workflow listing must succeed and must name every `.github/workflows/*.yml` of the base tree. After disabling, the workflows are listed again, and only kept ones may be active. If any of this fails, Actions is turned off again and provisioning stops.
5. Clones the test repository for Factory.
6. Creates a Project with Factory's fields (Factory, Factory order, Factory admission), links it and creates the Objective's labels.
7. Runs `factory setup` with its own `FACTORY_CONFIG` and `FACTORY_STATE_DIR` under the run directory, never `~/.config/factory`, and the run's capacity ([Several runs at once](#several-runs-at-once)). The installation's GitHub budget is production's too, so setup gets `--github-reserve 2000` and benchmark traffic yields first, but only when the Factory under test takes that option: a benchmark runs old releases for A/B comparison, and releases up to 0.5.11 don't. The Factory's version says whether it does: 0.5.12, the first release with it, and any later version do, and a release at 0.5.11 or before doesn't. Otherwise, as for a checkout at 0.5.11 or a pre-release version, its own usage says: the `setup` line of `factory help` lists `[--github-reserve ...]` or doesn't; a dry run reads it too. Provisioning stops rather than guess when that usage has no setup line. Setup has no option for `reviewArtifacts`, so provisioning then sets the top-level `reviewArtifacts` of the run's `factory.json` to exactly the definition's `factory.reviewArtifacts` selectors: the definition is the source of truth, so a selector it no longer has goes. The file is written only when its list differs from the definition's by Factory's selector identity, so a rerun leaves it byte for byte as it is. When the definition has none and the file has selectors an earlier provisioning wrote (as the run record says), the key is dropped. Setup keeps the key when it writes the file again.
8. Seeds repository memory as it stood before the Objective: a copy of the source's knowledge store without the Objective's entries or any made at or after the instant `memory.before`.
9. Starts the background service (`setup --background`), files the Objective verbatim and checks the filed body against the digest.

Each step looks before it acts, so running provisioning again with the same `--run-id` carries on where it stopped. It keeps the capacity the run recorded, since setup changes only the values it is given: a capacity flag given again changes that value, and provisioning says so. The record keeps its issue and when the run was first provisioned and queued. Without `--run-id`, a run gets a new id: the minute it started and a random suffix, such as `20310304-0900-3fa2c1`, so runs provisioned in the same minute differ, and a run directory already there is refused. The run record, `<benchRoot>/<benchmark>/<run id>/run.json`, holds the repository, issue, Project, Factory (CLI, version, commit), whether setup was given the GitHub reserve (`githubReserve`: `{ applied, reserve, by }`, `reserve` the amount or null, `by` `version` or `usage`), environment, capacity (`{ workers, validations, memoryMib, share }`, as given to setup; a value missing is Factory's own for the host), the base patches (each `{ commit, reason, applied }`, `applied` the commit it made on `main`), the review artifact selectors carried into `factory.json` (`reviewArtifacts`), the definition file it ran and the results directory the run is scored into. Provisioning refuses before creating anything when no results directory is given. A step that fails stops provisioning with its reason and exits 1.

| `provision.mjs` flag                               | What                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `--benchmark`, `--host`, `--factory`               | The definition, the host profile and the Factory to run                                 |
| `--run-id ID`                                      | The run to provision, or to carry on; a new id without it                               |
| `--label`, `--group`                               | The run's label and result group                                                        |
| `--share N`                                        | About 1/N of the host's CPUs and memory for this run's service, for N runs side by side |
| `--workers N`, `--validations N`, `--memory-mib N` | One capacity value, over the definition's `factory.capacity` and `--share`              |
| `--dry-run`                                        | Print every GitHub, Git and setup action and do none                                    |

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

These three are the only answers a policy may script by kind. A definition that scripts any other kind or answer, such as `accept` or `cancel`, is refused, and the follower never gives one. The opt-in scripted operator also answers some judgment holds, by the fixed rules in [The scripted operator](#the-scripted-operator): `node bench/run.mjs --run-dir DIR --policy scripted`, or `operatorPolicy.policy: "scripted"` in the definition. The flag wins over the definition, and `--policy stamps` (the default) answers by kind only. The policy is recorded in `run.json` (`policy`, and on the `queued` decision) when the Objective is queued, and the run follows it to its end, so it can be carried on after a pause without the flag; a later `--policy` that differs exits 64 rather than mix policies in one run.

A pause is recorded and printed, and `run.mjs` exits 2. A scripted answer Factory refuses is recorded too; if its hold is still open at the next look, it pauses for the operator. Answer it with `node bench/run.mjs answer --run-dir DIR --question ID ANSWER [ARG] [--text-file F] [--as NAME]`, then run `run.mjs` again. `DIR/decisions.jsonl` records every decision (asked, answered, answer, by whom) and every time the service was seen down. When the Objective ends, the run is scored into the results directory the run record names, unless `--results DIR` or `--bench-home DIR` is given. An exported `FACTORY_BENCH_HOME` is used only for a record that names none, never over it. The run is then graded on the record's checkout ([Grader](#grader)). A grader that fails is recorded in the card and printed; `run.mjs` still exits 0 (done) or 1 (cancelled).

| `run.mjs` exits | When                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------- |
| 0               | the Objective is done, scored (and graded)                                                    |
| 1               | the Objective was cancelled, or `factory run` didn't queue it                                 |
| 2               | paused for the operator                                                                       |
| 64              | usage: no results directory, no definition, unknown --policy, a --policy other than the run's |
| 75              | the service isn't running, so nothing was queued                                              |

A run's service keeps polling after its Objective ends. Once the run is scored, stop it:

```sh
node bench/run.mjs stop --run-dir <benchRoot>/acme-widgets-42/<run id>
```

This runs `factory setup --stop`, which stops the service and keeps it from starting again at the next login, and records `service-stopped` in `decisions.jsonl`. A held run keeps its service, so the answer can be acted on: while the Objective has an open hold, hasn't ended, or its status can't be read, `stop` refuses and exits 2. `--force` stops it anyway, and the record says why it was held. It exits 0 once stopped and 1 when setup doesn't stop it. To start it again, such as after stopping a held run:

```sh
node bench/run.mjs start --run-dir <benchRoot>/acme-widgets-42/<run id>
```

This runs `factory setup --background` in the run's environment, given nothing else, so the service starts on the configuration and capacity it has, and records `service-started`. It exits 0 once the service runs or is starting and 1 when setup doesn't start it. Don't provision the run again for this: once Factory has merged work, `main` is ahead of the base and provisioning's push of the base is refused.

#### The scripted operator

Repeated runs are comparable only if the operator answers the same way every time, and people don't (#2266). The scripted policy answers judgment holds by the fixed rules below, after the answers by kind, and pauses on anything they don't cover. The rules live in `bench/lib/scripted.mjs`, each `{ id, matches(hold), answer(hold) }`. They match a hold by its step and Factory's own question templates and phrases; `policy-exception-refused` and `planner-recommended` also read the planner's or diagnosis's own words inside them, for the explicit phrases below only, and anything less pauses, never a guess at what a question means. The first rule that matches decides; the refusals come before the planner's recommendation, so a recommended exception or widening is refused. A rule answers only with an option the hold offers. Each answer goes through `factory answer --as "<operatorPolicy.as> (scripted)"`, and `decisions.jsonl` records it with its `rule` and `text`. A hold no rule matches pauses exactly as before, and `run.mjs` exits 2.

| Rule id                    | Matches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Answer                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `final-pauses`             | Final validation's or final review's question (step `final` or `final-review`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | none: it pauses for the operator, so nothing is ever accepted for the Objective's result                                                                                                                                      |
| `policy-exception-refused` | A planner's, amendment planner's or repair diagnosis's question (step `decide:<g>:<n>`, `amend:<id>:plan` or `item:<id>:work`) offering `answer` with text, asking for an exception to a repository policy its owner records, such as a test budget: the planner's or diagnosis's own words name a "policy exception" or "budget exception", or an exception to or from a policy or budget                                                                                                                                                                                                                                                                                             | `answer` "No exception is granted: the repository's policy stays as its owner recorded it, and nothing is added to its exceptions. Stay within the policy, and meet the need in a way it already allows." It never grants one |
| `scope-widening-refused`   | The same steps, offering `answer` with text, whose question names the Objective's "May change section": a protected path it doesn't list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `answer` "Not authorized: the Objective's May change section stays as it is, so no protected path it doesn't list may change. Meet the need within the files the Objective allows."                                           |
| `amendment-continue`       | A rejected amendment's question (step `amend:<id>:continue`) offering `continue`, whose rejection (the text after "was rejected: ", before the discovery) is the fence's started-item rule ("has started, so it keeps its spec") or a duplicate of the amendment in flight ("Another amendment was in flight when it was taken in")                                                                                                                                                                                                                                                                                                                                                    | `continue`: the plan runs without it                                                                                                                                                                                          |
| `planner-recommended`      | The planner's own question (step `decide:<g>:<n>`, after "The planner needs a decision:") offering `answer` with text, where every sentence that mentions a recommendation states one outright: "X is recommended", "X (recommended)", "I recommend X" (or "we", "I'd", "we would"), "the recommended option is X" or "Recommendation: X". A sentence with a negation ("no", "not", "none", "neither", "nor", "never", "without", "against", "cannot", "either" or "n't") doesn't, and a sentence that asks (ends with "?") counts only with "(recommended)" on an option, so "Do you recommend A or B?", "Should we skip the recommended lint rule?" and "The docs recommend A" pause | `answer` "Take the recommended option." A question that names none pauses                                                                                                                                                     |

Scripted answers count toward human effort as judgments, whatever their answer, since a real operator would have had to give them, and the scorecard counts them apart as `human.scriptedJudgments`; `compare` warns when some runs had scripted judgments and others didn't ([Scorecard](#scorecard)).

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

`--grade-file FILE` attaches a grade written outside the harness, such as the [auto-grader](#auto-grader)'s standalone output, in place of running the definition's grader. It is checked as a grader's output is, and grades the commit the file names; a `--grade-commit` that differs is refused, and so is a commit other than the card's `endCommit` unless `--grade-commit` names it. It works with `--grade-only` too, and needs no grader in the definition.

| `score.mjs` exits | When                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| 0                 | scored, and graded where the definition has a grader and there is a repository to grade                  |
| 64                | usage: a missing flag, a bad definition, no card for `--grade-only`, an older card, a bad `--grade-file` |
| 65                | the Objective hasn't ended: a partial card isn't written into the results                                |
| 70                | the grader failed or timed out: the card is written, with `grade.error`                                  |

### 4. Report and compare

```sh
node bench/report.mjs --benchmark acme-widgets-42            # every run's report and the history page
node bench/report.mjs compare --benchmark acme-widgets-42 --candidate "Factory 0.6.0"
node bench/report.mjs calibrate --benchmark acme-widgets-42 \
  --pair widgets-0.5.8-1 widgets-0.6.0-1 --intent B --quality tie --by "a widgets maintainer"
```

A run report is one self-contained HTML file (inline CSS and SVG, no network assets, light and dark) plus a Markdown summary, written to the bench home's `reports/<id>/` (or `--out DIR`). The outcomes come first: grade, human effort, time to delivery, waste, stage escapes and cost, then the diagnostics. It has the comparison with the baseline's spread (outcomes, then diagnostics), the grader's verdict per criterion and its own metrics (with a reviewing grader's verified findings and surviving mutants, such as the [auto-grader](#auto-grader)'s), every operator touch with its weight, waste by cause and by Work Item, cost per model, tokens per Work Item, a timeline with the excluded time and holds, holds by kind, every operator decision, telemetry, and the checks against Factory's diagnostics. The history page plots each metric per run, outcomes first, grouped by Factory build, with each group's median and min-to-max band, and each metric the grader reported, such as `mutationScore`, after the outcomes.

With a judge in the definition, `compare` also runs the blind pairwise review ([Pairwise judge](#pairwise-judge)) and prints it after the metrics: each pair's choices, unblinded, the candidate's win rates, and the judge's agreement with the person's calibration choices. A run's tree is found through its run directory, which a harness run's card names; for a card scored before cards named it, give `--bench-root DIR`, the host profile's `benchRoot`. `calibrate` records a person's choice between two runs' trees into the definition's `judgeCalibration` ([Calibration](#calibration)).

A partial card in the results is reported and plotted, marked "partial" and drawn as a hollow dot. It is left out of its group's spread and out of every comparison, and `compare` warns about it. A version 2 card is reported with a warning to score it again: it has no outcome metrics, and it is left out of every comparison. A card of any other version is left out with a warning. `report.mjs` exits 0 when it wrote the reports, `compare` exits 0 on accept and 3 on reject, and `calibrate` exits 0 when it recorded the choice; each exits 64 on a usage error.

### Several runs at once

Runs can overlap: each has its own repository, Project, service and state. Three things keep them apart:

- **Run ids.** A run provisioned without `--run-id` gets a new one, so several started in the same minute each get their own repository.
- **The cache.** Provisioning holds a lock on the shared clone of the source while it clones and fetches into it. A lock whose process is gone is taken over. One held for 30 minutes stops provisioning, naming its holder.
- **Capacity.** By default each service sizes itself for the whole host (`src/capacity.ts`): workers are half the CPUs, validations a quarter, and memory all but 4 GiB. Side by side, every service claims the whole machine and overcommits memory. Give each run a share: `--share N` sizes it by the same formulas over 1/N of the CPUs and of the memory left after the system's 4 GiB, so `--share 3` on 24 CPUs and 46 GiB gives 4 workers, 2 validations and 14,336 MiB. A definition can fix values in `factory.capacity`, and `--workers`, `--validations` and `--memory-mib` set one value over both.

```sh
for i in 1 2 3; do
  node bench/provision.mjs --benchmark acme-widgets-42 --host ~/bench-host.json \
    --factory ~/work/factory --group "Factory candidate" --share 3 &
done
wait
```

Then follow each with `run.mjs`, and stop each service once its run is scored. The runs still share the provider's rate limits, which show in their times.

## Hill-climb

1. **Baseline.** Run the current release N times (N ≥ 3) with the same `--group`. The definition's `baseline` names the group.
2. **Candidate.** Make one change on a branch, build it, and provision N runs with `--factory <checkout>` and one `--group` for the candidate.
3. **Compare.** `report.mjs compare` compares the candidate group's median with the baseline group's spread, metric by metric. Better or worse means beyond the baseline's whole range, from min to max. Inside it is noise.
4. **Accept** only on outcomes:
   - `grade` is not worse;
   - `human` or `deliveryMs` is better;
   - `escapes` is not worse;
   - `cost` is not worse beyond the baseline's range;
   - with a judge, the candidate's blind pairwise intent win rate is not below 50%.

   An unknown outcome (no run graded, no pair judged) never passes a rule. Cost is a guard, not a goal: when it is unknown on both sides, as for a provider without per-token prices, or for the baseline alone, the cost guard is skipped with a warning. A candidate whose cost is unknown against a baseline whose cost is known is rejected. Waste and the grader's own metrics are shown with the outcomes but don't decide, and the diagnostics (the definition's `hillClimb` metrics, or tokens, active time, repairs, holds and first-pass rates) never do. `compare` exits 0 on accept and 3 otherwise. It warns when either group has fewer than 3 runs: a single run's planner variance is larger than most effects.

5. An accepted candidate is released. Its runs become the next baseline: set `baseline` to their group.

**Cost.** A definition's `budget` gives one run's expected tokens and hours. Set its spend cap well above that, so a run never stops on a limit the original Objective had to raise. A baseline and a candidate of 3 runs each cost six runs' budget, and with a judge, nine judgments (every pair), each made once and kept. Runs can overlap, since each has its own repository, service and state, but they share the host's capacity and the provider's rate limits, which then show in their times: give each a share of the host ([Several runs at once](#several-runs-at-once)).

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

| Field                                                               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                                                     | `1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `id`, `title`                                                       | The benchmark's id (the file name) and a short name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `source.repository`, `source.base`, `source.lfs`                    | The repository the Objective ran in, the full base commit, and whether to carry its LFS objects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `basePatches[]`                                                     | Optional: source commits put on the base before the Objective is queued, in order, each `{ commit, reason }` (a full SHA). For a known CI flake the source fixed soon after the base, say. The run record and the scorecard list them, and they are never hand fixes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `objective.issue`, `.title`, `.bodySha256`, `.labels`               | The Objective. Its body is fetched at provision time and must match the SHA-256                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `repository.owner`, `.namePrefix`, `.description`, `.mergeSettings` | The test repository: `<owner>/<namePrefix>-<run id>`, and GitHub's `allow_*`, `delete_branch_on_merge` and `has_*` settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ci.rulesets`, `ci.variables`, `ci.keepWorkflows`                   | Rulesets mirrored and Actions variables copied from the source by name, and the only workflow files left enabled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `memory.seed`, `memory.before`                                      | `before-objective`: the source's memory without the Objective's entries or any made at or after `before`, a UTC time written `YYYY-MM-DDTHH:MM:SS[.mmm]Z`; or `none`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `factory`                                                           | Provider, planner, worker (`kind`, `model`, `effort`, codex `network`), planner and reviewer models, sandbox (network, read-only paths, environment), toolchain (paths, executables), format, required and CI-only commands, allowances and spend caps: each maps to a `factory setup` option. Optional `capacity`: `workers`, `validations` and `memoryMib`, each optional, for the run's service (`--workers`, `--validations`, `--memory-mib`); provisioning's flags override it. Optional `reviewArtifacts`: the source installation's review artifact selectors ([Review artifacts](../docs/reference/capabilities.md#review-artifacts)), checked by Factory's own loader, for an Objective whose proof relies on them; provisioning writes them into the run's `factory.json` |
| `operatorPolicy.as`, `.answers`, `.otherwise`, `.policy`            | Who scripted answers are given as, the answer per hold kind (only `spend: more`, `allowance: more`, `config: adopt`), and `pause` for the rest. Optional `policy`: `stamps` (the default, answers by kind only) or `scripted` (the scripted operator's rules too, [The scripted operator](#the-scripted-operator)); `run.mjs --policy` overrides it                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `baseline`                                                          | The result group runs are compared with                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `hillClimb.primary`, `hillClimb.guards`                             | Optional: the diagnostics `compare` shows, as metric ids (`bench/lib/metrics.mjs`). They don't decide                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `budget.tokens`, `budget.hours`                                     | The expected cost per run, `[low, high]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `grader.command`, `grader.timeoutMinutes`                           | Optional: the benchmark's own grader of the merged result ([Grader](#grader)), and how long it may run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `judge.command`, `judge.timeoutMinutes`                             | Optional: the benchmark's own blind pairwise judge ([Pairwise judge](#pairwise-judge)), and how long it may run per pair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `judgeCalibration[]`                                                | Optional: a person's pairwise choices the judge is checked against, each `{ runA, runB, intent, quality, by, at }` ([Calibration](#calibration))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `scoring.questionChargeMinutes`                                     | Optional: what time to delivery charges per question for the operator; 15 by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `scoring.minJudgeAgreement`                                         | Optional: the share of the person's choices the judge must agree with, below which `compare` warns; 0.8 by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `prices.<model>.uncachedInput`, `.cachedInput`, `.output`           | Optional: each model's price, US dollars per million tokens, for `cost`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

A definition written before scorecard v3, without the optional fields, still loads: its runs have no grade or cost, so `compare` can't accept a candidate on them until they are added.

## Scorecard

`<results>/<benchmark>/<run id>.json`, `schemaVersion` 3. It is built from the Objective's state, its run log, Factory's diagnostics of it (the same `--summary` and `--analyze` JSON that `factory diagnostics ISSUE --all-runs` prints), the run repository's history and the grader's verdicts. A count the logs can't give is `null`, with the reason in `unavailable`. It is never 0.

### Outcomes

In priority order. Each is read from the run log's events, the state and the run repository's history, never from the text of a finding or a question (`bench/lib/outcomes.mjs`, `bench/lib/grade.mjs`).

1. **`grade`: correct delivery, judged independently.** The grader's verdict on each of the Objective's criteria, on a fresh checkout of the run repository's default branch at the Objective's end commit (`endCommit`: the last first-parent commit made by `endedAt`): `{ graderVersion, commit, passed, failed, unknown, passRate, criteria[], metrics }`, each criterion `{ id, text, verdict, method, evidence }` as the grader wrote it, and `metrics` the grader's own numbers by name, such as `mutationScore` (#2224), `{}` when it reports none; a reviewing grader's `findings`, `mutation`, `cost` and `durationMs` when it reports them ([Grader](#grader)). `passRate` is `passed` over all criteria: an unknown verdict is not a pass. A grader that fails, times out or writes anything else records `grade.error`, with every number null: never a made-up rate. No grader, or nothing to grade: `grade` is null and `unavailable` says why.
2. **`human`: human effort.** Every operator touch, weighted:

   | Touch      | Weight | What                                                                                                                                                  |
   | ---------- | -----: | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `stamp`    |      1 | `more`, a plain `retry`, `adopt` or `continue` with no text; a `retry`, `pause`, `resume` or `drain` request                                          |
   | `judgment` |      5 | any other answer (an answer with text, `accept`, `refuse`, `replan`, `repair`, `cancel`, ...); any other request (`cancel`, `decline-discovery`, ...) |
   | `handFix`  |     25 | a commit on the run repository's default branch during the run that no Factory merge made                                                             |

   Each hold in `operator.decisions` and each `operator.actions` entry has its `touch`. A stamp the policy gives counts as an operator's would (`policyStamps` counts them): someone has to give it outside the benchmark. So does an answer the scripted operator gave (its `as` ends in " (scripted)", and the entry is `scripted`): it is a judgment, whatever its answer, and `scriptedJudgments` counts them, so runs under different policies aren't compared as equals. Its hold is still charged as a question in `deliveryMs`. Hand fixes (`human.fixes`, each `{ sha, at, from, afterFinalReview }`): a harness run's are the default branch's first-parent commits from admission to the end, less Factory's merges (the merge commits its merge steps recorded in the state, with an item's earlier merges, and any merge commit whose other parent is a head Factory published) and less the base patches, which provisioning put on the branch before admission. A backfill's are the `--hand-fix` commits given. `score` is the weighted sum; `unattended` is true when the Objective is done with no touch.

3. **`deliveryMs`: time to delivery.** Active wall time (outages, pauses and waits on an answer with nothing running left out, as below) plus a fixed charge, `scoring.questionChargeMinutes` (15 by default), for each hold of a kind the policy doesn't answer. The operator's speed stays out of it; asking still costs something. `delivery` breaks it down.
4. **`waste`.** The tokens and model time of calls whose work didn't reach the result, as a share of the totals (`tokensShare`, `modelMsShare`), by cause (`byCause`) and by Work Item (`byItem`, `objective` for calls of none; an amendment's calls are its proposing item's). A call has one cause at most, the first that holds:
   - `outage`: its step attempt had no outcome before its run file ended and a later one began: the service restarted or died under it. An attempt the engine stopped (an `aborted` event) isn't one.
   - `hedge`: one of a hedged pair, aborted as `hedged` because the other answered first.
   - `amendment`: a call of an amendment the plan rejected or left unchanged (the state's `amend:<id>` record).
   - `superseded`: a call of a result that a later attempt of the same step made again. A step's attempts up to one that ends `done` make one result; it is superseded when the step ends `done` again with no `repair` outcome sending work back to that step in between. A repair builds on the result it repairs (the worker's conversation and branch go on), so a repaired result is no waste; a review of a result its step then reviewed again, or an amendment's plan its review sent back, is.
5. **`escapes`: stage escapes.** Defects caught later than the stage meant to catch them: `finalReviewRefusals` (final review refused the integrated result: an `objective-review` event `refused`), `handFixesAfterFinalReview` (hand fixes made after final review first started), `graderFailedPassed` (criteria the grader failed although final review passed the result, by `totals.final.reviewPassed`; null until graded), and `graderDefects` (the grader's verified findings of severity `defect`, each violating a stated criterion, in a result final review passed; null until graded by a grader that reports findings, such as the [auto-grader](#auto-grader)). `total` sums them.
6. **`cost`, a guard.** Each call's uncached input, cached input and output tokens (child threads included; reasoning is output) at its model's price from `definition.prices`: `{ usd, byModel, unpriced, unknownCalls }`. Null without prices; `usd` is null when any model has no price, never a partial sum.

### Diagnostics

The rest of the card, unchanged from version 2: shown after the outcomes, never deciding.

- **`run`, `factory`, `models`, `startedAt`, `endedAt`, `outcome`, `partial`.** The run's id, label, group and source, and for a harness run its run directory (`run.dir`, where the pairwise review finds its tree and Objective), its base patches when it had any (`run.basePatches`, each `{ commit, reason, applied }`, also listed in the run report: the base wasn't pristine) and the Factory build (kind, commit, `distSha256` at provisioning and at scoring). Factory's versions from the run headers, with the commit each release was tagged at (or a candidate's commit), and each run file and how it ended. Model calls by role, provider, model and effort. Admission to end, and `done`, `held`, `running` or `cancelled`. `partial` is true unless the Objective is done or cancelled.
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
- **`totals.workerValidation`.** Workers' own Validate calls.
  - `runs`: every call; `passed`: the full runs that passed with a handoff collection accepts; `targeted`: the calls that ran only some commands, which never count as passing.
  - `feedbackMs`: the median time from the worker's last edit (the newest file its result changes) to a call's verdict.
  - `passedShare`: the share of the calls' time their passing commands took: the time spent before the command that mattered. Lower is a faster inner loop.
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
- **`quality.verifiedFindings`, `quality.mutantsSurvived`.** Metric ids read from the grade, for a grader that reviews as well as grades ([Auto-grader](#auto-grader)): how many findings its verifier confirmed (`grade.findings`), and how many mutants of the changed lines the delivered tests let survive (`grade.mutation.survived`). Null for a grader that reports neither. `compare` and the history show them with the other diagnostics.

## Grader

The benchmark's own judgment of the merged result, frozen with the benchmark, never Factory's reviewers. The grader and its private checks live in the bench home (`graders/`), outside this repository, like the definition. `definition.grader = { command, timeoutMinutes }`:

- The command runs in a shell, with its working directory in a fresh checkout of the run repository's default branch at the Objective's end commit (a clone sharing the repository's objects, so nothing is fetched; LFS files are pointers, and a grader that needs them runs `git lfs pull`).
- Its environment has `BENCH_TREE` (the checkout), `BENCH_COMMIT` (the commit), `BENCH_DEFINITION` (the definition file, so `$(dirname "$BENCH_DEFINITION")/../graders/...` finds the grader in the bench home) and `BENCH_OUT`. A harness run's grader also gets `BENCH_OBJECTIVE`, the Objective as the run filed it (its `objective.md`). A graded card's grader gets `BENCH_BASE`, the commit the run's change starts from: the definition's `source.base`, or the last base patch provisioning applied onto it (`run.basePatches`), since the patches are the harness's, not the run's.
- It writes `{ graderVersion, criteria: [{ id, text, verdict, method, evidence }], metrics }` to `BENCH_OUT`, each `verdict` `pass`, `fail` or `unknown`.
- `metrics` is optional: a name → number map of whatever else the grader measures, recorded in the card as `grade.metrics`, shown with the grade in the run report and graphed in the history. For example `mutationScore`: the share of bounded, deterministic mutants of the files the Objective changed that the delivered tests kill. Metrics are shown, never deciding; which way is better is the grader's to say.
- A grader that reviews as well as grades, such as the [auto-grader](#auto-grader), may also write `findings` (each `{ id, severity, title, evidence, reproduce }`, `severity` `defect`, `quality` or `minor`: a defect violates a criterion the Objective states), `mutation` (`{ survived, killed, examples }`), `cost` (`{ usd, ... }`) and `durationMs`. They are recorded in the card's `grade`; findings decide `escapes.graderDefects`.
- At `timeoutMinutes` its process group gets SIGTERM, then SIGKILL once it exits or 5 seconds later, so everything it started in its group goes too; a grader that starts process groups of its own stops them on the SIGTERM. A non-zero exit, a timeout, or output without a `graderVersion`, criteria, or a valid verdict for each, or with a metric that isn't a number, or with any of the optional fields malformed, is `grade.error`.

The harness never interprets criteria itself. The checkout is removed after grading.

## Auto-grader

A benchmark's own grader takes days to write and calibrate, and grades one Objective. `bench/grade-auto.mjs` grades any Objective, a small one or a live one on a real repository, from its acceptance, the sources it cites in the checkout and the change from the base commit to the graded commit (#2273). Run it standalone:

```sh
node bench/grade-auto.mjs --repo ~/work/widgets --commit <graded> --base <base> \
  --objective objective.md --out widgets-42.grade.json
node bench/score.mjs --benchmark acme-widgets-42 --state-dir ... --issue 42 --run-id ... --label ... \
  --grade-file widgets-42.grade.json
```

or as a definition's `grader.command`, such as `node bench/grade-auto.mjs --evidence ~/bench-home/evidence/acme-widgets-42`, under the [grader contract](#grader): the checkout, commit, output and Objective come from `BENCH_TREE`, `BENCH_COMMIT`, `BENCH_OUT` and `BENCH_OBJECTIVE` (a backfill's grader has none: give `--objective FILE`), the base from `BENCH_BASE` (past the definition's base patches), else the definition's `source.base` (with a warning when the definition has base patches, whose changes are then graded as the run's), and the declared checks from the definition's `factory.requiredCommands`. A flag wins over each. Set `grader.timeoutMinutes` above the auto-grader's own `--timeout-minutes`: a grader the harness stops has no grade.

Four roles, each a separate headless agent, Claude Code's CLI by default (`claude -p --output-format stream-json --verbose --json-schema ...`, its transcript the stream). Each answers as a JSON schema says, and the harness checks the answer against it; an answer out of its schema counts as none. The roles' prompts are `bench/grade-auto/<role>.md`, repository-neutral.

1. **Grader.** Splits the acceptance into criteria and gives each `pass`, `partial`, `fail` or `unknown` with `file:line` evidence, after running the repository's declared checks. It votes 3 times (`--votes`), independently, all on one [criteria list](#criteria-lists): with none yet, the first vote to answer splits the acceptance and the others grade that list at once. A criterion's verdict is a strict majority of all the votes: `pass` with a majority of passes, `fail` with a majority of fails and partials (a partial is not a pass), and `unknown` otherwise.
2. **Quality.** Reviews the change for design, the repository's conventions, test economy, dead code, duplication and docs accuracy, and reads the [mutation pass](#mutation-pass)'s survivors, reporting those that show a gap in the tests.
3. **Adversary.** Writes throwaway probes that try to break each guarantee the acceptance states, and reports each break with a reproduce snippet.
4. **Verifier.** Reproduces the non-minor findings of 2 and 3, claimed defects first, at most 20 (`--max-findings`), and classifies each it confirms as `defect` (it violates a stated criterion), `quality` or `minor`. A finding it doesn't confirm, or never answers, is dropped: the default is rejected. Minor findings and those over the cap aren't verified, so they are dropped too; `verification` counts each.

Quality and adversary run beside the grader's votes (quality after the mutation pass), and the verifier after them. Each role works in its own scratch checkout of the graded commit (a clone sharing the repository's objects, with no remote, so nothing can be pushed), after the repository's install command (`--install CMD`) when there is one. The original tree is only read; a change to it while grading is named in `warnings`. Each role's agent and install run in a process group of their own; a SIGTERM (the grader contract's timeout), SIGINT or SIGHUP to the auto-grader kills every one and removes the scratch checkouts before it dies of the signal. Each role's web tools are off; its network otherwise is the host's, so run it where the repository's install is the only network it needs. Each role's prompt, transcript and answer are kept in the evidence directory (`--evidence DIR`, by default beside the output as `<out>.evidence/`: in a grader's `BENCH_OUT` directory, which the harness removes, so a definition's command gives `--evidence`).

### Criteria lists

The criteria are split once per Objective, not on every run: a split ran from 8 to 44 criteria on one Objective, so a pass rate couldn't be compared across runs or releases (#2275). Every vote grades one list, from the first of:

1. `--criteria FILE`: a JSON list of `{ id, text }`, ids distinct.
2. The store, `grade-auto/criteria.json` beside the definition (`BENCH_DEFINITION`), else beside `--out`: criteria lists by the SHA-256 of the Objective's text (trimmed). Edit a list there to change what is graded, or remove it to split afresh.
3. The first grader vote's split, stored in the store for the runs after. The output's `warnings` say so.

A digest of the list is part of `graderVersion`, so a changed list is another grader. A list that is given or stored is checked where it enters, and an unusable one is a usage error (exit 64).

### Mutation pass

`mutation` and `metrics.mutationScore` come from no model: a model picking its own mutants gave scores from 0.14 to 0.82 on one tree (#2275). The harness makes mutants of the lines the change added to source files (not tests, comments or strings) by rule: a comparison, logical or arithmetic operator flipped between spaces (`===` to `!==`, `<` to `>=`, `&&` to `||`, `+` to `-`), a boolean literal flipped, an `if` negated or dropped (`if (false)`), a member dropped from a list of literals, a returned value replaced (`return null`, or `None`). They are text rules, for JavaScript, TypeScript and Python above all (the other languages get the operator, boolean, `if` and list rules), so a mutant the build rejects counts as killed, and an equivalent one as survived.

At most `--mutants N` (40) run, those whose hash with `--seed S` (`0`) sorts first: the same change gets the same mutants, and a line added elsewhere doesn't move the others. Each runs in a scratch checkout against `--test CMD ...` (by default the declared checks, so a lint a mutant breaks kills it: give the test command), and the first command to fail kills it, as does a mutant that outlasts three times the unmutated run plus 30 seconds. The commands must pass unmutated, and the pass is bound by `--role-timeout-minutes`: otherwise `mutation` is unknown (null, and `warnings` say why), never a score. A change with no line to mutate has 0 of 0 mutants and no score. `mutation.examples` lists the survivors' `file:line` and rule; every mutant's result is kept in the evidence directory (`mutation/mutants.json`). The mutant bound and the seed are part of `graderVersion`.

Each role is bounded by `--role-timeout-minutes` and the whole run by `--timeout-minutes`, 30 minutes each by default. A role that times out, fails or answers out of its schema is unknown, never a fail: a grader vote is unknown on every criterion, and a reviewer, or the verifier when there were findings to verify, leaves the findings unknown: the output has no `findings`, says why in `warnings`, and `escapes.graderDefects` stays null, never 0. With no grader vote to split the acceptance there is nothing to grade: the output has `error` and no criteria, and it exits 1, which the harness records as `grade.error`.

| Flag                                              | What                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `--repo`, `--commit`, `--base`, `--objective`     | The checkout, the graded and base commits, the Objective's text               |
| `--out`, `--evidence`                             | The output file, and the directory of each role's transcript                  |
| `--cli PATH`, `--model NAME`, `--effort LEVEL`    | The agent CLI (`claude`), its model (`claude-sonnet-5-5`) and effort (`high`) |
| `--install CMD`, `--check CMD ...`                | The repository's install command and its declared checks                      |
| `--test CMD ...`                                  | What each mutant runs (the checks)                                            |
| `--criteria FILE`                                 | The criteria list to grade (the Objective's stored list)                      |
| `--mutants N`, `--seed S`                         | At most N mutants (40), chosen by the seed (`0`)                              |
| `--votes N`, `--max-findings N`                   | Grader votes per criterion (3), findings the verifier reproduces (20)         |
| `--timeout-minutes N`, `--role-timeout-minutes N` | The whole run's and each role's wall-clock bound (30 each)                    |

The output is the grader contract's, plus `commit` and `base`; `findings` (each verified one `{ id, role, title, severity, reported, evidence, reproduce }`, `reported` the reporter's severity); `mutation`; `verification`; the grader's `checks`; `cost` (`{ usd, byRole }`, each role's `total_cost_usd`, `usd` null when any is unknown); `durationMs`; each role's `status`, time and cost; and `graderVersion`, which names the auto-grader's version, a digest of its prompts, the CLI, the model, the effort, the votes, the criteria list and the mutant bound and seed. It exits 0 when graded, 1 with no criteria and 64 on a usage error.

## Pairwise judge

A grade says the criteria are met; it doesn't say whether the result is what the Objective meant, or code anyone wants to keep. The benchmark's own judge, frozen with the benchmark like the grader and living in the bench home beside it, compares two runs' final trees and says which it would rather have. `definition.judge = { command, timeoutMinutes }`. `report.mjs compare` pairs every candidate run with every baseline run (all of them, no sample: 3 × 3 runs are 9 pairs) and judges each pair once:

- **Blind.** Which run is tree A is decided by a hash of the two run ids, never by which is the candidate, and the same pair is always in the same order. The command runs in a shell, with its working directory a temporary directory holding the pair, and `BENCH_TREE_A` and `BENCH_TREE_B` (each run's tree as the grader gets it, a fresh checkout at the commit the run was graded at or its end commit, with its `.git` removed, since its history names the run's repository, its dates and Factory's commits), `BENCH_OBJECTIVE` (a copy of the Objective as the run filed it, its `objective.md`), `BENCH_DEFINITION` (a copy of the definition without `baseline` and `judgeCalibration`, which name groups and runs; a link to the bench home's `graders/` sits beside it, so `$(dirname "$BENCH_DEFINITION")/../graders/...` finds the judge as it finds a grader) and `BENCH_OUT`. Nothing it is given names a run, a Factory version, a group or a date.
- **Output.** It writes `{ judgeVersion, intent, quality, reasons }` to `BENCH_OUT`, `intent` and `quality` each `A`, `B` or `tie`. It is killed at `timeoutMinutes`. A non-zero exit, a timeout or any other output leaves the pair unjudged, with a warning.
- **Unblinded and kept.** Each judgment is stored with the run and commit of A and B in `results/<id>/judgments/`, one file per pair, and reused: a pair is judged again only when the judge or either tree's commit changes. The judge is its command and the bench home's `graders/`: a judgment keeps a hash of both (`judgeDigest`), so a judge edited in place under the same command, say tuned until it agrees with the person, judges every pair again, as does any other change to `graders/`, a grader's included. A judge kept outside `graders/` isn't hashed: change its command when it changes, or clear `judgments/`. A failed judgment isn't kept.
- **Win rates.** The candidate's share of the pairs it wins, on intent and on quality, a tie counting half. **Acceptance** adds: the intent win rate is not below 50%. No pair judged is unknown, which never passes. Quality is shown, not deciding.

`compare` finds each run's tree through its run directory: its run record names the run repository's checkout, and its `objective.md` the Objective. A backfill has no run directory, so its pairs aren't judged.

### Calibration

A judge that disagrees with the person who owns the intent isn't to be trusted. `definition.judgeCalibration` lists that person's own choices between pairs of runs, each `{ runA, runB, intent, quality, by, at }`, `intent` and `quality` `A` (the run `runA`), `B` or `tie`. Record one with `report.mjs calibrate --benchmark ID --pair RUN_A RUN_B --intent A|B|tie --quality A|B|tie --by NAME`: it checks that both runs have scorecards, replaces the person's earlier choice of the same pair and stamps the time. `compare` judges every calibration pair the same way (blind, and kept), compares the answers as run ids, and reports how many of the person's choices the judge made too, overall, on intent and on quality. Below `scoring.minJudgeAgreement` (0.8 by default) it warns that the judge's verdict isn't to be trusted; with no calibration pair it can judge, it warns that the judge is uncalibrated. A warning doesn't change the decision: whoever reads it decides whether to trust the judge.

## Review replay

A result reviewer ships only after it beats the one before it on recorded history (#2344). `bench/review-replay.mjs` runs a Factory build's result reviewer again on result reviews Factory recorded, several times each, and scores it against hand labels: how many of its refusals have a real defect behind them, how many of the known defects it refuses, how many questions it asks, and what it costs.

```sh
node bench/review-replay.mjs --bench-home ~/bench-home --repo ~/work/widgets \
  --build ~/work/factory-candidate --runs 3 --seeded
```

### The replay set

The set is `review-replay/` in the bench home (or `--set DIR`), private like the rest of a benchmark's data. The harness never builds one; whoever owns the repository extracts it from their Factory installation:

```
review-replay/
  records/<id>.json           one recorded result review each
  seeded/records/<id>.json    an accepted result with one planted defect
  plans/, sources/, inputs/   the plans, pinned sources and Objective inputs the records name
  config.json                 the installation's Factory configuration, for a reviewer that validates
  labels.json                 each record's labelled refusals and known defects
  objects.bundle              optional: the candidate commits, as refs/replay/<id>
  results/<label>/            written by the harness
```

A record holds what the review saw and what it decided:

- `id`, `objective`, `item`, `kind` (`work` or `qa`), `attempt`, `at`; `replay: false` with `why` leaves it out (a QA item's review, say, which changes no files).
- `plan`, `sources` and `inputs`: paths, in the set, of the plan in effect (the plan's JSON, as Factory's plan comment holds it), the Objective's pinned sources at the plan base, and the Objective as planned (`{ shown }`, its blocks).
- `candidate`: `{ commit, tree, base }`, the exact commit reviewed, its tree and the commit its change starts from.
- `criteria`, the criteria the reviewer judged, and `itemCriteria`, how many of them, first, are the item's own acceptance; the rest are the Objective criteria the plan gave the item's review.
- `validation`: `{ tree, commands, formatted?, results }`, Factory's validation of the tree: each command's `index`, `command`, `passed`, `exitCode`, `durationMs` and output `tail`.
- `notes`: optional, the worker's handoff notes, when they were recorded.
- `recorded`: the review as it happened: `outcome`, `provider`, `model`, `effort`, `tokens`, `durationMs`, `refused` (each `{ criterionIndex, detail, complete }`; `complete: false` when only a prefix survives) and `verdicts` (every criterion's, when the full answer survives, else null).
- A seeded record adds `seeded: { from, file, description }` and keeps its labels inline (`labels`, as in `labels.json`); it has no `recorded`.

`labels.json` maps a record id to `{ refusals, defects }`. Each refusal is `{ criterionIndex, defect, defectId?, category?, justification, labelledBy }`: whether the recorded refusal had a real defect behind it, with the evidence. Each defect is `{ id, criteria, description, evidence, labelledBy }`: a defect the candidate has, and the criteria it violates. `labelledBy` says who decided (`draft` until a person confirms it). The candidate commits come from `--repo`, a clone of the reviewed repository, or the set's bundle: the harness clones `--repo` into a scratch directory, with its own objects and `--repo`'s origin (a reviewer that validates the candidate, as the new one does, reads only the clone, and fetches Git LFS objects from origin), fetches the bundle into it, and checks each record's commit has its recorded tree before reviewing it. Nothing is written to `--repo`.

### Reviewers

The reviewer is the build's own, driven through its review entry point by an adapter per reviewer generation, in `bench/lib/reviewers/`. An adapter exports `id`, `fits(result, build)` (whether it drives this build, given its `dist/review/result.js`), `needsTree` (whether it wants a fresh checkout of the candidate tree, given as `tree`), optionally `prepare({ build, set, cache, record, checkout, signal })`, run once per record before any review and timed apart (what production has ready before a review, such as a warm install store), and `review({ build, set, cache, prepared, record, checkout, tree, dir, provider, signal, log })`, which returns `{ verdicts, extra? }`: one verdict per criterion, each `{ criterionIndex, kind, detail, repro? }`, `kind` `pass`, `refuse`, `question` or `note`, and `extra`, what else it reports, kept in the result (its `phases` join the result's). `prepared` is what `prepare` returned; `cache.record` is the record's directory for what its runs share, and `cache.shared` (`--cache DIR`, by default `~/.cache/factory-bench/review-replay`, outside the set) what every replay shares, such as install stores. `--reviewer auto` (the default) takes the first that fits the build, newest first.

- `v1`: the reviewer up to #2344. It calls the build's `reviewResult` with the build's planner for the provider (`providerPlanner`), fresh: no retained conversation, no operator decisions, no earlier verdicts, no repository memory. It judges every criterion of the record.
- `v2`: the reviewer of #2344, in the build's `dist/review/item.js`. It calls the build's `reviewResult` there with the item's own acceptance (the first `itemCriteria` criteria, so indices match), the build's scratch checkouts (`validationScratch`) for the reviewer's commands and the refusal check, and the item's mutation pass (`mutationPass`), which, as in Factory's validate step, runs in a validation of the candidate (`validateTree`). Its `prepare` gives each item a warm install store, as the validate step keeps one per item and one per Objective (#2280): one install fills it, and every validation, scratch checkout and repro check gets it after that. The mutation pass runs there too, once per record, kept in `cache.record`. The installation's sandbox, validation and review settings come from the set's `config.json`, read with the build's `loadConfig`. Its refusals are the confirmed ones; `extra` has the repros confirmed and dropped and the mutation pass, and its `phases` the mutation pass's time (`mutationMs`), making scratch checkouts (`scratchCheckouts`, `scratchPrepareMs`), the reviewer's commands (`commands`, `commandsMs`, inside the model calls' time) and the repro checks (`repros`, `reprosMs`). It validates as Factory does, so run it with the service's `PATH` (the runtime, the package manager and any toolchain the repository's commands need).
- `recorded`: no model. The recorded verdicts, scored like a replay, with the recorded tokens and time: the baseline the history itself sets.

Each review is bounded by `--timeout-minutes` (20). Tokens are the reviewer's own model calls, from the build's `model-usage` log events; time is the review's wall clock, with `phases.modelCalls` and `phases.modelMs` the calls' count and time. Each result's `reviewers` are the provider, model and effort its calls ran on, with the model the provider reported (`reportedModel`); the scorecard's `setting` is what was asked for, `from` the flags or the build's default (Codex's reviewer is `gpt-6.1-sol` at `medium`), and `reported` what the calls reported. Reviews run one at a time by default (`--concurrency`, recorded in the scorecard), so one doesn't stretch another's wall time; run more only within the host's share of CPUs.

### Scores

Each run is scored apart, then summarized (mean, min and max over the runs); seeded records are reviewed once and scored apart.

| Score                               | What                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `refusedReviews`, `reviewPrecision` | Reviews with any refusal, and the share of them with at least one real refusal    |
| `refusals`, `refusalPrecision`      | Refused criteria, and the share with a real defect behind them                    |
| `defects`, `caught`, `recall`       | Known defects over the records, and those refused                                 |
| `distinctDefects`, `distinctCaught` | The same, counting a defect once per item however many of its records have it     |
| `questions`, `notes`                | Verdicts of those kinds                                                           |
| `tokens`, `ms` (and per review)     | Cost                                                                              |
| `errors`                            | Reviews with no verdict: the reviewer failed, or the candidate wasn't found       |
| `unmatched`                         | Replayed refusals no labelled defect covers, with their details, to label by hand |

A recorded refusal is real when its label says so: the label judges its reason. A replayed refusal is real when the record has a labelled defect whose `criteria` include it; the harness doesn't read its reason, so `unmatched` lists the rest for a person, and a replayed refusal of a defect's criterion for another reason still counts. A defect is caught when a real refusal maps to it.

Results go to `<set>/results/<label>/`: `runs/<n>/<record id>.json` per review, reused by a later invocation (so an interrupted replay carries on) unless `--fresh`, except a review that failed, which runs again; and `scorecard.json`. The label defaults to the reviewer, provider, model and effort.

| Flag                                | What                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `--bench-home DIR`, `--set DIR`     | The bench home (its `review-replay/`), or the set itself               |
| `--repo DIR`                        | A clone of the reviewed repository                                     |
| `--build DIR`                       | The Factory checkout whose reviewer runs (its `dist/`; this checkout)  |
| `--reviewer auto\|v1\|recorded`     | The adapter                                                            |
| `--provider`, `--model`, `--effort` | The planner kind (`codex`), and the reviewer's model and effort        |
| `--runs N`, `--concurrency N`       | Reviews of each record (1), and reviews (and preparations) at once (1) |
| `--cache DIR`                       | What every replay shares, such as install stores                       |
| `--seeded`, `--only ID ...`         | Add the seeded records; only these records                             |
| `--label NAME`, `--fresh`           | The results' name; review again what earlier results hold              |
| `--timeout-minutes N`               | Each review's bound (20)                                               |

## The example

`bench/examples/acme-widgets-42.json` is an invented benchmark: an Objective, acme/widgets#42, that adds a query tokenizer, a query API, a CSV export and a read-only smoke check of the release. Nothing in it is real. The tests score an invented run of it, written by `test/fixtures/bench/generate.mjs` into `test/fixtures/bench/acme__widgets/`: three run files, Factory 0.5.7 and then 0.5.8, operator-assisted. `fixtureRepository` in the same file builds its run repository with Git, `test/fixtures/bench/grader.mjs` is a stand-in grader, and `test/fixtures/bench/judge.mjs` a stand-in judge with fixed preferences (quoted CSV values on intent, the shorter export on quality). Its scorecard shows what each part of the scorecard counts:

|                                                    | Scorecard                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Grade                                              | 60%: 3 of 5 criteria pass, 1 fails (the CSV row limit), 1 unknown (the release build needs a display); the grader's `mutationScore` 0.75       |
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
