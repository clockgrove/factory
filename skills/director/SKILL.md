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

The first line of `status` is the phase and a one-line summary. `Next:` is the exact command that answers it; run it only when the request covers it. Without `--objective`, status shows the service and the queue.

## Decide

- **Plan question** (phase `needs plan decision`): `factory decide --objective N --outcome accept|refuse [--answer TEXT] --reason TEXT`, then run. Accepting needs `--answer`. A refusal discards the plan, so the next run plans again.
- **Result criterion** (a Work Item, or final acceptance): have the operator inspect the full tree, because a truncated excerpt cannot auto-pass. Then `factory decide --objective N [--item ITEM] --outcome accept|refuse --reason TEXT`. Omit `--item` for final acceptance.
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

Search the pinned repository for the canonical text before treating a gap as a human decision. If it exists, add `path#Exact heading` under `## Planning sources` in the Objective, refuse the saved plan and run again. If it is genuinely unspecified, ask the owner. Never invent a requirement or weaken acceptance to pass a plan.

## Observe

```sh
factory diagnostics --objective N [--follow | --summary | --logs ITEM [--follow]]
```

A quiet timeline means no new provider event, not completion. Diagnostics can hold private source, so review them before pasting. Change the `autonomy` limits only on request. See the [capture guide](https://github.com/clockgrove/factory/blob/main/docs/CAPTURE.md) for timing and captures, and [remote execution](https://github.com/clockgrove/factory/blob/main/docs/REMOTE-EXECUTION.md), which is not live-qualified.
