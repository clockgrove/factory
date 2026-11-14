# factory-file: reference

Detail for the factory-file skill. SKILL.md says when to load each section; every rule here is as binding as one there.

## Workflow files

Factory never pushes a change under `.github/workflows/`. When the work needs one, tell the user now, before anything is filed: the run hands that change over in Factory's comment on the issue, labelled `factory:handover`, for a person to read and apply after the pull request merges with `factory handover <issue>`, and the rest lands as usual. Or they land the workflow change themselves first, and the Objective builds on it.
