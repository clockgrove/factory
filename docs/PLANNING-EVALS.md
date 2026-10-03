# Planning evals

`scripts/eval-planning.mjs` measures planning quality before a prompt, model or provider change ships. It never creates GitHub issues or starts workers. Live runs spend your planning provider's usage. Run `npm run build` first.

## Modes

| Mode            | What it does                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| plan (default)  | Plans each case with `planObjective`, the path `factory run` uses, including revisions within the config's `autonomy` allowances. Reports the production review, each frozen judge and judge-free metrics. |
| `--review-only` | Sends known-good plans and plans with one injected defect to the production reviewer. Reports recall per defect and the false-positive rate.                                                               |
| `--compare A B` | Compares two `report.json` files of the same mode, paired by case.                                                                                                                                         |

```sh
# Plan the public cases 5 times each and grade them with both frozen judges.
node scripts/eval-planning.mjs --config factory.json --output out/a --repeat 5 \
  --judge evals/judges/strict-rubric-v1-claude.json \
  --judge evals/judges/strict-rubric-v1-codex.json

# Seeded-defect review suite.
node scripts/eval-planning.mjs --review-only --config factory.json \
  --output out/review --repeat 5

# Did B improve on A?
node scripts/eval-planning.mjs --compare out/a/report.json out/b/report.json
```

| Option                     | Meaning                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--config FILE`            | A Factory configuration. Its `planning` block picks provider and models; `autonomy` bounds revisions. `checkout` is ignored. |
| `--output DIR`             | New or empty directory for `report.json` and `summary.md`.                                                                   |
| `--cases DIR`              | Case directory. Repeatable. Default `evals/cases`.                                                                           |
| `--case NAME`              | Run only this case (or review fixture). Repeatable.                                                                          |
| `--target CHECKOUT`        | Checkout for private cases that name only a commit.                                                                          |
| `--repeat N`               | Runs per case. Use at least 5 for a decision. Default 1.                                                                     |
| `--parallel N`             | Concurrent runs. Default: available parallelism / 4.                                                                         |
| `--judge FILE`             | Grade each plan with this frozen judge. Repeatable: several judges form a panel.                                             |
| `--fixtures DIR`           | Review fixtures for `--review-only`. Default `evals/review`.                                                                 |
| `--planning-model MODULE`  | Module exporting `createPlanningModel({ config, directory })`, replacing the configured planner and reviewer.                |
| `--judge-transport MODULE` | Testing only: module exporting `createJudgeTransport({ judge, checkout })`. The report records it.                           |

Runs use your provider login: the Codex login for `codex-sdk`, the Claude Code login for `claude-agent-sdk`. A failed plan is a result; the script still writes the report and exits 0. An invalid case, judge, config or option exits 2 before any model call and leaves the output directory empty.

To compare planner or reviewer versions, change one thing per report and compare. A 2×2 of old/new planner × old/new reviewer is four reports.

## Numbers

Rates show a 95% interval clustered by case (by fixture in review-only mode), because repeats of one case are not independent. The interval is the wider of a case-level bootstrap and a Wilson interval on the number of cases, so more cases narrow it more than more repeats. `--compare` shows mean(B − A) per case with a paired-bootstrap 95% interval. An interval that contains 0 is no evidence of a change.

| Number                          | Meaning                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Production review clean         | The plan ended clean, with no review findings or questions.                                                             |
| Judge pass                      | A frozen judge passed all seven dimensions. Shown per judge, separately from the production review.                     |
| Judges agree                    | How often two judges gave the same verdict, with both-pass, both-fail and one-fails counts.                             |
| Case expectation met            | The case's `expect` held: outcome (`plan` or `question`), required checks, size, critical path, read-only.              |
| First try                       | How the first compile ended: `accepted`, `review-findings`, `review-invalid`, `parse`, `semantic:<field>`, `provider`.  |
| Final review for command        | Coverage that leaves a command-shaped criterion to final review. Should be 0.                                           |
| Own-lifecycle acceptance        | Work Item acceptance that mentions merge, upload, publication or hydration. Should be 0.                                |
| Ungrounded CI                   | Named CI checks that appear in no pinned source or workflow file. Should be 0.                                          |
| Critical path, items, revisions | Longest dependency chain, Work Items, planning revisions.                                                               |
| Tokens, wall                    | Planning tokens (judge tokens are separate) and planning wall time.                                                     |
| Recall (review-only)            | The reviewer returned a finding for a plan with that defect. Localized: a finding names the item or defect (heuristic). |
| False positive (review-only)    | The reviewer returned a finding for a known-good plan. Compared separately from recall.                                 |
| Caught by compile validation    | A seeded defect that deterministic validation already refuses; it never reaches review.                                 |

The seeded defects are: invented CI check name, acceptance that needs the item's own merge or upload, native-stack dependency assumed merged, final review replacing a required command, missing file ownership, missing dependency, and a worker-written test as the only proof.

## Frozen judges

A judge in `evals/judges/` is a JSON spec (provider, model, effort, prompt file, prompt SHA-256). Two ship with the same rubric: `strict-rubric-v1-claude` (Claude Agent SDK) and `strict-rubric-v1-codex` (Codex SDK). Both see only the input, with no tools or repository access.

- Never edit a frozen judge in a prompt PR, because a judge tuned with the prompt it grades measures nothing. Add a new judge file with a new name instead.
- A judge is never the production reviewer prompt, because the reviewer cannot grade itself.
- To compare planners on different providers, use the judge on the other provider, or both, because a judge may favour its own provider's plans. Run both judges by default; their agreement shows how much to trust either.
- `--compare` compares a judge's numbers only when both reports used that judge with the same digest.

A judge's digest covers its spec and prompt, the output schema, the input and prompt builders, and the provider's fixed system prompt. The test suite pins each digest, so any of those changes fails CI.

## Cases

Public cases live in `evals/cases/`. Keep private cases outside this repository and pass them with `--cases`. A case directory has `objective.md` (the Objective body) and `case.json`:

```json
{
  "fixture": "../../targets/node-lib",
  "tags": ["native-stack", "required-ci"],
  "expect": { "outcome": "plan", "requiredChecks": ["unit-tests"] }
}
```

- `fixture`: an in-repo target tree under `evals/targets/`. It is committed with fixed metadata, so its SHA is the same everywhere. Names starting with `dot-` become dotfiles.
- For a private case use `commit` and optionally `target` (a checkout; default `--target`) instead of `fixture`. Use a full SHA so the case stays repeatable; a branch resolves at start and the report records the SHA.
- `sources` adds `PATH#HEADING` selectors like `factory plan --source`. Prefer the Objective's own `## Planning sources`, which `factory run` reads.
- `repository` defaults to the configuration's; `objective` defaults to 1.
- `expect` is optional: `outcome`, `requiredChecks`, `maxWorkItems`, `maxCriticalPath`, `readOnly`, and `questionPattern`, a regular expression the operator question must match when `outcome` is `question`. Planning that stops on an undelegated decision also counts as a question.

Predecessor cases are text only: the eval serves no predecessor Objectives, so `planningPrerequisites` evidence never reaches the planner. They test how the planner reads an Objective that names a predecessor, not native prerequisite admission.

Review fixtures live in `evals/review/<name>/fixture.json`: the case they plan, a known-good authored graph (coverage names criteria by index), `native` for native-stack delivery, and an optional `workerTest` command. The harness derives each defect from the good graph.

## Report

`report.json` has `runs` (one per case and repeat, or per review), `summary`, and `units` (per-case means used by `--compare`). Each plan run keeps its plan, worker log and diagnostics under `runs/CASE-K/`.
