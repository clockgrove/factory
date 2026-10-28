// The main suite's holds case checks that an answered question's comment
// mentions no one. Run 2026-10-28T125104PDT-3c18 (codex) and
// 2026-10-28T125305PDT-73ad failed holds.answered-comment on a correct
// comment: the check refused any "@", and the comment's own marker carries
// one in its hold id (decide:1:1@2026-10-28T19:55:03.646Z).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const GH = join(import.meta.dirname, "../integration/lib/gh.sh");

function mentions(body) {
  const r = spawnSync(
    "bash",
    ["-c", 'source "$1"; body_mentions "$2"', "_", GH, body],
    { encoding: "utf8" },
  );
  assert.equal(r.stderr, "");
  assert.ok(r.status === 0 || r.status === 1, `status ${r.status}`);
  return r.status === 0;
}

const MARKER = "<!-- factory:2:hold:decide:1:1@2026-10-28T19:55:03.646Z -->";
const ANSWERED = `${MARKER}
**Answered** \`/factory answer\` by \`kirkmarple-clockgrove\` in [a \`/factory\` comment](https://github.com/clockgrove/fd-20261028-125104-3c18-m/issues/2#issuecomment-6479115747) at \`2026-10-28 12:55:32 PDT\`.

> Not decided yet; ask me again.

It asked:

The planner needs a decision:

Which literal separator should joinPathQekne use?

Its answers were \`answer <text>\`, \`replan\`, \`cancel\`.

Nothing waits on this question now; \`factory status 2\` shows what Factory is doing.`;

test("an answered comment whose only @ is in its marker's hold id mentions no one", () => {
  assert.equal(mentions(ANSWERED), false);
});

test("a hold id's @ in the text, an email-like word or a code span is no mention", () => {
  assert.equal(
    mentions(
      `${MARKER}\nQuestion \`decide:1:1@2026-10-28T19:55:03.646Z\` closed.`,
    ),
    false,
  );
  assert.equal(mentions(`${MARKER}\nSee decide:1:1@2026-10-28.`), false);
  assert.equal(mentions(`${MARKER}\nWrite to ops@example.com.`), false);
  assert.equal(mentions(`${MARKER}\nUse \`@types/node\`.`), false);
});

test("the operators' mentions are found, at the end or the start of the body", () => {
  assert.equal(mentions(`${ANSWERED}\n\n@kirkmarple @other-op`), true);
  assert.equal(
    mentions(`${MARKER}\n**Factory needs you.** Pick one. (@kirkmarple)`),
    true,
  );
  assert.equal(mentions("@kirkmarple first"), true);
});
