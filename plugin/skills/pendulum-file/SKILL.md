---
name: pendulum-file
description: "Read issue readiness before source discovery, then draft, refine or admit an Objective on the user's yes. Use when the user wants Pendulum to build something or take an existing GitHub issue, even without naming a skill. Not for executing an admitted Objective or resuming a run."
---

# /pendulum:pendulum-file [issue]

The issue is the whole specification. Read its text, labels and readiness before source discovery. Ask only for what the Objective needs. The dispatched worker plans the change, owns its branch and edits, and delegates implementation. Write to GitHub only on a yes.

`<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead.

## Write the issue

- **Title:** the outcome in a few words.
- **`## Goal`:** two or three sentences on what a user or a caller can do once it is done, and why. State the outcome, not the implementation: name no files, functions or steps the user did not fix.
- **`## Acceptance`:** a list under this exact heading. Each entry is one thing that must be true and that a reviewer can check through the real path: a command and its output, a request and its response, a behaviour a test proves. Give exact values where they matter.
- **`## Context`,** when there is any: the user's decisions, contracts that must not change, what is out of scope (never under Acceptance: every item there is judged, sub-headings included).

Ask only for what the issue cannot be written without. Where the user left a choice open, write the simplest reading and say so.

## Check it

- **Doable now, here.** Every entry can be met from the default branch as it stands, in this repository; another repository's work is its own Objective.
- **Labels and limits:** another harness or model than the workflow's, workflow files, network hosts, blockers and the draft label: [reference.md](reference.md).
- **Trust.** Pendulum acts only on an issue whose author and last editor can push or are maintainers the workflow names: unless `gh api repos/OWNER/NAME --jq .permissions.push` prints `true`, a maintainer files it.
- **Nothing private.** No token, key or secret.

## Create it

Show the title, body and labels. Offer:

- **Start it now:** write the line `pendulum zone` prints (this machine's zone, for the Objective's times), a blank line and the body to a temporary file, and run `gh issue create --repo OWNER/NAME --title "<title>" --body-file <file> --label pendulum:objective`. Add `--label pendulum:local` for the user's own machine's loop, and `P0`, `P1` or `P2` for a priority. One that must follow another Objective gets the label only after its dependency (reference.md, Blocking Objectives).
- **Save it as a draft:** the same command with `--label pendulum:draft` in its place; Pendulum never runs a draft. A missing label: reference.md, The draft label.
- **Keep discussing:** nothing goes to GitHub; revise and show it again.

Create any harness, model or host label first (`gh label create <label> --repo OWNER/NAME --force`), then add it: one added after the plan is an edit.

## An existing issue (given its number)

Run `gh issue view <issue> --repo OWNER/NAME --json number,title,body,state,labels` and show it. Closed: say so and stop. Do what the user asked:

- **Refine it:** as Write the issue, keeping the text that still fits; save it back on a yes ([reference.md](reference.md), Refine a draft). A started one (`pendulum:objective`, no `pendulum:draft`) Blocks on an edit after its plan: say so first.
- **Start it:** admit a draft or unlabelled issue after the trust check ([reference.md](reference.md), Start a draft). Keep open dependencies in place. Follow admitted work through its dispatcher or existing run. Use pendulum-status for a Blocked one or a Question, and pendulum-restart only on request.

## After

Print the issue's URL. Admission puts it in the queue. Report it as running once Pendulum records the start, and point to the run, progress comment or verified active claim. Use pendulum-status to follow it or pendulum-serve for the existing local queue. A draft comes back here to refine or start.
