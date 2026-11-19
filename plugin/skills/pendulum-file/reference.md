# pendulum-file: reference

Detail for the pendulum-file skill. SKILL.md says when to load each section; every rule here is as binding as one there.

## Workflow files

Pendulum never pushes a change under `.github/workflows/`. When the work needs one, tell the user now, before anything is filed: the run hands that change over in Pendulum's comment on the issue, labelled `pendulum:handover`, for a person to read and apply after the pull request merges with `pendulum handover <issue>`, and the rest lands as usual. Or they land the workflow change themselves first, and the Objective builds on it.

## Label limits

A label name is at most 50 characters: 35 for the model id of `pendulum:model:<id>`, 26 for that of `pendulum:subagent-model:<id>` and `pendulum:reviewer-model:<id>`. Drop a date suffix to fit.

## Network hosts

An Objective's sandboxes reach GitHub, the npm and Yarn registries and the hosts the repository allows for every Objective. When the work needs one more (a model hub, a vendor's API), offer a `pendulum:host:<host>` label per host (`pendulum:host:huggingface.co`, or `pendulum:host:*.hf.co` for subdomains): it opens that host to this Objective's sandboxes alone, and counts only when someone who can push applies it. A host name only: no scheme, port, path, IP address or `localhost`, and at most 36 characters. `*.` is refused over a top-level name (`*.com`) and over any name the Public Suffix List holds as a public suffix, or holds one below (`*.co.uk`, `*.github.io`, `*.amazonaws.com`). The check is on the name alone: a name that resolves to a loopback or link-local address is not refused. Offer the narrowest host the work needs.

## Blocking Objectives

When the work must follow another Objective `<N>`, record the GitHub issue dependency while Draft is on. The dispatcher reads that dependency. A `Blocked by #N` line counts only on a host without dependencies. In this order:

1. Create the issue with both `pendulum:objective` and `pendulum:draft`.
2. Add the dependency: `gh api -X POST repos/OWNER/NAME/issues/<new>/dependencies/blocked_by -F issue_id=$(gh api repos/OWNER/NAME/issues/<N> --jq .id)`.
3. Check it: `gh api repos/OWNER/NAME/issues/<new>/dependencies/blocked_by --jq '.[].number'` prints `<N>`. If not, stop and say so.
4. To start it, follow Start a draft. Keep both labels while the user wants it held.

The dispatcher then starts it only once `<N>` is closed.

## The draft label

When GitHub says `pendulum:draft` does not exist, create it, then run the draft's command again: `gh label create pendulum:draft --repo OWNER/NAME --color D4C5F9 --description "A draft Objective: Pendulum never runs it while this label is on"`.

## Harness and models

When the user wants another harness or model than the workflow's for this Objective, offer one label per kind: `pendulum:harness:claude`, `codex` or `copilot`; `pendulum:model:<id>` (worker); `pendulum:subagent-model:<id>`; `pendulum:reviewer-model:<id>`. A cheaper worker suits a small, bounded change, the strongest one trust, money or concurrency. Claude Code runs `claude-` models, Codex those in `<plugin root>/scripts/lib/codex-prices.json`; no provider prefix. Label names have length limits (Label limits).

## Refine a draft

A draft lives on GitHub, not in this chat: Pendulum never runs an issue with `pendulum:draft` on it, so edit it freely. Once an Objective has been released from Draft, an edit before its first plan is used by the run. After that, a typo, formatting or wording-only edit keeps the plan. Any other edit Blocks the Objective at its next stage. Resuming through Draft plans again from the new text ([Edit an Objective](https://github.com/clockgrove/pendulum/blob/v0.10.9/docs/USAGE.md#edit-an-objective)). Say so before going on, and offer to make it a draft again first: `gh issue edit <issue> --repo OWNER/NAME --add-label pendulum:draft`, which stops a running stage (a missing label: The draft label).

Refine it as SKILL.md writes an Objective: the title, `## Goal`, `## Acceptance`, `## Context`, and its checks. Change only what you discussed. Then show the whole new title and body, and say what changed. Write nothing to GitHub without a yes; on a no, keep discussing or leave the issue as it is. On a yes:

1. Read the issue again. When its title or body changed on GitHub since you loaded it, show that change and ask which text to keep.
2. Check that `gh api repos/OWNER/NAME --jq .permissions.push` prints `true`: whoever saves the body becomes its last editor, and whoever changes the title its latest renamer, and Pendulum acts on an issue only when both can push. Otherwise say a maintainer has to save it.
3. Write the body to a temporary file, run `gh issue edit <issue> --repo OWNER/NAME --title "<title>" --body-file <file>`, and delete the file. If an older managed draft lacks `pendulum:objective`, verify Draft is still on before restoring its Objective label. Leave Draft on when saving a draft.

Then offer the next step: keep working on it, leave it as a draft, or start it (Start a draft).

## Start a draft

`pendulum:objective` stays on the issue as its identity. Removing `pendulum:draft` queues it for the dispatcher. Confirm before releasing the hold because processing spends model budget.

**Check the issue.** An Objective without Draft is already released to its configured route. Check dependencies and follow its dispatcher or existing run. Use pendulum-status for a Blocked one or a Question. A draft or unlabelled issue without a goal or acceptance entries needs refinement first (SKILL.md). When Draft was applied to stop work, wait for the old stage to exit and the PR to leave the merge queue before removing it.

Read open dependencies with `gh api --paginate repos/OWNER/NAME/issues/<issue>/dependencies/blocked_by --jq '.[] | select(.state == "open") | .number'`. On a GitHub host without issue dependencies, use the body fallback described under Blocking Objectives. If the read fails, report that readiness is unknown. Report any open dependency as a queue condition and preserve the link.

**Check trust.** Pendulum acts on an issue only when its author, its last editor once the body was edited, and whoever made the latest rename once the title was renamed, is a person who can push to the repository or a maintainer the workflow names (`PENDULUM_NOTIFY` or `PENDULUM_MAINTAINERS` in `.github/workflows/pendulum.yml`, as `login#id`). Otherwise the run Blocks before any model reads the text, so check first:

1. `gh api graphql -f query='query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){issue(number:$i){lastEditedAt author{__typename login} editor{__typename login} title timelineItems(itemTypes:[RENAMED_TITLE_EVENT],last:1){nodes{...on RenamedTitleEvent{actor{__typename login} currentTitle}}}}}}' -f o=OWNER -f n=NAME -F i=<issue>`. The body was edited when `lastEditedAt` or `editor` is set; then the editor counts too, and an editor that reads as null (a deleted account) fails. The title was renamed when `timelineItems` has a node; then its actor counts too, and one that reads as null, or a `currentTitle` other than `title`, fails.
2. Each one counted must have `__typename` `User`: an App or bot never vouches.
3. For each login, `gh api repos/OWNER/NAME/collaborators/<login>/permission --jq '.permission + " " + .role_name'` must show `admin`, `maintain` or `write`, or the login is one of the workflow's maintainers.

When a check fails, or a login cannot be read, do not start it. Say who and why: an author who fails means a person who can push files it again as a new issue; a last editor who fails means a person who can push reads the body and saves it, becoming its last editor; a renamer who fails means a person who can push reads the title and changes it (the same title records no rename).

**Ask.** Show the issue, labels, dependencies and people the trust check read. Explain that removing Draft queues the Objective for its configured dispatcher, subject to dependency and capacity checks. Confirm the start if the user has not already approved this exact issue and its start.

**Start it.** For an unlabelled issue or legacy draft missing `pendulum:objective`, add `pendulum:draft` if absent and verify it before adding `pendulum:objective`. Verify both labels before starting. Apply any approved route or dependency updates while Draft is on. Run `gh issue edit <issue> --repo OWNER/NAME --remove-label pendulum:draft`. Print its URL and observed state as described in SKILL.md.
