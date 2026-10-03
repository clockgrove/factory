# Planning evals

`scripts/eval-planning.mjs` measures planning quality on a set of real Objectives. Use it to compare planner prompt versions, models or planning providers on the same inputs before changing a default.

Each run uses the same code as `factory plan`: pinned sources, compile, independent plan review and at most one revision. It creates no GitHub issues and starts no workers. Live runs spend your planning provider's usage.

## Run

```sh
npm run build
node scripts/eval-planning.mjs \
  --cases /path/to/eval-set \
  --target /path/to/target-checkout \
  --config /path/to/factory-config.json \
  --output /path/to/new-output-dir \
  --repeat 3
```

| Option                    | Meaning                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--cases DIR`             | Eval set: one subdirectory per case.                                                                           |
| `--target CHECKOUT`       | Target repository checkout for cases without their own `target`. It is cloned per run and never modified.      |
| `--config FILE`           | A Factory configuration. Its `planning` block selects the provider and models. `checkout` is ignored.          |
| `--output DIR`            | New or empty directory for the report.                                                                         |
| `--repeat K`              | Runs per case, to measure variance. Default 1.                                                                 |
| `--parallel N`            | Concurrent runs. Default: available parallelism / 4.                                                           |
| `--case NAME`             | Run only this case. Repeatable.                                                                                |
| `--planning-model MODULE` | Use a module exporting `createPlanningModel({ config, directory })` instead of the configured `PlanningModel`. |

Runs inherit your environment: Codex planning uses your Codex login, and `claude-api` planning reads the key named by `planning.credentialEnv`. To compare settings, run the same eval set once per configuration file and compare the two `summary.md` tables.

A failed plan is a result, not a harness error: the script still writes the report and exits 0. An invalid case or option exits 2 before any model call.

## Cases

Keep private eval sets outside this repository. A case directory contains:

- `objective.md`: the Objective issue body.
- `case.json`:

```json
{
  "commit": "<full SHA in the target>",
  "sources": ["docs/SPEC.md#Scope"],
  "repository": "owner/name",
  "objective": 1,
  "target": "../relative/checkout"
}
```

Only `commit` is required. Use a full SHA so the case stays repeatable; a branch name resolves at start, and the report records the SHA. `sources` uses the `factory plan --source PATH#HEADING` syntax. `repository` defaults to the configuration's repository and `objective` to 1.

[`test/fixtures/eval/`](../test/fixtures/eval/) holds a public example for the [`autonomous-target`](../test/fixtures/autonomous-target/) fixture. Commit that fixture to a new Git repository on `main` to use it as `--target`.

## Report

`report.json` has one entry in `runs` per case and repeat, and one aggregate per case in `cases`:

| Field          | Meaning                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `planned`      | A plan candidate was produced.                                                                                                                |
| `review`       | `clean`; `findings` (unresolved review findings); or `question` (review was invalid or the revision failed).                                  |
| `findingCount` | Unresolved review findings. `findings` and `failure` hold their text.                                                                         |
| `revisions`    | Planning revisions used, 0 or 1.                                                                                                              |
| `workItems`    | Work Items in the plan.                                                                                                                       |
| `invocations`  | Planning model invocations: total, completed, failed, without usage, and per phase.                                                           |
| `tokens`       | Token totals from model observations, when the provider reports usage. Read with `invocations.usageUnavailable`; a missing count is not zero. |
| `wallMs`       | Planning wall time.                                                                                                                           |
| `error`        | Why the run produced no plan.                                                                                                                 |
| `plan`         | The saved plan candidate.                                                                                                                     |

`summary.md` shows the per-case table. Each run's `runs/CASE-K/` directory keeps its plan, worker log and private diagnostics.
