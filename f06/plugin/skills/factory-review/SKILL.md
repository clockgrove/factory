---
name: factory-review
description: /factory review <pr>. Run the Factory reviewer in this session on one PR of the current repository: one comment-only pass of line-tied findings. Use when the user asks to review a Factory PR by number.
---

# /factory review <pr>

Run one reviewer pass on a PR in this session, exactly as the Action's reviewer job does.

## Gather

1. `gh pr view <pr> --json number,title,body,headRefName,baseRefName,isDraft,headRefOid` and confirm the head is a `factory/<issue>` branch, or the user said to review it anyway.
2. The Objective issue: the number from the branch or the title, then `gh issue view <issue> --json title,body`.
3. The diff: `gh pr diff <pr>`.
4. The validation state: `gh pr checks <pr>`. If validation has not passed, say so; the reviewer job runs after validation, and a review of a red PR is the user's choice.
5. Whether a review body already carries `<!-- factory:<issue>:review -->`: if so, the one pass has run; say so and stop unless the user wants another.

## Review

Load the `review-pr` skill and follow it. The reviewer is one model call on the top model: if this session's model is not the reviewer model pinned in this plugin's `agents/` for this harness, spawn the `reviewer` agent definition and give it the issue text, the diff and the PR body; otherwise do the pass yourself. Either way the result is the skill's JSON list of `path`, `line`, `body`.

Post it as one comment-only review: `gh api repos/{owner}/{repo}/pulls/<pr>/reviews` with `event: COMMENT`, `commit_id` set to the head, a `body` that starts with `<!-- factory:<issue>:review -->` (so the Action's review job does not repeat the pass), and the `comments` array. Never approve, never request changes.

## After

Tell the user how many comments were posted and list them one per line as `path:line: first sentence`. The worker (`/factory <issue>` on the branch, or the Action's worker pass) answers them; do not answer them yourself. Note that the Action's answer pass only answers comments posted by the Factory App; comments posted from your own `gh` login are answered by running `/factory <issue>` again on the branch.
