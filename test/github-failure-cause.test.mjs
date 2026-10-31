// A GitHub request that gets no answer fails with fetch's "fetch failed",
// its reason only in the error's cause chain (a DNS failure, a reset, a
// closed socket, a connect timeout, a TLS failure, an AggregateError of
// each address tried). The error message and the request's
// `github-request` event keep that cause, so an outage can be told from a
// bug afterwards (#2192). Every error here is synthetic, shaped as Node
// and undici build them, or met on a local socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze } from "../dist/analysis.js";
import { failureText, networkCause } from "../dist/github-trace.js";
import { RunLog } from "../dist/log.js";
import { tempDir } from "./helpers.mjs";

const fetchFailed = (cause) => new TypeError("fetch failed", { cause });

test("a failure's text is one line, without a URL's login or query, and ends on a cycle", () => {
  assert.equal(
    failureText(
      fetchFailed(
        new Error(
          "request to https://x-access-token:ghs_synthetic0@github.com/acme/widgets.git?token=synthetic1#x failed\nagain",
        ),
      ),
    ),
    "fetch failed: request to https://github.com/acme/widgets.git failed again",
  );
  const loop = new Error("loop");
  loop.cause = loop;
  assert.equal(failureText(loop), "loop");
  assert.deepEqual(networkCause(loop), {});
  assert.equal(failureText("not an error"), "not an error");
  assert.deepEqual(networkCause("not an error"), {});
});

test("diagnostics --analyze lists failed requests by category and error code", () => {
  const ISSUE = 64;
  const logs = tempDir("factory-failure-cause-");
  const log = new RunLog(logs, "2026-10-29T01-00-00-000Z-1");
  const request = (fields) =>
    log.write(ISSUE, {
      event: "github-request",
      job: "queue",
      method: "POST",
      route: "/graphql",
      status: null,
      attempt: 1,
      ms: 12,
      ...fields,
    });
  request({ category: "connection", codes: ["UND_ERR_SOCKET"] });
  request({ category: "connection", codes: ["UND_ERR_SOCKET"] });
  request({ category: "timeout", codes: ["UND_ERR_CONNECT_TIMEOUT"] });
  request({ category: "dns", codes: ["EAI_AGAIN"] });
  // Logged before the cause was: counted by category only.
  request({ category: "connection" });
  const run = (json) => {
    let out = "";
    analyze(
      {
        logs,
        issue: ISSUE,
        runs: { kind: "all" },
        secrets: [],
        json,
        groupBy: ["phase"],
        filters: {},
      },
      (text) => {
        out += text;
      },
    );
    return out;
  };
  const report = JSON.parse(run(true));
  assert.deepEqual(report.github.causes, {
    "connection UND_ERR_SOCKET": 2,
    "timeout UND_ERR_CONNECT_TIMEOUT": 1,
    "dns EAI_AGAIN": 1,
  });
  assert.equal(report.github.traced["network connection"], 3);
  assert.match(
    run(false),
    /failed requests by error code: connection UND_ERR_SOCKET 2, timeout UND_ERR_CONNECT_TIMEOUT 1, dns EAI_AGAIN 1/,
  );
});
