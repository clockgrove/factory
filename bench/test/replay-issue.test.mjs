// The review replay's issue body: the Work Item's criteria are the issue's acceptance entries, on the same exact-heading
// path the review job reads for a factory-file issue.
import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceEntries } from "../../plugin/scripts/lib/logic.mjs";
import { reviewerPrompt } from "../../plugin/scripts/review.mjs";
import { replayIssueBody } from "../lib/replay-issue.mjs";

test("review replay: the Work Item's criteria are the entries, never the Objective's own Acceptance list", () => {
  const blocks = [
    { kind: "heading", level: 1, text: "Goal" },
    { kind: "text", text: "Rank the results." },
    { kind: "heading", level: 1, text: "Acceptance" },
    { kind: "list", items: ["the Objective's own entry"] },
  ];
  const body = replayIssueBody({ blocks, item: "WI-2", criteria: ["results are ranked", "a test covers it"] });
  assert.deepEqual(acceptanceEntries(body), [
    { id: "1", text: "results are ranked" },
    { id: "2", text: "a test covers it" },
  ]);
  assert.match(body, /This Work Item: WI-2\./);
  const prompt = reviewerPrompt({ issue: 9, issueTitle: "WI-2", issueBody: body, prBody: "", diff: "", harness: "claude" });
  assert.match(prompt, /by the ids to use[^\n]*\n- 1: results are ranked\n- 2: a test covers it\n/);
});
