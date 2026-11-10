---
name: review
description: /factory:review <pr>. Run the Factory reviewer in this session on one PR of the current repository: one comment-only pass of line-tied findings. Use when the user asks to review a Factory PR by number.
---

# /factory:review <pr>

Run one reviewer pass on a PR in this session, exactly as the Action's reviewer job does.

## Gather

1. `gh pr view <pr> --json number,title,body,headRefName,baseRefName,isDraft,headRefOid` and confirm the head is a `factory/<issue>` branch, or the user said to review it anyway.
2. The Objective issue: the number from the branch, then `factory issue <issue> --out <file outside the clone>` (else `node <plugin root>/scripts/local.mjs issue <issue> --out <file>`) and read that file, never the issue from GitHub. It writes the issue only when its author and last editor can push or are pinned maintainers; if it refuses, stop and relay its message: the review job Blocks such an Objective, and `post-review` posts nothing for it.
3. The diff: `gh pr diff <pr>`.
4. The validation state: `gh pr checks <pr>`. If validation has not passed, say so; the reviewer job runs after validation, and a review of a red PR is the user's choice.
5. Whether a review body already carries `<!-- factory:<issue>:review -->`: if so, the one pass has run; say so and stop unless the user wants another.

## Review

Load the `review-pr` skill and follow it. The reviewer is one model call on the top model: if this session's model is not the reviewer model pinned in this plugin's `agents/` for this harness, spawn the `reviewer` agent definition and give it the issue text, the diff and the PR body; otherwise do the pass yourself. Either way the result is the skill's JSON: `acceptance` (one judgment per entry) and `comments` (`path`, `line`, `entry`, `body`), each comment on an entry carrying its `entry`.

Write that JSON (`{"acceptance": [...], "comments": [...]}`) to a file outside the clone, and have Factory post it: `factory post-review <pr> <file>` (else `node <plugin root>/scripts/local.mjs post-review <pr> <file>`). Factory fits each comment to the diff, adds one for each entry judged not met without one, neutralises mentions and markers in the text, and posts one comment-only review with the judgments in its body on the head with the `<!-- factory:<issue>:review -->` marker, so the Action's review job does not repeat the pass. It posts nothing from a file with no reviewer JSON or no judgment of the issue's entries; fix the file and run it again. Post nothing yourself; never approve, never request changes.

## After

Tell the user how many comments were posted and list them one per line as `path:line: first sentence`. The worker (`/factory:run <issue>` on the branch, or the Action's worker pass) answers them; do not answer them yourself. The Action's answer pass answers this review like its own, since it carries the marker and comes from someone who can push.
