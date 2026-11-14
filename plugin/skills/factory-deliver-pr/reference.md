# factory-deliver-pr: reference

Detail for the factory-deliver-pr skill that applies only on some passes. SKILL.md says when to load each section; every rule here is as binding as one there.

## Reviewer comments

The reviewer posts one pass of line comments; they are in `$FACTORY_IN/review-comments.json` (`id`, `path`, `line`, `body`). Handle them once: for each comment, either make the change and reply with the commit, or reply with a rebuttal that names the acceptance entry or repository rule that makes the comment wrong. Write the replies to `$FACTORY_OUT/replies.json` as `[{"id": <comment id>, "body": "..."}]`, one per comment; Factory posts each in its thread after it pushes your commits. Never leave one unanswered or answer one twice. A comment that names a real defect is fixed, not argued. A comment that flags an assumption as behaviour-changing is answered, when the Question rule's test is met, by marking that assumption `QUESTION` under `## Assumptions` in pr.md and writing a `question` exit record.

After the replies: rebase onto `origin/<default branch>` again, run the validation commands (when the task card names required checks, only the tests your replies touched), commit, and stop.
