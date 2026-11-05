# Factory contributor rules

Factory is a GitHub Action (`action.yml`), a plugin (`plugin/`: skills, agents, task card, scripts, tests, workflow template) and a bench (`bench/`). Never run Factory Objectives against this repository; the first adopter is a scratch repository.

Read `docs/PLAN.md` (what 0.6 is and how it is measured), `docs/RESEARCH.md` (the harness facts), `plugin/NOTES.md` (layout decisions) and `docs/HANDOFF.md` (the running log). Code decides on structure only: JSON the harness writes, GitHub fields, exit codes, counts; never prose. Tests: `node --test plugin/test/*.test.mjs bench/test/*.test.mjs`.
