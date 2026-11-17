# The foundation pass

When `factory issue` says the Objective is a foundation one (`factory:foundation`), run the foundation pass as well: spawn the `foundation-reviewer` agent definition the same way as the `reviewer` (or, on its model, follow the reviewer skill's reference.md, "Foundation review", yourself), and put its answer in the same JSON under `foundation`:

```json
{"acceptance": [...], "comments": [...], "foundation": {"comments": [...]}}
```

The review job runs it on such an Objective and this review replaces the job's, so `post-review` refuses a foundation Objective's file without it, and any other Objective's file with it.

# Posting

`factory post-review <pr> <file>` fits each comment to the diff, adds one for each entry judged not met without one, neutralises mentions and markers in the text, and posts one comment-only review with the judgments in its body on the head with the `<!-- factory:<issue>:review -->` marker, so the Action's review job does not repeat the pass. It posts nothing from a file with no reviewer JSON or no judgment of the issue's entries; fix the file and run it again.
