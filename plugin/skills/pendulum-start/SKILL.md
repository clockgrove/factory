---
name: pendulum-start
description: "Start a draft Clockgrove Pendulum Objective by issue number on the user's yes, after the same trust check as a new Objective: takes the issue's pendulum:draft label off and applies pendulum:objective, so Pendulum picks it up. Use when the user asks to start, launch or queue a draft Clockgrove Pendulum Objective, or says a draft is ready. Not for refining the draft (pendulum-draft) or restarting a started one (pendulum-restart)."
---

# /pendulum:pendulum-start <issue>

A draft is an issue with the `pendulum:draft` label: Pendulum never runs it, on any route, even with `pendulum:objective` on it too. Starting it takes `pendulum:draft` off and applies `pendulum:objective`; the dispatcher then picks it up like a new Objective. Confirm first: a started Objective runs unattended and spends model budget.

## Check the issue

Run `gh issue view <issue> --repo OWNER/NAME --json number,title,state,labels,body`.

- Closed: say so and stop.
- `pendulum:objective` without `pendulum:draft`: it is started already; say so and stop.
- No `pendulum:draft`: not a draft, but starting it is the same step.
- No goal or no acceptance entries (the pendulum-file skill's shape): say so, and offer to refine it first ("Let's keep working on Clockgrove Pendulum Objective <issue>", the pendulum-draft skill).

## Check trust

Pendulum acts on an issue only when its author, its last editor once the body was edited, and whoever made the latest rename once the title was renamed, is a person who can push to the repository or a maintainer the workflow names (`PENDULUM_NOTIFY` or `PENDULUM_MAINTAINERS` in `.github/workflows/pendulum.yml`, as `login#id`). Otherwise the run Blocks before any model reads the text, so check first:

1. `gh api graphql -f query='query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){issue(number:$i){lastEditedAt author{__typename login} editor{__typename login} title timelineItems(itemTypes:[RENAMED_TITLE_EVENT],last:1){nodes{...on RenamedTitleEvent{actor{__typename login} currentTitle}}}}}}' -f o=OWNER -f n=NAME -F i=<issue>`. The body was edited when `lastEditedAt` or `editor` is set; then the editor counts too, and an editor that reads as null (a deleted account) fails. The title was renamed when `timelineItems` has a node; then its actor counts too, and one that reads as null, or a `currentTitle` other than `title`, fails.
2. Each one counted must have `__typename` `User`: an App or bot never vouches.
3. For each login, `gh api repos/OWNER/NAME/collaborators/<login>/permission --jq '.permission + " " + .role_name'` must show `admin`, `maintain` or `write`, or the login is one of the workflow's maintainers.

When a check fails, or a login cannot be read, do not start it. Say who and why: an author who fails means a person who can push files it again as a new issue; a last editor who fails means a person who can push reads the body and saves it, becoming its last editor; a renamer who fails means a person who can push reads the title and changes it (the same title records no rename).

## Ask

Show the number, title and labels, the people the trust check read, and what starting does: the run starts within seconds on Actions (on the ten-minute cron at the latest; in local mode on `pendulum serve`'s next tick), and one comment on the issue shows its progress. An edit after its plan is made Blocks it at its next stage ([Edit an Objective](https://github.com/clockgrove/pendulum/blob/v0.10.0/docs/USAGE.md#edit-an-objective)). Ask for a yes.

## Start it

On a yes, when the issue carries `pendulum:objective` too, first run `gh issue edit <issue> --repo OWNER/NAME --remove-label pendulum:objective`, so the start applies the label afresh. Then run `gh issue edit <issue> --repo OWNER/NAME --remove-label pendulum:draft --add-label pendulum:objective`; for an issue without `pendulum:draft`, drop `--remove-label pendulum:draft`, since `gh` refuses to remove a label the repository does not have. Say it is started and print its URL.
