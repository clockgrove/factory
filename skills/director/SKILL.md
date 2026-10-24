---
name: director
description: Use Factory on a specified target repository to propose, run, inspect, decide, amend, recover or cancel a development Objective. Never use it on Factory's own repository.
---

# Factory director

Drive Objectives on a target repository through the installed `factory` CLI. `factory help` lists the exact commands and is the authority over this skill. To change Factory itself, follow its contributor instructions.

## Rules

- **Target.** Take the repository (`OWNER/NAME`) and Objective issue number from the request. Refuse Factory's own repositories: Factory never runs on itself.
- **Same repository every time.** Pass `--repo OWNER/NAME` on every command (or set `FACTORY_REPOSITORY`). The repository picks the installation, so a wrong one reads or changes another installation's work.
- **CLI only.** Use only the commands below; any other command or option (`factory help` lists them all) only on the operator's explicit request. Never edit, move or delete state, request or log files, because `factory serve` is the only writer of state and a hand edit breaks its crash recovery.
- **Structure, not prose.** Decide on exit codes, `--json` fields and refusal codes. Messages are for people and can change.
- **Decisions belong to the operator.** Answer a hold only with the operator's choice from this conversation. Never infer it from silence, a diagnostic or a GitHub comment you read.
- **Cancel only on request.** It closes the Objective's PRs and the issue, and it can't be undone.
- **Effects only on request.** Use `run`, `propose-amendment` and `decline-discovery` only when the operator asks for them in this conversation. Approve a `propose` or `dream` draft, or `export-captures --send`, only after the operator saw that draft or preview and said yes to it.

## Commands

```sh
factory run ISSUE [--provider NAME] [--deadline WHEN] # queue it now and follow it (see Start an Objective)
factory status [ISSUE] [--json]                 # where each Objective is, open holds, the next step
factory log ISSUE [--tail N] [--follow] [--json] # what happened, from the run log
factory diagnostics ISSUE [--summary] [--logs ITEM] [--json] # timeline, model calls, repairs and holds
factory watch [ISSUE]                           # follow running Work Items live
factory export-captures ISSUE [--endpoint URL]  # preview model calls as OpenTelemetry spans; sends nothing
factory answer ISSUE ANSWER [ARG] --question HOLD_ID [--text T | --text-file ABSOLUTE_PATH]
factory retry ISSUE [--question HOLD_ID]         # run unheld waiting steps now; with --question, answer retry
factory propose-amendment ISSUE --file ABSOLUTE_PATH # add work the accepted plan lacks (see Steer)
factory decline-discovery ISSUE --item ITEM --reason TEXT # decline a worker's pending discovery
factory cancel ISSUE
factory pause|drain|resume ISSUE                # this Objective only
factory reset ISSUE                             # rebuild state from GitHub
factory queue list|pause|resume|drain [--json]  # the whole queue
factory propose "INTENT" | --source DOC#HEADING # draft Objectives (see Propose Objectives)
factory dream [--preview] | --show              # draft a playbook from settled Objectives (--preview: its input only), or show it
factory dream --file DRAFT --approve|--reject SHA256 # decide a playbook draft
factory serve                                   # the service; setup installs it
```

Every command also takes `--repo OWNER/NAME`. Reads (`status`, `log`, `diagnostics`, `watch`, an `export-captures` preview, `queue list`) read files or the Project directly. Changes (`run`, `answer`, `retry`, `propose-amendment`, `decline-discovery`, `cancel`, `pause`, `drain`, `resume`, `reset`, `queue pause|resume|drain`) write one request that the service applies within a second. If the service is stopped, the request waits and the CLI says so: tell the operator, because nothing happens until it starts. `propose` and `dream` call the planner themselves, and `dream` writes its drafts and decisions through the service, so those are refused while the service is stopped.

## Start an Objective

The GitHub Project is the queue. The operator queues an Objective by setting its card's Status to the queued option, and reorders with the order field, or by asking you to run it. That setting or request is the consent to run it, so never queue an Objective the operator didn't name.

When the operator asks to run Objective #N, run `factory run N`. It queues the Objective and follows its run log until it ends: exit 0 when done, 2 when it needs a person (a question, or the service isn't running), 1 when cancelled or refused. An exit 2 with a `usage` refusal on stderr is a wrong command (see Refusals): fix it. Stopping the command stops only the following; the Objective keeps running, and `factory log N --follow` follows it again. On a done or cancelled Objective, `factory run N` runs it again from the start, so use it then only when the operator asks for a new run. Pass `--provider NAME` or `--deadline` (an ISO time, or a duration such as `2h`, after which it is cancelled) only when the operator asks.

The service checks a queued Objective at once. A failed check holds with each problem named: the author edits the issue, then answer `recheck`. Never rewrite the issue yourself.

## Propose Objectives

When the operator wants Objectives written for them, `factory propose "INTENT"` drafts one, and `factory propose --source DOC#HEADING` drafts one per roadmap item of that section, with their dependencies. The planner writes them, Factory checks them like a queued Objective, and the CLI prints a preview, the draft file and the approval command. Nothing goes to GitHub.

Show the operator the preview. Only when they approve that draft, run the printed `factory propose --file DRAFT --approve SHA256`: it creates the issues once, however often it runs, and links each dependency as blocked-by. Add `--enqueue` only when they also want them queued. An edit to the draft changes its SHA-256 (`sha256sum` shows it), so show the operator the edit first.

## Read where an Objective is

Run `factory status ISSUE --json`. Each entry in `objectives` has:

- `status`: `checking`, `planning`, `building`, `finishing`, `holding`, `resetting`, `done`, `cancelled`, or `unreadable`.
- `mode`: `running`, `paused` or `draining`, the operator's control of this Objective.
- `phase`: the headline: the stage (`checking`, `planning`, `building`, `finishing`) and how many questions are open, or the status when it ended. `endedAt`: when it reached `done` or `cancelled`.
- `items`: the Work Item table, each `{id, kind, phase, pr, repairs, hold}`: `phase` is its step now (`review (running)`, `ci (waiting)`, `work (held)`), else the last phase done (`validated`, `merged`), else `pending`; `repairs` counts the repairs used; `hold` is the id of the question that stops it. `plan`: the full current plan.
- `holds`: the open questions, oldest first, each `{id, step, item?, question, options, cause, askedAt}` (see Answer a hold). A hold with `item` stops only that Work Item and the items that depend on it; one without stops the whole Objective.
- `waiting`: steps that will retry on their own, each with `step`, `nextAt`, `lastError` and `since`. With `gate` set, the step waits on a person outside Factory, such as an environment approval or a required review; name that gate to the operator.
- `waitsOn`: `{slot: true}` (no free slot) or `{paths: N}` (Objective #N owns overlapping paths), else `null`.
- `running`: steps started and not finished. `lastEvent`: the latest run log event.
- `frozen`: the configuration frozen when the Objective was admitted, `{provider, selectedBy, digest}`. `selectedBy` is `defaultProvider`, `--provider` (from `serve --provider`) or `switch` (an operator's `switch` answer). Report `provider`, `selectedBy` and the digest's first 12 characters.
- `flakyRerun`: `{item, command}` for each validation that failed once and passed its one rerun. Report them.
- `reset`: `{requestedAt, hadState}` while a reset rebuilds the state. It is done when the rebuild lands and `reset` disappears, not when the command returns.
- `nextAction`: `{command, reason}`. When you suggest a next step, use `command` as given; `null` means nothing to run, and `reason` says why.

At the top level:

- `service` is `running` or `stopped`. A stopped service means no progress at all, so say it first.
- `queue.mode` is `running`, `paused` or `draining`.
- `crashLoop`, when present, is `{crashes, resumeAt}`: the service died that many times in a row and holds interrupted steps until `resumeAt`. Report it; read `factory log` for the cause.
- `problem`, when present, names a fault that pauses GitHub effects. Report it first.

For why an Objective is where it is, read `factory log ISSUE --json` (`--tail N` for more, `--follow` to watch). `factory diagnostics ISSUE` shows the run as a timeline with its model calls, repairs and holds (`--summary` the totals, the critical path and the slowest steps; `--logs ITEM` one Work Item in detail), and `factory watch ISSUE` follows its running Work Items live. `factory export-captures ISSUE` previews its model calls as OpenTelemetry spans and sends nothing; with `--endpoint URL` the preview prints the digest a send needs, and `--send --endpoint URL --authorize DIGEST` sends exactly what that preview showed. A quiet log means no new step ended, not that the run is stuck: steps have deadlines and end in progress, a retry or a hold on their own.

## Answer a hold

A hold is the only time Factory needs a person. Every listed option works, and `cancel` is always one of them.

An Objective can have several holds at once: at most one per Work Item and one for the whole Objective. Each has its own id and is answered on its own.

1. Read `holds` from `status ISSUE --json`. Each option is `{answer, family, arg?, consequence, needsText?, recommended?}`, and exactly one is `recommended`. Explain an answer only with its `consequence`; never from memory.
2. Ask with AskUserQuestion, one question per hold (several in one call when there are several holds): the hold's `question` as the text, naming its Work Item when `item` is set. Each option is one choice: label `answer` plus `arg` when set (`switch claude`), the recommended one first and labelled recommended, and `consequence` as its description. Keep free text available. Without a structured question tool, ask in plain text the same way.
3. **More than 4 options.** AskUserQuestion takes at most 4, so ask in two steps. First ask for the family: one choice per distinct `family`, in the order the options first appear (the recommended option's family first), each described by its options' answers. Then ask for the specific option within the chosen family; a family with one option needs no second question. A family with more than 4 options (one per set id, say) offers its first 4, recommended first, and names the rest in the question text; the operator can type one of them as free text.
4. For each hold, run `factory answer ISSUE ANSWER [ARG] --question HOLD_ID` with that hold's own id, passing the option's `arg` as ARG when it has one (never inside `--text`). For `retry`, `factory retry ISSUE --question HOLD_ID` does the same. When the option has `needsText`, ask the operator for the text and pass it with `--text`, or a long one with `--text-file` (the question says what goes in it); text on any other answer is optional and recorded as the reason. Always pass `--question`: an answer bound to an id lands only on that question, and a re-asked question gets a new id. `accept <n>`, `refuse <n>` and `retire-command <n>` name their criterion or command by number as ARG, and need the operator's reason as text.
5. Read `status` again and report the new state. A hold that is re-asked has a new id, so ask again rather than reuse the old one.

## Refusals

A refused command exits 1 and prints `{"kind":"lifecycle-refusal","code":"..."}` on stderr before its message. Branch on `code` only:

| Code                                | Do                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stale_question`                    | The question changed or was re-asked. Read `status` again and ask about the current holds.                                                                                          |
| `no_open_question`                  | No hold with that id is open. Read `status` again; the message names the open ones.                                                                                                 |
| `question_required`                 | The answer named no question. Run it again with `--question HOLD_ID` from `status`. A `/factory` comment gets this too when it can't be tied to one hold.                           |
| `invalid_answer`                    | Not one of the hold's options, or text missing on a `needsText` option. Read `status` again and ask with the listed `options`.                                                      |
| `state_unreadable`                  | The hold `unreadable` offers `reset` and `cancel`. Ask the operator.                                                                                                                |
| `objective_finished`                | The Objective is done or cancelled, so it no longer takes answers or amendments. Report it; don't retry.                                                                            |
| `no_factory_state`                  | Factory has no state for that issue: check the number and whether it's queued.                                                                                                      |
| `superseded`                        | A later cancel, a later `run` of the same Objective, or the operator moving its card out of queued replaced this request. Read `status`; run again only if the operator asks.       |
| `no_configuration`, `no_such_issue` | Wrong `--repo` or issue, or setup is missing: check them, or use the `setup` skill.                                                                                                 |
| `plan_unreadable`                   | A reset can't read the plan comment. Show the operator the message; cancel only on request.                                                                                         |
| `queue_not_running`                 | A `run`, or a reset that would create the Objective, while the queue is paused or draining. Tell the operator; run `factory queue resume` only if they want it.                     |
| `reset_in_progress`                 | A reset is already rebuilding the state. Tell the operator and wait for `reset` to disappear from `status`; don't retry.                                                            |
| `cleanup_running`                   | A cancelled Objective is still cleaning up (at most 5 tries), or a done one's last step is still ending. Run it again later, or `factory reset ISSUE` if the operator wants it now. |
| `issue_closed`                      | `run` names a closed issue Factory never ran. Tell the operator; it runs once they reopen it.                                                                                       |
| `deadline_passed`                   | The `run --deadline` passed before the Objective was admitted. Ask the operator for a new deadline.                                                                                 |
| `unknown_provider`                  | The service has no provider by that `--provider` name. Show the operator the message; run again without `--provider` only if they want it.                                          |
| `amendment_refused`                 | `propose-amendment` or `decline-discovery` wasn't taken; the message names each problem and what would pass. Show the operator, and run again only with their corrected content.    |
| `proposal_refused`                  | `propose` refused the draft or its approval; the message says why. Show the operator the message.                                                                                   |
| `export_refused`                    | `export-captures` can't build or send the export; the message says why. Show the operator, and check the collector before sending again.                                            |
| `dream_refused`                     | The playbook store refused a `dream` write: a changed or decided draft, or an unreadable store. Show the operator the message.                                                      |
| `service_not_running`               | `dream` needs the running service. Tell the operator; it works once the service runs.                                                                                               |
| `invalid_request`                   | The request file was malformed and moved to `requests/rejected/`. Run the command again.                                                                                            |
| `request_failed`                    | Applying the request failed; nothing changed. Show the operator the message, then run the command again once.                                                                       |
| `usage` (exit 2)                    | Fix the command.                                                                                                                                                                    |

Any other code, or a non-zero exit with no JSON line: show the operator the message (and the code, if any), and stop. Never retry a refused command unchanged.

## Recover

- **Service stopped:** ask the operator to start it the way it was set up (the `setup` skill installs it). A restart is the normal recovery path; the service continues from its last saved step without repeating GitHub effects.
- **Waiting on a cleared cause** (a provider limit lifted, the network back): `factory retry ISSUE` runs now the waiting steps that no open hold stops. It is refused while an Objective-wide hold is open: answer that hold instead.
- **Configuration changed:** the hold names the changed keys and offers `adopt` (re-freeze the current configuration), `switch NAME` (another provider) and `cancel`. When the frozen provider is no longer configured it offers `switch NAME`, `retry` (after restoring it and restarting) and `cancel`.
- **`unreadable` state:** the hold (id `unreadable`) offers `reset` and `cancel`. `factory reset ISSUE` rebuilds state from the plan comment, PRs and report on GitHub; run it only when the operator chooses it. The command returns at once; the reset is done when the rebuild lands and `status` no longer shows `reset`.
- **Repeated failure:** read `factory diagnostics ISSUE --summary` and `factory log ISSUE`, and diagnose before answering `retry` again. Never loop on the same answer.

## Steer

Feedback in this conversation ("item 3 edits the wrong file") is the operator's to give. No channel reaches a running step, so map it to what Factory offers:

- **Answers an open hold:** `factory answer`, as above.
- **Changes the Objective itself:** the author edits the issue. Factory notices the edit and holds with `continue`, `replan` and `cancel`.
- **Adds work the accepted plan lacks**, within the Objective: `factory propose-amendment ISSUE --file ABSOLUTE_PATH`, a JSON file with `scope` (`in-scope`), `reason`, and lists `evidence`, `ownership` (the paths it needs), `acceptance` and `dependencies` (existing Work Item ids, may be empty), all from the operator. The planner revises the plan, an independent review judges it, and it uses a planning revision. A rejected amendment holds, and answering `replace` with the operator's correction plans it again. Only on request.
- **Declines a worker's discovery:** a worker that finds work the plan lacks proposes it as an amendment, and its Work Item waits for the outcome. `factory decline-discovery ISSUE --item ITEM --reason TEXT` settles it as declined, and the item carries on with its result as collected; the planning revision stays spent. Only on request.
- **Applies after the Objective is done:** a successor Objective in a new issue.
- **Hold this Objective:** `factory pause ISSUE` starts no step until `resume`; `factory drain ISSUE` lets started Work Items finish and starts no new one. Only on request.
- **Hold the whole queue:** `factory queue pause` starts no step anywhere and admits nothing; `queue drain` admits nothing new while admitted Objectives carry on; `queue resume` undoes either. Only on request.
- **Stop this Objective now:** `factory cancel ISSUE`, only on request.

When feedback fits none of these, or two pieces conflict, ask instead of choosing.

## Observe the queue

`factory queue list --json` returns `queue` (its mode), `queued` (`{issue, order, status}` in run order), `candidates` (cards in another Status option), `inert` (cards that will never run, with a `reason`) and `truncated`. Report inert cards with their reason. `factory status` without an issue shows the service and every Objective with state: report holds first, then waits on gates, then progress. Give a short snapshot: each Objective's status, its open question, and what it waits on.
