---
name: factory-file
description: "/factory:factory-file. Turn what the user wants built into a Clockgrove Factory Objective: a GitHub issue in the current repository with a goal and acceptance entries, created on the user's yes either started (the factory:objective label) or saved as a draft (factory:draft) to refine and start later. Use when the user asks to file, create or queue a Clockgrove Factory Objective, or asks Clockgrove Factory to build something."
---

# /factory:factory-file

An Objective is a GitHub issue that is the whole specification: the worker cannot ask anything while it runs. Write the issue, show it, and create it only on a yes.

## Write the issue

- **Title:** the outcome in a few words.
- **`## Goal`:** two or three sentences on what a user or a caller can do once it is done, and why. State the outcome, not the implementation: name no files, functions or steps the user did not fix.
- **`## Acceptance`:** a list. Each entry is one thing that must be true and that a reviewer can check through the real path: a command and its output, a request and its response, a behaviour a test proves. Give exact values where they matter.
- **`## Context`,** when there is any: decisions the user has made, contracts that must not change, what is out of scope.

Ask the user only for what the issue cannot be written without. Where they left a choice open, write the simplest reading into the issue and point it out when you show it.

## Harness and models

The workflow sets the default harness and models (doctor names them). When the user wants others for this Objective, offer one label per kind: `factory:harness:claude`, `codex` or `copilot`; `factory:model:<id>` (worker); `factory:subagent-model:<id>`; `factory:reviewer-model:<id>`. A cheaper worker suits a small, bounded change, the strongest one trust, money or concurrency. Claude Code runs `claude-` models, Codex those in `plugin/scripts/lib/codex-prices.json`; no provider prefix. A label name is at most 50 characters (36 for a model id, 27 for the other two): drop a date suffix to fit.

## Check before creating

- **Doable now, here.** Every entry can be met from the default branch as it stands, in this one repository. Work that needs another repository is its own Objective there; work that must follow another Objective says so on a `Blocked by #N` line in the body.
- **Trust.** Factory acts on an issue only when its author, and its last editor, can push to the repository or is a maintainer the workflow names. `gh api repos/OWNER/NAME --jq .permissions.push` must print `true` for the login `gh` uses; otherwise say a maintainer has to file it.
- **Nothing private.** No token, key or secret goes in an issue.

## Create it

Show the title, the body and any harness or model labels, and offer three outcomes:

- **Start it now:** write the body to a temporary file and run `gh issue create --repo OWNER/NAME --title "<title>" --body-file <file> --label factory:objective`. Add `--label factory:local` when the user wants their own machine's loop to take it, and a `P0`, `P1` or `P2` label when they give a priority.
- **Save it as a draft:** the same command with `--label factory:draft` in place of `factory:objective`. Factory never runs an issue while `factory:draft` is on it. When GitHub says the label does not exist, create it first: `gh label create factory:draft --repo OWNER/NAME --color D4C5F9 --description "A draft Objective: Factory never runs it while this label is on"`.
- **Keep discussing:** nothing goes to GitHub; revise it and show it again.

With harness or model labels, run `gh label create <label> --repo OWNER/NAME --force` for each, then add `--label <label>` to either command: one added after the plan stops the Objective like an edit.

Print the issue's URL. For a started one, say what happens next: one comment on the issue shows the run's progress, and it ends merged, Blocked with the reason, or with a Question on a draft pull request. For a draft, say that "Let's keep working on Clockgrove Factory Objective <number>" refines it (the factory-draft skill) and "Start Clockgrove Factory Objective <number>" starts it (the factory-start skill).
