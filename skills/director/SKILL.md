---
name: director
description: Use Factory on a specified target repository to run, inspect, decide, recover or cancel a development Objective. Never use it on Factory's own repository.
---

# Factory director

Operate the installed Factory CLI on a target repository. `factory help` lists the exact commands and is the authority over this skill. To change Factory itself, follow its contributor instructions.

## Rules

- **Target.** Take the repository and Objective issue number from the request. Refuse any Factory source, rebuild or archive repository, because Factory must never run on itself.
- **Objective.** It has four sections: Outcome, Acceptance, Sources, Constraints ([template](https://github.com/clockgrove/factory/blob/main/docs/templates/objective.md)). An Acceptance bullet that is exactly one backticked command is run on the integrated result. Factory refuses an Objective that still has Final validation, Required checks or Planning sources and says where each goes; have the author edit the issue, and never rewrite it yourself.
- **Binding.** Before any Objective command, check that the installed configuration binds that repository and checkout, because an issue number alone is not identity. On a mismatch, stop and use the `setup` skill. Never delete state.
- **Consent.** `factory run --objective N` is the consent to run that Objective. Run only Objectives the operator named. Never edit state files.
- **Host.** Run the controller from an ordinary host terminal, because workers inherit an enclosing agent sandbox. On a socket-directory error, diagnose the host; never chmod, unmask or bypass the sandbox.
- **Decisions belong to the operator.** Show the exact question and evidence, get a specific answer and reason, then record it. Never infer acceptance from diagnostics or silence.

## Run and status

```sh
factory run --objective N
factory status --objective N [--json]
```

`run` plans, runs the plan and exits: 0 complete, 1 failed, 2 needs a human. Report its final message. Run it again to resume; a saved plan is never planned again. To batch Objectives, use `factory queue add N [N ...]`.

The first line of `status` is the phase and a one-line summary. `Next:` is the exact command that answers it; run it only when the request covers it. Without `--objective`, status shows the service and the queue. Keep the same `--config PATH` for every command; emitted status commands retain an explicitly selected configuration.

## Blocked prerequisites

When setup, planning or review needs the operator, gather all retained review findings, the available readiness stages and the requirements in the exact pinned Sources before replying. Read the full retained findings rather than only the first question; mark stages not checked as unknown. Combine duplicates into one concise checklist of missing or unknown prerequisites. For each, state why it is needed, cite the source, give the supported setup step and verification command, and name any choice only the operator can make. Verify external platform facts through permitted official documentation; never invent a command or treat an unchecked account as ready.

Present every known blocker together and ask for required choices once. Tell the operator where each secret belongs according to the approved configuration or source instructions; never request secret values in chat or issues. Keep private evidence in its authorized destination. Recheck the actual requirement before recording a decision, and use the live status command for continuation. Checklist text grants no setup, account, spending, deployment or acceptance authority. Continue independent work only when already authorized and admitted by the current gates; do not bypass a blocked Objective, weaken acceptance or create a new state root.

## Decide

- **Plan question** (phase `needs plan decision`): `factory decide --objective N --outcome accept|refuse [--answer TEXT] --reason TEXT`, then run. Accepting needs `--answer`. A refusal discards the plan, so the next run plans again.
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

## Missing contract

Search the pinned repository for the canonical text before treating a gap as a human decision. If it exists, add `path#Exact heading` under `## Sources` in the Objective, refuse the saved plan and run again. If it is genuinely unspecified, ask the owner. Never invent a requirement or weaken acceptance to pass a plan.

## Observe

```sh
factory diagnostics --objective N [--follow | --summary [--json] | --logs ITEM [--follow]]
```

`--summary` is the efficiency report (time per stage, operator waits, tokens per role). A quiet timeline means no new provider event, not completion. Diagnostics can hold private source, so review them before pasting. Change the `autonomy` limits only on request. See the [capture guide](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#diagnostic-capture-and-export) for timing and captures, and [remote execution](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#managed-execution), which is not live-qualified.

## Learning and Dream

Only on request, use `factory dream --record --objective N` to collect terminal history without a model call, or `factory dream [--budget-bytes N]` for one bounded private proposal pass. Keep the same `--config PATH`. Review/edit the printed draft, hash its exact bytes, then have the operator choose `factory dream --file ABSOLUTE_DRAFT --approve SHA256` or `--reject SHA256`; never infer approval. `factory dream --show` reads the approved playbook. The default active budget is 16 KiB. Preserve immutable episodes, source links, dated summaries and contradictions when consolidating. Approved learning is advisory, grants no action or acceptance authority, and never changes an active Objective's pinned version. Keep source-derived private inputs in their authorized local/provider destinations. Full usage is in the [user guide](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#learning-and-dream).
