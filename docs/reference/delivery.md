# Delivery and cancel

Part of [the design](../DESIGN.md).

## Delivery

`delivery.kind` in the installation's configuration picks how Work Items reach the default branch. The service reads it once at start.

- **`regular`** (default): one PR per Work Item, merged with a merge commit once its checks pass.
- **`native-stack`**: each linear chain of the plan is one GitHub native stack. Each layer's PR targets the branch below it, and the top layer's merge step merges the whole stack with one shared merge commit. An item off a chain is an ordinary PR. When the layer below moves (GitHub updates it with the default branch, or it is repaired), GitHub merges its new head into the layer above, with no worker; only a conflict is that layer's repair.
- **Strict protection.** A PR BEHIND the default branch is updated by GitHub (update-branch), not by a worker; a conflict is the item's repair. A repair that only replays the refused change onto a moved base, and applies cleanly, runs no worker either.
- **`accept`.** A stack that merged by other means (layer by layer, or with different merge commits) is a question with `accept`, `retry` and `cancel`. `accept` takes the unit as delivered once every layer is merged at Factory's head with its merge commit on the default branch; otherwise the question names what is missing.
- **Changing it.** A plan is split by the setting it ran with, so a retry never switches it. To deliver an Objective without native stacks: cancel it, set `delivery.kind` to `regular`, restart the service and queue it again.

## Cancel

`/factory cancel`, `factory cancel <issue>`, or the Objective's deadline (see [Deadlines](steps.md#deadlines)):

1. Abort the Objective's running steps. This kills the process groups the service started for those steps; it tracks them in memory, and they die with the service anyway.
2. Close every open Factory PR of the Objective (each branch under `factory/<issue>/`, whatever plan made it) with a comment, delete those branches Factory made (see [Idempotence](steps.md#idempotence)), close the issue as not planned, and set Status to Cancelled.
3. Mark the state cancelled, recording who cancelled and when (`ended`).
4. Post one closing comment on the issue (github-sync.ts, marker `cancelled:<run>`): who cancelled it, or that its deadline passed. Only a `/factory cancel` comment's author is named (`ended.source: github`); a CLI cancel says "the operator", never the host's user name. A cancelled Objective settles once it is posted, or GitHub refused it (`cancel-comment-given-up`). None for a dequeued run withdrawn before it started, or while `progress.enabled` is false. Crash points: `sync:cancel:before` and `sync:cancel:after`.

Cancel reads only the Objective's state file and its open PRs, so its cost doesn't depend on history. It can't be refused. If closing a PR fails, the close is retried in the background; it never blocks the cancel. An issue GitHub no longer has here (404 or 410: deleted; a redirect, while the repository itself has not moved: transferred away) has nothing to close: the PRs, branches and work files still go, and the Objective settles.
