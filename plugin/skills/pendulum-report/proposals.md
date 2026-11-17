# Model-usage proposals

Write these only when the user asks what to try: which model, effort or setting to use where, or how to spend less for the same work. Never as part of a plain report, never on your own, and never unattended.

## Who writes them

A named decision model writes them: the model the user names, else Fable 5.2 (`claude-fable-5-2`). Where this harness can start a sub-agent on that model, give it the report JSON and this page, and relay its proposals as it wrote them. Where it cannot, or that model is not on this login, write them yourself and name your own model as the writer. Never name a model that did not write them.

## What they read

The report JSON you already have, and nothing else: no issue, PR, transcript or log. For a ratio of rates, run the report again with the candidate models: `pendulum report --json [scope] --rates MODEL[,MODEL...]`. Pendulum then gives, in `rates.items`, each candidate's published rates over a recorded model's, on that model's recorded token mix, for models of one vendor only, and in `rates.skipped` why a pair has none. Anthropic's models have no rate table (Claude Code reports its own dollars), so there is no ratio for a Claude model: say so, and propose an experiment instead.

## Each proposal

A few at most, each built from the figures as the JSON gives them, in four parts, in this order:

1. **Observation**: what the report shows. Cite every figure by the exact JSON path of the row it came from, with the row's key, for example `breakdowns.model[1]` (`key` `gpt-6-sol`) `cost.usd.api` and `stages`; a figure with no row cited is left out.
2. **Hypothesis**: what a change of model, effort or setting might move, and which measure would show it: dollars per merged Objective, model minutes, wall clock, review rounds, fix passes, or the review findings and their outcomes.
3. **Experiment**: the one that would measure it.
   - The reviewer's model or effort: the replay set, `node <pendulum clone>/bench/review-replay.mjs --set DIR --repo DIR --model NAME --label NAME`, once with the current model as the baseline and once with the candidate (recall and noise per record).
   - The worker's model, effort or skills: the medium drill set on a scratch repository (never the user's product repository), `node <pendulum clone>/bench/drill.mjs --repo OWNER/SCRATCH --set medium --count 5 --dispatch`, once per arm.
   - On real Objectives: an A/B. Label each arm's Objectives `pendulum:experiment:<name>`, set each arm's model, effort or setting itself (a `pendulum:model:<id>` label, or the workflow setting), then compare with `pendulum report --compare A,B`.
4. **Command**: the exact commands to run, with the names from the report filled in; a placeholder only for what the report cannot know (the replay set's directory, the scratch repository).

## Rules

- **No counterfactual dollars, ever.** Never write what a model, an effort or a setting would have cost, saved or spent: no dollar figure, range, bound or percentage of dollars that the JSON does not hold. A dollar figure in a proposal is one the JSON holds, cited.
- A rate ratio only from `rates.items`, as given, said as "N× the published rates on the recorded token mix" with its `rates.basis`: never with a dollar sign or unit, never multiplied by a dollar figure, and never across vendors.
- Review findings (`findings`, when the report has it): a reviewer's findings, their outcomes and its review stages' `cost` side by side from one `findings.byReviewer` row, each cited; no new figure divided out of them.
- Hot spots are ranked facts: cite them as ranked, and call none too high. There is no threshold.
- A comparison's arms: their figures as given, no difference called significant.
- Run nothing: no command, label, filing or dispatch. Each command is the user's to run.

## The output

Head the proposals with one line, then the proposals, numbered:

> Proposals: a judgement by <model>, not a figure of Pendulum's. Rows read: <every JSON path cited below>.

`<model>` is the writer's model id, as above.
