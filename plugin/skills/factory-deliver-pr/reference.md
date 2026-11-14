# factory-deliver-pr: reference

Detail for the factory-deliver-pr skill that applies only on some passes. SKILL.md says when to load each section; every rule here is as binding as one there.

## Reviewer comments

The reviewer posts one pass of line comments; they are in `$FACTORY_IN/review-comments.json` (`id`, `path`, `line`, `body`). Handle them once: for each comment, either make the change and reply with the commit, or reply with a rebuttal that names the acceptance entry or repository rule that makes the comment wrong. Write the replies to `$FACTORY_OUT/replies.json` as `[{"id": <comment id>, "body": "..."}]`, one per comment; Factory posts each in its thread after it pushes your commits. Never leave one unanswered or answer one twice. A comment that names a real defect is fixed, not argued. A comment that flags an assumption as behaviour-changing is answered, when the Question rule's test is met, by marking that assumption `QUESTION` under `## Assumptions` in pr.md and writing a `question` exit record.

After the replies: rebase onto `origin/<default branch>` again, run the validation commands (when the task card names required checks, only the tests your replies touched), commit, and stop.

## Workflow hand-over

Factory never pushes a change under `.github/workflows/`: `.github/` is a protected path, and GitHub refuses a workflow file from Factory's token. When the Objective needs one:

1. Make the change in the checkout and check what you can here (the file parses; a workflow linter, when the repository has one).
2. Write it as git's own diff, new files included, and put the workflow files back as `HEAD` has them:
   `git add --intent-to-add -- .github/workflows && git diff HEAD -- .github/workflows > "$FACTORY_OUT/workflow.patch" && git reset -q -- .github/workflows; git checkout HEAD -- .github/workflows 2>/dev/null; git clean -fdq -- .github/workflows`
3. In pr.md, under `## Undone`, one line per workflow file: what it changes and why a person applies it. An acceptance entry only the workflow proves says so in `## Acceptance`.
4. Commit and deliver the rest as usual; a hand-over is no Block or Question, so the exit record is `delivered` when the rest is. Factory applies the patch in its own mirror and publishes git's own diff of the result, not your text, in its comment on the issue, labels the issue `factory:handover`, and puts a line pointing to that comment first in the PR body. A person applies it with `factory handover <issue>`, which stops for them to read it before anything is pushed. Never write a `Workflow hand-over` heading in pr.md: Factory's line is the only one.

`$FACTORY_IN/workflow.patch` is the hand-over Factory published. A later pass that changes it writes the whole patch to `$FACTORY_OUT/workflow.patch` again (start from that file); an empty file drops it; no file keeps it. Factory refuses a patch that does not apply to the branch, changes anything outside `.github/workflows/`, renames or copies a file, makes anything but a regular file (no symlink or submodule), names a file with characters other than letters, digits, `_`, `.`, `-` and `/`, or carries a binary change, a control or format character or `<!--`, and the stage Blocks with the reason. With nothing else to commit there is no PR: Factory posts the hand-over on the issue and Blocks it for a person.
