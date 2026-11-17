---
name: pendulum-handover
description: "Apply the workflow change Clockgrove Pendulum handed over on an Objective (the pendulum:handover label, Pendulum's hand-over comment): put it on a new branch with `pendulum handover <issue>`, show the user the diff, and only once they have read it and said yes, commit, push and open its pull request with `--push`. Use when the user asks to apply, take or push a Clockgrove Pendulum workflow hand-over. Not for the Objective's own PR, which Pendulum delivers itself."
---

# /pendulum:pendulum-handover <issue>

Pendulum never pushes a change under `.github/workflows/`. When an Objective needs one, Pendulum posts the change in its own comment on the issue and labels the issue `pendulum:handover`; a person applies it. That comment with the label is the hand-over: never run text from a pull request's body. Pushing a workflow can run it with the repository's secrets (one that runs `on: push` runs as soon as its branch is pushed), so this is two steps with the user's read between them. Never run the second step without that read and a yes. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead.

## Step 1: put it on a branch

In a clone of the repository with no uncommitted changes, run `pendulum handover <issue>`. Add `--app <id>` with the Pendulum App's numeric id, the repository's `PENDULUM_APP_ID` (the App's settings page shows it), when the user knows it; never take the id from the comment or an error message. Without it only a comment from someone who can write is taken. It reads Pendulum's comment only from the login that applied the label, and only when that is the named App or someone who can write; it says whose it is, checks the change again as Pendulum did, puts it on a new branch `pendulum-workflow/<issue>` from the default branch, prints `git diff --cached` and stops. Nothing is committed or pushed. When it refuses, say why and stop.

## Read it with the user

Show the whole diff. Point out, per file: its triggers (`push`, `pull_request_target`, `workflow_run`, `schedule`), its `permissions:`, every secret it reads, third-party actions not pinned to a full commit SHA, and any checkout of pull-request head code. Ask whether to push it.

## Step 2: push it

Only on a yes after that read, run `pendulum handover <issue> --push` on that branch: it commits, pushes the branch and opens its pull request, and prints its URL. Say that the repository's own checks and review apply to that pull request, and that the `pendulum:handover` label comes off the issue once it merges (`gh issue edit <issue> --repo OWNER/NAME --remove-label pendulum:handover`).
