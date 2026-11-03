# Factory 0.6 reset: handoff (Nov 2, 2026, 18:35 PST)

This directory is the 0.6 tree as built overnight in a Claude cloud session, pushed unreviewed so a Claude Code session can continue. It sits beside the 0.5.20 tree on purpose: nothing in 0.5 is changed on this branch.

Read in this order: PLAN.md (the decision and design), RESEARCH.md (verified mechanics per harness and GitHub), then plugin/NOTES.md, action/NOTES.md, bench/NOTES.md (each lane's assumptions and what needs a real runner or the App to verify).

State:
- plugin/: six Factory skills, six /factory command skills, task-card template, agent definitions in three formats from agents/source.json via agents/render.mjs, marketplace manifests. The Clockgrove repository skill (`clockgrove-objective`) is at clockgrove-skill/.agents/skills/.
- action/: action.yml, workflow-template.yml, scripts/{dispatch,worker,review,doctor,setup}.mjs with lib/, 30 passing `node --test` tests on pure logic.
- bench/: score.mjs (four job-one numbers per harness unit), 13 passing tests, judge and grade-auto carried over.
- Nov 2 evening: fresh-eyes review of the three lanes done; the unambiguous findings are fixed and the rest are in REVIEW.md (read it after PLAN.md).
- Nov 2, 7:22 PM PST: step 1's gate (#2372) passed on the scratch adopter `clockgrove/factory-scratch` (Kirk: Factory never builds itself; Clockgrove only at #2375 through the Action). Issue #1 there ran through `action/scripts/worker.mjs` and `review.mjs` on this machine (Claude, Opus worker, Sonnet implementers, Fable reviewer, CLI login, gh login as the GitHub token): PR #2 merged with the `quality` check green, one reviewer finding rebutted on the thread, $0.45 worker + $0.56 review, 6 minutes label to merge. Two bugs found and fixed by the run: `updateProjectV2Field` takes no `projectId`; `credential.helper` must be replaced, not set, on a rerun. The App's write path is untested until step 3 has `FACTORY_APP_ID`, `FACTORY_APP_PRIVATE_KEY` and `ANTHROPIC_API_KEY` as secrets on the scratch repository. Nothing has run on a runner yet.

Issues: #2372–#2378 are the sequence steps, #2379 the Copilot gate, #2380–#2382 the open decisions, #2371 carried. Start at #2372.
