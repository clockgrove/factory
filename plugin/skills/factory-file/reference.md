# factory-file: reference

Detail for the factory-file skill. SKILL.md says when to load each section; every rule here is as binding as one there.

## Workflow files

Factory never pushes a change under `.github/workflows/`. When the work needs one, tell the user now, before anything is filed: the run hands that change over in Factory's comment on the issue, labelled `factory:handover`, for a person to read and apply after the pull request merges with `factory handover <issue>`, and the rest lands as usual. Or they land the workflow change themselves first, and the Objective builds on it.

## Network hosts

An Objective's sandboxes reach GitHub, the npm and Yarn registries and the hosts the repository allows for every Objective. When the work needs one more (a model hub, a vendor's API), offer a `factory:host:<host>` label per host (`factory:host:huggingface.co`, or `factory:host:*.hf.co` for subdomains): it opens that host to this Objective's sandboxes alone, and counts only when someone who can push applies it. A host name only: no scheme, port, path, IP address or `localhost`, and at most 37 characters. `*.` is refused over a public suffix, as the Public Suffix List names them (`*.com`, `*.co.uk`, `*.github.io`, `*.vercel.app`): a wildcard covers one organisation's name. The check is on the name alone: a name that resolves to a loopback or link-local address is not refused. Offer the narrowest host the work needs.
