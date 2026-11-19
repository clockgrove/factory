---
name: pendulum-file
description: "Read issue readiness before source discovery. File, refine or start a Pendulum Objective on the user's yes. Use when asked to hand new work or an existing issue to Pendulum, even in plain language. Not for executing an Objective or resuming a Blocked run."
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

Show the title, body and labels. On a yes to save as a draft or start, prefix the body with `pendulum zone` and a blank line. Create the issue with both labels:

`gh issue create --repo OWNER/NAME --title "<title>" --body-file <file> --label pendulum:objective --label pendulum:draft`

Add `pendulum:local` for the local loop if chosen, and any agreed priority, harness, model or host labels. Create missing labels first. Add dependencies while Draft is on ([reference.md](reference.md), Blocking Objectives). To start, follow Start a draft. To save a draft, leave both labels on. To keep discussing, revise without writing to GitHub.

## An existing issue (given its number)

Run `gh issue view <issue> --repo OWNER/NAME --json number,title,body,state,labels` and show it. Closed: say so and stop. Do what the user asked:

- **Refine it:** as Write the issue, keeping the text that still fits; save it back on a yes ([reference.md](reference.md), Refine a draft). A started one (`pendulum:objective`, no `pendulum:draft`) Blocks on an edit after its plan: say so first.
- **Start it:** remove Draft after the trust check ([reference.md](reference.md), Start a draft). Keep `pendulum:objective` and any dependencies. Follow work already in the queue through its dispatcher or existing run. Use pendulum-status for Blocked work or Questions, and pendulum-restart only on request.

## After

Print the issue's URL and state. Draft removal queues the Objective. Cite a run, current progress comment or verified active claim before reporting that work began. Use pendulum-status or pendulum-serve to follow it.
