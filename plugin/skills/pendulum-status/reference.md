# pendulum-status: reference

Detail for the pendulum-status skill. SKILL.md says when to load each section; every rule here is as binding as one there.

## States

Pendulum keeps each Objective's state in one label (and, on a repository an organization owns, the Project board's column beside it). Re-applying `pendulum:objective` is taking it off and putting it back; only someone who can push, or a maintainer the workflow names, makes it count.

| Label | State | What happens next | Re-applying `pendulum:objective` resumes it |
| --- | --- | --- | --- |
| none | Queued | The dispatcher starts it once a slot is free (`max_concurrent`), the day's spend is under `daily_usd` and every issue that blocks it is closed, `P0` first, then `P1`, `P2`, then by issue number. | no |
| `pendulum:running` | Running | A stage works it; its progress comment says what it is doing. Taking the label off stops it. | no |
| `pendulum:in-review` | In review | Its PR goes through the review, the worker's answer to it, the required checks and the merge on its own. Re-applying the label runs a work stage again, as after its PR was closed unmerged. | yes |
| `pendulum:blocked` | Blocked | Waits for a person: its Blocked notice names the reason, the fix and whether to resume or restart. | yes |
| `pendulum:question` | Question | Waits for the decision it asks: answer it (Questions). | yes |

Beside these: `pendulum:draft` (a draft, never run, whatever else is on it), no `pendulum:objective` on an open issue (stopped), `pendulum:restart` (a restart under way: the label comes off once the dispatcher has restarted it) and `pendulum:handover` (a workflow change waits for a person: the pendulum-handover skill applies it).

## Block causes

A Blocked notice's last line records its cause as `<!-- pendulum:block {"cause":"<cause>"} -->`. The notice's own last paragraph says the way on; this table is what each cause gives when the notice is older or the user asks why. `resume`: the stop is outside the work, so once its cause is fixed or has passed, re-apply the label; a restart would discard the work and gain nothing. `work`: the work itself stopped, so resume once the cause is fixed, and restart only when the work must be redone from the issue's text. External causes are outside Pendulum and the work: the scorecard does not count them against it.

| Cause | External | Way on | What stopped it |
| --- | --- | --- | --- |
| `max-usd` | yes | resume | the stage reached `max_usd` |
| `gateway-budget` | yes | resume | the AI Gateway refused for its own budget or credits |
| `provider-quota` | yes | resume | a provider's quota, usage limit, plan limit or billing refusal, GitHub's Git LFS storage or API rate limit, or the sandbox vendor's plan |
| `outage` | yes | resume | a provider or GitHub outage, or this machine's own network |
| `setup` | no | resume | a setup gap: a credential, a secret, a host, an install, the repository's settings or rules, the author's access |
| `pendulum` | no | resume | Pendulum itself: a crash, a lost or stuck stage, an exit it could not apply |
| `work` | no | work | the work: the worker's own Block, red validation, review findings, a protected path, the Objective's size, an edit after its plan |

Two notices say otherwise in their last paragraph, and win: "Neither a resume nor a restart gets past this" (the issue's author cannot push: a person who can push files it again as a new issue), and "To keep the work instead of restarting" (a restart that could not finish).

## Questions

Pendulum's Question notice on the issue starts with the marker `<!-- pendulum:<issue>:question:<stage>:<run>:<form> -->`, `<form>` saying where the answer goes. The latest notice since the issue's last `pendulum:question` label counts. A Question its PR asks often has no notice on the issue: its review request on the PR is the notice.

| Form | Asked | Answer |
| --- | --- | --- |
| `issue` | on the issue: before any code (the plan-time Question), or with no open PR | A comment on the issue. The Objective goes back to the queue at the dispatcher's next tick, on every route. Marking the PR ready would start its review and merge the part done so far. |
| `pr` | in the draft PR's body, as `QUESTION:` items | A comment on the issue or the PR (a review or a line comment works too), then the PR marked ready: the review job applies the answer, and with no answer since the Question the PR goes back to a Question rather than merging. |

A decision model reads whether the comments since the Question decide it; with none (`decision_route` off, or `gateway` with no key), any comment resumes it. Re-applying `pendulum:objective` instead reruns the worker with the answer unjudged, and wins over a ready mark beside it.
