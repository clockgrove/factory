# Factory

A GitHub-native engineering-management plugin. You author an **Objective**; Factory compiles it into
**Work Items**, dispatches them to parallel GitHub Copilot coding-agent sessions, supervises the
results, integrates what is good, and asks a human about what is not.

Factory targets GitHub Copilot CLI today. Manifests for Codex and Claude Code ship in the same tree;
running an identical Objective on all three is a separate check, not something the design assumes.

## How it works

```
  Objective (human)
        │
        ▼
  ┌─────────────────────────────┐
  │  Factory — runs in the      │   the loop lives in the agent harness,
  │  agent harness              │   not in GitHub Actions
  │                             │
  │  compile → dispatch →       │
  │  supervise → replan         │
  └─────────────────────────────┘
        │                ▲
        │ Issues,        │ PRs, diffs,
        │ assignment     │ terminal state
        ▼                │
  ┌─────────────────────────────┐
  │  GitHub                     │   durable state + execution substrate
  │  Issues · Copilot sessions  │
  │  Pull Requests              │
  └─────────────────────────────┘
```

Two constraints shape everything:

1. **No deployed infrastructure.** No database, queue, dashboard, or service. GitHub holds the
   durable state; the harness holds the loop.
2. **Harness- and model-agnostic.** Packaged as an [Agent Plugins 1.0](https://agent-plugins.org)
   package — an open, vendor-neutral standard — targeting Codex, GitHub Copilot, and Claude Code with
   no architectural primacy for any. Factory selects no model anywhere.

### Derived state

Factory stores nothing. Every Work Item's state is a pure function of what GitHub currently says:

| Concept | GitHub primitive |
|---|---|
| Objective | Issue labelled `factory:objective` |
| Work Item | **sub-issue** of the Objective |
| Dependency | native **`blocked by`** relationship |
| Assignment | `copilot-swe-agent` as assignee |
| Attempt | a linked pull request |
| Completion | PR merged → issue closed |

There is no status label, no sidecar file, and no lease. Nothing stored can go stale or diverge,
crash recovery is free, and "resume" and "start" are the same code path.

## Install

```bash
copilot plugin marketplace add clockgrove/factory
copilot plugin install factory@clockgrove
copilot plugin list
```

Factory runs no install script and does not need `node_modules`; the committed bundle is the artifact
the plugin launches. The repository must be public, or the adopter must independently have read
access.

Start a new Copilot CLI session, invoke the `director` skill, and give it an Objective repository,
issue number, and escalation login. The MCP server reads `GITHUB_TOKEN` or `GH_TOKEN` from the harness
environment when its first tool is called.

### Upgrade

```bash
copilot plugin update factory@clockgrove
```

Restart the session afterwards. Objective state lives in GitHub, so upgrading or restarting Factory
requires no migration.

### Pinning

Tracking the default branch is the normal path and the one these instructions assume. Pin when a run's
result has to mean something — an experiment must not have its instrument change underneath it — or as
a review posture, since Factory holds a token and merges pull requests unattended, so adopting new
code grants it that authority.

Pin by appending a `#<ref>` to the marketplace source:

```bash
copilot plugin marketplace add "clockgrove/factory#some-ref"
```

**`<ref>` must be a branch or tag name, never a commit SHA.** The CLI resolves the fragment with
`git clone --depth 1 --branch <ref>`, which accepts only branches and tags. To move, `marketplace
remove` and re-add at the new ref.

### Uninstall

```bash
copilot plugin uninstall factory
copilot plugin marketplace remove clockgrove
```

Uninstalling removes the local plugin only. It does not delete or mutate Objectives, Work Items, pull
requests, labels, repository settings, environments, or secrets.

## Before you point it at a repository

Factory creates no environments and requires no repository secrets — it acts with the operator's own
harness credentials. Two things about the target repository do matter:

- **Ship a CI workflow that runs on `pull_request`.** Without one, GitHub reports no check runs and a
  `ready` verdict silently narrows to "open, mergeable, touches the expected files" — nothing has
  actually executed the code.
- **Decide how the workflow-approval hold is set.** GitHub ships repositories with *"Require approval
  for workflow runs"* enabled for the Copilot coding agent, so every workflow run on an agent-authored
  pull request parks in `action_required` until a human clicks *Approve and run workflows*. Factory
  refuses to merge without CI evidence and escalates. It cannot clear the hold itself: the REST
  approve endpoint covers *fork* pull requests only and refuses a same-repo agent branch, and the
  repository setting that governs the hold is readable over REST with no write.

```bash
# check the current value
gh api repos/OWNER/REPO/copilot/cloud-agent/configuration --jq .require_actions_workflow_approval
```

Either approve runs as they arrive, or turn the requirement off at **Settings → Copilot → Coding
agent → Require approval for workflow runs**. Decide it deliberately — it governs every future agent
run in that repository, not one pull request. When Factory escalates, it attaches the blast-radius
evidence a human needs in order to decide: whether the default workflow token is read-only, whether
any pull-request workflow can reach a secret, and whether a self-hosted runner is involved.
Repositories with no pull-request CI are unaffected. Full account in
[`docs/DESIGN.md`](docs/DESIGN.md) §9.

## What Factory does on its own, and what it refuses to

Factory merges autonomously only when the mechanical checks pass, a semantic review of the actual diff
says it satisfies the Work Item's acceptance criteria and nothing more, the change is reversible, and
it touches no security-sensitive surface.

It stops and asks a human when intent is ambiguous, when the diff touches workflows, permissions,
secrets or release configuration, when behavior not named in the Work Item is deleted or rewritten,
when a conflict needs a judgment about intent, or when an action would be irreversible. Escalation is
a first-class successful outcome, not a failure — the measure is whether escalations are well-founded,
not whether they are rare. The full bar is [`docs/DESIGN.md`](docs/DESIGN.md) §7.3.

## Development

For a source checkout, the CLI entry point is read-only and prints the derived state of an Objective:

```bash
npm install && npm run build
GITHUB_TOKEN=$(gh auth token) node dist/factory.js owner/repo 42
```

To check the thing that actually ships — the manifests, the skills, and the bundled MCP server
starting and serving its tools over stdio with no install step and no token:

```bash
npm run verify:package
```

Worth running after any change to `mcp.json`, `plugin.json`, the skill frontmatter, or the tool
surface. Note that it is **not** an install test: it starts the committed bundle the way the manifest
says to, which is a strictly weaker claim than "a real Copilot CLI can install this". Before claiming
a change is installable, install the published artifact the way a stranger would.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full validation loop.

## Documentation

- [`docs/DESIGN.md`](docs/DESIGN.md) — goals, scope, non-goals, the loop, evaluation and integration
  rules, the confidence bar, packaging, and stated limitations.
- [`docs/PLATFORM-BEHAVIOR.md`](docs/PLATFORM-BEHAVIOR.md) — measured behavior of GitHub's coding
  agent and API that the design rests on.
- [`docs/CREDENTIALS.md`](docs/CREDENTIALS.md) — what Factory needs in order to run, and what it
  deliberately does not.

## License

Factory is released under the [MIT License](LICENSE).
