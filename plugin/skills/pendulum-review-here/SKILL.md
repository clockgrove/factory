---
name: pendulum-review-here
description: "Review one Pendulum Objective's PR of the current repository by number: in this session with the reviewer's skill, posting one comment-only pass of line-tied findings as the user only once they have read it and said yes; or, on their yes, with local mode's sandboxed review stage (`pendulum review <pr> --wait`). Use when the user asks to review a Pendulum PR. Not for answering a review's comments, which the worker does (pendulum-run)."
---

# /pendulum:pendulum-review-here <pr>

One reviewer pass on a Pendulum PR, as the Action's review job makes it. `<plugin root>` is `${CLAUDE_PLUGIN_ROOT}` in Claude Code, elsewhere two directories above this SKILL.md; where `pendulum` is not on PATH (only Claude Code puts the plugin's `bin/` there), run `node <plugin root>/scripts/local.mjs` instead.

## Gather

1. `gh pr view <pr> --json number,title,body,headRefName,baseRefName,isDraft,headRefOid`; the head is a `pendulum/<issue>` branch, or the user said to review it anyway.
2. The Objective issue: the number from the branch, then `pendulum issue <issue> --out <file outside the clone>`; read that file, never the issue on GitHub. It refuses an issue whose author, last editor or latest title renamer cannot push and is no pinned maintainer: stop and relay its message; the review job Blocks such an Objective, and `post-review` posts nothing for it.
3. The diff: `gh pr diff <pr>`.
4. `gh pr checks <pr>`: if validation has not passed, say so; reviewing a red PR is the user's choice.
5. Whether a review body already carries `<!-- pendulum:<issue>:review -->`: if so, the one pass has run; say so and stop unless the user wants another. A foundation Objective's own marker: [reference.md](reference.md).

## Ask

Offer two ways, the default first, saying what each writes and spends:

- **In this session (default).** You make the pass here, on this session's model and spend; it is posted only on a second yes, once the user has read it (Review, below).
- **Sandboxed: `pendulum review <pr> --wait`.** Local mode's review stage on this machine, in sandboxes on its harness login: the reviewer posts its one pass, the worker's answer pass answers it with commits on the PR's branch, and with `auto_merge` on it follows the PR through its checks and the merge queue to merged (without `--wait`, a PR not yet green waits for a running `pendulum serve` or the Action to merge it). The stage stops at `max_usd` (doctor's `settings` row); its spend is booked on the issue toward `daily_usd`. It needs local mode set up (the pendulum-setup skill); if it refuses, relay its message, which names the fix.

Either posts a public review as the user (local mode's token, else their `gh` login). Ask which; act only on a yes.

## Sandboxed

Run it in the background and report its `[#<issue> …]` lines, its exit and the review's link. Where this harness cannot run a command in the background, give the user the command to run in a terminal of their own, and read its output once they say it has ended.

## Review

Read `<plugin root>/skills/pendulum-review-pr/SKILL.md` (the reviewer's skill) and follow it. The reviewer is one model call on the top model: if this session's model is not the reviewer model pinned in this plugin's `agents/` for this harness, spawn the `reviewer` agent definition and give it the issue text, the diff, the PR body and the skill's absolute path (`<plugin root>/skills/pendulum-review-pr/SKILL.md`, its `reference.md` beside it); otherwise do the pass yourself. Either way the result is the skill's JSON: `acceptance` (one judgment per entry) and `comments` (`path`, `line`, `entry`, `body`). A foundation Objective (`pendulum:foundation`, as `pendulum issue` says) needs the foundation pass too: [reference.md](reference.md).

Write that JSON to a file outside the clone. Show the user the judgments and the comments, one per line as `path:line: first sentence`, and ask whether to post them. On a yes, run `pendulum post-review <pr> <file>` ([reference.md](reference.md), Posting). Post nothing yourself; never approve, never request changes.

## After

Say how many comments were posted. The worker (the pendulum-run skill on the branch, or the Action's worker pass) answers them, not you. The Action's answer pass answers this review like its own, since it carries the marker and comes from someone who can push.
