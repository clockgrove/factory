# Factory 0.6 plugin: notes from the skills and agents lane

## Assumptions

1. **Plugin layout.** `.claude-plugin/plugin.json` carries `skills` and `agents` (pointing at `agents/claude/`), modelled on the 0.5.20 manifest; `.codex-plugin/plugin.json` keeps 0.5.20's shape minus the logo and long description. Two marketplace manifests are shipped inside `plugin/` (`.claude-plugin/marketplace.json` for `claude plugin marketplace add`, `.agents/plugins/marketplace.json` for Codex), both pinned to `ref: v0.6.0` and `path: plugin`, so the plugin installs from the Factory repository itself. In 0.5 these lived at the repository root; lane 7 (reset) decides whether to move them up. The Action is expected to mirror `skills/` to `.agents/skills/` and `.claude/skills/` in the runner checkout; the plugin does not ship the mirror twice.
2. **Command names.** Claude Code resolves a skill by its directory name, so `/factory review` is `skills/factory-review/`, invoked as `/factory-review <pr>`; the task text's `/factory review <pr>` is read as that. Same for score, queue, doctor and setup.
3. **Plan-comment marker.** `objective-plan` tags the comment `<!-- factory:{{issue}}:plan -->`, following 0.5's idempotent-marker shape from RESEARCH.md, so a rerun and `/factory score` find it. Lane 2's scripts should look for that marker.
4. **PR title.** `#<issue>: <goal in a few words>`; the plan says only "titled with the issue number".
5. **Action scripts.** The command skills call `scripts/doctor.mjs`, `scripts/setup.mjs` and `scripts/dispatch.mjs` under the action checkout (`<action>`), and each lists what the script does as its fallback. Flags (`--repo`, `--json`, `--apply <step>`, `--issue`) are my guess for lane 2 to adopt or change.
6. **Doctor's check list** is the plan's "Doctor" paragraph, one bullet per check, with the fix each names; the per-check probe commands (`claude -p 'reply ok' --output-format json`, etc.) are from RESEARCH.md.
7. **`templates/factory.yml`** is a placeholder reusable-workflow call with `{{...}}` inputs so `factory-setup` has something to render; the plan says "calling `clockgrove/factory@v1`", and lane 2 owns the real file and whether it is a reusable workflow or a composite action.
8. **Agent `tools`.** Claude Code names (`Read, Edit, Write, Grep, Glob, Bash`) are the source; Copilot's `.agent.md` gets them mapped to `read`, `edit`, `search`, `shell` (deduped). The Copilot tool vocabulary was not verified; adjust the map in `render.mjs` if `copilot --help` disagrees. Codex agents have no tool list.
9. **Copilot default model.** `source.json` has `copilot: null`, meaning "the Copilot default"; the renderer then writes neither `model` nor `model-policy: required`, since requiring an unnamed model is meaningless. Setting a model string in `source.json` turns both lines on.
10. **Model ids** are written as given (`claude-sonnet-5-5`, `claude-fable-5-1`, `gpt-6.1-sol`); Claude Code accepts full ids in `model`.
11. **Reviewer invocation from `/factory review`.** If the session's model is not the pinned reviewer model, the skill spawns the `reviewer` agent; otherwise it does the pass itself. Posting uses the REST reviews endpoint with `event: COMMENT` so Claude's cloud (GraphQL blocked) also works.
12. **`/factory queue` cloud path** is written from RESEARCH.md's facts (Claude cloud ignores repo-declared plugins, blocks GraphQL; Codex agent phase offline by default; Copilot session is an Actions job capped at 59 minutes) and says a cloud run ends at an open PR without the Action, since the merge path needs the App token.
13. **Scorecard.** `factory-score` calls `node bench/score.mjs --issue --repository --usage --print`; the 0.5 scorecard takes different flags and RESEARCH.md says it is rewritten for the new shape, so these flags are a proposal for the bench lane. Usage artifact name assumed `factory-usage-<issue>` with `result.json` (Claude) or `events.jsonl` (Codex).
14. **Clockgrove skill** lists the validation commands from RESEARCH.md and `development.md`, the budget command as `node scripts/check-test-budget.mjs` (what `pnpm check` runs through `check-boundaries.mjs`), and the protected paths from RESEARCH.md. It omits `infra:validate` and `verify:supply-chain` from the Objective validation set (the latter needs the registry; the former only matters for infra changes and the runbook says to run it after them).
15. **Page cap** read as about 60 lines and under about 700 words; all skills fit (table below). The clockgrove skill is the longest at 49 lines because it distils four documents.

## Skill sizes (lines / words)

| Skill | Lines | Words |
| --- | ---: | ---: |
| objective-plan | 33 | 559 |
| implement-split | 34 | 594 |
| prove-acceptance | 36 | 624 |
| deliver-pr | 36 | 554 |
| review-pr | 43 | 580 |
| score | 34 | 628 |
| factory | 37 | 399 |
| factory-review | 25 | 265 |
| factory-score | 27 | 377 |
| factory-queue | 30 | 476 |
| factory-doctor | 33 | 468 |
| factory-setup | 40 | 515 |
| clockgrove-objective (in clockgrove-skill/) | 49 | 692 |

None exceeds the cap.

## Regenerating the agents

`node agents/render.mjs` rewrites `agents/claude/*.md`, `agents/codex/*.toml` and `agents/copilot/*.agent.md` from `agents/source.json`. Edit the source, never the outputs.
