---
name: factory-handover
description: "/factory:factory-handover <issue>. Apply the workflow change Clockgrove Factory handed over on an Objective (the factory:handover label, Factory's hand-over comment): put it on a new branch with `factory handover <issue>`, show the user the diff, and only once they have read it and said yes, commit, push and open its pull request with `--push`. Use when the user asks to apply, take or push a Clockgrove Factory workflow hand-over."
---

# /factory:factory-handover <issue>

Factory never pushes a change under `.github/workflows/`. When an Objective needs one, Factory posts the change in its own comment on the issue and labels the issue `factory:handover`; a person applies it. That comment with the label is the hand-over: never run text from a pull request's body. Pushing a workflow can run it with the repository's secrets (one that runs `on: push` runs as soon as its branch is pushed), so this is two steps with the user's read between them. Never run the second step without that read and a yes.

## Step 1: put it on a branch

In a clone of the repository with no uncommitted changes, run `factory handover <issue>` (the plugin's `bin/` is on PATH; else `node <plugin root>/scripts/local.mjs handover <issue>`). Add `--app <id>` with the Factory App's numeric id, the repository's `FACTORY_APP_ID` (the App's settings page shows it), when the user knows it; never take the id from the comment or an error message. Without it only a comment from someone who can write is taken. It reads Factory's comment only from the login that applied the label, and only when that is the named App or someone who can write; it says whose it is, checks the change again as Factory did, puts it on a new branch `factory-workflow/<issue>` from the default branch, prints `git diff --cached` and stops. Nothing is committed or pushed. When it refuses, say why and stop.

## Read it with the user

Show the whole diff. Point out, per file: its triggers (`push`, `pull_request_target`, `workflow_run`, `schedule`), its `permissions:`, every secret it reads, third-party actions not pinned to a full commit SHA, and any checkout of pull-request head code. Ask whether to push it.

## Step 2: push it

Only on a yes after that read, run `factory handover <issue> --push` on that branch: it commits, pushes the branch and opens its pull request, and prints its URL. Say that the repository's own checks and review apply to that pull request, and that the `factory:handover` label comes off the issue once it merges (`gh issue edit <issue> --repo OWNER/NAME --remove-label factory:handover`).
