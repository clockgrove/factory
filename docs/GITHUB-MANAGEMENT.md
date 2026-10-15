# GitHub management contract

This document defines the GitHub management surfaces introduced in the #983 milestone. Progress comments and Project status are on by default; the plan-decision pilot stays opt-in. All of them use the existing GitHub credentials and atomic continuation. Source implementation and independent review are distinct from installed live qualification; qualification receipts establish which operator journeys have actually been demonstrated.

The preferred interaction is the existing agent conversation, such as Codex. The director surfaces actual retained questions there and records the operator's answer through the supported local CLI. GitHub supplies progress and detailed Objective, Work Item, PR and acceptance records. Section B documents a separate optional experiment, not a requirement to answer questions in GitHub or a demonstrated remote decision-consumption journey. Background persistence alone does not provide proactive notifications into an inactive agent conversation.

## Baseline and opt-in behavior

Before this milestone, GitHub issue graphs, pull requests and accepted issue closure were tracked, but comments could not authenticate a planning decision. The queue returned when human input was needed. The local CLI remains the complete decision and recovery surface.

By default, Factory projects bounded phone-readable snapshots on the Objective and short transition comments on each Work Item issue. With the separate narrow decision opt-in, an eligible single planning question can retain its existing controller while awaiting an authenticated answer. This requires a finite saved whole-Objective deadline. Unsupported questions, deliberate pause/drain, unknown effects and disabled intake retain the supported local path. Project status is set independently of comments. Neither presentation setting is part of the configuration or queue authority digests, so turning one on or off never strands a started Objective or a queue receipt. No configured feature changes independent app acceptance.

## A. Bounded progress projection

Append a small stream of Factory-owned snapshots on each admitted Objective as a phone-readable projection of the same continuation. Publish meaningful phase, accepted-work, human-decision and final transitions; coalesce changes and ignore wall timestamps for semantic deduplication. Do not post time-only heartbeats or edit existing comments. Show accepted deliveries and their PRs, running or delivering items, the next action, blockers and grouped pending questions. Link the Objective and existing issue/PR evidence. Display the snapshot observation time, summary preparation time, the GitHub comment publication timestamp, repository, Objective, run and configuration identity. A timestamp describes an observation, not a live heartbeat or proof of owner cessation.

Progress projection is on by default for the configured target repository, with question text excluded. `githubManagement.progress: { "enabled": false }` turns it off. Question and decision text needs the explicit `includeQuestions: true` opt-in naming the target and the permitted content scope. Use the existing status derivation, with an explicit allowlist of public fields, including published Work Item IDs. Do not copy logs, prompts, source bodies, credentials, arbitrary exception text or private model findings into a comment merely because diagnostic redaction ran. Question, recommendation and consequence text must be cleared for this target's existing disclosure scope. If no substantive recommendation exists, say that the operator must choose; do not fabricate one. Missing facts remain unavailable. Oversized questions must link to already authorized complete evidence or stop publication; truncation cannot become a complete decision packet. Keep long identity digests and action bindings in an expandable detail/copy section so the main phone view remains brief.

Publication identity and request accounting belong in the existing atomic continuation: immutable snapshot identity, exact body/digest, authenticated numeric actor ID, observation time and observed comment identity/publication timestamp. Retain at most 64 snapshot requests per Objective, reserving the last two slots for human-decision or final transitions.

Each started Work Item gets the same treatment on its own issue: a short comment when its structured facts change, namely status and step, the current attempt identity, a provider outage and its next try, the last failure's class, its pull request and the coordinator mode. Comments carry no failure detail, logs or exception text. A pending or skipped item gets nothing. The same intent, reconciliation and 64-request bound apply per Work Item, recorded with the item's issue in `workItemTracking`, so a later graph revision cannot rebind its history. Never evict history or an unresolved intent. Record the sole creation intent before dispatch. A lost response remains unknown; restart may only reconcile one matching Factory-authored comment at the exact repository/Objective, marker and body. An empty or ambiguous lookup never authorizes another create, and unresolved publication holds further projection. Existing comments are never overwritten. Exhausted projection history or unavailable/unknown publication remains visible in local status as degraded tracking, independently of app acceptance. Progress is presentation, not operational authority.

Initial source hooks are `contracts.ts` / `github.ts` for the narrow gateway operation, `state.ts` / `state-store.ts` for validated continuation fields, and owner-controlled `runner.ts` / `intake.ts` checkpoints. `github-progress.ts` only renders the bounded presentation. Keep projection failures separate from substantive acceptance; they remain visible tracking failures and must not replay delivery or implementation.

## B. Experimental opt-in plan decision intake

The initial remote action answers one genuinely retained planning question with `outcome: accept`. It is available only before projection, for a `needs-human` plan with exactly one substantive finding, no review failure, verified acceptable structure and `acceptable !== false`. No unresolved external effect may remain. Multiple findings, review failures, structurally unacceptable plans and refusal stay on the local supported path. The summary still groups all known questions when remote action is unavailable. It does not approve a Work Item result or final acceptance, change the Objective, invent a question, supply missing acceptance facts, select assets, retry, repair, cancel, merge, change providers, increase limits or run shell commands. All normal independent review, exact source/command validation and acceptance continue after a plan answer.

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

Alternatively, `githubManagement.projectStatus` explicitly names the target repository, existing Project node ID, Status field ID and option IDs for `planning`, `running`, `review`, `needs-human`, `stopped` and `accepted`, with `factoryManagedField: true`; explicit IDs override discovery. The Project must belong to the repository owner and be writable with the existing credentials. The field must be named Status and be a single-select field; all configured options must exist, and the accepted option must differ from every other phase. The Objective must already have one nonarchived card in that Project. Each started Work Item's card follows the item too: running, review while its result or assets are reviewed, needs-human while it waits for a decision, stopped when it fails or is cancelled, and accepted when it is done. A Work Item without exactly one card in the Project records that once and keeps its comments. This status projection never adds/deletes a card or changes another field.

The opt-in designates that one field as Factory-managed. Concurrent human edits may be overwritten; this is not compare-and-swap protection. Factory binds the exact card, field, desired option and original observation in a durable intent before its sole mutation. Only that mutation's returned response settles it. A definitely not-sent request retains its original transport provenance and permits a later fresh intent; an ambiguous submitted update permanently fences that field. One later automatic read can show its observed option but never proves the old mutation completed or authorizes replay. Other workflow work and substantive acceptance continue. Local status exposes the retained requests, returned and later observed options, observation time and tracking failure separately. Accepted status requires actual accepted Objective closure, not merely completed workers.

## D. Project queue authority

`queue.project` separately binds an existing Project, dedicated TEXT metadata and NUMBER order fields, and an existing control card. The scheduling fields are distinct from the derived Status projection. Explicit queue/proposal actions can add Objective cards and write these scheduling fields; they do not change another field or delete cards.

Issues retain definitions; Project supplies current membership, order and controls. Private Git checkpoints preserve immutable original admission, mutation and owner receipts. A current field value must match the original approved body and semantic configuration. Manual edits and ordinary roadmap cards grant no provider-spending authority. Complete authenticated Project reads are required; unavailable or ambiguous observations never fall back to a local queue.

Withdrawn admissions retain their original receipts and authority after an approved stopped configuration change. They remain historical and cannot dispatch work; current control and queued admissions must match the current authority.

GitHub field updates supply no conditional-version input. Before dispatch, Factory claims the exact admission through independently acknowledged Git fast-forward publication. A competing or foreign unfinished claim holds execution. Original returned mutation receipts settle writes; later observations never confirm an unknown submission or permit replay. `queue sync` rereads current data without admitting or reordering work. Restoring receipts grants neither service activation nor foreign-resource cessation.

## Qualification and review

Before remote execution, independently review authentication, disclosure, atomic decision consumption, publication uncertainty and continuation locking together. Qualification uses a real public disposable target, a genuine model-originated human planning question and an explicitly authorized real human account. Record finite deadlines and attempt limits before the run. Prove a normal GitHub phone comment can answer the bound question and that continuation observes that same decision after a supported stop/restart. Do not manufacture a review question or submit an agent-authored comment as human authorization. Progress-only qualification can proceed separately; it does not establish the phone decision journey.
