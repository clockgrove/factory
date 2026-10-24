// Holds, waits and questions: retries, wait budgets, provider switches,
// configuration changes, and which steps a question stops.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cli,
  closedPort,
  comment,
  configured,
  githubOrigin,
  installation,
  item,
  offered,
  refusal,
  seed,
  serve,
  silentServer,
  stateOf,
  status,
  stopped,
  until,
} from "./helpers.mjs";

test("a step past its deadline retries, then holds after three", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await silentServer()}`, {
    FACTORY_DEADLINE_MS: "300",
  });
  seed(inst, 21);
  const service = serve(inst);
  await until(() => stateOf(inst, 21).holds.length, "hold");
  const [hold] = stateOf(inst, 21).holds;
  assert.match(hold.question, /keeps failing \(deadline\)/);
  assert.deepEqual(
    hold.options.map((option) => option.answer),
    ["retry", "cancel"],
  );
  assert.equal(stateOf(inst, 21).retries.check.count, 3);
  await stopped(service);
});

test("a transient wait retries without counting errors, then asks, and wait waits on", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`, {
    FACTORY_WAIT_MS: "1500",
  });
  seed(inst, 22);
  const service = serve(inst);
  await until(() => stateOf(inst, 22).retries.check?.attempts >= 3, "retries");
  assert.deepEqual(stateOf(inst, 22).holds, [], "no hold before the budget");
  assert.equal(stateOf(inst, 22).retries.check.count, 0, "waits aren't errors");
  await until(() => stateOf(inst, 22).holds.length, "the wait's question");
  const first = stateOf(inst, 22);
  const [asked] = first.holds;
  assert.match(asked.question, /has been retrying since/);
  assert.match(asked.question, /Last error: GitHub GET/);
  assert.deepEqual(
    asked.options.map((option) => option.answer),
    ["wait", "retry", "cancel"],
  );
  assert.equal(
    asked.options.find((option) => option.recommended).answer,
    "wait",
  );

  assert.equal(
    cli(inst, "answer", "22", "wait", "--question", asked.id).code,
    0,
  );
  const granted = stateOf(inst, 22);
  assert.equal(granted.status, "checking");
  assert.ok(granted.retries.check.grantedUntil, "wait grants more time");
  assert.equal(granted.retries.check.since, first.retries.check.since);
  await until(
    () =>
      stateOf(inst, 22).holds.length &&
      stateOf(inst, 22).holds[0].id !== asked.id,
    "the question again once the grant is spent",
  );
  assert.equal(cli(inst, "cancel", "22").code, 0);
  await stopped(service);
});

test("switch moves an Objective held on a usage limit to the named provider", async () => {
  const inst = installation();
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    {
      providers: {
        codex: { planner: "codex", worker: { kind: "codex" } },
        claude: { planner: "claude", worker: { kind: "claude" } },
      },
      defaultProvider: "codex",
    },
  );
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
  const limited = {
    count: 0,
    attempts: 1,
    since: now,
    nextAt: later,
    lastError: "Codex usage limit",
    wait: { kind: "reset", at: later, provider: "codex" },
  };
  const id = `item:a:work@${now}`;
  // Both items' work waits on Codex's limit; the question is the
  // Objective's, asked once.
  seed(inst, 41, "holding", {
    holds: [
      {
        id,
        step: "item:a:work",
        question: "Codex usage limit: weekly.",
        // As the engine saves it: one switch option per target.
        options: offered("wait", "switch", "cancel").map((option) =>
          option.answer === "switch" ? { ...option, arg: "claude" } : option,
        ),
        askedAt: now,
      },
    ],
    done: {
      check: {},
      plan: {
        items: ["a", "b"].map((item) => ({
          id: item,
          ownedPaths: [`src/${item}.ts`],
          dependencies: [],
        })),
      },
    },
    retries: { "item:a:work": limited, "item:b:work": limited },
  });
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const unknown = cli(inst, "answer", "41", "switch", "nope", "--question", id);
  assert.equal(unknown.code, 1);
  assert.equal(refusal(unknown), "invalid_answer");
  assert.match(unknown.err, /`switch claude`/);
  assert.equal(cli(inst, "answer", "41", "switch", "--question", id).code, 0);
  const state = stateOf(inst, 41);
  assert.deepEqual(state.holds, []);
  assert.ok(
    Object.values(state.retries).every((retry) => retry.wait?.kind !== "reset"),
    "every step on the limit runs now",
  );
  assert.equal(state.frozen.provider, "claude");
  assert.equal(state.frozen.selectedBy, "switch");
  assert.equal(state.frozen.config.provider.planner, "claude");
  assert.equal(cli(inst, "cancel", "41").code, 0);
  await stopped(service);
});

test("a changed configuration holds once, naming the frozen keys; adopt re-freezes only what it named", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  seed(inst, 44);
  const before = stateOf(inst, 44).frozen.digest;
  // One frozen key and two operational ones change under the Objective.
  const config = JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));
  config.autonomy = { allowances: { planningRevisions: 1 } };
  config.queue.pollSeconds = 7;
  config.execution = { workers: 1 };
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  const first = serve(inst);
  await until(() => stateOf(inst, 44).holds.length > 0, "the question");
  const [stale] = stateOf(inst, 44).holds;
  assert.equal(stale.step, "config");
  assert.deepEqual(
    stale.options.map((option) => option.answer),
    ["adopt", "cancel"],
  );
  assert.match(
    stale.question,
    /changed since this Objective froze it .*: autonomy\.allowances\.planningRevisions\./,
  );
  assert.doesNotMatch(stale.question, /pollSeconds|workers/);
  await stopped(first);
  // A second edit while the question is open: adopt never freezes a
  // configuration the question didn't name, and the question is asked again.
  config.autonomy.allowances.perPath = 2;
  // The service has one of the two variables planning requires.
  config.autonomy.requiredEnvironment = ["NEEDED_TOKEN", "SET_TOKEN"];
  config.policy = { allowedSecretNames: ["NEEDED_TOKEN", "SET_TOKEN"] };
  inst.env.SET_TOKEN = "present-value-xyz";
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  const late = cli(inst, "answer", "44", "adopt", "--question", stale.id);
  assert.equal(late.code, 1);
  assert.equal(refusal(late), "stale_question");
  await until(
    () => stateOf(inst, 44).holds.some((open) => open.id !== stale.id),
    "the question asked again",
  );
  const [asked] = stateOf(inst, 44).holds;
  assert.match(
    asked.question,
    /autonomy\.allowances\.perPath, autonomy\.allowances\.planningRevisions, autonomy\.requiredEnvironment, policy\.allowedSecretNames\./,
  );
  assert.equal(stateOf(inst, 44).frozen.digest, before);
  assert.equal(
    cli(inst, "answer", "44", "adopt", "--question", asked.id).code,
    0,
  );
  const state = stateOf(inst, 44);
  assert.notEqual(state.frozen.digest, before);
  assert.equal(state.frozen.config.autonomy.allowances.planningRevisions, 1);
  assert.equal(state.frozen.config.autonomy.allowances.perPath, 2);
  // The check runs on the adopted configuration: it holds the whole
  // Objective, naming only the missing variable, and never a value.
  await until(
    () => stateOf(inst, 44).holds.some((open) => open.step === "check"),
    "the check holds on the missing variable",
  );
  const [missing] = stateOf(inst, 44).holds;
  assert.equal(missing.step, "check");
  assert.equal(missing.item, undefined);
  assert.deepEqual(
    missing.options.map((option) => option.answer),
    ["retry", "cancel"],
  );
  assert.match(missing.question, /needs `NEEDED_TOKEN` set/);
  assert.doesNotMatch(missing.question, /SET_TOKEN|present-value/);
  const dir = join(inst.logs, "44");
  for (const name of readdirSync(dir))
    assert.doesNotMatch(readFileSync(join(dir, name), "utf8"), /present-value/);
  assert.equal(cli(inst, "cancel", "44").code, 0);
  await stopped(service);
});

test("a changed delivery.kind can't be adopted or switched to: the question names cancel and re-queue", async () => {
  const inst = installation();
  const providers = {
    codex: { planner: "codex", worker: { kind: "codex" } },
    claude: { planner: "claude", worker: { kind: "claude" } },
  };
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    { providers, defaultProvider: "codex" },
  );
  seed(inst, 47);
  const before = stateOf(inst, 47).frozen;
  const config = JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));
  config.delivery = { kind: "native-stack" };
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  let service = serve(inst);
  await until(() => stateOf(inst, 47).holds.length > 0, "the question");
  const [asked] = stateOf(inst, 47).holds;
  assert.equal(asked.step, "config");
  assert.deepEqual(
    asked.options.map((option) => option.answer),
    ["retry", "cancel"],
  );
  assert.match(
    asked.question,
    /: delivery\.kind\. Its plan is split for delivery\.kind "regular", so it can't run on "native-stack"\. To deliver it with "native-stack", cancel it and queue it again\./,
  );
  await stopped(service);
  // Its provider is gone too: a switch would freeze native-stack, so the
  // engine refuses it.
  config.providers = { claude: providers.claude };
  config.defaultProvider = "claude";
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  assert.equal(
    cli(inst, "answer", "47", "retry", "--question", asked.id).code,
    0,
  );
  await until(
    () => stateOf(inst, 47).holds.some((open) => open.id !== asked.id),
    "the removed provider's question",
  );
  const [removed] = stateOf(inst, 47).holds;
  assert.ok(removed.options.some((option) => option.answer === "switch"));
  const switched = cli(
    inst,
    "answer",
    "47",
    "switch",
    "claude",
    "--question",
    removed.id,
  );
  assert.equal(switched.code, 1);
  assert.equal(refusal(switched), "invalid_answer");
  assert.match(
    switched.err,
    /`switch claude` would deliver this Objective with delivery\.kind "native-stack", but its plan is split for "regular"/,
  );
  assert.deepEqual(stateOf(inst, 47).frozen, before);
  assert.equal(cli(inst, "cancel", "47").code, 0);
  await stopped(service);
});

test("an execution profile frozen at admission is kept through a config change; a removed one holds with retry", async () => {
  const inst = installation();
  const providers = {
    codex: { planner: "codex", worker: { kind: "codex" } },
    claude: { planner: "claude", worker: { kind: "claude" } },
  };
  const profiles = {
    careful: {
      provider: "claude",
      description: "Delicate changes.",
      instructions: "Keep public signatures unchanged.",
      worktreeRead: true,
    },
  };
  configured(
    inst,
    `http://127.0.0.1:${await closedPort()}`,
    {},
    { providers, defaultProvider: "codex", execution: { profiles } },
  );
  // Its plan runs an item on the profile.
  const plan = {
    items: [
      {
        id: "a",
        title: "Item a",
        ownedPaths: ["src/"],
        executionProfile: { id: "careful", reason: "delicate" },
      },
    ],
  };
  seed(inst, 46, "checking", {
    done: { plan, predecessors: { predecessors: [], ignored: [] } },
  });
  const admitted = stateOf(inst, 46).frozen;
  const careful = () =>
    stateOf(inst, 46).frozen.config.execution.profiles.careful;
  assert.equal(careful().settings.planner, "claude");
  const model = careful().settings.worker.settings.model;
  assert.equal(careful().instructions, "Keep public signatures unchanged.");
  // The profile's provider changes model and its instructions change: the
  // Objective holds and keeps the frozen worker settings and instructions.
  const config = JSON.parse(readFileSync(inst.env.FACTORY_CONFIG, "utf8"));
  config.providers.claude.worker.model = "another-model";
  config.execution.profiles.careful.instructions = "Rename freely.";
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  let service = serve(inst);
  await until(() => stateOf(inst, 46).holds.length > 0, "the question");
  const [changed] = stateOf(inst, 46).holds;
  assert.equal(changed.step, "config");
  assert.match(
    changed.question,
    /execution\.profiles\.careful\.instructions, execution\.profiles\.careful\.settings\.worker\.settings\.model/,
  );
  assert.equal(careful().settings.worker.settings.model, model);
  assert.equal(careful().instructions, "Keep public signatures unchanged.");
  assert.equal(stateOf(inst, 46).frozen.digest, admitted.digest);
  await stopped(service);
  // The profile is gone: only restoring it helps.
  config.providers.claude.worker = { kind: "claude" };
  config.execution = {};
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  // adopt would freeze a configuration without the profile: the question
  // is asked again, and offers only restoring it.
  const late = cli(inst, "answer", "46", "adopt", "--question", changed.id);
  assert.equal(refusal(late), "stale_question");
  await until(
    () => stateOf(inst, 46).holds.some((open) => open.id !== changed.id),
    "the removed profile's question",
  );
  const [removed] = stateOf(inst, 46).holds;
  assert.deepEqual(
    removed.options.map((option) => option.answer),
    ["retry", "cancel"],
  );
  assert.match(removed.question, /execution profile "careful"/);
  await stopped(service);
  // Restored and retried, it runs on the profile it froze.
  config.execution = { profiles };
  writeFileSync(inst.env.FACTORY_CONFIG, JSON.stringify(config));
  service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  assert.equal(
    cli(inst, "answer", "46", "retry", "--question", removed.id).code,
    0,
  );
  await until(
    () => stateOf(inst, 46).done.check || stateOf(inst, 46).retries.check,
    "the check runs",
  );
  assert.ok(stateOf(inst, 46).holds.every((open) => open.step !== "config"));
  assert.deepEqual(stateOf(inst, 46).frozen, admitted);
  assert.equal(cli(inst, "cancel", "46").code, 0);
  await stopped(service);
});

test("a held Objective and one waiting on its paths don't stall the queue", async () => {
  const inst = installation();
  const plan = (paths) => ({
    items: [{ id: "a", ownedPaths: paths, dependencies: [] }],
  });
  const asked = new Date().toISOString();
  // #32 holds while it owns src/; #31 owns src/x.ts and its plan was
  // accepted later (a replan), so the lower issue waits for #32.
  seed(inst, 32, "holding", {
    holds: [
      {
        id: `item:a:work@${asked}`,
        step: "item:a:work",
        item: "a",
        question: "Step item:a:work keeps failing (error: broken).",
        options: offered("retry", "cancel"),
        askedAt: asked,
      },
    ],
    done: { check: {}, plan: plan(["src/"]) },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
  });
  seed(inst, 31, "building", {
    done: { check: {}, plan: plan(["src/x.ts"]) },
    kept: { "plan:acceptedAt": "2026-01-02T00:00:00.000Z" },
  });
  // #33 is checked and needs the only slot (no configuration: one at a time).
  seed(inst, 33, "planning", { done: { check: {} } });
  const service = serve(inst);
  await until(() => stateOf(inst, 33).holds.length, "#33 runs and asks");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const waiting = stateOf(inst, 31);
  assert.deepEqual(waiting.holds, [], "#31 waits on #32's paths");
  assert.deepEqual(waiting.attempts, {});
  assert.equal(stateOf(inst, 32).holds[0].step, "item:a:work");
  await stopped(service);
});

test("an item's question holds only that item and its dependents", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const item = (id, kind, dependencies = []) => ({
    id,
    kind,
    ownedPaths: [],
    dependencies,
    ...(kind === "aggregate" ? { children: [] } : {}),
  });
  const asked = new Date().toISOString();
  // a holds; b is unrelated; c depends on a; d is unrelated and asks too:
  // its kept base is missing from the checkout, so its work keeps failing.
  seed(inst, 61, "holding", {
    kept: { "item:a:base": "0".repeat(40), "item:d:base": "0".repeat(40) },
    holds: [
      {
        id: `item:a:work@${asked}`,
        step: "item:a:work",
        item: "a",
        question: "Which asset set?",
        options: offered("retry", "cancel"),
        askedAt: asked,
      },
    ],
    done: {
      check: { shown: { body: "## Goal\n\nA goal.", blocks: [], spans: [] } },
      plan: {
        items: [
          item("a", "work"),
          item("b", "aggregate"),
          item("c", "aggregate", ["a"]),
          item("d", "work"),
        ],
      },
    },
  });
  let service = serve(inst);
  await until(
    () =>
      stateOf(inst, 61).done["item:b:merge"] &&
      stateOf(inst, 61).holds.length === 2,
    "b finishes and d asks while a holds",
  );
  const both = stateOf(inst, 61);
  assert.equal(both.status, "holding");
  assert.deepEqual(
    both.holds.map((hold) => hold.item),
    ["a", "d"],
  );
  assert.match(both.holds[1].question, /keeps failing/);
  const held = (state) =>
    [
      ...Object.keys(state.done),
      ...Object.keys(state.attempts),
      ...Object.keys(state.retries),
    ].filter((key) => key.startsWith("item:c:"));
  assert.deepEqual(held(both), [], "c waits for a");
  assert.equal(status(inst).objectives[0].holds.length, 2);

  // A bound answer goes to its question; d asks again.
  const [a, d] = both.holds;
  assert.equal(cli(inst, "answer", "61", "retry", "--question", d.id).code, 0);
  await until(
    () => stateOf(inst, 61).holds.some((h) => h.item === "d" && h.id !== d.id),
    "d asks again",
  );
  assert.equal(stateOf(inst, 61).holds[0].id, a.id, "a is still open");
  const stale = cli(inst, "answer", "61", "retry", "--question", d.id);
  assert.equal(stale.code, 1);
  assert.equal(refusal(stale), "stale_question");
  assert.match(stale.err, /isn't open/);

  // With two questions open, a comment must name one: an unbound answer
  // is refused and changes nothing.
  const open = stateOf(inst, 61).holds;
  assert.match(
    await comment(inst, 61, "retry", new Date().toISOString()),
    /names no question, and more than one question is open/,
  );
  assert.deepEqual(stateOf(inst, 61).holds, open);
  assert.equal(cli(inst, "answer", "61", "retry", "--question", a.id).code, 0);
  await until(
    () =>
      stateOf(inst, 61).holds.length === 2 &&
      !stateOf(inst, 61).holds.some((h) => h.id === a.id),
    "a asks again",
  );
  const before = stateOf(inst, 61);
  assert.deepEqual(
    before.holds.map((hold) => hold.item),
    ["d", "a"],
  );

  // Open questions survive a crash.
  service.child.kill("SIGKILL");
  await service.exit;
  service = serve(inst);
  await until(() => status(inst).service === "running", "restart");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(stateOf(inst, 61).holds, before.holds);
  assert.equal(stateOf(inst, 61).status, "holding");
  assert.deepEqual(held(stateOf(inst, 61)), [], "c still waits for a");

  assert.equal(cli(inst, "cancel", "61").code, 0);
  assert.deepEqual(stateOf(inst, 61).holds, []);
  assert.equal(stateOf(inst, 61).status, "cancelled");
  await stopped(service);
});

test("an Objective question from an item step stops every item, once", async () => {
  const inst = installation();
  // A real checkout whose local Git configuration runs a program: Factory
  // refuses to run Git in it, which is about the checkout, not one item.
  const git = (...args) =>
    assert.equal(
      spawnSync("git", args, { encoding: "utf8" }).status,
      0,
      args.join(" "),
    );
  const origin = join(inst.root, "origin.git");
  const checkout = join(inst.root, "checkout");
  git("init", "--quiet", "--bare", "--initial-branch=main", origin);
  git("clone", "--quiet", origin, checkout);
  git(
    "-C",
    checkout,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "base",
  );
  git("-C", checkout, "push", "--quiet", "origin", "HEAD:main");
  githubOrigin(checkout, origin);
  git("-C", checkout, "config", "filter.evil.clean", "cat");
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  const item = (id, kind) => ({
    id,
    ...(kind ? { kind, children: [] } : {}),
    ownedPaths: [],
    dependencies: [],
  });
  const asked = new Date().toISOString();
  seed(inst, 62, "holding", {
    holds: [
      {
        id: `item:a:work@${asked}`,
        step: "item:a:work",
        question: "The checkout refuses Git.",
        options: offered("retry", "cancel"),
        askedAt: asked,
      },
    ],
    done: {
      check: { shown: { body: "## Goal\n\nA goal.", blocks: [], spans: [] } },
      plan: { items: [item("a"), item("e"), item("c", "aggregate")] },
    },
  });
  const service = serve(inst);
  await until(() => status(inst).service === "running", "service");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const quiet = stateOf(inst, 62);
  assert.deepEqual(
    quiet.attempts,
    {},
    "an Objective question stops every step",
  );
  assert.equal(quiet.done["item:c:merge"], undefined);

  // Answered, every item starts; the work steps meet the refusal, and it
  // is asked once, about the Objective.
  assert.equal(
    cli(inst, "answer", "62", "retry", "--question", quiet.holds[0].id).code,
    0,
  );
  const settled = () => {
    const state = stateOf(inst, 62);
    return (
      state.done["item:c:merge"] &&
      state.holds.length === 1 &&
      state.holds[0].id !== quiet.holds[0].id &&
      Object.keys(state.attempts).length === 0
    );
  };
  await until(settled, "the refusal asked again");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(settled(), "asked once");
  const state = stateOf(inst, 62);
  const [refused] = state.holds;
  assert.match(refused.question, /filter\.evil\.clean/);
  assert.equal(refused.item, undefined, "an Objective question");
  const other = refused.step === "item:a:work" ? "item:e:work" : "item:a:work";
  assert.equal(state.done[other], undefined, "the other item waits");
  assert.equal(state.retries[other], undefined, "and asks after the answer");
  assert.equal(cli(inst, "cancel", "62").code, 0);
  await stopped(service);
});

test("a Codex worker's login or quota hold on one item stops every item, once", async () => {
  const { ObjectiveRunner } = await import("../dist/engine.js");
  const { codexFailure } = await import("../dist/providers/codex.js");
  const { providerOutcome } = await import("../dist/providers/planner.js");
  const { newObjective } = await import("../dist/state.js");
  // The messages a failed Codex turn reports (codex.ts codexFailure), as
  // the Codex worker maps them (codex-worker.ts outcome).
  for (const failure of [
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    "Quota exceeded. Check your plan and billing details.",
  ]) {
    const started = [];
    const step = (key) => ({
      key,
      deadlineMs: 60_000,
      run: async () => {
        started.push(key);
        return { kind: "done" };
      },
    });
    const runner = new ObjectiveRunner(
      newObjective(1, new Date()),
      {
        steps: () => [step("item:a:work"), step("item:b:work")],
        status: () => "building",
      },
      mkdtempSync(join(tmpdir(), "factory-scope-")),
      { write() {} },
      { id: "run", finished: 0, resumeAt: 0 },
    );
    const held = providerOutcome(codexFailure(failure));
    runner.apply("item:a:work", held);
    assert.equal(runner.state.holds.length, 1, failure);
    assert.equal(runner.state.holds[0].item, undefined, "an Objective hold");
    runner.tick();
    assert.deepEqual(started, [], "item b waits too");
    // b, already running, meets the same failure: still one question.
    runner.apply("item:b:work", held);
    assert.equal(runner.state.holds.length, 1);
  }
});

test("a deferred question asks right after the covering one; stack layers and bare retries respect item holds", async () => {
  const { ObjectiveRunner, hold, objectiveWide } = await import(
    "../dist/engine.js"
  );
  const { newObjective } = await import("../dist/state.js");
  const keys = ["item:a:work", "item:b:ci", "item:c:work", "item:d:ci"];
  const started = [];
  const outcomes = {};
  // No repair allowed on any path, on either provider.
  const config = { autonomy: { allowances: { perPath: 0 } } };
  const runner = new ObjectiveRunner(
    newObjective(1, new Date(), {
      provider: "codex",
      selectedBy: "defaultProvider",
      digest: "x",
      config,
    }),
    {
      steps: (state) =>
        keys
          .filter((key) => !state.done[key])
          .map((key) => ({
            key,
            deadlineMs: 60_000,
            run: async () => {
              started.push(key);
              return outcomes[key] ?? { kind: "done" };
            },
          })),
      status: () => "building",
      // b is the native-stack layer above a.
      upstream: (_, item) => (item === "b" ? ["a"] : []),
      freezable: { claude: { digest: "c", config } },
      // c keeps a refused result it can check again.
      revalidatable: (_, key) => key === "item:c:work",
    },
    mkdtempSync(join(tmpdir(), "factory-defer-")),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
  );
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const due = (key) =>
    Date.parse(runner.state.retries[key].nextAt) <= Date.now();

  // a's question stops a and the layer above it; d goes on, and backs off.
  runner.apply("item:a:work", hold("Which asset set?"));
  outcomes["item:d:ci"] = {
    kind: "retry",
    reason: "GitHub 502",
    afterMs: 3_600_000,
  };
  runner.tick();
  await settle();
  assert.ok(!started.includes("item:b:ci"), "b waits on the layer below");
  assert.ok(started.includes("item:d:ci"));
  assert.ok(!due("item:d:ci"));
  // A bare retry cuts d's backoff and answers nothing.
  assert.equal(
    runner.transact(() => runner.retryNow("op")),
    null,
  );
  assert.ok(due("item:d:ci"));
  assert.equal(runner.state.holds.length, 1);

  // An Objective question is open: a bare retry is refused.
  runner.apply(
    "final",
    objectiveWide(hold("Issue closed?", ["switch", "cancel"])),
  );
  assert.match(
    runner.transact(() => runner.retryNow("op")).message,
    /stops every step/,
  );
  // d meets a limit 5 h away, and c a repair over budget: neither is
  // asked now, and neither waits past the covering answer.
  runner.apply("item:d:ci", {
    kind: "retry",
    reason: "usage limit",
    wait: {
      kind: "reset",
      at: new Date(Date.now() + 5 * 3_600_000).toISOString(),
      provider: "codex",
    },
  });
  runner.apply("item:c:ci", {
    kind: "repair",
    finding: "still failing",
    target: "item:c:work",
    clear: ["item:c:work", "item:c:ci"],
  });
  assert.equal(runner.state.holds.length, 2);
  assert.ok(due("item:d:ci"), "d runs right after the answer");
  // c's earlier limit retry is still on record: `switch` drops it, not the question.
  runner.state.retries["item:c:work"] = {
    count: 0,
    attempts: 1,
    since: new Date().toISOString(),
    nextAt: new Date().toISOString(),
    lastError: "usage limit",
    wait: { kind: "reset", provider: "codex" },
  };
  const final = runner.state.holds.find((h) => h.step === "final");
  assert.equal(
    runner.transact(() =>
      runner.answer("switch", "claude", "op", undefined, final.id),
    ),
    null,
  );
  assert.ok(!runner.state.retries["item:c:work"]);
  assert.equal(runner.state.repairs["item:c:work"].count, 1);
  const ran = started.length;
  outcomes["item:d:ci"] = undefined;
  runner.tick();
  await settle();
  const asked = runner.state.holds.find((h) => h.step === "item:c:work");
  assert.match(
    asked?.question ?? "",
    /item:c:work needs another repair, past its repair path's 0 .*still fails:\n\nstill failing/s,
  );
  assert.equal(asked.cause, "failure");
  assert.deepEqual(
    asked.options.map((option) => option.answer),
    ["more", "revalidate", "cancel"],
  );
  assert.ok(
    !started.slice(ran).includes("item:c:work"),
    "c asks before it runs again",
  );
  assert.ok(started.slice(ran).includes("item:d:ci"), "d ran at once");
  // `more` is the engine's: it grants as much again (one, at least) and
  // c runs its repair, never seeing the answer.
  assert.equal(
    runner.transact(() =>
      runner.answer("more", undefined, "op", undefined, asked.id),
    ),
    null,
  );
  assert.equal(runner.state.answers["item:c:work"], undefined);
  assert.deepEqual(runner.state.kept["allowances:granted"], {
    "perPath:item:c:work": 1,
  });
  runner.tick();
  await settle();
  assert.ok(started.slice(ran).includes("item:c:work"), "c repairs");
  // An interrupted attempt passed the check when it started: it runs
  // again at once, even past the allowance, and asks nothing.
  runner.state.repairs["item:c:work"].count = 5;
  delete runner.state.done["item:c:work"];
  runner.state.attempts["item:c:work"] = {
    startedAt: new Date().toISOString(),
    run: "earlier",
  };
  const holds = runner.state.holds.length;
  const before = started.length;
  runner.tick();
  await settle();
  assert.equal(
    started.slice(before).filter((k) => k === "item:c:work").length,
    1,
  );
  assert.equal(runner.state.holds.length, holds);
  // Each `revalidate` is charged when it lands, against the live state:
  // past resultRereviews (1) the step asks instead, and that `more`
  // grants as much again and revalidates.
  const rereview = () => {
    runner.apply(
      "item:b:ci",
      hold("Diagnosis needs you.", [
        { answer: "revalidate", family: "accept", consequence: "Again." },
        "cancel",
      ]),
    );
    const open = runner.state.holds.find((h) => h.step === "item:b:ci");
    return runner.transact(() =>
      runner.answer("revalidate", undefined, "op", undefined, open.id),
    );
  };
  assert.equal(rereview(), null);
  assert.equal(runner.state.answers["item:b:ci"].answer, "revalidate");
  assert.equal(runner.state.kept["allowances:rereviews"], 1);
  delete runner.state.answers["item:b:ci"];
  assert.equal(rereview(), null);
  assert.equal(runner.state.answers["item:b:ci"], undefined, "not recorded");
  const spent = runner.state.holds.find((h) => h.step === "item:b:ci");
  assert.match(spent.question, /used its 1 result rereview/);
  assert.equal(spent.cause, "failure");
  assert.equal(
    runner.transact(() =>
      runner.answer("more", undefined, "op", undefined, spent.id),
    ),
    null,
  );
  assert.equal(runner.state.answers["item:b:ci"].answer, "revalidate");
  assert.equal(runner.state.kept["allowances:rereviews"], 2);
  // c's failure blamed on a (repair.ts `predecessor`): a's repair counts,
  // and c's blamed repair is free, once however often the outcome lands.
  const { perPath } = await import("../dist/allowances.js");
  const charged = perPath(runner.state)["item:c:work"].used;
  const blame = {
    kind: "repair",
    finding: "a's result breaks c",
    target: "item:a:work",
    clear: ["item:a:work"],
    free: {
      target: "item:c:work",
      repair: runner.state.repairs["item:c:work"].count,
    },
  };
  runner.apply("item:c:work", blame);
  runner.apply("item:c:work", blame);
  assert.equal(perPath(runner.state)["item:c:work"].used, charged - 1);
  assert.equal(perPath(runner.state)["item:a:work"].used, 2);
});

test("a replan answer is the workflow's, spent once applied, and the new plan starts with a fresh repair budget", async () => {
  const { ObjectiveRunner, failure } = await import("../dist/engine.js");
  const { newObjective } = await import("../dist/state.js");
  const order = ["check", "plan", "item:api:work", "final"];
  const seen = [];
  const state = newObjective(1, new Date());
  // The old plan spent item api's budget, and an earlier replan's history is on check.
  state.repairs = {
    "item:api:work": { count: 3, findings: ["old finding"] },
    check: { count: 3, findings: ["The operator asked to replan."] },
  };
  const runner = new ObjectiveRunner(
    state,
    {
      steps: (current) => {
        const key = order.find((k) => !current.done[k]);
        if (!key) return [];
        return [
          {
            key,
            deadlineMs: 60_000,
            run: async ({ answer }) => {
              if (key !== "final") return { kind: "done" };
              seen.push(answer?.answer);
              return failure("Final validation failed.");
            },
          },
        ];
      },
      status: () => "building",
      replannable: (_, key) => key === "final",
      // As work/steps.ts replanOutcome answers `replan` after acceptance.
      replan: (current) => ({
        kind: "repair",
        finding: "The operator asked to replan.",
        target: "check",
        clear: Object.keys(current.done),
      }),
    },
    mkdtempSync(join(tmpdir(), "factory-replan-")),
    { write() {} },
    { id: "run", finished: 0, resumeAt: 0 },
  );
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      runner.tick();
      await new Promise((r) => setImmediate(r));
    }
  };
  await settle();
  const [asked] = runner.state.holds;
  assert.equal(asked?.step, "final");
  assert.equal(asked.cause, "failure");
  assert.deepEqual(
    asked.options.map((option) => option.answer),
    ["retry", "replan", "cancel"],
  );
  assert.equal(
    runner.transact(() =>
      runner.answer("replan", undefined, "op", undefined, asked.id),
    ),
    null,
  );
  await settle();
  assert.deepEqual(seen, [undefined, undefined], "the step never sees replan");
  assert.equal(runner.state.answers.final, undefined, "the answer is spent");
  assert.deepEqual(runner.state.repairs, {}, "the budget starts afresh");
  const [again] = runner.state.holds;
  assert.equal(again?.question, "Final validation failed.");
});

test("a new wait class starts its own budget and ends a run of errors", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  // Eight hours on a human gate, after two errors: then GitHub is down.
  const long = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  seed(inst, 23, "checking", {
    retries: {
      check: {
        count: 2,
        attempts: 9,
        since: long,
        nextAt: long,
        lastError: "Waiting on a required review",
        cause: "Waiting on a required review",
        wait: { kind: "gate", gate: "a required review" },
      },
    },
  });
  const service = serve(inst);
  await until(
    () =>
      !stateOf(inst, 23).retries.check?.wait &&
      stateOf(inst, 23).retries.check?.attempts >= 2,
    "transient retries",
  );
  const { holds, retries } = stateOf(inst, 23);
  assert.deepEqual(holds, [], "the gate's hours aren't the transient budget");
  assert.equal(retries.check.wait, undefined);
  assert.equal(retries.check.count, 0, "a wait ends the run of errors");
  assert.ok(Date.parse(retries.check.since) > Date.parse(long) + 60_000);
  assert.match(retries.check.cause, /GitHub GET/);
  assert.equal(cli(inst, "cancel", "23").code, 0);
  await stopped(service);
});

test("an open question pauses other steps' wait clocks", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  // Five hours on a question, while check's transient wait (due then)
  // could not run: those hours are not check's, so no 3 h question.
  const asked = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  seed(inst, 24, "holding", {
    holds: [
      {
        id: `plan@${asked}`,
        step: "plan",
        question: "A question",
        options: offered("retry", "cancel"),
        askedAt: asked,
      },
    ],
    retries: {
      check: {
        count: 0,
        attempts: 1,
        since: asked,
        nextAt: asked,
        lastError: "GitHub GET: down",
        cause: "GitHub GET: down",
      },
    },
  });
  assert.equal(
    cli(inst, "answer", "24", "retry", "--question", `plan@${asked}`).code,
    0,
  );
  const service = serve(inst);
  await until(
    () => stateOf(inst, 24).retries.check?.attempts >= 3,
    "check retries after the answer",
  );
  const { holds, retries } = stateOf(inst, 24);
  assert.deepEqual(holds, [], "the question's hours aren't check's budget");
  assert.ok(Date.parse(retries.check.since) > Date.now() - 60_000);
  assert.equal(cli(inst, "cancel", "24").code, 0);
  await stopped(service);

  // An item's question stops only its item: another item's wait clock
  // runs on, so its five hours count, and it asks. Both wait to publish.
  const scoped = installation();
  configured(scoped, `http://127.0.0.1:${await closedPort()}`);
  const waited = {
    count: 0,
    attempts: 1,
    since: asked,
    nextAt: asked,
    lastError: "GitHub GET: down",
    cause: "GitHub GET: down",
  };
  seed(scoped, 25, "holding", {
    holds: [
      {
        id: `item:a:publish@${asked}`,
        step: "item:a:publish",
        item: "a",
        question: "A question",
        options: offered("retry", "cancel"),
        askedAt: asked,
      },
    ],
    done: {
      check: {},
      plan: {
        items: ["a", "b"].map((item) => ({
          id: item,
          ownedPaths: [`src/${item}.ts`],
          dependencies: [],
        })),
      },
      ...Object.fromEntries(
        ["a", "b"].flatMap((item) =>
          ["work", "validate", "review"].map((phase) => [
            `item:${item}:${phase}`,
            {},
          ]),
        ),
      ),
    },
    kept: { "plan:acceptedAt": "2026-01-01T00:00:00.000Z" },
    retries: { "item:b:publish": waited },
  });
  const answered = cli(
    scoped,
    "answer",
    "25",
    "retry",
    "--question",
    `item:a:publish@${asked}`,
  );
  assert.equal(answered.code, 0);
  const again = serve(scoped);
  await until(
    () => stateOf(scoped, 25).holds.some((h) => h.step === "item:b:publish"),
    "b's wait asks",
  );
  const [question] = stateOf(scoped, 25).holds;
  assert.equal(question.step, "item:b:publish");
  assert.equal(question.item, "b");
  assert.match(question.question, /has been retrying since/);
  assert.equal(
    stateOf(scoped, 25).retries["item:b:publish"].since,
    asked,
    "a's question didn't pause b's clock",
  );
  assert.equal(cli(scoped, "cancel", "25").code, 0);
  await stopped(again);
});

test("a wait on a human gate takes no slot", async () => {
  const inst = installation();
  const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  // #41 started first and waits on a review; #42 needs the only slot.
  seed(inst, 41, "building", {
    done: { check: {}, plan: { items: [] } },
    retries: {
      build: {
        count: 0,
        attempts: 1,
        since: new Date().toISOString(),
        nextAt: later,
        lastError: "Waiting on a required review on PR #1",
        wait: { kind: "gate", gate: "a required review on PR #1" },
      },
    },
  });
  seed(inst, 42, "planning", { done: { check: {} } });
  const service = serve(inst);
  await until(() => stateOf(inst, 42).holds.length, "#42 runs and asks");
  assert.deepEqual(stateOf(inst, 41).holds, [], "#41 still waits on its gate");
  await stopped(service);
});

test("a planner's can't-be-planned answer holds once with replan and cancel, and plans no round on its own", async () => {
  const inst = installation();
  configured(inst, `http://127.0.0.1:${await closedPort()}`);
  // The round the plan step saves for that answer (planning/steps.ts).
  const reason =
    "Acceptance requires changing src/config.ts; the constraints forbid touching src/, and nothing outside it can change the behaviour.";
  seed(inst, 71, "planning", {
    done: {
      predecessors: { predecessors: [], ignored: [] },
      check: { shown: { body: "## Goal\n\nA goal.", blocks: [], spans: [] } },
      "plan:1:1": {
        cannot: { reason, change: "Allow changes under src/." },
      },
    },
  });
  const service = serve(inst);
  await until(
    () => stateOf(inst, 71).holds.length,
    "the planner's reason asks",
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const state = stateOf(inst, 71);
  assert.equal(state.holds.length, 1);
  const [held] = state.holds;
  assert.equal(held.step, "decide:1:1");
  assert.ok(held.question.includes(reason));
  assert.match(held.question, /What would have to change: Allow changes/);
  assert.deepEqual(
    held.options.map((option) => option.answer),
    ["replan", "answer", "cancel"],
  );
  assert.deepEqual(
    Object.keys(state.done).filter((key) => /^(plan|review|decide):/.test(key)),
    ["plan:1:1"],
    "no review and no next round",
  );
  // `replan` starts a new generation, which re-reads the issue first.
  assert.equal(
    cli(inst, "answer", "71", "replan", "--question", held.id).code,
    0,
  );
  await until(
    () => stateOf(inst, 71).retries["plan:2:1"],
    "the new generation reads the issue",
  );
  assert.equal(stateOf(inst, 71).done["decide:1:1"].replan, true);
  await stopped(service);
  const log = readdirSync(join(inst.logs, "71"))
    .map((file) => readFileSync(join(inst.logs, "71", file), "utf8"))
    .join("");
  assert.doesNotMatch(log, /"model-usage"/, "no planner call");
});
