---
name: setup
description: Set up Factory for a target repository through one guided configuration-only or explicitly consented verified background flow.
---

# Factory setup

Use this skill on a target repository. Follow contributor instructions when building Factory itself; never target Factory source, rebuild or archive repositories.

Resolve the operator's intended outcome first. Recommend background operation on a supported Linux/WSL systemd user host when the request is to keep processing approved work. Honor an install-only or “do not start work” request with configuration-only setup. Package download alone grants no service or execution consent. Reuse positive choices, authority and limits already supplied in this session; ask together only for genuinely missing choices. Do not make registration, startup and verification separate operator chores.

Inspect `factory help` and the existing binding before writing. Confirm the GitHub `OWNER/REPO`, trusted absolute checkout, requested positive worker concurrency, regular or native-stack delivery, and any role model/reasoning choices. Read the target's instructions. Reuse a matching existing configuration; preserve conflicting state and report it rather than deleting or inventing another root. Fresh configuration persists explicit defaults when no model choices were supplied: planner `gpt-5.6-sol` with `medium` reasoning, reviewer `gpt-5.6-sol` with `medium` reasoning, and worker `gpt-5.6-luna` with `medium` reasoning. Keep configuration, credentials, state and the immutable installed package outside the target repository. Retain that exact package until supported upgrade/uninstall; do not register a scratch directory scheduled for cleanup.

During an explicitly authorized Objective's graph projection, Factory establishes the target role labels `factory:objective` and `factory:work-item`. The Objective receives the first; every compiled work, QA and aggregate issue receives the second. Missing repository labels use neutral `ededed` color. Existing colors, descriptions and unrelated issue labels remain intact. Archived or ambiguous role labels stop projection for an operator decision; Factory does not rename or unarchive them. Initial Work Items become native children of their Objective, and aggregate children attach to their aggregate. Dependency edges remain separate from parent links. Labels and hierarchy describe context; they grant no execution authority. Configuration-only and observation-only setup do not write these target labels.

Use the installed guided entry point when available:

```sh
factory setup --background --service-consent --actor OPERATOR --reason REASON \
  --retain-package --repository OWNER/REPO --checkout ABSOLUTE_PATH \
  --concurrency N --config ABSOLUTE_PRIVATE_CONFIG
```

For an existing matching configuration, omit installation choices already bound. Pass selected role options, delivery or network policy when creating a fresh configuration. `--retain-package` records the caller's commitment to retain the exact external installed path; it is not permission to delete another installation. The background flags reflect the operator's requested service operation. They grant no provider spending. An idle watcher with no execution authority observes GitHub, reports unapproved candidate IDs and waits model-free. Polling defaults to 30 seconds; pass `--poll-seconds N` only for an operator-selected interval.

When the same request includes explicitly authorized execution, pass `--authority ABSOLUTE_PRIVATE_FILE` with the operator's finite Objective IDs, execution consent, existing numeric allowances/resource ceilings and required environment. Use the documented [authority contract](https://github.com/clockgrove/factory/blob/main/docs/USER-GUIDE.md#admit-an-exact-plan-for-autonomous-work); invent no spending, repair or concurrency limits. Configuration remains authoritative for providers, permissions and source disclosure. Discovery, labels and service consent never admit another Objective. Execution-ready setup uses model-free readiness, not model calls as probes. For the local Codex harness, choose an existing outside directory you own with `--outside-directory` when the checkout's parent is unsuitable. Other harnesses need their supported readiness surface; unavailable readiness stays blocked. Managed credentials use the existing owner-private `--credential-file` surface and do not prove account access.

For configuration only:

```sh
factory setup --config-only --repository OWNER/REPO \
  --checkout ABSOLUTE_PATH --concurrency N --config ABSOLUTE_PRIVATE_CONFIG
```

This outcome remains usable without a supported user manager and stops before admission or service activation. Older artifacts without `setup` retain their documented `install` surface for configuration only; do not claim the new guided background outcome from a manually assembled substitute.

Inspect the returned JSON and exit status. Background completion requires `status: ready`, an active enabled service and exact verified owner/control connection. Report repository/configuration binding, retained artifact path, poll interval, approved IDs or idle reason, and sleep/shutdown/logout limits. A configuration file or registered unit alone is incomplete setup. A blocked result identifies the failed stage and stages already completed. Preserve them, inspect `supervisor status` and `intake status`, resolve the stated prerequisite through supported controls and repeat the same flow. Never silently resume paused/draining work, reset allowances, revive terminal work or remove evidence. Artifact changes use supported drain/compatibility/upgrade operations; unresolved ownership remains fenced.

Later Objective batches use explicit `factory intake enqueue --authority FILE --config CONFIG` at a settled idle boundary. The current authenticated owner handles refill without a second controller or queue. Active/failed nonterminal work prevents refill, and terminal work never replays. A consented watcher stays idle after its batch finishes; explicit finite intake still exits unless watch was selected. Use `pause`, `resume`, `drain`, `stop`, `disable` and `uninstall` through their packaged lifecycle controls. No administrator or linger changes are part of setup. Ordinary target setup needs no contributor release fixture or new provider.
