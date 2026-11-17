---
name: pendulum-file
description: "Write, refine and start Clockgrove Pendulum Objectives: turn what the user wants built into a GitHub issue with a goal and acceptance entries, created on the user's yes started (pendulum:objective) or as a draft (pendulum:draft); or, by issue number, refine or start a draft. Use when the user asks to file, draft, refine, keep working on or start a Clockgrove Pendulum Objective, or asks Clockgrove Pendulum to build something. Not for starting over one that already ran (pendulum-restart), resuming a Blocked one (pendulum-status) or running one on this machine (pendulum-run)."
---

# /pendulum:pendulum-file [issue]

An Objective is a GitHub issue that is the whole specification: the worker cannot ask anything while it runs. Write the issue, show it, and write to GitHub only on a yes. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead.

## Write the issue

- **Title:** the outcome in a few words.
- **`## Goal`:** two or three sentences on what a user or a caller can do once it is done, and why. State the outcome, not the implementation: name no files, functions or steps the user did not fix.
- **`## Acceptance`:** a list under this exact heading. Each entry is one thing that must be true and that a reviewer can check through the real path: a command and its output, a request and its response, a behaviour a test proves. Give exact values where they matter.
- **`## Context`,** when there is any: the user's decisions, contracts that must not change, what is out of scope (never under Acceptance: every item there is judged, sub-headings included).

Ask only for what the issue cannot be written without. Where the user left a choice open, write the simplest reading and point it out.

## Check it

- **Doable now, here.** Every entry can be met from the default branch as it stands, in this repository; another repository's work is its own Objective.
- **Labels and limits:** another harness or model than the workflow's, workflow files, network hosts, blockers and the draft label: [reference.md](reference.md).
- **Trust.** Pendulum acts only on an issue whose author and last editor can push or are maintainers the workflow names: unless `gh api repos/OWNER/NAME --jq .permissions.push` prints `true`, a maintainer files it.
- **Nothing private.** No token, key or secret goes in an issue.

## Create it

Show the title, body and labels, and offer:

- **Start it now:** write the body to a temporary file and run `gh issue create --repo OWNER/NAME --title "<title>" --body-file <file> --label pendulum:objective`. Add `--label pendulum:local` for the user's own machine's loop, and `P0`, `P1` or `P2` for a priority. One that must follow another Objective gets the label only after its dependency (reference.md, Blocking Objectives).
- **Save it as a draft:** the same command with `--label pendulum:draft` in its place; Pendulum never runs an issue while it is on. A missing label: reference.md, The draft label.
- **Keep discussing:** nothing goes to GitHub; revise and show it again.

Create any harness, model or host label first (`gh label create <label> --repo OWNER/NAME --force`), then add it: one added after the plan is an edit.

## An existing issue (given its number)

Run `gh issue view <issue> --repo OWNER/NAME --json number,title,body,state,labels` and show it. Closed: say so and stop. Do what the user asked:

- **Refine it:** as Write the issue, keeping the text that still fits; save it back on a yes ([reference.md](reference.md), Refine a draft). A started one (`pendulum:objective`, no `pendulum:draft`) Blocks on an edit after its plan: say so first.
- **Start it:** a draft, or an issue with neither label, after the trust check ([reference.md](reference.md), Start a draft). One started already: pendulum-status resumes a Blocked one or answers a Question; pendulum-restart starts it over.

## After

Print the issue's URL. Started: one comment on the issue shows its progress until it merges, Blocks or asks a Question; pendulum-status says where it stands. A draft: "Let's keep working on Clockgrove Pendulum Objective <number>" or "Start Clockgrove Pendulum Objective <number>" comes back here.
