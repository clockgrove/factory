// A GitHub request that gets no answer fails with fetch's "fetch failed",
// its reason only in the error's cause chain (a DNS failure, a reset, a
// closed socket, a connect timeout, a TLS failure, an AggregateError of
// each address tried). The error message and the request's
// `github-request` event keep that cause, so an outage can be told from a
// bug afterwards (#2192). Every error here is synthetic, shaped as Node
// and undici build them, or met on a local socket.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, afterEach, test } from "node:test";
import { analyze } from "../dist/analysis.js";
import { GitHub, TransientError } from "../dist/github.js";
import {
  failureText,
  networkCategory,
  networkCause,
  newTransport,
  requestEvents,
  transport,
} from "../dist/github-trace.js";
import { RunLog } from "../dist/log.js";
import { closedPort, REPO, tempDir } from "./helpers.mjs";

const errno = (message, fields) => Object.assign(new Error(message), fields);
const fetchFailed = (cause) => new TypeError("fetch failed", { cause });

const SHAPES = [
  {
    name: "a DNS failure",
    error: fetchFailed(
      errno("getaddrinfo ENOTFOUND api.github.com", {
        code: "ENOTFOUND",
        errno: -3008,
        syscall: "getaddrinfo",
        hostname: "api.github.com",
      }),
    ),
    text: "fetch failed: getaddrinfo ENOTFOUND api.github.com",
    cause: {
      codes: ["ENOTFOUND"],
      syscall: "getaddrinfo",
      hostname: "api.github.com",
    },
    category: "dns",
  },
  {
    name: "a DNS server that didn't answer",
    error: fetchFailed(
      errno("getaddrinfo EAI_AGAIN api.github.com", {
        code: "EAI_AGAIN",
        syscall: "getaddrinfo",
        hostname: "api.github.com",
      }),
    ),
    text: "fetch failed: getaddrinfo EAI_AGAIN api.github.com",
    cause: {
      codes: ["EAI_AGAIN"],
      syscall: "getaddrinfo",
      hostname: "api.github.com",
    },
    category: "dns",
  },
  {
    name: "a reset",
    error: fetchFailed(
      errno("read ECONNRESET", {
        code: "ECONNRESET",
        errno: -104,
        syscall: "read",
      }),
    ),
    text: "fetch failed: read ECONNRESET",
    cause: { codes: ["ECONNRESET"], syscall: "read" },
    category: "connection",
  },
  {
    name: "a socket the other side closed",
    error: fetchFailed(
      errno("other side closed", {
        name: "SocketError",
        code: "UND_ERR_SOCKET",
        socket: {
          remoteAddress: "192.0.2.10",
          remotePort: 443,
          bytesWritten: 512,
          bytesRead: 0,
        },
      }),
    ),
    text: "fetch failed: other side closed (UND_ERR_SOCKET, 192.0.2.10:443)",
    cause: { codes: ["UND_ERR_SOCKET"], address: "192.0.2.10:443" },
    category: "connection",
  },
  {
    name: "a connect timeout",
    error: fetchFailed(
      errno(
        "Connect Timeout Error (attempted address: api.github.com:443, timeout: 10000ms)",
        { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" },
      ),
    ),
    text: "fetch failed: Connect Timeout Error (attempted address: api.github.com:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT)",
    cause: { codes: ["UND_ERR_CONNECT_TIMEOUT"] },
    category: "timeout",
  },
  {
    name: "a timeout two causes down",
    error: fetchFailed(
      new Error("connect failed", {
        cause: errno("connect ETIMEDOUT 192.0.2.10:443", {
          code: "ETIMEDOUT",
          syscall: "connect",
          address: "192.0.2.10",
          port: 443,
        }),
      }),
    ),
    text: "fetch failed: connect failed; connect ETIMEDOUT 192.0.2.10:443",
    cause: {
      codes: ["ETIMEDOUT"],
      syscall: "connect",
      address: "192.0.2.10:443",
    },
    category: "timeout",
  },
  {
    name: "an AggregateError of each address tried",
    error: fetchFailed(
      Object.assign(
        new AggregateError(
          [
            errno("connect ECONNREFUSED ::1:443", {
              code: "ECONNREFUSED",
              syscall: "connect",
              address: "::1",
              port: 443,
            }),
            errno("connect ETIMEDOUT 192.0.2.10:443", {
              code: "ETIMEDOUT",
              syscall: "connect",
              address: "192.0.2.10",
              port: 443,
            }),
          ],
          "",
        ),
        { code: "ECONNREFUSED" },
      ),
    ),
    text: "fetch failed: AggregateError (ECONNREFUSED); connect ECONNREFUSED ::1:443; connect ETIMEDOUT 192.0.2.10:443",
    cause: {
      codes: ["ECONNREFUSED", "ETIMEDOUT"],
      syscall: "connect",
      address: "[::1]:443",
    },
    // An address that timed out, not only the cause's own code.
    category: "timeout",
  },
  {
    name: "an untrusted certificate",
    error: fetchFailed(
      errno("unable to verify the first certificate", {
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      }),
    ),
    text: "fetch failed: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)",
    cause: { codes: ["UNABLE_TO_VERIFY_LEAF_SIGNATURE"] },
    category: "tls",
  },
  {
    name: "a certificate for another name",
    error: fetchFailed(
      errno(
        "Hostname/IP does not match certificate's altnames: Host: api.github.com. is not in the cert's altnames: DNS:example.test",
        { code: "ERR_TLS_CERT_ALTNAME_INVALID", host: "api.github.com" },
      ),
    ),
    text: "fetch failed: Hostname/IP does not match certificate's altnames: Host: api.github.com. is not in the cert's altnames: DNS:example.test (ERR_TLS_CERT_ALTNAME_INVALID)",
    cause: {
      codes: ["ERR_TLS_CERT_ALTNAME_INVALID"],
      hostname: "api.github.com",
    },
    category: "tls",
  },
  {
    name: "a TLS handshake cut off",
    error: fetchFailed(
      errno(
        "Client network socket disconnected before secure TLS connection was established",
        { code: "ECONNRESET", host: "api.github.com", port: 443 },
      ),
    ),
    text: "fetch failed: Client network socket disconnected before secure TLS connection was established (ECONNRESET, api.github.com)",
    cause: { codes: ["ECONNRESET"], hostname: "api.github.com" },
    category: "connection",
  },
];

for (const shape of SHAPES)
  test(`${shape.name}: its cause in one line, its codes and its category`, () => {
    assert.equal(failureText(shape.error), shape.text);
    assert.deepEqual(networkCause(shape.error), shape.cause);
    assert.equal(networkCategory(shape.error, false), shape.category);
  });

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

// --- the client --------------------------------------------------------------

let answer = (_req, res) => res.end("{}");
const server = createServer((req, res) => answer(req, res));
after(() => {
  server.closeAllConnections();
  server.close();
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function client(api) {
  process.env.FACTORY_GITHUB_TOKEN = "unused";
  if (!api && !server.listening)
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return new GitHub(REPO, api ?? `http://127.0.0.1:${server.address().port}`);
}

/** `read` in a sync job's scope (failures traced): what it threw and the scope's events. */
async function failed(read) {
  const counted = newTransport();
  const error = await transport.run(counted, read).then(
    () => assert.fail("the request succeeded"),
    (thrown) => thrown,
  );
  assert.ok(error instanceof TransientError, String(error));
  return { error, events: requestEvents("sync", counted), counted };
}

const PATH = `/repos/${REPO}/installation`;

test("a request whose socket the server closes says why, in its error and its github-request event", async () => {
  const github = await client();
  answer = (req) => req.socket.destroy();
  const { error, events } = await failed(() => github.rest("GET", PATH));
  const port = server.address().port;
  assert.equal(
    error.message,
    `GitHub GET ${PATH}: fetch failed: other side closed (UND_ERR_SOCKET, 127.0.0.1:${port})`,
  );
  assert.equal(events.length, 1);
  const { ms, ...request } = events[0];
  assert.equal(typeof ms, "number");
  assert.deepEqual(request, {
    event: "github-request",
    job: "sync",
    method: "GET",
    route: PATH,
    status: null,
    attempt: 1,
    category: "connection",
    codes: ["UND_ERR_SOCKET"],
    address: `127.0.0.1:${port}`,
    cause: `fetch failed: other side closed (UND_ERR_SOCKET, 127.0.0.1:${port})`,
  });
});

test("a refused connection records its code, syscall and address", async () => {
  const port = await closedPort();
  const github = await client(`http://127.0.0.1:${port}`);
  const { error, events } = await failed(() => github.rest("GET", PATH));
  assert.match(
    error.message,
    new RegExp(`^GitHub GET ${PATH}: fetch failed: .*ECONNREFUSED`),
  );
  assert.doesNotMatch(error.message, /\n/);
  assert.equal(events[0].category, "connection");
  assert.ok(events[0].codes.includes("ECONNREFUSED"), events[0].codes);
  assert.equal(events[0].syscall, "connect");
  assert.equal(events[0].address, `127.0.0.1:${port}`);
});

test("each synthetic cause reaches the request's error and event whole", async () => {
  const github = await client();
  for (const shape of SHAPES) {
    globalThis.fetch = async () => {
      throw shape.error;
    };
    const { error, events } = await failed(() => github.rest("GET", PATH));
    assert.equal(error.message, `GitHub GET ${PATH}: ${shape.text}`);
    const { category, codes, syscall, hostname, address, cause } = events[0];
    assert.equal(category, shape.category, shape.name);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries({ codes, syscall, hostname, address }).filter(
          ([, value]) => value !== undefined,
        ),
      ),
      shape.cause,
      shape.name,
    );
    assert.equal(cause, shape.text);
  }
});

test("a body cut short is traced as a failed request with its cause", async () => {
  const github = await client();
  answer = (_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": "4096",
    });
    res.write('{"id":');
    setTimeout(() => res.socket.destroy(), 20);
  };
  const { error, events, counted } = await failed(() =>
    github.rest("GET", PATH),
  );
  const port = server.address().port;
  assert.equal(
    error.message,
    `GitHub GET ${PATH}: the answer's body didn't arrive whole: terminated: other side closed (UND_ERR_SOCKET, 127.0.0.1:${port})`,
  );
  assert.equal(counted.failed, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 200);
  assert.equal(events[0].category, "connection");
  assert.deepEqual(events[0].codes, ["UND_ERR_SOCKET"]);
  assert.equal(events[0].address, `127.0.0.1:${port}`);
});

test("a whole answer that isn't JSON is no network failure, and its body is never quoted", async () => {
  const github = await client();
  for (const [type, page] of [
    ["text/html", "<!DOCTYPE html><html>synthetic-portal</html>"],
    ["application/json", ""],
    ["application/json", '{"id":'],
  ]) {
    answer = (_req, res) => {
      res.writeHead(200, { "content-type": type });
      res.end(page);
    };
    const counted = newTransport();
    const error = await transport
      .run(counted, () => github.rest("GET", PATH))
      .then(
        () => assert.fail("the request succeeded"),
        (thrown) => thrown,
      );
    assert.ok(error instanceof TransientError, String(error));
    assert.equal(
      error.message,
      `GitHub GET ${PATH}: the answer's body isn't JSON (${type}, ${page.length} characters)`,
    );
    assert.equal(counted.failed, 0);
    const events = requestEvents("sync", counted);
    assert.ok(
      events.every(
        (event) =>
          event.category === undefined &&
          event.cause === undefined &&
          event.codes === undefined,
      ),
      JSON.stringify(events),
    );
    assert.doesNotMatch(
      JSON.stringify(events),
      /synthetic-portal|DOCTYPE|JSON input/,
    );
  }
});

test("a request the caller aborts records no cause", async () => {
  const github = await client();
  answer = () => {};
  const counted = newTransport();
  const controller = new AbortController();
  const read = transport.run(counted, () =>
    github.rest("GET", PATH, undefined, controller.signal),
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(read, { name: "AbortError" });
  const [request] = requestEvents("sync", counted);
  assert.equal(request.category, "aborted");
  assert.equal(request.codes, undefined);
  assert.equal(request.cause, undefined);
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
