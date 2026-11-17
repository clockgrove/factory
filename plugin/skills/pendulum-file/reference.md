# pendulum-file: reference

Detail for the pendulum-file skill. SKILL.md says when to load each section; every rule here is as binding as one there.

## Workflow files

Pendulum never pushes a change under `.github/workflows/`. When the work needs one, tell the user now, before anything is filed: the run hands that change over in Pendulum's comment on the issue, labelled `pendulum:handover`, for a person to read and apply after the pull request merges with `pendulum handover <issue>`, and the rest lands as usual. Or they land the workflow change themselves first, and the Objective builds on it.

## Label limits

A label name is at most 50 characters: 35 for the model id of `pendulum:model:<id>`, 26 for that of `pendulum:subagent-model:<id>` and `pendulum:reviewer-model:<id>`. Drop a date suffix to fit.

## Network hosts

An Objective's sandboxes reach GitHub, the npm and Yarn registries and the hosts the repository allows for every Objective. When the work needs one more (a model hub, a vendor's API), offer a `pendulum:host:<host>` label per host (`pendulum:host:huggingface.co`, or `pendulum:host:*.hf.co` for subdomains): it opens that host to this Objective's sandboxes alone, and counts only when someone who can push applies it. A host name only: no scheme, port, path, IP address or `localhost`, and at most 36 characters. `*.` is refused over a top-level name (`*.com`) and over any name the Public Suffix List holds as a public suffix, or holds one below (`*.co.uk`, `*.github.io`, `*.amazonaws.com`). The check is on the name alone: a name that resolves to a loopback or link-local address is not refused. Offer the narrowest host the work needs.

## Blocking Objectives

When the work must follow another Objective `<N>`, make `<N>` block it as a GitHub issue dependency before the issue carries `pendulum:objective`: that label starts it at once, and the dispatcher reads the dependency, not the body (a `Blocked by #N` line counts only on a host without dependencies). In this order:

1. Create the issue with the "Start it now" command less `--label pendulum:objective` (a draft keeps `--label pendulum:draft`).
2. Add the dependency: `gh api -X POST repos/OWNER/NAME/issues/<new>/dependencies/blocked_by -F issue_id=$(gh api repos/OWNER/NAME/issues/<N> --jq .id)`.
3. Check it: `gh api repos/OWNER/NAME/issues/<new>/dependencies/blocked_by --jq '.[].number'` prints `<N>`. If not, stop and say so.
4. Start it: `gh issue edit <new> --repo OWNER/NAME --add-label pendulum:objective`. A draft stays a draft; the pendulum-start skill starts it later.

The dispatcher then starts it only once `<N>` is closed.

## The draft label

When GitHub says `pendulum:draft` does not exist, create it, then run the draft's command again: `gh label create pendulum:draft --repo OWNER/NAME --color D4C5F9 --description "A draft Objective: Pendulum never runs it while this label is on"`.

## Harness and models

When the user wants another harness or model than the workflow's for this Objective, offer one label per kind: `pendulum:harness:claude`, `codex` or `copilot`; `pendulum:model:<id>` (worker); `pendulum:subagent-model:<id>`; `pendulum:reviewer-model:<id>`. A cheaper worker suits a small, bounded change, the strongest one trust, money or concurrency. Claude Code runs `claude-` models, Codex those in `<plugin root>/scripts/lib/codex-prices.json`; no provider prefix. Label names have length limits (Label limits).
