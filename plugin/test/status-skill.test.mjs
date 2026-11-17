// The pendulum-status skill tells a person how to resume, answer or restart an Objective, so what it says must be what
// the code does: each table row of its reference.md, and each marker it reads, is checked against the rule it states.
import "./temp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BLOCK_CAUSES, STATE_LABELS, blockMarker, marker, questionForm, questionFormOf, questionMarker } from "../scripts/lib/logic.mjs";
import { blockedLine, nextOf, nextStep } from "../scripts/lib/session.mjs";
import { DRAFT_LABEL, REQUEUED_FROM, RESTART_LABEL, requeuedIn } from "../scripts/lib/stop.mjs";

const DIR = join(import.meta.dirname, "..", "skills", "pendulum-status");
const skill = readFileSync(join(DIR, "SKILL.md"), "utf8");
const ref = readFileSync(join(DIR, "reference.md"), "utf8");
const OBJECTIVE = "pendulum:objective";

/** The body rows of the one table under reference.md's `## <heading>`, as trimmed cells. */
function table(heading) {
  const section = ref.split(/^## /m).find((s) => s.startsWith(`${heading}\n`));
  assert.ok(section, `reference.md has a ${heading} section`);
  const rows = section.split("\n").filter((l) => l.startsWith("|"));
  assert.ok(rows.length > 2, `${heading} has a table`);
  return rows.slice(2).map((l) => l.slice(1, -1).split("|").map((c) => c.trim()));
}
/** A cell that is one code span: its text; else null. */
const code = (cell) => /^`([^`]+)`$/.exec(cell)?.[1] ?? null;
/** The one code span of `text` that starts with `prefix`. */
function quoted(text, prefix) {
  const found = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((q) => q.startsWith(prefix));
  assert.equal(new Set(found).size, 1, `one quoted ${prefix}…`);
  return found[0];
}

test("States: each state label with the state the code reads from it, and re-applying the label resumes exactly the states a person's go requeues", async () => {
  const rows = table("States");
  const labelled = rows.filter((r) => code(r[0]));
  assert.deepEqual(Object.fromEntries(labelled.map((r) => [code(r[0]), r[1]])), STATE_LABELS);
  assert.deepEqual(
    rows.filter((r) => !code(r[0])).map((r) => [r[0], r[1], r.at(-1)]),
    [["none", "Queued", "no"]],
    "the one row without a label is Queued, which a re-apply leaves Queued",
  );
  for (const r of rows) assert.match(r.at(-1), /^(yes|no)$/, `${r[0]}: yes or no`);
  assert.deepEqual(labelled.filter((r) => r.at(-1) === "yes").map((r) => code(r[0])).sort(), [...REQUEUED_FROM].sort());
  // And as the dispatcher's recovery reads a timeline: the state's label, then the Objective label applied by a writer.
  for (const r of labelled) {
    const events = [
      { event: "labeled", label: { name: code(r[0]) }, created_at: "2031-01-01T00:00:00Z", actor: { login: "kim" } },
      { event: "labeled", label: { name: OBJECTIVE }, created_at: "2031-01-01T01:00:00Z", actor: { login: "kim" } },
    ];
    const go = await requeuedIn(events, OBJECTIVE, async () => true);
    assert.equal(go.requeued, r.at(-1) === "yes", `${code(r[0])}: re-applying ${OBJECTIVE} ${go.requeued ? "requeues" : "does not requeue"} it`);
  }
  for (const label of [DRAFT_LABEL, RESTART_LABEL]) assert.ok(ref.includes(`\`${label}\``) && skill.includes(`\`${label}\``), label);
});

test("Block causes: every cause the code records, whether it is external, and the way on its notice gives", () => {
  const rows = table("Block causes");
  assert.deepEqual(rows.map((r) => code(r[0])).sort(), Object.keys(BLOCK_CAUSES).sort());
  for (const [cell, external, way] of rows) {
    const cause = code(cell);
    assert.equal(external, BLOCK_CAUSES[cause].external ? "yes" : "no", `${cause}: external`);
    assert.equal(way, nextOf(cause), `${cause}: the way on`);
  }
  // The cause line it reads is the one Pendulum writes.
  const line = quoted(ref, "<!-- pendulum:block ");
  for (const cause of Object.keys(BLOCK_CAUSES)) assert.equal(line.replace("<cause>", cause), blockMarker(cause));
  // The two notices whose own last paragraph overrides the cause's way on, quoted as the notice says them.
  for (const next of ["none", "restart"]) {
    const said = nextStep({ issue: 12, pr: { number: 34 }, next });
    const phrase = [...ref.matchAll(/"([^"]+)"/g)].map((m) => m[1]).find((p) => said.startsWith(p));
    assert.ok(phrase, `reference.md quotes the start of the ${next} notice: ${said.slice(0, 60)}`);
  }
});

test("the Blocked notice and the Question notice it reads are the ones Pendulum posts", () => {
  const blocked = quoted(skill, "<!-- pendulum:<issue>:blocked:");
  assert.ok(marker(12, "blocked", "work:9-1").startsWith(blocked.replace("<issue>", "12")));
  const text = quoted(skill, "Blocked (<stage>):");
  assert.ok(blockedLine({ issue: 12, stage: "work", reason: "red checks" }).startsWith(text.replace("<stage>", "work")));
  assert.ok(quoted(skill, "<!-- pendulum:<issue>:question:").length > 0);

  // Where a Question is answered: the notice's form, which the code decides and the dispatcher reads back.
  const template = quoted(ref, "<!-- pendulum:<issue>:question:");
  const forms = new Set([questionForm({ pr: null }), questionForm({ pr: { number: 34 } }), questionForm({ pr: { number: 34 }, askOnIssue: true })]);
  assert.deepEqual(table("Questions").map((r) => code(r[0])).sort(), [...forms].sort());
  for (const form of forms) {
    const line = template.replace("<issue>", "12").replace("<stage>", "work").replace("<run>", "9-1").replace("<form>", form);
    assert.equal(line, questionMarker(12, { stage: "work", runId: "9-1", form }));
    const notice = { body: `${line}\nQuestion (work): which name?`, user: { login: "pendulum[bot]", type: "Bot" }, created_at: "2031-01-01T01:00:00Z" };
    assert.equal(questionFormOf([notice], { issue: 12, since: "2031-01-01T00:00:00Z" }), form);
  }
  // With no open PR the Question is answered on the issue, as SKILL.md says.
  assert.equal(questionForm({ pr: null }), "issue");
  assert.match(skill, /\*\*On the issue\*\* \(no open PR, or the notice's marker ends `:issue`\)/);
});
