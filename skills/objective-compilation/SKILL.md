---
name: objective-compilation
description: Compiles a human-authored Objective (a GitHub Issue labelled `factory:objective`) into a validated Work Item graph conforming to schemas/objective.schema.json. Use when Director reads an Objective that has no Work Item graph yet, or when replanning (§7) needs to add or revise Work Items for an Objective already in flight.
---

# Objective compilation

This is Factory's "high-level compiler" (IMPLEMENTATION-PLAN.md §2): the one place judgment about
*what the work actually is* belongs. Everything downstream — `graph.ts` applying sub-issues and
dependencies, `dispatch.ts` assigning them, `evaluate.ts` classifying the resulting PRs — is
mechanical and trusts this skill's output completely. A vague or wrong Work Item here becomes a
declined task, an untouched-scope failure, or a merge conflict several steps later (§5, §6) — this
skill is the cheapest point at which to prevent that.

## When to use this skill

- Director has just read an Objective issue (`factory:objective` label) with **no existing Work
  Item sub-issues** — first compilation.
- Replanning (§7) has determined the graph itself is wrong (repeated declines, repeated conflicts,
  attempts exhausted) and new or revised Work Items are needed.

Do not use this skill to re-describe or duplicate a Work Item that already exists and is not
`done` — only add what the current graph is missing.

## Inputs

- The Objective issue's **title and body**, exactly as the human wrote them. Treat this as the
  complete statement of intent — do not infer goals the text does not state.
- The target repository's own conventions (its README, test/build commands, existing file layout).
  Pull `conventions` (below) from what the repo actually says about itself, never from assumption.
- If replanning: the current Work Item graph and *why* replanning was triggered (§7.1) — a repeated
  decline or conflict is itself evidence about what the graph got wrong.

## Output

Exactly one JSON object conforming to `schemas/objective.schema.json` (which in turn embeds
`schemas/work-item.schema.json` per Work Item) — and, when operating non-interactively, *only* that
JSON object. This becomes the input to `graph.ts`'s apply step (§9 build order step 6): every
`workItems[].id` is a compiler-local label that exists only to express `dependsOn` edges before
GitHub issue numbers exist; nothing in the output is stored anywhere once `graph.ts` has run.

## Process

1. **Read the Objective's title and body as-is.** If the stated goal is too vague to decompose
   without inventing scope, stop and ask — do not guess. A graph built on a guessed scope is a
   compiler defect waiting to surface as a decline or an untouched-scope failure three steps later
   (§5.3 extends here: frequent declines are a compiler defect, not an execution defect, and an
   Objective the compiler had to guess at is exactly how those get created).

2. **Find independent seams.** Default to maximum independence. Gate 0 (PRD §7) is explicitly 2–3
   *independent* Work Items — bias toward splitting work so items do not depend on each other,
   and only introduce `dependsOn` when work genuinely cannot proceed in parallel (one item's output
   is literally the input to another, or two items would otherwise modify the same file). Prefer
   splitting `scope` to avoid a dependency over introducing one. A single Work Item is a valid
   output for an Objective that genuinely does not decompose — do not force an artificial split.

3. **Draft each Work Item's fields** (`schemas/work-item.schema.json`):
   - `goal` — one sentence, what this Work Item accomplishes.
   - `acceptance` — criteria checkable **from the diff alone**. Outcome-evaluation (§5.2) verifies
     these against the PR, never against the agent's self-report (§15.7) — if a criterion can only
     be confirmed by trusting what the agent says it did, rewrite it or drop it. **When a criterion
     names an exact file path, state it as a hard requirement, not a description** — a bullet like
     "`test/foo.test.ts` exists" reads as informative, not binding, and loses to the executing
     agent's own habits. Gate 1 evidence: this exact wording ("test/parseLine.test.ts exists and
     covers...") was used verbatim across 3 Work Items, and the executing coding agent colocated the
     test file under `src/` instead in all 3 — a real, reproducible instruction-following miss, not
     an isolated fluke. Prefer explicit, negatively-stated phrasing when the path is load-bearing:
     put the path in `scope` *and* restate it as a constraint in `outOfScope` (e.g. "the test file
     must be at exactly `test/foo.test.ts`; do not colocate it next to the source file or place it
     anywhere else"). If the exact path genuinely does not matter (many test runners discover tests
     anywhere), do not assert one — a criterion the compiler doesn't actually need enforced is scope
     creep waiting to become a false escalation.
   - `scope` — concrete file or directory paths (trailing `/` for a directory), never glob
     patterns. PROBE-001 measured a one-line scope constraint holding 11/11 times; this field is
     also `evaluate.ts`'s `isUntouched` input, which does exact/prefix matching only.
   - `preconditions` — what must already be true for this to be actionable. This is what lets the
     agent decline honestly instead of inventing something (§5.3) — e.g. "the file being modified
     already exists". If you are not sure a precondition holds, that uncertainty belongs here, not
     silently assumed.
   - `outOfScope` — explicit non-goals, guarding against scope creep beyond `scope`.
   - `conventions` — repo-specific constraints (test/build commands, commit style) pulled from the
     repo's own documentation, never invented.
   - `dependsOn` — other Work Items' `id` values that must be `done` first. Empty by default.

4. **Assign each Work Item a short, kebab-case `id`**, unique within this graph
   (`schemas/work-item.schema.json`'s pattern: lowercase letters, digits, hyphens).

5. **Self-check before emitting.** `objective.schema.json` validates shape only; these graph-level
   invariants are this skill's responsibility, not the schema's:
   - Every `id` is unique within the graph.
   - Every `dependsOn` entry resolves to another Work Item's `id` in the same output.
   - The dependency graph is acyclic — no Work Item transitively depends on itself.
   - No two Work Items' `scope` entries overlap unless one explicitly `dependsOn` the other. An
     undetected overlap here is precisely the "parallel PRs branch from the same base and collide
     at merge" finding (§6, PROBE-001 finding 3) — catching it at compile time is cheaper than
     discovering it as a merge conflict.

## Worked example

PRD §7's Gate 0 fixture: *"add three pure functions, each with tests."*

```json
{
  "title": "Add three pure utility functions",
  "workItems": [
    {
      "id": "slugify",
      "title": "Add a slugify function",
      "goal": "Add a pure function that converts a string to a URL-safe slug.",
      "acceptance": [
        "src/slugify.ts exports a function slugify(input: string): string",
        "test/slugify.test.ts exists and covers at least: basic text, mixed case, punctuation, existing hyphens"
      ],
      "scope": ["src/slugify.ts", "test/slugify.test.ts"],
      "preconditions": ["src/ and test/ directories already exist"],
      "outOfScope": ["no changes to any other file"],
      "conventions": ["vitest is the test runner; run `npx vitest run` before finishing"],
      "dependsOn": []
    },
    {
      "id": "truncate",
      "title": "Add a truncate function",
      "goal": "Add a pure function that truncates a string to a max length with an ellipsis.",
      "acceptance": [
        "src/truncate.ts exports a function truncate(input: string, maxLength: number): string",
        "test/truncate.test.ts exists and covers: under limit, exactly at limit, over limit"
      ],
      "scope": ["src/truncate.ts", "test/truncate.test.ts"],
      "preconditions": ["src/ and test/ directories already exist"],
      "outOfScope": ["no changes to any other file"],
      "conventions": ["vitest is the test runner; run `npx vitest run` before finishing"],
      "dependsOn": []
    },
    {
      "id": "chunk",
      "title": "Add a chunk function",
      "goal": "Add a pure function that splits an array into fixed-size chunks.",
      "acceptance": [
        "src/chunk.ts exports a function chunk<T>(items: T[], size: number): T[][]",
        "test/chunk.test.ts exists and covers: even split, remainder, size larger than input, size <= 0"
      ],
      "scope": ["src/chunk.ts", "test/chunk.test.ts"],
      "preconditions": ["src/ and test/ directories already exist"],
      "outOfScope": ["no changes to any other file"],
      "conventions": ["vitest is the test runner; run `npx vitest run` before finishing"],
      "dependsOn": []
    }
  ]
}
```

All three items are independent (disjoint `scope`, empty `dependsOn`) — the shape Gate 0 requires.

## Common edge cases

- **The Objective is too vague to decompose.** Do not fabricate scope or acceptance criteria to
  fill the schema. Ask instead — a well-founded escalation at compile time is far cheaper than a
  Work Item the agent later, correctly, declines (§5.3).
- **The work genuinely does not split.** Emit a single-item graph. Forcing an artificial split
  produces two Work Items with entangled scope, which becomes a merge conflict (§6), not a
  parallelism win.
- **Replanning an existing graph.** Only add or revise what triggered replanning (§7.1). Do not
  reassign or redescribe an `id` still in use by a Work Item that is not `done` — its issue already
  exists and downstream state (`state.ts`) is keyed off the sub-issue relationship, not this id.
- **Two Work Items would naturally touch the same file.** This is a signal to either merge them
  into one Work Item or add a `dependsOn` edge — never leave both with overlapping `scope` and no
  edge between them.
