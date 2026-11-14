---
name: factory-start
description: "/factory:factory-start <issue>. Start a draft Clockgrove Factory Objective on the user's yes, after the same trust check as a new Objective: takes the issue's factory:draft label off and applies factory:objective, so Factory picks it up. Use when the user asks to start, launch or queue a draft Clockgrove Factory Objective, or says a draft is ready."
---

# /factory:factory-start <issue>

A draft is an issue with the `factory:draft` label: Factory never runs it, on any route, even with `factory:objective` on it too. Starting it takes `factory:draft` off and applies `factory:objective`; the dispatcher then picks it up like a new Objective. Confirm first: a started Objective runs unattended and spends model budget.

## Check the issue

Run `gh issue view <issue> --repo OWNER/NAME --json number,title,state,labels,body`.

- Closed: say so and stop.
- `factory:objective` without `factory:draft`: it is started already; say so and stop.
- No `factory:draft`: not a draft, but starting it is the same step.
- No goal or no acceptance entries (the factory-file skill's shape): say so, and offer to refine it first ("Let's keep working on Clockgrove Factory Objective <issue>", the factory-draft skill).

## Check trust

Factory acts on an issue only when its author, and its last editor once the body was edited, is a person who can push to the repository or a maintainer the workflow names (`FACTORY_NOTIFY` or `FACTORY_MAINTAINERS` in `.github/workflows/factory.yml`, as `login#id`). Otherwise the run Blocks before any model reads the text, so check first:

1. `gh api graphql -f query='query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){issue(number:$i){lastEditedAt author{__typename login} editor{__typename login}}}}' -f o=OWNER -f n=NAME -F i=<issue>`. The body was edited when `lastEditedAt` or `editor` is set; then the editor counts too, and an editor that reads as null (a deleted account) fails.
2. Each one counted must have `__typename` `User`: an App or bot never vouches.
3. For each login, `gh api repos/OWNER/NAME/collaborators/<login>/permission --jq '.permission + " " + .role_name'` must show `admin`, `maintain` or `write`, or the login is one of the workflow's maintainers.

When a check fails, or a login cannot be read, do not start it. Say who and why: an author who fails means a person who can push files it again as a new issue; a last editor who fails means a person who can push reads the body and saves it, becoming its last editor.

## Ask

Show the number, title and labels, the people the trust check read, and what starting does: the run starts within seconds on Actions (on the ten-minute cron at the latest; in local mode on `factory serve`'s next tick), and one comment on the issue shows its progress. An edit after its plan is made Blocks it at its next stage (docs/USAGE.md, Edit an Objective). Ask for a yes.

## Start it

On a yes, when the issue carries `factory:objective` too, first run `gh issue edit <issue> --repo OWNER/NAME --remove-label factory:objective`, so the start applies the label afresh. Then run `gh issue edit <issue> --repo OWNER/NAME --remove-label factory:draft --add-label factory:objective`; for an issue without `factory:draft`, drop `--remove-label factory:draft`, since `gh` refuses to remove a label the repository does not have. Say it is started and print its URL.
