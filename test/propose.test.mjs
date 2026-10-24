// propose: drafting and publishing Objectives across crashes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { checkObjective } from "../dist/objective.js";
import { readShown } from "../dist/shown.js";
import {
  CLI,
  children,
  configured,
  githubOrigin,
  installation,
  REPO,
  refusal,
} from "./helpers.mjs";

test("propose --approve publishes a drafted batch once across crashes, checked like the check step, with blocked-by links; --enqueue queues each", async () => {
  const inst = installation();
  const dir = mkdtempSync(join(tmpdir(), "factory-propose-"));
  const git = (cwd, ...args) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  };
  git(dir, "init", "--quiet", "--bare", "-b", "main", "origin.git");
  git(dir, "clone", "--quiet", "origin.git", "work");
  writeFileSync(
    join(dir, "work", "README.md"),
    "# Drill\n\n## Usage\n\nRun it.\n\n## Roadmap\n\n- Docs\n- A usage test\n",
  );
  git(join(dir, "work"), "add", ".");
  git(join(dir, "work"), "commit", "--quiet", "-m", "0");
  git(join(dir, "work"), "push", "--quiet", "origin", "HEAD:main");
  git(dir, "clone", "--quiet", "origin.git", "checkout");
  const checkout = join(dir, "checkout");
  githubOrigin(checkout, join(dir, "origin.git"));
  // GitHub: its renderer, Factory's login, the issues it opened and their links.
  const issues = [];
  const links = new Map();
  const server = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const reply = (code, body) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const path = req.url.split("?")[0];
      if (req.method === "POST" && path === "/markdown") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(
          micromark(JSON.parse(raw).text, {
            extensions: [gfm()],
            htmlExtensions: [gfmHtml()],
          }),
        );
      }
      if (path === "/user") return reply(200, { login: "factory-bot" });
      if (path === `/repos/${REPO}/issues` && req.method === "GET")
        return reply(200, [...issues].reverse());
      if (path === `/repos/${REPO}/issues` && req.method === "POST") {
        const at = new Date().toISOString();
        const created = {
          ...JSON.parse(raw),
          id: 9000 + issues.length,
          number: 500 + issues.length,
          state: "open",
          user: { login: "factory-bot" },
          created_at: at,
          updated_at: at,
        };
        issues.push(created);
        return reply(201, created);
      }
      const blocked = new RegExp(
        `^/repos/${REPO}/issues/(\\d+)/dependencies/blocked_by$`,
      ).exec(path);
      if (blocked) {
        const number = Number(blocked[1]);
        const list = links.get(number) ?? [];
        if (req.method === "GET") return reply(200, list);
        const blocker = issues.find(
          (issue) => issue.id === JSON.parse(raw).issue_id,
        );
        links.set(number, [...list, blocker]);
        return reply(201, blocker);
      }
      reply(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  configured(
    inst,
    `http://127.0.0.1:${server.address().port}`,
    {},
    { checkout },
  );
  /** `factory propose`, as its own process (the fake GitHub runs in this one). */
  const propose = (crashAt, ...args) => {
    const env = { ...inst.env };
    if (crashAt) env.FACTORY_CRASH_AT = crashAt;
    const child = spawn(
      process.execPath,
      [CLI, "propose", ...args, "--repo", REPO],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.add(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    return new Promise((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal, out, err })),
    );
  };
  const objective = (key, fields) => ({
    key,
    dependencies: [],
    title: "Usage docs",
    goal: "Explain usage to @octo <b>now</b>.",
    acceptance: ["# The README says how to run it"],
    commands: [],
    context: [],
    sources: ["README.md#Roadmap"],
    constraints: ["1. No new dependencies"],
    nonGoals: [],
    ...fields,
  });
  /** A roadmap draft as `factory propose --source` saves it after the model's answer. */
  const draft = (name, id, objectives) => {
    const file = join(dir, `${name}.json`);
    const text = `${JSON.stringify(
      {
        id,
        createdAt: new Date().toISOString(),
        intent: "",
        sources: ["README.md#Roadmap"],
        objectives,
      },
      null,
      2,
    )}\n`;
    writeFileSync(file, text);
    return { file, digest: createHash("sha256").update(text).digest("hex") };
  };
  const id = "0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
  const batch = [
    objective("docs", {}),
    objective("usage-test", {
      title: "Usage test",
      dependencies: ["docs"],
    }),
  ];
  const good = draft("good", id, batch);
  const approve = (crashAt, { file, digest }, ...more) =>
    propose(crashAt, "--file", file, "--approve", digest, ...more);
  // The approval names the reviewed bytes, and every draft passes the checks.
  const changed = await approve(undefined, {
    file: good.file,
    digest: "0".repeat(64),
  });
  assert.equal(refusal(changed), "proposal_refused");
  const unsourced = draft("unsourced", id, [
    batch[0],
    { ...batch[1], sources: ["MISSING.md"] },
  ]);
  const invalid = await approve(undefined, unsourced);
  assert.equal(refusal(invalid), "proposal_refused");
  assert.match(invalid.err, /usage-test: Sources entry "MISSING\.md"/);
  assert.equal(issues.length, 0);
  // A partial batch: a crash after the first create, then one before the
  // link. Each next approval adopts what exists and adds what is missing.
  const first = await approve("propose:create:after", good);
  assert.equal(first.signal, "SIGKILL");
  assert.equal(issues.length, 1);
  const second = await approve("propose:link:before", good);
  assert.equal(second.signal, "SIGKILL");
  assert.equal(issues.length, 2);
  assert.equal(links.size, 0);
  const again = await approve(undefined, good, "--enqueue");
  assert.equal(again.code, 0, again.err);
  const result = JSON.parse(again.out.split("\n")[0]);
  assert.deepEqual(
    result.issues.map(({ key, issue, created }) => ({ key, issue, created })),
    [
      { key: "docs", issue: 500, created: false },
      { key: "usage-test", issue: 501, created: false },
    ],
  );
  assert.equal(result.queued, true);
  assert.equal(issues.length, 2);
  assert.deepEqual(
    links.get(501).map((issue) => issue.number),
    [500],
  );
  // Approving once more changes nothing.
  assert.equal((await approve(undefined, good)).code, 0);
  assert.equal(issues.length, 2);
  assert.equal(links.get(501).length, 1);
  // Each is queued through `factory run`'s request.
  const queued = new Set(
    readdirSync(inst.requests)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) =>
          JSON.parse(readFileSync(join(inst.requests, name), "utf8")).request,
      )
      .filter((request) => request.kind === "run")
      .map((request) => request.issue),
  );
  assert.deepEqual([...queued].sort(), [500, 501]);
  // The same draft edited after publishing: refused, nothing made.
  const edited = draft("good", id, [
    { ...batch[0], title: "Usage docs, edited" },
    batch[1],
  ]);
  assert.equal(refusal(await approve(undefined, edited)), "proposal_refused");
  assert.equal(issues.length, 2);
  // The body: the marker, the sections, and untrusted text escaped.
  const [issue] = issues;
  assert.equal(issue.title, "Usage docs");
  assert.match(
    issue.body,
    new RegExp(`^<!-- factory:0:proposal:${id}:docs -->\\n`),
  );
  assert.match(
    issue.body,
    /## Goal\n\nExplain usage to &#64;octo &lt;b&gt;now&lt;\/b&gt;\./,
  );
  assert.match(
    issue.body,
    /## Acceptance\n\n- \\# The README says how to run it/,
  );
  assert.match(issue.body, /## Sources\n\n- `README\.md#Roadmap`/);
  assert.match(issue.body, /## Constraints\n\n- 1\\\. No new dependencies/);
  const shown = readShown(
    micromark(issue.body, {
      extensions: [gfm()],
      htmlExtensions: [gfmHtml()],
    }),
    { sources: true },
  );
  assert.deepEqual(checkObjective(shown.blocks).problems, []);
  // A crash before the create: nothing was made, and the next one makes it.
  const other = draft("other", "1b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d", [
    batch[0],
  ]);
  assert.equal(
    (await approve("propose:create:before", other)).signal,
    "SIGKILL",
  );
  assert.equal(issues.length, 2);
  const made = await approve(undefined, other);
  assert.equal(made.code, 0, made.err);
  assert.equal(JSON.parse(made.out.split("\n")[0]).issues[0].created, true);
  assert.equal(issues.length, 3);
});
