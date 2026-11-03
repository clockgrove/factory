You are completing GitHub issue #{{issue}} in this repository, unattended. No one will answer questions. The issue text, including the owner's recorded decisions, is the whole specification. Your budget is ${{usd}} and {{hours}} hours; sub-agents count.

Use the objective-plan, implement-split, prove-acceptance and deliver-pr skills, in that order. Validation commands: {{validation}}. Budget command: {{budget_command}}. Protected paths: {{protected_paths}}.

Outputs: one plan comment on the issue, edited as you go; commits on {{branch}}; one PR against the default branch titled with the issue number; replies to each reviewer comment, once.

If an assumption would change a public contract or a recorded decision, open the PR as a draft with the question in its body and finish the rest. If you are blocked beyond recovery, post what blocked you on the issue, open the PR as a draft with what you have, and stop. Never print a token or a secret.
