---
name: director
description: Use Factory on a specified target repository to run, inspect, decide, recover or cancel a development Objective. Never use it on Factory's own repository.
---

# Factory director

Drive Objectives on a target repository through the installed `factory` CLI. `factory help` lists the exact commands and is the authority over this skill. To change Factory itself, follow its contributor instructions.

## Rules

- **Target.** Take the repository (`OWNER/NAME`) and Objective issue number from the request. Refuse Factory's own repositories: Factory never runs on itself.
- **Same repository every time.** Pass `--repo OWNER/NAME` on every command (or set `FACTORY_REPOSITORY`). The repository picks the installation, so a wrong one reads or changes another installation's work.
- **CLI only.** Use only the commands below. Never edit, move or delete state, request or log files, because `factory serve` is the only writer of state and a hand edit breaks its crash recovery.
- **Structure, not prose.** Decide on exit codes, `--json` fields and refusal codes. Messages are for people and can change.
- **Decisions belong to the operator.** Answer a hold only with the operator's choice from this conversation. Never infer it from silence, a diagnostic or a GitHub comment you read.
- **Cancel only on request.** It closes the Objective's PRs and the issue, and it can't be undone.

## Commands

```sh
factory status [ISSUE] [--json]                 # where each Objective is, open holds, the next step
factory log ISSUE [--tail N] [--follow] [--json] # what happened, from the run log
factory answer ISSUE ANSWER [NAME] --question HOLD_ID [--text T]
factory retry ISSUE [--question HOLD_ID]         # run unheld waiting steps now; with --question, answer retry
factory cancel ISSUE
factory pause|drain|resume ISSUE                # this Objective only
factory reset ISSUE                             # rebuild state from GitHub
factory queue list|pause|resume|drain [--json]  # the whole queue
factory serve                                   # the service; setup installs it
```

Every command also takes `--repo OWNER/NAME`. Reads (`status`, `log`, `queue list`) read files or the Project directly. Changes (`answer`, `retry`, `cancel`, `pause`, `drain`, `resume`, `reset`, `queue pause|resume|drain`) write one request that the service applies within a second. If the service is stopped, the request waits and the CLI says so: tell the operator, because nothing happens until it starts.

## Start an Objective

The GitHub Project is the queue. The operator queues an Objective by setting its card's Status to the queued option, and reorders with the order field. That setting is the consent to run it, so ask the operator to set it rather than doing it yourself.

The service checks a queued Objective at once. A failed check holds with each problem named: the author edits the issue, then answer `recheck`. Never rewrite the issue yourself.

## Read where an Objective is

Run `factory status ISSUE --json`. Each entry in `objectives` has:

- `status`: `checking`, `planning`, `building`, `finishing`, `holding`, `done`, `failed`, `cancelled`, or `unreadable`.
- `mode`: `running`, `paused` or `draining`, the operator's control of this Objective.
- `holds`: the open questions, oldest first, each `{id, step, item?, question, answers, recommended, askedAt}`. A hold with `item` stops only that Work Item and the items that depend on it; one without stops the whole Objective.
- `waiting`: steps that will retry on their own, each with `step`, `nextAt`, `lastError` and `since`. With `gate` set, the step waits on a person outside Factory, such as an environment approval or a required review; name that gate to the operator.
- `waitsOn`: `{slot: true}` (no free slot) or `{paths: N}` (Objective #N owns overlapping paths), else `null`.
- `running`: steps started and not finished. `lastEvent`: the latest run log event.
- `provider`: the provider frozen when the Objective was admitted, `{name, selectedBy, settings}`. `selectedBy` is `defaultProvider`, `--provider` (from `serve --provider`) or `switch` (an operator's `switch` answer). Report `name` and `selectedBy`.
- `flakyRerun`: `{item, command}` for each validation that failed once and passed its one rerun. Report them.
- `reset`: `{requestedAt, hadState}` while a reset rebuilds the state. It is done when the rebuild lands and `reset` disappears, not when the command returns.
- `nextAction`: `{command, reason}`. When you suggest a next step, use `command` as given; `null` means nothing to run, and `reason` says why.

At the top level:

- `service` is `running` or `stopped`. A stopped service means no progress at all, so say it first.
- `queue.mode` is `running`, `paused` or `draining`.
- `crashLoop`, when present, is `{crashes, resumeAt}`: the service died that many times in a row and holds interrupted steps until `resumeAt`. Report it; read `factory log` for the cause.
- `problem`, when present, names a fault that pauses GitHub effects. Report it first.

For why an Objective is where it is, read `factory log ISSUE --json` (`--tail N` for more, `--follow` to watch). A quiet log means no new step ended, not that the run is stuck: steps have deadlines and end in progress, a retry or a hold on their own.

## Answer a hold

A hold is the only time Factory needs a person. Every listed answer works, and `cancel` is always valid.

An Objective can have several holds at once: at most one per Work Item and one for the whole Objective. Each has its own id and is answered on its own.

1. Read `holds` from `status ISSUE --json`.
2. Ask with AskUserQuestion, one question per hold (several in one call when there are several holds): the hold's `question` as the text, naming its Work Item when `item` is set; one option per entry in `answers`, the `recommended` one first and labelled recommended; and a one-line consequence for each. Keep free text available. Without a structured question tool, ask in plain text the same way.
3. For each hold, run `factory answer ISSUE ANSWER --question HOLD_ID` with that hold's own id. For `retry`, `factory retry ISSUE --question HOLD_ID` does the same. Add `--text` when the answer takes text (`answer` and `allow` do; the question says what goes in it). For `switch NAME`, pass the provider name after the answer. Always pass `--question`: an answer bound to an id lands only on that question, and a re-asked question gets a new id.
4. Read `status` again and report the new state. A hold that is re-asked has a new id, so ask again rather than reuse the old one.

Common answers, so you can explain them:

| Answer                     | Effect                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `retry`                    | Run the stopped step again.                                                                                                      |
| `wait`                     | Keep waiting on a slow cause or a usage limit.                                                                                   |
| `switch NAME`              | Run this Objective on provider NAME, or re-freeze the same provider's changed settings. Plain `switch` when there is one target. |
| `answer` + text            | A correction or decision the planner or worker uses next.                                                                        |
| `allow` + an exact command | Authorize that validation command for this Objective.                                                                            |
| `approve`, `more`          | Accept the reviewed plan; grant more plan revisions.                                                                             |
| `replan`                   | Discard the plan and plan again from the current issue and default branch.                                                       |
| `recheck`, `continue`      | Check the edited Objective again; carry on after an edit Factory noticed.                                                        |
| `revalidate`               | The refused result was right and Factory's check was wrong: validate it again.                                                   |
| `reset`                    | Rebuild unreadable state from GitHub.                                                                                            |
| `cancel`                   | End the Objective: close its PRs and the issue.                                                                                  |

## Refusals

A refused command exits 1 and prints `{"kind":"lifecycle-refusal","code":"..."}` on stderr before its message. Branch on `code` only:

| Code                                | Do                                                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stale_question`                    | The question changed or was re-asked. Read `status` again and ask about the current holds.                                                                |
| `no_open_question`                  | No hold with that id is open. Read `status` again; the message names the open ones.                                                                       |
| `question_required`                 | The answer named no question. Run it again with `--question HOLD_ID` from `status`. A `/factory` comment gets this too when it can't be tied to one hold. |
| `invalid_answer`                    | Not one of the hold's answers. Ask again with the listed `answers`.                                                                                       |
| `state_unreadable`                  | The hold `unreadable` offers `reset` and `cancel`. Ask the operator.                                                                                      |
| `objective_finished`                | The Objective is done, failed or cancelled, so its hold no longer takes answers. Report it; don't retry.                                                  |
| `no_factory_state`                  | Factory has no state for that issue: check the number and whether it's queued.                                                                            |
| `superseded`                        | A later cancel replaced this request. Read `status`.                                                                                                      |
| `no_configuration`, `no_such_issue` | Wrong `--repo` or issue, or setup is missing: check them, or use the `setup` skill.                                                                       |
| `plan_unreadable`                   | A reset can't read the plan comment. Show the operator the message; cancel only on request.                                                               |
| `queue_not_running`                 | A reset would create the Objective while the queue is paused or draining. Tell the operator; run `factory queue resume` only if they want it.             |
| `reset_in_progress`                 | A reset is already rebuilding the state. Tell the operator and wait for `reset` to disappear from `status`; don't retry.                                  |
| `usage` (exit 2)                    | Fix the command.                                                                                                                                          |

Any other code, or a non-zero exit with no JSON line: show the operator the message (and the code, if any), and stop. Never retry a refused command unchanged.

## Recover

- **Service stopped:** ask the operator to start it the way it was set up (the `setup` skill installs it). A restart is the normal recovery path; the service continues from its last saved step without repeating GitHub effects.
- **Waiting on a cleared cause** (a provider limit lifted, the network back): `factory retry ISSUE` runs now the waiting steps that no open hold stops. It is refused while an Objective-wide hold is open: answer that hold instead.
- **Provider changed or unavailable:** the hold offers `switch NAME`, `retry` and `cancel`. `switch` with the same provider's name re-freezes its changed settings; another name moves the Objective to that provider.
- **`unreadable` state:** the hold (id `unreadable`) offers `reset` and `cancel`. `factory reset ISSUE` rebuilds state from the plan comment, PRs and report on GitHub; run it only when the operator chooses it. The command returns at once; the reset is done when the rebuild lands and `status` no longer shows `reset`.
- **Repeated failure:** read `factory log ISSUE` and diagnose before answering `retry` again. Never loop on the same answer.

## Steer

Feedback in this conversation ("item 3 edits the wrong file") is the operator's to give. No channel reaches a running step, so map it to what Factory offers:

- **Answers an open hold:** `factory answer`, as above.
- **Changes the Objective itself:** the author edits the issue. Factory notices the edit and holds with `continue`, `replan` and `cancel`.
- **Applies after the Objective is done:** a successor Objective in a new issue.
- **Hold this Objective:** `factory pause ISSUE` starts no step until `resume`; `factory drain ISSUE` lets started Work Items finish and starts no new one. Only on request.
- **Hold the whole queue:** `factory queue pause` starts no step anywhere and admits nothing; `queue drain` admits nothing new while admitted Objectives carry on; `queue resume` undoes either. Only on request.
- **Stop this Objective now:** `factory cancel ISSUE`, only on request.

When feedback fits none of these, or two pieces conflict, ask instead of choosing.

## Observe the queue

`factory queue list --json` returns `queue` (its mode), `queued` (`{issue, order, status}` in run order), `candidates` (cards in another Status option), `inert` (cards that will never run, with a `reason`) and `truncated`. Report inert cards with their reason. `factory status` without an issue shows the service and every Objective with state: report holds first, then waits on gates, then progress. Give a short snapshot: each Objective's status, its open question, and what it waits on.
