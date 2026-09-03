# Credentials and environments

## What Factory needs

Factory runs in your agent harness with your own GitHub credentials. The bundled MCP server first
reads `GITHUB_TOKEN` or `GH_TOKEN` from its environment. If the harness does not forward ambient
variables into plugin subprocesses, Factory asks the already-authenticated GitHub CLI (`gh auth
token`) instead. Set one of the variables or run `gh auth login` once on that host; Factory never
stores or prints the resulting token.

It creates no GitHub environments, requires no repository secrets, and needs no token beyond the
operator's own. Installing the plugin grants no workflow, settings, secret, or activation authority.
It also requires no repository-local credential configuration.

## Policy on environments

GitHub environments are a **deployment** primitive. They gate a job behind approvals or branch
restrictions and scope secrets to a deployment target. They answer *"may this job run, and what may
it see?"*

One rule follows:

> An environment exists only to separate a credential that must not be visible to the rest of the
> repository. Never to select behavior, pin a model, or mark a phase.

Behavior selection belongs in configuration that is visible in the repository and reviewable in a
diff. A secret store is a bad configuration file: invisible, unversioned, and unreviewable. An
environment named after a step in a process — `-initial-assignment`, `-initial-model` — is
configuration wearing a trust boundary's clothes, and the correct count of environments is the number
of distinct trust boundaries, not the number of steps in a process.

**Target: zero Factory-created environments.** If Factory ever appears to need one, that is a finding
to record against the design, not a task to complete.

One environment may legitimately exist in a repository Factory works on: GitHub's Copilot coding
agent reads runtime configuration from an environment named `copilot`. That is platform convention,
not a Factory invention, and it should be created only when there is something to put in it.

## The one configuration step an adopter cannot avoid

The zero-environments target holds. A zero-configuration adoption does not, and the gap is worth
naming rather than hiding.

A repository whose pull requests run CI is subject to **Settings → Copilot → Coding agent → Require
approval for workflow runs**. While that is on, every agent-authored run parks in `action_required`
having executed nothing, and Factory correctly refuses to merge without CI evidence. Either a human
approves runs as they arrive, or the requirement is turned off deliberately.

That is one mandatory pre-flight decision, and by this document's own standard it is a portability
defect rather than a feature. It is recorded rather than fixed because it cannot be fixed from here:
the REST approve endpoint covers fork pull requests only and refuses a same-repository agent branch,
and the setting that governs the hold is readable over REST with no write. It is also GitHub's
account-wide default, so a fresh repository does not avoid it.

Factory's response is to escalate with the blast-radius evidence a human needs in order to decide,
which is the correct behavior for a decision the confidence bar places outside autonomy anyway. See
[`DESIGN.md`](DESIGN.md) §9.
