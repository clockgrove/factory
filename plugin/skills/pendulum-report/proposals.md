# Model-usage proposals

Write these only when the user asks for them: what to try, which model, effort or setting to measure where. Never as part of a plain report, never on your own, and never unattended.

## Who writes them

A named decision model writes them: the model the user names, else Fable 5.2 (`claude-fable-5-2`). You, the session, run every `pendulum report` the proposals read first (with `--rates` when ratios are wanted, below). Then, where this harness can start a sub-agent on that model, give it the report JSON and this page, and relay its proposals as it wrote them; the sub-agent runs nothing. Where it cannot, or that model is not on this login, write them yourself and name your own model as the writer. Never name a model that did not write them.

## What they read

The report JSON you already have, and nothing else: no issue, PR, transcript or log. For a ratio of rates, run the report again with the candidate models: `pendulum report --json [scope] --rates MODEL[,MODEL...]`, each candidate a model id from a row of `<plugin root>/scripts/lib/codex-prices.json`. Pendulum then gives, in `rates.items`, each candidate's published rates over a recorded model's, on that model's recorded token mix (its long-context share at the long-context rates), for models of one vendor only, and in `rates.skipped` why a model or pair has none, with its `text`. Pendulum holds no rates for Anthropic's models (Claude Code reports its own dollars), so there is no ratio for a Claude model: say so, and propose an experiment instead.

## Each proposal

A few at most, each built from the figures as the JSON gives them, in four parts, in this order:

1. **Observation**: what the report shows. Cite every figure by the exact JSON path of the row it came from, with the row's key, for example `breakdowns.model[1]` (`key` `gpt-6-sol`) `cost.usd.api` and `stages`; a figure with no row cited is left out.
2. **Hypothesis**: what a change of model, effort or setting might move, and which measure would show it: dollars per merged Objective, model minutes, wall clock, review rounds, fix passes, or the review findings and their outcomes.
3. **Experiment**: the one that would measure it.
   - A Claude reviewer's model or effort, for a user who has Pendulum's private replay set (the replay runs Claude Code only, on that set): `node <pendulum clone>/bench/review-replay.mjs --set DIR --repo DIR --model NAME --effort LEVEL --label NAME`, once with the current model as the baseline and once with the candidate (recall and noise per record). Any other reviewer, or without the set: an A/B on real Objectives with `pendulum:reviewer-model:<id>`, below.
   - The worker's model, effort or skills: the medium drill set on a scratch repository (never the user's product repository), `node <pendulum clone>/bench/drill.mjs --repo OWNER/SCRATCH --set medium --count 5 --dispatch`, once per arm, with the scratch repository's workflow setting for the arm (`PENDULUM_MODEL`, or `PENDULUM_EFFORT`) set before each.
   - On real Objectives: an A/B. Label each arm's Objectives `pendulum:experiment:<name>`, and set each arm's choice itself, by a label on each of its Objectives or the workflow setting:
     - `pendulum:model:<id>`: the worker, and its fix and answer passes (`PENDULUM_MODEL`);
     - `pendulum:reviewer-model:<id>`: the reviewer (`PENDULUM_REVIEWER_MODEL`);
     - `pendulum:subagent-model:<id>`: the implementer sub-agents (`PENDULUM_SUBAGENT_MODEL`);
     - `pendulum:harness:<name>`: `claude`, `codex` or `copilot` (`PENDULUM_HARNESS`; the models no label names become that harness's defaults).

     Then compare with `pendulum report --compare A,B`.
4. **Command**: the exact commands to run, with the names from the report filled in; a placeholder only for what the report cannot know (the replay set's directory, the scratch repository).

## Rules

- **No counterfactual dollars, ever.** Never write what a model, an effort or a setting would have cost, saved or spent, or would cost, save or spend: no dollar figure, range, bound or percentage of dollars that the JSON does not hold. A dollar figure in a proposal is one the JSON holds, cited.
- A rate ratio only from `rates.items`, as given, said as "N× the published rates on the recorded token mix" with its `rates.basis`: never with a dollar sign or unit, never as a percentage, "cheaper" or a saving, never multiplied by a dollar figure, and never across vendors.
- Review findings (`findings`, when the report has it): a reviewer's findings, their outcomes and its review stages' `cost` side by side from one `findings.byReviewer` row, each cited; no new figure divided out of them.
- Hot spots are ranked facts: cite them as ranked, and call none too high. There is no threshold.
- A comparison's arms: their figures as given, no difference called significant.
- Run nothing but `pendulum report` itself, which only reads: no other command, label, filing or dispatch. Each proposed command is the user's to run.

## The output

Head the proposals with one line, then the proposals, numbered:

> Proposals: a judgement by <model>, not a figure of Pendulum's. Rows read: <every JSON path cited below>.

`<model>` is the writer's model id, as above.
