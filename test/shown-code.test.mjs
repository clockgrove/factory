// The planner text keeps inline code exactly as GitHub shows it: the
// Markdown conversion minifies whitespace, which would turn `"ab  "` into
// `"ab "` and change what the Objective asks for.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readShown } from "../dist/shown.js";

test("inline code keeps its spaces in the planner text, as in the spans", () => {
  const shown = readShown(
    '<p><code>padEnd("ab", 4)</code> is <code>"ab  "</code>, and <code>a   b</code> keeps three.</p>\n<pre><code>x  y\n</code></pre>',
    { sources: true },
  );
  assert.match(shown.body, /`"ab  "`/);
  assert.match(shown.body, /`a   b`/);
  assert.match(shown.body, /x {2}y/);
  assert.deepEqual(shown.spans, ['padEnd("ab", 4)', '"ab  "', "a   b"]);
});

test("a list item or heading keeps the spaces inside its code, collapsing the rest", () => {
  const { blocks } = readShown(
    '<h2>Pad   <code>x  y</code></h2>\n<ul>\n<li><code>padEnd("ab", 4)</code>   is\n<code>"ab  "</code>.</li>\n</ul>',
    { sources: true },
  );
  assert.deepEqual(blocks, [
    { kind: "heading", level: 2, text: "Pad `x  y`" },
    { kind: "item", text: '`padEnd("ab", 4)` is `"ab  "`.' },
  ]);
});
