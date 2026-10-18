---
name: director
description: Use Factory on a specified target repository to run, inspect, decide, recover or cancel a development Objective. Never use it on Factory's own repository.
---

# Factory director

Operate the installed Factory CLI on a target repository. `factory help` lists the exact commands and is the authority over this skill. To change Factory itself, follow its contributor instructions.

## Rules

- **Target.** Take the repository and Objective issue number from the request. Refuse any Factory source, rebuild or archive repository, because Factory must never run on itself.
- **Objective.** Short prose: a Goal (or Outcome) paragraph, required Acceptance bullets, optional Context and Sources, and Constraints ([template](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.md)). The compiler reads the repository at the base commit and plans the work itself. An Acceptance bullet that is exactly one backticked command is run on the integrated result. Factory refuses an Objective that still has Final validation, What must be true or Planning sources and says where each goes; have the author edit the issue, and never rewrite it yourself.
- **Issue types.** Explicitly set native Feature for Objectives and Task for Work Items when those types are available in the target repository. Standalone defects use Bug; maintenance, investigation and qualification use Task. Verify the returned issue's type and labels. Keep existing area, priority and Factory-role labels, but omit redundant bug, enhancement, feature and task classification labels. Do not create issue types, change repository settings or invent fallback classification labels to enforce this convention. Report unavailable types through the existing prerequisite guidance.
- **Priority.** Use the target's existing priority convention when creating or triaging approved issues, and verify it after creation or Work Item projection. A Work Item normally inherits its Objective's priority unless its own impact justifies a difference. Do not invent labels or silently overwrite an existing priority; report missing priority configuration through the existing prerequisite guidance. Priority never grants execution authority or changes approved queue order, dependencies, limits or held decisions.
- **Binding.** Before any Objective command, check that the installed configuration binds that repository and checkout, because an issue number alone is not identity. On a mismatch, stop and use the `setup` skill. Never delete state.
- **Provider.** A started Objective keeps the provider it froze. New work uses `defaultProvider`; run another provider only with an explicit `--provider NAME`, and say that you are overriding the default. Report the `Provider:` line of status. To add a provider, use the `setup` skill; never edit another provider's settings to switch.
- **Consent.** `factory run --objective N` is the consent to run that Objective. Run only Objectives the operator named. Never edit state files.
- **Host.** Run the controller through the host's supported ordinary-host permission route, because workers inherit an enclosing agent sandbox. Follow the [controller PATH guidance](https://github.com/clockgrove/factory/blob/main/README.md#controller-path-in-an-agent-host): Codex can inject private runtime aliases, so bind the complete reviewed literal PATH and verified absolute CLI after shell startup for every controller command, including status continuations. Include all selected project and validation tools; never append inherited `$PATH` or mount credential roots. On a socket-directory error, diagnose the host; never chmod, unmask or bypass the sandbox.
- **Decisions belong to the operator.** Ask actual retained questions in the current agent conversation, such as Codex, with the question, recommendation when supported, consequences and links to evidence. When the host has a structured question tool, such as AskUserQuestion in Claude Code, ask through it so the host can show the operator that a decision is waiting: one question per decision, the recommended choice first, and the free-text answer kept available for the reason. Otherwise ask in plain text. Get a specific answer and reason, verify the live Objective/configuration binding, then record the answer through the supported local decision command. Do not direct ordinary decisions to GitHub comments or require the operator to copy identity digests or JSON there. GitHub is the detailed progress and evidence view; Factory reads no comment as an answer. Never infer acceptance from diagnostics, scheduling availability or silence.

## Run and status

An inspection-only request permits reading the issue, committed Sources and existing status. There is no plan-only CLI command. Do not use `run` to satisfy a request to see a plan before authorizing execution: a clean independently reviewed plan proceeds directly to workers and GitHub delivery.

```sh
factory run --objective N
factory status --objective N [--json]
factory status --issue N|URL [--json]
```

An Objective or Work Item issue link is the handle: when the operator pastes one, run `factory status --issue URL`. It finds the Objective, and the Work Item, from local state and refuses a link to another repository. Then check the binding as for any Objective command and answer from that status. Live status comments on GitHub name the same command and the exact next one; GitHub shows them, it never runs them.

`run` plans, runs the plan and exits: 0 complete, 1 failed, 2 needs a human. Report its final message. Run it again to resume; a saved plan is never planned again. To batch Objectives, use `factory queue add N [N ...]`. When the plan splits the Objective into child Objectives, `run` exits 0 once the child issues exist. The queue runs each child after the children it builds on are accepted, and the parent closes after its last child. Report the children, and follow each one as its own Objective.

With a configured Project queue, `factory queue list` or `factory queue sync` reads current membership/order and authenticated approval receipts. Roadmap cards, progress/status fields and manual metadata edits are not execution consent. Queue changes have one three-minute deadline through durable completion. After installing a release, run `factory supervisor upgrade --cli ABSOLUTE_INSTALLED_CLI` before any queue command: a running service from an older release refuses a newer CLI's forwarded request deadline. Local status retains its one-second deadline; the local pause acknowledgment targets a one-second response. The pause acknowledgment does not prove remote completion or worker cessation. Preserve pause/drain, uncertain mutations, original limits and foreign ownership holds; a timeout never permits replay. Never use an archived queue observation as current authority or activate a restored service without the operator's request.

For an approved fresh installation, `factory persistence restore` verifies Git records and rebuilds replicas without execution. Inspect restored Objective status, then use `factory persistence reconcile --objective N` only through its supported settlement checks. A remaining hold is a real recovery boundary: missing local PIDs, native homes and expired leases do not prove foreign cessation. Preserve original attempts, unknown effects and terminal records; never rewrite state or copy a credential-bearing harness home.

Project-bound foreground runs require a current approved admission. When the operator has explicitly authorized the named Objective and it lacks an admission, use `factory queue add N` before `run`; this records that same consent without starting a service. Never automatically resume a paused/draining queue or clear an ownership hold. An inspection request grants no admission.

The first line of `status` is the phase and a one-line summary. `Next:` is the exact command that answers it; run it only when the request covers it. Without `--objective`, status shows the service and the queue. Keep the same `--config PATH` for every command; emitted status commands retain an explicitly selected configuration.

Use `factory supervisor check` to inspect authenticated local service readiness without observing the remote queue. `starting` preserves an active service whose ownership handshake is still pending; keep the service and inspect it again. `owned-ready` proves local ownership only. Queue authorization and required Project/private-history checks still gate dispatch.

## Blocked prerequisites

When setup, planning or review needs the operator, read `factory status --objective N --json` first. Its `prerequisiteGuidance` is the same derived packet shown by foreground and service status: current run/configuration/graph bindings, controller ownership and control mode, one owner per dependency, reason, actual readiness, completion condition, retained sources and exact supported action. Present its known blockers together without being asked to create a checklist. Distinguish inaccessible required facts, product choices, permission or limit boundaries, setup, unknown submitted effects and returned results awaiting propagation. Compiler retrieval has already tried the accessible facts; a catalog entry alone does not establish an unavailable fact. Keep the guidance digest with the conversation and coalesce unchanged checks instead of repeating the same questions.

Reconcile the current status, owner and submitted-effect receipts before using historical instructions or decisions. A retained returned result awaiting propagation needs the existing controller's completion path, not another implementation or a repeated human question. Unknown ownership, resource settlement or submission stays unknown; an absent controller does not prove a submitted external effect completed. Preserve pause/drain and exact reconciliation fences. Reuse eligible retained setup or decision references only with their exact bindings and existing authority; historical account or environment success remains historical until the selected current phase establishes readiness.

Read all retained findings and the requirements in the exact pinned Sources rather than only the first question. Mark stages not checked as unknown. Use source-grounded setup and verification references actually present in the packet or supported readiness output; omit unavailable commands or references rather than inventing them. Verify external platform facts through permitted official documentation when the request already authorizes that check. Guidance itself grants no new checks, recurring jobs, retries or spending.

Check the exact source-authorized prerequisite commands and their order in the actual fresh phase checkout, including setup before probes or validation. A pinned Git tree transfers tracked inputs, not ignored installations or generated runtime artifacts; verify those prerequisites there within the existing authority and gates.

Present every known blocker together and ask for required choices once. Tell the operator where each secret belongs according to the approved configuration or source instructions; never request secret values in chat or issues. Keep private evidence in its authorized destination. Recheck the actual requirement before recording a decision, and use the live status command for continuation. Checklist text grants no setup, account, spending, deployment or acceptance authority. Continue independent work only when already authorized and admitted by the current gates; do not bypass a blocked Objective, weaken acceptance or create a new state root.

Ask when the real question exists; do not create an advance availability-confirmation gate merely to reach it. If the operator is away, preserve the pending question and original deadline. At the next check-in, inspect live status and surface the retained choices in this conversation. Do not claim the background service can wake an inactive conversation. Never edit state.

## Decide

- **Plan question** (phase `needs plan decision`): `factory decide --objective N --outcome accept|refuse [--answer TEXT] --reason TEXT`, then run. Accepting needs `--answer`. When planning stopped at the planner's own question (`planningQuestion` in status) or the plan review asked an operator question (`planReviewQuestion` in status), accepting records the answer and the next run revises the plan with it and reviews it again; do not edit the Objective for it. When it stopped because plan revisions ran out with only review fix findings left (`planningRevisionGrant` in status), accepting takes no `--answer` and grants that many more revisions of the retained draft. A refusal discards the plan, so the next run plans again.
- **Result criterion** (a Work Item, or final acceptance): have the operator inspect the full tree, because a truncated excerpt cannot auto-pass. Then `factory decide --objective N [--item ITEM] [--criterion TEXT] --outcome accept|refuse --reason TEXT`. Omit `--item` for final acceptance.
- **Review again** a pending Work Item result: `factory retry --objective N --item ITEM --rereview`, then run. It makes no model call and accepts nothing.
- **Media:** `factory select --objective N --item ITEM --output ABSOLUTE_NEW_DIRECTORY` writes the candidate sets for review. After the human picks one whole set: `factory select --objective N --item ITEM --set SET_ID [--bind DEPENDENT ...]`, then run.

## Recover

- **Controller stopped:** run the Objective again.
- **Failed Work Item:** read `factory diagnostics --objective N --logs ITEM`. With explicit authority, `factory retry --objective N --item ITEM` starts a new attempt. The same `retry` answers a stopped step that status names.
- **Diagnosed correction:** `factory repair --objective N --proposal FILE`.
- **Graph amendment:** `factory propose-amendment --objective N --proposal FILE`. The file formats are in the [user guide](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#decisions).
- **Control:** `factory pause|drain|resume|cancel --objective N`. Cancel only on request.
- After a repeated failure, diagnose instead of looping. Never reset allowances or revive terminal work.

## Steer

Feedback in this conversation ("W3 is fixing the wrong file", "split auth out first") is the operator's to give; GitHub comments are not. Map it to an existing operation from current status, never to a new one:

| Feedback                                                  | Operation                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answers a pending plan or criterion question              | `decide`, as above                                                                                                                                                                                                                        |
| A running attempt is going the wrong way                  | No channel reaches a running attempt. On request, `pause` or `drain` to its safe point, then act on its result: refuse a human criterion with `decide`, then `repair`; once it is accepted and merged, only a successor Objective applies |
| A failed or refused Work Item went the wrong way          | `repair` with the feedback as its `diagnosis` and `correction`, while paused or drained; `retry` starts a new attempt but carries no feedback                                                                                             |
| Scope, ownership or ordering of not-yet-started work      | `propose-amendment`                                                                                                                                                                                                                       |
| An in-scope worker discovery should not proceed           | `decline-discovery`, while paused or stopped with owned work settled                                                                                                                                                                      |
| Applies after acceptance, or changes the Objective itself | A successor Objective in a new issue the author writes. Never edit an admitted Objective's issue: the run refuses changed contents                                                                                                        |
| Stop now                                                  | `pause`, `drain` or, only on request, `cancel`                                                                                                                                                                                            |

Before running anything, show the exact command or proposal file and what it spends: an amendment consumes a planning revision, a repair uses the allowance already charged for its failure, and status says when none remains. Run it only after the operator confirms. A rejected amendment holds the Objective: `repair` and `retry` refuse until its replacement is admitted or the Objective is cancelled, and status names which. When feedback fits no row, or two pieces of feedback conflict, ask instead of choosing.

## Missing contract

Search the pinned repository for the canonical text before treating a gap as a human decision. If it exists, add `path#Exact heading` under `## Sources` in the Objective, refuse the saved plan and run again. If it is genuinely unspecified, ask the owner. Never invent a requirement or weaken acceptance to pass a plan.

## Observe

```sh
factory diagnostics --objective N [--follow | --summary [--json] | --logs ITEM [--follow]]
```

For local process/resource observations, use the recorded owners' runtime and process namespace and establish that visibility before claiming cessation. A sandbox-only `/proc` scan cannot establish host closure; keep unproved visibility or resources unknown and follow the existing ownership and permission gates.

`--summary` is the efficiency report (time per stage, operator waits, tokens per role). A quiet timeline means no new provider event, not completion. Diagnostics can hold private source, so review them before pasting. Change the `autonomy` limits only on request. See the [capture guide](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#diagnostic-capture-and-export) for timing and captures, and [remote execution](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#managed-execution), which is not live-qualified.

## Learning and Dream

Only on request, use `factory dream --record --objective N` to collect terminal history without a model call, or `factory dream [--budget-bytes N]` for one bounded private proposal pass. Keep the same `--config PATH`. Review/edit the printed draft, hash its exact bytes, then have the operator choose `factory dream --file ABSOLUTE_DRAFT --approve SHA256` or `--reject SHA256`; never infer approval. `factory dream --show` reads the approved playbook. The default active budget is 16 KiB. Preserve immutable episodes, source links, dated summaries and contradictions when consolidating. Approved learning is advisory, grants no action or acceptance authority, and never changes an active Objective's pinned version. Keep source-derived private inputs in their authorized local/provider destinations. Full usage is in the [user guide](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#learning-and-dream).
