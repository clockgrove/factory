import assert from "node:assert/strict";
import { test } from "node:test";
import { killMatches } from "../scripts/live-check-hook.mjs";
import {
  checkOptions,
  count,
  parseArgs,
  REPO,
  reset,
  run,
  setup,
} from "../scripts/live-check.mjs";

test("--opt=value is read like --opt value", () => {
  assert.equal(parseArgs(["reset", "--objective=5"]).objective, "5");
  assert.equal(parseArgs(["reset", "--objective", "5"]).objective, "5");
  assert.equal(parseArgs(["run", "--tag=a=b"]).tag, "a=b");
  assert.deepEqual(parseArgs(["run", "--", "--x=1"]).rest, ["--x=1"]);
});

test("an unknown or misplaced option is refused, never ignored", () => {
  const refuse = (argv, pattern) =>
    assert.throws(() => {
      const options = parseArgs(argv);
      checkOptions(options._[0], options);
    }, pattern);
  refuse(["reset", "--objectve", "5"], /Unknown option --objectve for reset/);
  refuse(["reset", "--tag", "x"], /Unknown option --tag for reset/);
  refuse(["setup", "--objective=5"], /Unknown option --objective for setup/);
  refuse(["reset", "--objective"], /--objective needs a value/);
  refuse(["reset", "--objective", "--tag"], /--objective needs a value/);
  refuse(["reset", "--rest=1"], /Unknown option --rest/);
  refuse(["assert", "--objective=5", "--", "x"], /takes no arguments/);
  const ok = parseArgs(["assert", "--objective=5", "--work=/tmp/w"]);
  assert.doesNotThrow(() => checkOptions("assert", ok));
});

test("run --objective fails early without a tag or a work dir", async () => {
  await assert.rejects(
    run({ objective: "5", rest: [] }),
    /--objective needs --tag/,
  );
  await assert.rejects(
    run({ objective: "5", tag: "no-such-dir-for-live-check", rest: [] }),
    /No work dir/,
  );
});

test("the kill hook counts only a successful response to the matching request", () => {
  const kill = { method: "POST", repo: REPO, path: "/issues$", nth: 1 };
  const path = `/repos/${REPO}/issues`;
  assert.equal(killMatches(kill, "POST", path, true), true);
  assert.equal(killMatches(kill, "POST", path, false), false);
  assert.equal(killMatches(kill, "GET", path, true), false);
  assert.equal(killMatches(kill, "POST", "/repos/other/x/issues", true), false);
  assert.equal(killMatches(undefined, "POST", path, true), false);
});

const live = (patchStatus, deleteStatus = 204) => {
  const login = "me";
  const objective = {
    number: 5,
    title: "Live check t1",
    user: { login },
    body: "under `live/t1/` for Factory's live crash-restart check",
  };
  const calls = [];
  return {
    calls,
    all: (path) => {
      if (path.includes("matching-refs"))
        return [{ ref: "refs/heads/factory/objective-5/a" }];
      if (path.includes("/pulls?")) return [];
      return [objective];
    },
    api: (method, path) => {
      calls.push(`${method} ${path}`);
      if (method === "GET") return { status: 200, data: { login } };
      return { status: method === "PATCH" ? patchStatus : deleteStatus };
    },
  };
};

test("reset reports a write GitHub refused", () => {
  const ok = live(200);
  assert.doesNotThrow(() => reset("5", ok));
  assert.ok(
    ok.calls.includes(
      `DELETE repos/${REPO}/git/refs/heads/factory/objective-5/a`,
    ),
  );
  assert.throws(
    () => reset("5", live(403)),
    /1 write\(s\) failed: close issue #5: 403/,
  );
  assert.throws(
    () => reset("5", live(200, 403)),
    /delete refs\/heads\/factory\/objective-5\/a: 403/,
  );
});

test("setup requires 200 or 404 from the workflow lookup", () => {
  const answer = (status) => (method) => {
    if (method === "GET") return { status, data: [] };
    throw new Error("must not write");
  };
  assert.throws(() => setup(answer(500)), /workflow lookup: 500/);
  assert.throws(() => setup(answer(403)), /workflow lookup: 403/);
});

test("assert without the planned set does not pass", () => {
  const issue = {
    number: 11,
    state: "closed",
    body: "<!-- factory:objective=5;item=a -->",
  };
  const pull = {
    number: 21,
    head: { ref: "factory/objective-5/a" },
    merged_at: "2026-01-01T00:00:00Z",
  };
  const io = {
    all: (path) => {
      if (path.includes("/timeline"))
        return [{ event: "merged", commit_id: "c1" }];
      if (path.includes("/sub_issues")) return [issue];
      if (path.includes("/comments")) return [];
      if (path.includes("/pulls?")) return [pull];
      return [issue];
    },
    api: () => ({ data: { state: "closed" } }),
  };
  const result = count(5, undefined, io);
  assert.equal(result.checks.plannedKnown, false);
  assert.equal(result.pass, false);
  assert.equal(result.planned, null);
});
