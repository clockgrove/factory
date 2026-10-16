# GitHub management contract

This document defines the GitHub management surfaces introduced in the #983 milestone. Progress comments and Project status are on by default; the plan-decision pilot stays opt-in. All of them use the existing GitHub credentials and atomic continuation. Source implementation and independent review are distinct from installed live qualification; qualification receipts establish which operator journeys have actually been demonstrated.

The preferred interaction is the existing agent conversation, such as Codex. The director surfaces actual retained questions there and records the operator's answer through the supported local CLI. GitHub supplies progress and detailed Objective, Work Item, PR and acceptance records. Section B documents a separate optional experiment, not a requirement to answer questions in GitHub or a demonstrated remote decision-consumption journey. Background persistence alone does not provide proactive notifications into an inactive agent conversation.

## Baseline and opt-in behavior

Before this milestone, GitHub issue graphs, pull requests and accepted issue closure were tracked, but comments could not authenticate a planning decision. The queue returned when human input was needed. The local CLI remains the complete decision and recovery surface.

By default, Factory keeps one phone-readable **Live status** comment on the Objective and on each started Work Item issue, edited in place, and posts a new comment only when something needs a phone notification. With the separate narrow decision opt-in, an eligible single planning question can retain its existing controller while awaiting an authenticated answer. This requires a finite saved whole-Objective deadline. Unsupported questions, deliberate pause/drain, unknown effects and disabled intake retain the supported local path. Project status is set independently of comments. Neither presentation setting is part of the configuration or queue authority digests, so turning one on or off never strands a started Objective or a queue receipt. No configured feature changes independent app acceptance.

## A. Bounded progress projection

Each issue has one Factory status comment, the **Live status** comment, edited in place as a phone-readable projection of the same continuation. New comments are notifications only, because GitHub notifies on a new comment but not on an edit.

The Objective's Live status shows a headline with the phase, delivered and active Work Items with their PR links and worker liveness (only when there are any), the next action, and blockers or decisions needed only when present. A decision shows its question, recommendation and consequences. While planning it also shows the planning step, revision, Work Item issue count, the phase's age and the planner call's timing, event count and token use; the record lives in the preparation and carries into execution, so one comment spans the run. Run and configuration identity, decision bindings and, when the [plan-decision pilot](#b-experimental-opt-in-plan-decision-intake) is eligible, the filled JSON answer template sit in a collapsed details block. A Work Item's Live status shows its status and step, the current attempt, a provider outage and its next try, the last failure's class, its pull request, the coordinator mode, its own pending criteria, and while it runs worker liveness, `no progress for Nm` after 15 minutes without an owned-file change or Validate call, turns, context, compactions, the checkout's changed paths and recent tool names with their repository-relative path or shell program name. Neither shows arguments, contents, logs, output or failure detail.

Factory edits a Live status comment on each transition and at most every 3 minutes while the work is active. A pending or skipped Work Item gets no comment. The comment carries a hidden `factory:live` marker bound to the Objective, item and run. Its creation is exactly once: the actor is recorded before the sole create, a lost response is adopted only by reading exactly one matching Factory-authored comment, and a marker by another author is refused. Edits record no state. A failed edit is skipped and retried on the next transition or after a backoff of 3 minutes doubling up to an hour; it never fails the run.

A new comment is posted only when:

- the Objective needs a human decision: the question, recommendation, consequences and how to answer, including the JSON template when the pilot is eligible;
- the Objective completes, fails or is cancelled: one short final comment with the delivered count and next action;
- a Work Item fails or waits for a human decision: its facts, its pending criteria and the supported path.

A new question, answer path or outcome notifies again; a repeat of the last notification does not. Timestamps never take part.

Progress projection is on by default for the configured target repository, with question text excluded. `githubManagement.progress: { "enabled": false }` turns off both kinds of comment. Question and decision text needs the explicit `includeQuestions: true` opt-in naming the target and the permitted content scope. Use the existing status derivation, with an explicit allowlist of public fields, including published Work Item IDs. Do not copy logs, prompts, source bodies, credentials, arbitrary exception text or private model findings into a comment merely because diagnostic redaction ran. Question, recommendation and consequence text must be cleared for this target's existing disclosure scope. If no substantive recommendation exists, say that the operator must choose; do not fabricate one. Missing facts remain unavailable. Oversized questions must link to already authorized complete evidence or stop publication; truncation cannot become a complete decision packet. Keep long identity digests and action bindings in an expandable detail/copy section so the main phone view remains brief.

Notification identity and request accounting belong in the existing atomic continuation: immutable snapshot identity, exact body/digest, authenticated numeric actor ID, observation time and observed comment identity/publication timestamp. Retain at most 64 notification requests per Objective, and 64 per Work Item recorded with the item's issue in `workItemTracking`, so a later graph revision cannot rebind its history. Never evict history or an unresolved intent. Record the sole creation intent before dispatch. A lost response remains unknown; restart may only reconcile one matching Factory-authored comment at the exact repository/Objective, marker and body. An empty or ambiguous lookup never authorizes another create, and unresolved publication holds further notifications on that issue. Notification comments are never edited. Exhausted history or unavailable/unknown publication remains visible in local status as degraded tracking, independently of app acceptance. Progress is presentation, not operational authority.

Initial source hooks are `contracts.ts` / `github.ts` for the narrow gateway operation, `state.ts` / `state-store.ts` for validated continuation fields, and owner-controlled `runner.ts` / `intake.ts` checkpoints. `github-progress.ts` only renders the bounded presentation; `github-live-status.ts` edits the Live status comments and `github-progress-projection.ts` decides notifications. Keep projection failures separate from substantive acceptance; they remain visible tracking failures and must not replay delivery or implementation.

## B. Experimental opt-in plan decision intake

The initial remote action answers one genuinely retained planning question with `outcome: accept`. It is available only before projection, for a `needs-human` plan with exactly one substantive finding, no review failure, verified acceptable structure and `acceptable !== false`. No unresolved external effect may remain. Multiple findings, review failures, structurally unacceptable plans and refusal stay on the local supported path. The Live status comment still groups all known questions when remote action is unavailable. It does not approve a Work Item result or final acceptance, change the Objective, invent a question, supply missing acceptance facts, select assets, retry, repair, cancel, merge, change providers, increase limits or run shell commands. All normal independent review, exact source/command validation and acceptance continue after a plan answer.

Installation configuration must explicitly enable this action and name immutable numeric GitHub human account IDs authorized by the operator. No repository-role inference, comment reactions, issue author, Factory bot, login string or unrelated conversation grants permission. Bots are excluded. Credentials use the existing GitHub adapter; no hosted service or additional secret is introduced.

A normal issue comment supplies a strict versioned JSON envelope:

```json
{
  "factoryDecision": 1,
  "repository": "OWNER/REPOSITORY",
  "objective": 1,
  "runId": "EXACT_RUN_ID",
  "configDigest": "EXACT_CONFIG_SHA256",
  "planReviewDigest": "EXACT_PLAN_REVIEW_SHA256",
  "questionDigest": "EXACT_COMPLETE_QUESTION_PACKET_SHA256",
  "outcome": "accept",
  "answer": "Specific answer to the retained question",
  "reason": "Why this choice satisfies the approved Objective"
}
```

Reject additional fields, missing identities, malformed or oversized bodies, wrong repositories/Objectives/runs/configurations, stale plans/questions, non-allowlisted authors, bots and observably edited comments. Fetch the exact comment from the expected repository and issue, authenticate numeric author ID and comment identity, and retain the exact bytes/digest observed. Creation/update timestamp equality alone does not establish an unedited comment. Read the same authenticated GraphQL `IssueComment` node with its exact body, author, issue/repository and edit metadata: require explicitly observed `lastEditedAt: null`, `editor: null` and `includesCreatedEdit: false`; absent metadata is unknown and rejected. Bind the REST identity through the same node ID or a strict decimal safe-integer conversion of `fullDatabaseId`, avoiding the narrower legacy `databaseId` for modern comment IDs. These facts prove only the unedited observation at that time; the comment remains editable on GitHub. Recheck every binding, control disposition, owned-resource condition and deadline after awaited fetches and inside the same owner mutation lock immediately before consuming the decision. Serialize the final save with same-process pause/drain mutations as well as cross-process mutation ownership. A later edit cannot change an already consumed record.

Record comment ID, numeric human author ID, login as display only, observed timestamps, body digest, question packet and answer provenance in the same atomic snapshot that records the plan disposition. Consume a comment once; restart reads the same disposition and never infers approval from unrelated GitHub activity. Exact question packets include the complete single unresolved finding and its evidence identities. If additional findings appear, reject this pilot action; a whole-packet digest alone does not prove a human answered every question. Existing plan verification can refuse an answer; a comment never turns a structurally or substantively unacceptable plan into an acceptable one.

The local plan-refusal path deletes its preparation snapshot. Remote refusal is excluded from this pilot and remains unsupported; the phone summary must name the local supported path and remain paused. A later remote-refusal contract would require a shared supported retained disposition that preserves the rejected plan, comment, evidence, usage and spent allowances. Never claim a completed phone refusal by recording a comment alone.

While awaiting an enabled decision, the already authorized service may keep a passive polling hold under its existing exclusive ownership. It must distinguish that hold from an intentional operator pause or drain. A supported answer may continue only its retained previously running mode; it cannot clear a deliberate pause, an unknown effect, unresolved owner resources, an exhausted allowance or the recorded whole-run deadline. Waiting time and transport costs remain accounted. Disabled intake keeps existing local behavior. Service restart reconciles ownership and the exact question before observing comments. To switch an active phone hold to local plan acceptance or refusal, stop its owner and verify `factory status` reports no active owner. For a foreground run, use the supported SIGTERM handoff, restore the stopped coordinator with `factory resume --objective N`, answer through local `factory decide`, then restart the same run. For a background service, use `factory supervisor stop`; while the service remains stopped, use `factory queue resume` to restore Project control and `factory resume --objective N` for the paused coordinator, answer through local `factory decide`, then use `factory supervisor start`. Objective resume alone does not restore a draining queue. Resume records control state without launching work while the owner/service remains stopped. Keep the same configuration throughout. A deliberate Factory pause retains ownership and is not that handoff. Do not launch a competing decision process or edit state.

## C. Existing Project Status projection

By default, Project status uses the Project that `queue.project` names. Factory reads that Project's one single-select field named Status and picks each phase's option by name, case-insensitively, taking the first name the field has:

| Phase         | Option names, in order            |
| ------------- | --------------------------------- |
| `planning`    | Planning, In Progress             |
| `running`     | Running, In Progress              |
| `review`      | In Review, Review, In Progress    |
| `needs-human` | Needs Human, Blocked, In Progress |
| `stopped`     | Stopped, Blocked, Todo            |
| `accepted`    | Accepted, Done                    |

GitHub's default Todo / In Progress / Done board therefore works unchanged. If the field or an option is missing, `factory status` reports `status-field-unavailable` once and comments continue without Project status; a run never fails for it. With no queue Project, there is no default. `githubManagement.projectStatus: { "enabled": false }` turns it off.

Alternatively, `githubManagement.projectStatus` explicitly names the target repository, existing Project node ID, Status field ID and option IDs for `planning`, `running`, `review`, `needs-human`, `stopped` and `accepted`, with `factoryManagedField: true`; explicit IDs override discovery. The Project must belong to the repository owner and be writable with the existing credentials. The field must be named Status and be a single-select field; all configured options must exist, and the accepted option must differ from every other phase. The Objective must already have one nonarchived card in that Project. Each started Work Item's card follows the item too: running, review while its result or assets are reviewed, needs-human while it waits for a decision, stopped when it fails or is cancelled, and accepted when it is done. A Work Item without exactly one card in the Project records that once and keeps its comments. A failed card read or comment is tried again only when that item's phase or presentation changes, or the controller restarts, so presentation never spends the request budget delivery needs. A pause, drain or restart is reported only on items still in progress. This status projection never adds/deletes a card or changes another field.

The opt-in designates that one field as Factory-managed. Concurrent human edits may be overwritten; this is not compare-and-swap protection. Factory binds the exact card, field, desired option and original observation in a durable intent before its sole mutation. Only that mutation's returned response settles it. A definitely not-sent request retains its original transport provenance and permits a later fresh intent; an ambiguous submitted update permanently fences that field. One later automatic read can show its observed option but never proves the old mutation completed or authorizes replay. Other workflow work and substantive acceptance continue. Local status exposes the retained requests, returned and later observed options, observation time and tracking failure separately. Accepted status requires actual accepted Objective closure, not merely completed workers.

## D. Project queue authority

`queue.project` separately binds an existing Project, dedicated TEXT metadata and NUMBER order fields, and an existing control card. The scheduling fields are distinct from the derived Status projection. Explicit queue/proposal actions can add Objective cards and write these scheduling fields; they do not change another field or delete cards.

Issues retain definitions; Project supplies current membership, order and controls. Private Git checkpoints preserve immutable original admission, mutation and owner receipts. A current field value must match the original approved body and semantic configuration. Manual edits and ordinary roadmap cards grant no provider-spending authority. Complete authenticated Project reads are required; unavailable or ambiguous observations never fall back to a local queue.

Withdrawn admissions retain their original receipts and authority after an approved stopped configuration change. They remain historical and cannot dispatch work; current control and queued admissions must match the current authority.

GitHub field updates supply no conditional-version input. Before dispatch, Factory claims the exact admission through independently acknowledged Git fast-forward publication. A competing or foreign unfinished claim holds execution. Original returned mutation receipts settle writes; later observations never confirm an unknown submission or permit replay. `queue sync` rereads current data without admitting or reordering work. Restoring receipts grants neither service activation nor foreign-resource cessation.

## Qualification and review

Before remote execution, independently review authentication, disclosure, atomic decision consumption, publication uncertainty and continuation locking together. Qualification uses a real public disposable target, a genuine model-originated human planning question and an explicitly authorized real human account. Record finite deadlines and attempt limits before the run. Prove a normal GitHub phone comment can answer the bound question and that continuation observes that same decision after a supported stop/restart. Do not manufacture a review question or submit an agent-authored comment as human authorization. Progress-only qualification can proceed separately; it does not establish the phone decision journey.
