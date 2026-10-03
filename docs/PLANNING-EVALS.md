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
| `--judge-transport MODULE` | Testing only: module exporting `createJudgeTransport({ judge })`. The report records it.                                     |

Runs use your provider login: the Codex login for `codex-sdk`, the Claude Code login for `claude-agent-sdk`.

Each plan run ends with one outcome:

- `plan`: a clean plan.
- `question`: planning stopped for an operator. Either the plan waits for a decision, or the controller refused with `PlanningNeedsDecision` before it had a plan.
- `error`: a crash, timeout, provider outage or harness failure.

Errors are counted but carry no quality metrics. They are left out of every rate and every comparison.

Exit codes:

- 0: every run and judge call completed, whatever the plans' quality.
- 1: at least one run or judge call errored. The report is still written.
- 2: an invalid case, judge, config or option, caught before any model call. The output directory is left empty.

Each run records the host-dependent planning inputs (`host.localExecutables`, `host.capacity`), so runs on different machines can be told apart.

To compare planner or reviewer versions, change one thing per report and compare. A 2×2 of old/new planner × old/new reviewer is four reports.

## Numbers

Rates show a 95% interval clustered by case (by fixture in review-only mode), because repeats of one case are not independent. The interval is the wider of a case-level bootstrap and a Wilson interval on the number of cases, so more cases narrow it more than more repeats.

`--compare` pairs units that both reports ran on identical inputs: same Objective and commit, and in review mode the same plan variants. Review units are pooled per fixture. For each metric it reports:

- mean(B − A), with a paired-bootstrap 95% interval;
- an exact sign-flip p-value, and its floor (the smallest p-value that number of units can reach).

One metric is primary and reported unadjusted: production clean in plan mode, review recall and false positives in review-only mode. All other metrics are Holm-adjusted, including each judge's pass rate. A metric with fewer than 5 paired units is marked insufficient and gets no interval or p-value. An interval that contains 0 is no evidence of a change.

| Number                           | Meaning                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production review clean          | The plan ended clean, with no review findings or questions.                                                                                                            |
| Judge pass                       | A frozen judge passed all seven dimensions. Shown per judge, separately from the production review.                                                                    |
| Judges agree                     | How often two judges gave the same verdict, Cohen's kappa, and both-pass, both-fail and one-fails counts.                                                              |
| Case expectation met             | The case's `expect` held: outcome (`plan` or `question`), required checks, size, critical path, read-only.                                                             |
| First try                        | How the first compile ended: `accepted`, `review-findings`, `review-invalid`, `parse`, `semantic:<field>`, `provider`.                                                 |
| Final review for command         | Criteria whose text is exactly one code span (the rule Final validation uses for a command line), not a Final validation command, proved by final review. Should be 0. |
| Proof kinds, final-review proofs | Coverage proofs per kind (result command, semantic, QA, CI, final review).                                                                                             |
| Ungrounded CI                    | Named CI checks that no workflow job produces (job `name`, or job id). Should be 0.                                                                                    |
| Critical path, items, revisions  | Longest dependency chain, Work Items, planning revisions.                                                                                                              |
| Tokens, wall                     | Planning tokens (judge tokens are separate) and planning wall time.                                                                                                    |
| Recall (review-only)             | The reviewer returned a finding for a plan with that defect. Recall counts the review status only; findings carry no structured pointer to items yet.                  |
| False positive (review-only)     | The reviewer returned a finding for a known-good plan. Compared separately from recall. Invalid reviews count in neither.                                              |
| Caught by compile validation     | A seeded defect that deterministic validation already refuses; it never reaches review.                                                                                |

Each seeded defect breaks exactly one rule:

- an invented CI check name;
- acceptance that needs the item's own merge or upload;
- a native-stack dependency assumed merged;
- final review replacing a command that an Acceptance bullet consisting of exactly that command line requires (Final validation commands are exempt);
- missing file ownership;
- a missing dependency;
- the item's own new test as the only proof of a source-required behavior that the good plan leaves to independent review. Every command stays in place.

Judge-free metrics count structured fields only: proofs, commands, workflow jobs, dependencies and diagnostics. They never interpret prose. Questions that need interpretation, such as acceptance that depends on the item's own merge, belong to the judges' rubric.

## Frozen judges

A judge in `evals/judges/` is a JSON spec: provider, model, effort, prompt file and prompt SHA-256. Two ship with the same rubric: `strict-rubric-v1-claude` (Claude Agent SDK) and `strict-rubric-v1-codex` (Codex SDK). Neither sees production review findings or the production review status.

Judges run in a separate process inside a bubblewrap mount namespace (Linux, with unprivileged user namespaces). The namespace holds only:

- the system directories;
- the Factory code the judge runs;
- a scratch directory;
- the provider logins, bound so token refreshes reach the operator.

Everything else does not exist inside, including `/home`, `/tmp`, the eval's output, sibling runs' plans and checkouts. The working directory is an empty Git repository. `HOME` is in the scratch directory. `CODEX_HOME` holds the login and the judge's own `config.toml`, which turns off shell, file, web, app, plugin and agent tools; the operator's `config.toml` and `AGENTS.md` never apply. Only an allowlist of environment variables passes in. Claude judges also run with no tools, MCP servers, agents, plugins or settings.

A Codex judge is refused, with exit 2, when the sandbox is unavailable. A Claude judge then runs in a plain child process. In plan mode, judges grade after the checkout is removed and before the plan reaches disk. In review-only mode, they grade after every review. The scratch directory is deleted afterwards.

- Never edit a frozen judge in a prompt PR, because a judge tuned with the prompt it grades measures nothing. Add a new judge file with a new name instead.
- A judge is never the production reviewer prompt, because the reviewer cannot grade itself.
- To compare planners on different providers, use the judge on the other provider, or both, because a judge may favour its own provider's plans. Run both judges by default; their agreement shows how much to trust either.
- `--compare` compares a judge's numbers only when both reports used that judge with the same digest.

A judge's digest covers:

- its spec and prompt;
- the input, prompt and repository-fact builders;
- the decoder and the isolation code;
- the resolved provider options: Claude's thinking, turns, tools, system prompt and transformed output schema, or Codex's thread options and output schema;
- the provider SDK versions in `package-lock.json`.

The test suite pins each digest, so a change to any of these fails CI.

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
- Sources come from the Objective's own `## Planning sources`, as in `factory run`.
- `repository` defaults to the configuration's; `objective` defaults to 1.
- `expect` is optional: `outcome`, `requiredChecks`, `maxWorkItems`, `maxCriticalPath`, `readOnly`. A `question` outcome is met when planning stopped for an operator: a plan waiting for a decision, or the controller's undelegated-decision refusal. Whether it asked the right question is the judges' `scope` dimension.

Predecessor cases are text only: the eval serves no predecessor Objectives, so `planningPrerequisites` evidence never reaches the planner. They test how the planner reads an Objective that names a predecessor, not native prerequisite admission.

Review fixtures live in `evals/review/<name>/fixture.json`. Each holds the case it plans, a known-good authored graph (coverage names criteria by index), `native` for native-stack delivery, and an optional `workerTest` command. The harness derives each defect from the good graph. A defect only applies where its rule can hold. For example, final review can replace a command only when an Acceptance bullet is exactly that command line.

## Report

`report.json` has `runs` (one per case and repeat, or per review), `summary`, and `units` (per-case means used by `--compare`). Each plan run keeps its plan, worker log and diagnostics under `runs/CASE-K/`.
