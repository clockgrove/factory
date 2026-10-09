# Factory product direction

## The outcome

Give Factory a human-written Objective, check in from a phone a few times a day, and receive a well-built app with a trustworthy GitHub record of how it was delivered.

Factory should keep making useful progress between check-ins. The operator needs a short account of what finished, what is running, what is blocked and which decisions need attention. GitHub provides the detail: Objectives, dependency-linked Work Items, pull requests, acceptance evidence and Project status.

This is the agreed product direction, not a claim that every part is implemented. The [user guide](USER-GUIDE.md) describes current behavior, and the [architecture](ARCHITECTURE.md) describes the contracts that changes must preserve.

## Priorities

1. **Low-touch delivery.** Reduce supervision and context reconstruction. Make useful progress between operator check-ins and ask clear, actionable questions when a human owns a decision.
2. **App quality.** Deliver correct, usable, robust and maintainable software. Assess the app separately from the number of tests or review calls.
3. **Continuity and tracking.** Preserve accepted work, pending obligations, decisions and accounting across sessions and restarts. Keep GitHub consistent with the verified delivery state.
4. **Reasonable time and cost.** Avoid egregious latency and unnecessary provider usage. Slower delivery can be worthwhile when it produces demonstrably better quality or less operator effort. Record cached and uncached input and accounting coverage; token totals are not dollar costs.

Speed is a guardrail rather than the primary success metric. Extra planning or review must have an identifiable purpose and its benefit should be measured.

## The operating experience

The operator approves an Objective and its targets, providers, permissions and finite resource limits. Factory runs the approved work while its configured host and background service are available. A phone check-in should be sufficient to understand progress and handle the human-owned choices supported by the product.

Each check-in should answer:

- What was delivered and independently accepted?
- What is running, and what will happen next?
- What is blocked, and does Factory need the operator or an external prerequisite?
- Which decisions require attention, what is the recommendation, and what changes with each answer?

Keep technical details and evidence available through GitHub links. Group known related questions instead of requiring a sequence of small interruptions. A technical failure alone does not establish that a human decision is required: use supported, authorized recovery within the recorded bounds when it exists. Unresolved external effects and exhausted allowances remain visible stops.

Continue independent work only where dependency, ownership and sequencing contracts permit it. The current background queue is sequential and stops when its active Objective needs a human decision. Continuing other admitted work past that stop is an open design question, not an existing capability or permission to bypass the queue.

## Build on the existing product

Factory already has persistent continuation state, a local coordinator, background setup, GitHub intake and bounded recovery. Improve those surfaces rather than introducing another state store, hosted service or operator dashboard by default.

Keep normal implementation close to the supported agent harness. Compilation should settle ambiguous requirements, shared interfaces, ownership and proof responsibilities, then supply a usable assignment with authoritative context. Independently useful components may form a parallel DAG; small coherent changes may remain one item. Planning effort should follow the uncertainty and risk of the Objective.

Give each review a distinct responsibility. Work Item review checks its contract against the exact result; integrated review examines original Objective criteria and cross-component behavior. Reuse authenticated source evidence and receipts to avoid reacquiring identical context. Final acceptance still requires independent assessment of the integrated result; earlier verdicts do not become final acceptance.

Use existing model profiles deliberately. The current cleanup qualification and following direct-Codex comparison use the same supported model throughout, with reasoning effort tuned by phase. Lower reasoning is a candidate for narrow, settled work; UI and integration assignments need their own quality evidence. Compare cheaper models separately after this baseline. Preserve compiled assignments and provider limits; this direction does not authorize runtime fallback or broader recovery.

## Evidence and measurement

The completed bounded full-stack comparison did not demonstrate Factory acceleration or dollar savings. Same-model Factory supplied stronger verification but took longer than the recorded direct route. The mixed-model result required repair and had weaker authored proof and visible metric explanation. Neither establishes a generally better app or a cheaper-worker default. The [published scorecard](https://github.com/clockgrove/factory/issues/894#issuecomment-6081418952) records the outcomes and accounting limits.

Extend the existing scorecard for sustained delivery, keeping these dimensions separate:

| Dimension           | Evidence to collect                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Operator effort     | Actual attention time when measured, check-ins, interventions, redirections and context reconstruction; elapsed operator wait separately               |
| App quality         | Independent correctness, robustness, usability/design, maintainability and scope assessment on exact generated results                                 |
| Verification        | Meaningful authored checks, preserved regressions and uncovered requirements; passing counts alone do not prove quality                                |
| Continuity          | Accepted work preserved, correct next action after a restart or handoff, reconciliation outcomes and duplicate work/effects avoided                    |
| GitHub tracking     | Accurate issues, dependencies, PRs, acceptance evidence and Project status; visible uncertainty and supported decisions                                |
| Delivery efficiency | Accepted throughput, full elapsed time, critical path, review/repair overhead, model and tool calls, cached/uncached input and accounting completeness |

The next qualification should use a small admitted development queue over multiple sessions, declared phone-style check-in windows, a controlled restart or handoff, and a human-owned decision. Predeclare equivalent substantive acceptance and independent quality assessment, including any direct-harness comparison. Include setup, review, repair, operator involvement and all selected failures. Preserve unknown usage and sample limits; do not infer benefits from failed or unfinished runs.

## Follow-up work

The [direction issue #982](https://github.com/clockgrove/factory/issues/982) coordinates three linked outcomes:

- [#983: GitHub phone check-ins](https://github.com/clockgrove/factory/issues/983), including fresh progress and a supported human-decision journey.
- [#984: Low-touch qualification](https://github.com/clockgrove/factory/issues/984), covering multiple sessions, measured operator involvement and a controlled restart or handoff.
- [#985: Proportional planning and review](https://github.com/clockgrove/factory/issues/985), preserving independent acceptance while addressing evidenced overhead and qualifying worker selection.

A baseline may record current phone-management limitations. Full qualification of that journey requires the supported outcome from #983. Existing receipts can inform overhead diagnosis before another live milestone. Filing these issues does not start implementation or a paid run.

## Boundaries

Capture and qualify the new direction before claiming unattended phone management works. This note creates no schedule, deployment, spending increase, mobile app, cloud provider or new remote control channel.

Changes retain independent acceptance, exact-tree evidence, source and command authority, branch protection, isolation and finite attempt/resource limits. Restarts must reconcile possibly active work before continuing; unknown effects remain unknown and are not replayed. GitHub summaries must respect the target's disclosure permissions. Product workers and adopters receive only their own approved authority, never a contributor's personal standing mandate.
