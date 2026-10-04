import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ClaudeManagedExecutionDriver } from "../dist/execution/claude-managed.js";
import { LocalContentStore } from "../dist/content/local.js";
import { claudeByteDigest } from "../dist/execution/claude-managed-transfer.js";
import { faultOf } from "../dist/fault.js";
/** The driver confirmed the worker stopped without a result. */
const stoppedWithoutResult = (error) =>
  faultOf(error).kind === "transient" &&
  faultOf(error).outcomeUnknown === false;
const config = () => ({
  agentId: "agent_pinned",
  agentVersion: 3,
  environmentId: "env_isolated",
  workspaceId: "wrkspc_public",
  credentialEnv: "FACTORY_CLAUDE_MANAGED_KEY",
  environment: {
    type: "cloud",
    packages: {
      apt: [],
      cargo: [],
      gem: [],
      go: [],
      npm: [],
      pip: [],
      type: "packages",
    },
    networking: {
      type: "limited",
      allowed_hosts: [],
      allow_mcp_servers: false,
      allow_package_managers: false,
    },
  },
  agent: {
    id: "agent_pinned",
    version: 3,
    type: "agent",
    name: "fixture",
    description: null,
    model: { id: "claude-sonnet-5" },
    system: null,
    skills: [],
    multiagent: null,
    mcp_servers: [],
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: {
          enabled: false,
          permission_policy: { type: "always_ask" },
        },
        configs: [
          {
            name: "bash",
            type: "bash",
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
        ],
      },
    ],
  },
});

/** A response lost in transit: the provider may or may not have applied it. */
const lost = (message) => Object.assign(new Error(message), { status: 503 });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-claude-driver-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  writeFileSync(join(checkout, "keep.txt"), "baseline\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const request = {
    attemptId: "attempt",
    baseSha: git("rev-parse", "HEAD"),
    item: {
      id: "item",
      title: "fixture",
      goal: "edit",
      acceptance: ["done"],
      nonGoals: [],
      citations: [],
      dependencies: [],
      ownedPaths: ["keep.txt", "new.bin"],
      validation: [],
      brief: "edit fixture",
    },
  };
  const state = {
    calls: [],
    events: [],
    files: [],
    outputs: new Map(),
    deleted: false,
    absence: true,
    sends: 0,
    creates: 0,
    strays: [],
  };
  const saved = [];
  const orphans = [];
  const context = {
    observeOrphan: (orphan) => orphans.push(orphan),
    cancelled: () => false,
    checkpoint: (h) => saved.push(structuredClone(h)),
  };
  const event = (id, type, extra = {}) => ({
    id,
    type,
    processed_at: "2026-09-29T00:00:00Z",
    ...extra,
  });
  const client = {
    async verifyEnvironment() {},
    assertSession() {},
    async upload(path) {
      assert.equal(saved.at(-1).data.phase, "prepared");
      const id = `file_${state.files.length}`;
      state.files.push({ id, path });
      if (state.loseUpload && path.endsWith(state.loseUpload)) {
        delete state.loseUpload;
        throw lost("upload response lost");
      }
      return { id };
    },
    async create(id, resources) {
      assert.equal(saved.at(-1).data.phase, "create-submitted");
      assert.ok(saved.at(-1).data.createdAfter);
      state.creates++;
      if (state.failCreate) {
        state.failCreate = false;
        throw lost("create never arrived");
      }
      state.session = {
        id: `sesn_${state.creates}`,
        status: "idle",
        resources,
        agent: config().agent,
        environment_id: config().environmentId,
        metadata: { factory_attempt: id },
        budget: null,
      };
      state.deleted = false;
      if (state.loseCreate) {
        state.loseCreate = false;
        throw lost("create response lost");
      }
      return structuredClone(state.session);
    },
    async findSessions(identity) {
      return state.session && !state.deleted && !state.gone
        ? [state.session, ...state.strays]
            .filter((s) => s.metadata.factory_attempt === identity)
            .map((s) => structuredClone(s))
        : [];
    },
    async retrieve() {
      if (state.gone)
        throw Object.assign(new Error("session not found"), { status: 404 });
      return structuredClone(state.session);
    },
    async present(id) {
      if (id !== state.session?.id)
        return state.strays.find((s) => s.id === id);
      return state.gone || (state.deleted && state.absence)
        ? undefined
        : structuredClone(state.session);
    },
    async send(id, input) {
      state.calls.push(input.type);
      state.sends++;
      assert.equal(saved.at(-1).data.sessionId, id);
      if (state.failSend) {
        state.failSend = false;
        state.onFailSend?.();
        throw lost("lost send");
      }
      const inputId = `input_${state.sends}`;
      const lose = () => {
        if (!state.loseSend) return;
        state.loseSend = false;
        throw lost("send response lost");
      };
      if (input.type === "user.interrupt") {
        state.events.push(event(inputId, input.type));
        state.session.status = "idle";
        return { data: [event(inputId, input.type)] };
      }
      if (saved.at(-1).data.phase === "bootstrap-submitted") {
        assert.equal(saved.at(-1).data.phase, "bootstrap-submitted");
        assert.ok(!input.content[0].text.includes("edit fixture"));
        const data = saved.at(-1).data;
        const source = JSON.parse(
          readFileSync(join(data.root, "factory-input.json")),
        );
        state.outputs.set(
          "factory-bootstrap.json",
          Buffer.from(
            JSON.stringify({
              inputDigest: data.inputDigest,
              baseSha: source.baseSha,
              treeSha: source.treeSha,
              files: source.files
                .filter((f) => !f.path.startsWith(".git/"))
                .map(({ content, ...f }) => f),
            }),
          ),
        );
        state.events = [
          event(inputId, "user.message", { content: input.content }),
          event("tool", "agent.tool_use", {
            name: "bash",
            input: { command: input.content[0].text.split("\n").at(-1) },
          }),
          event("toolresult", "agent.tool_result", {
            tool_use_id: "tool",
            is_error: false,
          }),
          event("bootstrap_end", "session.status_idle", {
            stop_reason: { type: "end_turn" },
          }),
        ];
      } else {
        assert.equal(saved.at(-1).data.phase, "implementation-submitted");
        assert.ok(saved.at(-1).data.bootstrap);
        state.events.push(
          event(inputId, "user.message", { content: input.content }),
          event("end", "session.status_idle", {
            stop_reason: { type: "end_turn" },
          }),
        );
      }
      lose();
      return { data: [event(inputId, "user.message")] };
    },
    async events() {
      return structuredClone(state.events);
    },
    async files() {
      return [...state.outputs].map(([filename, bytes]) => ({
        id: filename,
        filename,
        size_bytes: bytes.length,
        downloadable: true,
        scope: { type: "session", id: state.session.id },
      }));
    },
    async download(id) {
      if (state.failDownload) {
        state.failDownload = false;
        throw Object.assign(new Error("transient output read"), {
          status: state.failDownloadStatus ?? 503,
        });
      }
      return new Response(state.outputs.get(id));
    },
    async deleteSession(id) {
      state.calls.push(`delete:${id}`);
      if (id === state.session?.id) state.deleted = true;
      else state.strays = state.strays.filter((s) => s.id !== id);
    },
    async deleteFile(id) {
      state.calls.push(`delete:${id}`);
    },
    async fileAbsent() {
      return true;
    },
  };
  const args = {
    checkout,
    workRoot: join(root, "managed"),
    contentStore: new LocalContentStore(join(root, "content")),
    config: config(),
    client,
  };
  const driver = () => new ClaudeManagedExecutionDriver(args);
  const output = (handle) => {
    const content = Buffer.from("changed\n");
    state.outputs.set(
      "factory-result.json",
      Buffer.from(
        JSON.stringify({
          attemptId: "attempt",
          baseSha: request.baseSha,
          inputDigest: handle.data.inputDigest,
          files: [
            {
              path: "keep.txt",
              mode: "100644",
              sha256: claudeByteDigest(content),
              bytes: content.length,
              content: content.toString("base64"),
            },
          ],
        }),
      ),
    );
  };
  return {
    state,
    request,
    context,
    saved,
    orphans,
    driver,
    output,
    git,
    store: args.contentStore,
  };
}
test("Claude driver verifies bootstrap before implementation and collects exact result after restart", async (t) => {
  const f = fixture(t);
  const handle = await f.driver().start(f.request, f.context);
  assert.equal(f.state.sends, 1);
  assert.equal((await f.driver().observe(handle, f.context)).state, "running");
  assert.equal(f.state.sends, 1);
  assert.equal((await f.driver().observe(handle, f.context)).state, "running"); // observation never submits
  f.output(handle);
  const result = await f.driver().collect(structuredClone(handle), f.context);
  assert.equal(f.git("show", `${result.changeRef}:keep.txt`), "changed");
  assert.equal(f.state.calls.filter((c) => c.startsWith("delete:")).length, 5);
  assert.equal(f.saved.at(-1).data.phase, "disposed");
});
const settledInterruption = (error) => stoppedWithoutResult(error);
test("Claude create lost after submission adopts the tagged session instead of creating another", async (t) => {
  const f = fixture(t);
  f.state.loseCreate = true;
  // The lost response leaves a recorded phase for collection; no step interruption is spent.
  const handle = await f.driver().start(f.request, f.context);
  assert.equal(f.saved.at(-1).data.phase, "create-submitted");
  assert.equal(f.saved.at(-1).data.sessionId, undefined);
  f.output(handle);
  const result = await f
    .driver()
    .collect(structuredClone(f.saved.at(-1)), f.context);
  assert.equal(f.git("show", `${result.changeRef}:keep.txt`), "changed");
  assert.equal(f.state.creates, 1);
  assert.equal(f.state.sends, 2);
  assert.equal(f.saved.at(-1).data.sessionId, "sesn_1");
});
test("Claude create that never arrived creates the session again", async (t) => {
  const f = fixture(t);
  f.state.failCreate = true;
  const handle = await f.driver().start(f.request, f.context);
  f.output(handle);
  await f.driver().collect(structuredClone(f.saved.at(-1)), f.context);
  assert.equal(f.state.creates, 2);
  assert.equal(f.saved.at(-1).data.sessionId, "sesn_2");
  assert.equal(f.state.files.length, 4);
});
test("Claude upload response lost uploads again and records the possible orphan", async (t) => {
  const f = fixture(t);
  f.state.loseUpload = "factory-export.mjs";
  const handle = await f.driver().start(f.request, f.context);
  assert.equal(f.saved.at(-1).data.files.length, 2);
  assert.equal(f.orphans.length, 1);
  assert.equal(f.orphans[0].resource, "file");
  assert.match(f.orphans[0].detail, /factory-export\.mjs.*attempt/);
  f.output(handle);
  await f.driver().collect(structuredClone(f.saved.at(-1)), f.context);
  assert.equal(f.state.files.length, 5);
  assert.equal(f.saved.at(-1).data.files.length, 4);
});
test("Claude bootstrap send resolves from history: adopted when received, sent again when not", async (t) => {
  for (const flag of ["loseSend", "failSend"]) {
    const f = fixture(t);
    f.state[flag] = true;
    const handle = await f.driver().start(f.request, f.context);
    assert.equal(f.saved.at(-1).data.phase, "bootstrap-submitted");
    f.output(handle);
    await f.driver().collect(structuredClone(f.saved.at(-1)), f.context);
    const bootstraps = flag === "loseSend" ? 1 : 2;
    assert.equal(f.state.sends, bootstraps + 1, flag);
    assert.equal(f.state.creates, 1);
  }
});
test("Claude implementation send resolves in place: adopted when received, sent again when not", async (t) => {
  for (const flag of ["loseSend", "failSend"]) {
    const f = fixture(t);
    const handle = await f.driver().start(f.request, f.context);
    f.state[flag] = true;
    f.output(handle);
    // One collection resolves the lost response without a step interruption.
    const result = await f.driver().collect(handle, f.context);
    assert.equal(f.git("show", `${result.changeRef}:keep.txt`), "changed");
    assert.equal(f.state.sends, flag === "loseSend" ? 2 : 3, flag);
  }
});
test("Claude unknown implementation outcome settles the session and interrupts the attempt", async (t) => {
  const f = fixture(t);
  const handle = await f.driver().start(f.request, f.context);
  f.state.failSend = true;
  // Activity the attempt cannot attribute: neither its input nor an idle session.
  f.state.onFailSend = () => {
    f.state.session.status = "running";
  };
  await assert.rejects(
    f.driver().collect(handle, f.context),
    settledInterruption,
  );
  assert.ok(
    f.state.calls.indexOf("user.interrupt") <
      f.state.calls.indexOf("delete:sesn_1"),
  );
  assert.equal(f.saved.at(-1).data.phase, "disposed");
  assert.equal(
    (await f.driver().observe(f.saved.at(-1), f.context)).interrupted,
    true,
  );
});
test("Claude cancellation deletes a stray tagged session left by a lost create", async (t) => {
  const f = fixture(t);
  const handle = await f.driver().start(f.request, f.context);
  f.state.strays.push({
    ...structuredClone(f.state.session),
    id: "sesn_stray",
  });
  await f.driver().cancel(handle, f.context);
  assert.ok(f.state.calls.includes("delete:sesn_stray"));
  assert.equal(f.state.strays.length, 0);
});
test("Claude deletion repeats until absence is confirmed", async (t) => {
  const f = fixture(t);
  const handle = await f.driver().start(f.request, f.context);
  f.state.absence = false;
  await assert.rejects(f.driver().cancel(handle, f.context), /not confirmed/);
  await assert.rejects(f.driver().cancel(handle, f.context), /not confirmed/);
  assert.equal(f.state.calls.filter((c) => c === "delete:sesn_1").length, 2);
  f.state.absence = true;
  await f.driver().cancel(handle, f.context);
  assert.equal(f.saved.at(-1).data.phase, "disposed");
});
test("Claude running cancellation records processed interrupt then deletes owned sandbox", async (t) => {
  const f = fixture(t);
  const handle = await f.driver().start(f.request, f.context);
  f.state.session.status = "running";
  await f.driver().cancel(handle, f.context);
  assert.ok(
    f.state.calls.indexOf("user.interrupt") <
      f.state.calls.indexOf("delete:sesn_1"),
  );
  assert.equal(
    (await f.driver().observe(handle, f.context)).state,
    "cancelled",
  );
});
test("Claude refuses changed resources before implementation and reports budget stops", async (t) => {
  const f = fixture(t);
  const handle = await f.driver().start(f.request, f.context);
  f.state.session.resources[0].mount_path = "/unexpected";
  await assert.rejects(
    f.driver().observe(handle, f.context),
    /resources changed/,
  );
  assert.equal(f.state.sends, 1);
  f.state.session.resources = JSON.parse(
    JSON.stringify(
      f.saved
        .find((h) => h.data.resourcesDigest)
        ?.data.files.map((file) => ({
          type: "file",
          file_id: file.id,
          mount_path: `/mnt/session/uploads/${file.name}`,
        })),
    ),
  );
  f.state.events.at(-1).stop_reason = { type: "budget_reached" };
  f.state.events.find((e) => e.id === "toolresult").is_error = true;
  assert.equal(
    (await f.driver().observe(handle, f.context)).detail,
    "Claude stopped: budget_reached",
  );
  await f.driver().cancel(handle, f.context);
  const evidence = JSON.parse(
    readFileSync(join(handle.data.root, "provider-evidence.json")),
  );
  assert.equal(
    evidence.events.find((e) => e.id === "bootstrap_end").stop_reason.type,
    "budget_reached",
  );
  assert.equal(
    evidence.events.find((e) => e.id === "toolresult").tool_use_id,
    "tool",
  );
  assert.equal(
    evidence.events.find((e) => e.id === "toolresult").is_error,
    true,
  );
});
test("Claude verifies actual returned selected bytes instead of restoring originals", async (t) => {
  const f = fixture(t);
  const original = Buffer.from([0, 255, 3, 0, 8]);
  const ref = await f.store.put(new Response(original).body, {
    mediaType: "application/octet-stream",
  });
  f.request.selectedAssets = [{ ref, path: "approved.bin" }];
  const handle = await f.driver().start(f.request, f.context);
  await f.driver().observe(handle, f.context);
  f.output(handle);
  const result = JSON.parse(f.state.outputs.get("factory-result.json"));
  const bytes = Buffer.from("tampered");
  result.files.push({
    path: ".factory-inputs/selected-0",
    mode: "100644",
    sha256: claudeByteDigest(bytes),
    bytes: bytes.length,
    content: bytes.toString("base64"),
  });
  f.state.outputs.set(
    "factory-result.json",
    Buffer.from(JSON.stringify(result)),
  );
  await assert.rejects(
    f.driver().collect(handle, f.context),
    (error) =>
      faultOf(error).kind === "work" &&
      /changed|modified|digest|bytes|immutable/i.test(error.message),
  );
  // The rejected attempt's session is deleted so a new attempt never runs beside it.
  assert.equal(f.state.deleted, true);
});
test("Claude refused create is a real failure, not an interruption", async (t) => {
  const f = fixture(t);
  const create = f.driver().args.client.create;
  f.driver().args.client.create = async () => {
    throw Object.assign(new Error("permission denied"), { status: 403 });
  };
  await assert.rejects(
    f.driver().start(f.request, f.context),
    (error) =>
      faultOf(error).kind === "work" && /permission denied/.test(error.message),
  );
  f.driver().args.client.create = create;
  assert.equal(f.saved.at(-1).data.phase, "disposed");
  assert.equal(f.state.calls.filter((c) => /^delete:file_/.test(c)).length, 4);
});
test("Claude refused read settles the attempt; a passed deadline settles it as a timeout", async (t) => {
  for (const kind of ["refused", "deadline"]) {
    const f = fixture(t);
    const handle = await f.driver().start(f.request, f.context);
    if (kind === "refused") {
      f.state.failDownload = true;
      f.state.failDownloadStatus = 403;
    } else handle.data.startedAt -= 901_000;
    await assert.rejects(
      f.driver().collect(handle, f.context),
      (error) =>
        faultOf(error).kind === "work" &&
        (kind === "refused"
          ? /transient output read/
          : /configured timeout/
        ).test(error.message),
    );
    assert.equal(f.state.deleted, true, kind);
    assert.equal(f.saved.at(-1).data.phase, "disposed");
    // A restart finishes the same settlement instead of resuming the work.
    await assert.rejects(
      f.driver().collect(structuredClone(f.saved.at(-1)), f.context),
      (error) => ["work", "transient"].includes(faultOf(error).kind),
    );
    assert.equal(f.state.sends, 1);
  }
});
test("Claude transient read is retried in place without spending a step interruption", async (t) => {
  const f = fixture(t);
  const handle = await f.driver().start(f.request, f.context);
  const events = f.driver().args.client.events;
  let failures = 2;
  f.driver().args.client.events = async (...args) => {
    if (failures-- > 0)
      throw Object.assign(new Error("connection reset"), {
        code: "ECONNRESET",
      });
    return events(...args);
  };
  f.output(handle);
  const result = await f.driver().collect(handle, f.context);
  assert.equal(f.git("show", `${result.changeRef}:keep.txt`), "changed");
  assert.equal(f.state.creates, 1);
  assert.equal(f.state.sends, 2);
});
test("Claude session that is gone settles the attempt and still deletes its files", async (t) => {
  const f = fixture(t);
  const handle = await f.driver().start(f.request, f.context);
  f.state.gone = true;
  // The worker is gone with its session: no result, not a wrong one.
  await assert.rejects(f.driver().collect(handle, f.context), (error) =>
    stoppedWithoutResult(error),
  );
  assert.equal(f.saved.at(-1).data.phase, "disposed");
  assert.equal(f.state.calls.filter((c) => /^delete:file_/.test(c)).length, 4);
});

test("failure cleanup observation after a bootstrap read error never submits implementation", async (t) => {
  const f = fixture(t);
  const handle = await f.driver().start(f.request, f.context);
  f.state.failDownload = true;
  await assert.rejects(
    f.driver().observe(handle, f.context),
    /transient output read/,
  );
  // Same observe-before-cancel sequence used by runner failure cleanup, even with cancelled() false.
  assert.equal((await f.driver().observe(handle, f.context)).state, "running");
  assert.equal(f.state.sends, 1);
  await f.driver().cancel(handle, f.context);
  assert.equal(f.state.sends, 1);
  assert.equal(f.saved.at(-1).data.phase, "disposed");
});
test("Claude preserves binary selected bytes through the ordinary collector", async (t) => {
  const f = fixture(t);
  const bytes = Buffer.from([0, 255, 3, 0, 8]);
  const ref = await f.store.put(new Response(bytes).body, {
    mediaType: "application/octet-stream",
  });
  f.request.selectedAssets = [{ ref, path: "approved.bin" }];
  const handle = await f.driver().start(f.request, f.context);
  await f.driver().observe(handle, f.context);
  f.output(handle);
  const result = JSON.parse(f.state.outputs.get("factory-result.json"));
  for (const path of [".factory-inputs/selected-0", "new.bin"])
    result.files.push({
      path,
      mode: "100644",
      sha256: claudeByteDigest(bytes),
      bytes: bytes.length,
      content: bytes.toString("base64"),
    });
  f.state.outputs.set(
    "factory-result.json",
    Buffer.from(JSON.stringify(result)),
  );
  const collected = await f.driver().collect(handle, f.context);
  assert.equal(
    f.git("cat-file", "-s", `${collected.changeRef}:new.bin`),
    String(bytes.length),
  );
  assert.ok(
    !f
      .git("ls-tree", "-r", "--name-only", collected.changeRef)
      .includes(".factory-inputs"),
  );
});

const notFound = () =>
  Object.assign(new Error("session not found"), { status: 404 });

test("Claude session gone while collecting is a dead worker, not a failed result", async (t) => {
  const f = fixture(t);
  const handle = await f.driver().start(f.request, f.context);
  f.state.gone = true;
  const error = await f
    .driver()
    .collect(handle, f.context)
    .catch((caught) => caught);
  // The session is gone: the worker stopped without a result.
  assert.ok(stoppedWithoutResult(error));
});

test("Claude cancel succeeds when the session disappears before its interrupt", async (t) => {
  const f = fixture(t);
  const handle = await f.driver().start(f.request, f.context);
  f.state.session.status = "running";
  const client = f.driver().args.client;
  const send = client.send;
  client.send = async (id, input) => {
    if (input.type !== "user.interrupt") return send(id, input);
    f.state.gone = true;
    throw notFound();
  };
  await f.driver().cancel(handle, f.context);
  assert.equal(f.saved.at(-1).data.phase, "disposed");
});

test("Claude cleanup succeeds when the session disappears before its history is read", async (t) => {
  const f = fixture(t);
  const handle = await f.driver().start(f.request, f.context);
  const client = f.driver().args.client;
  client.events = async () => {
    throw notFound();
  };
  await f.driver().cancel(handle, f.context);
  assert.equal(f.saved.at(-1).data.phase, "disposed");
  assert.ok(f.state.calls.includes("delete:sesn_1"));
});
