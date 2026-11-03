# Factory 0.6 reset: handoff (Nov 2, 2026, 18:35 PST)

This directory is the 0.6 tree as built overnight in a Claude cloud session, pushed unreviewed so a Claude Code session can continue. It sits beside the 0.5.20 tree on purpose: nothing in 0.5 is changed on this branch.

Read in this order: PLAN.md (the decision and design), RESEARCH.md (verified mechanics per harness and GitHub), then plugin/NOTES.md, action/NOTES.md, bench/NOTES.md (each lane's assumptions and what needs a real runner or the App to verify).

State:
- plugin/: six Factory skills, six /factory command skills, task-card template, agent definitions in three formats from agents/source.json via agents/render.mjs, marketplace manifests. The Clockgrove repository skill (`clockgrove-objective`) is at clockgrove-skill/.agents/skills/.
- action/: action.yml, workflow-template.yml, scripts/{dispatch,worker,review,doctor,setup}.mjs with lib/, 30 passing `node --test` tests on pure logic.
- bench/: score.mjs (four job-one numbers per harness unit), 13 passing tests, judge and grade-auto carried over.
- Not done: no fresh-eyes review of the three lanes; nothing has run on a runner or with the App; step 1's gate (#2372) has not been attempted.

Issues: #2372–#2378 are the sequence steps, #2379 the Copilot gate, #2380–#2382 the open decisions, #2371 carried. Start at #2372.
