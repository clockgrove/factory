# factory-file: reference

Detail for the factory-file skill. SKILL.md says when to load each section; every rule here is as binding as one there.

## Workflow files

Factory never pushes a change under `.github/workflows/`. When the work needs one, tell the user now, before anything is filed: the run hands that change over in Factory's comment on the issue, labelled `factory:handover`, for a person to read and apply after the pull request merges with `factory handover <issue>`, and the rest lands as usual. Or they land the workflow change themselves first, and the Objective builds on it.

## Label limits

A label name is at most 50 characters: 36 for the model id of `factory:model:<id>`, 27 for that of `factory:subagent-model:<id>` and `factory:reviewer-model:<id>`. Drop a date suffix to fit.

## Network hosts

An Objective's sandboxes reach GitHub, the npm and Yarn registries and the hosts the repository allows for every Objective. When the work needs one more (a model hub, a vendor's API), offer a `factory:host:<host>` label per host (`factory:host:huggingface.co`, or `factory:host:*.hf.co` for subdomains): it opens that host to this Objective's sandboxes alone, and counts only when someone who can push applies it. A host name only: no scheme, port, path, IP address or `localhost`, and at most 37 characters. The check is on the name alone: `*.` is refused only over a bare top-level domain, so `*.co.uk` or `*.github.io` would pass and open every site under it, and a name that resolves to a loopback or link-local address is not refused. Offer the narrowest host the work needs.

## Blocking Objectives

When the work must follow another Objective `<N>`, make `<N>` block it as a GitHub issue dependency before the issue carries `factory:objective`: that label starts it at once, and the dispatcher reads the dependency, not the body (a `Blocked by #N` line counts only on a host without dependencies). In this order:

1. Create the issue with the "Start it now" command less `--label factory:objective` (a draft keeps `--label factory:draft`).
2. Add the dependency: `gh api -X POST repos/OWNER/NAME/issues/<new>/dependencies/blocked_by -F issue_id=$(gh api repos/OWNER/NAME/issues/<N> --jq .id)`.
3. Check it: `gh api repos/OWNER/NAME/issues/<new>/dependencies/blocked_by --jq '.[].number'` prints `<N>`. If not, stop and say so.
4. Start it: `gh issue edit <new> --repo OWNER/NAME --add-label factory:objective`. A draft stays a draft; the factory-start skill starts it later.

The dispatcher then starts it only once `<N>` is closed.

## The draft label

When GitHub says `factory:draft` does not exist, create it, then run the draft's command again: `gh label create factory:draft --repo OWNER/NAME --color D4C5F9 --description "A draft Objective: Factory never runs it while this label is on"`.
