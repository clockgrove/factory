import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  createTarget,
  factoryConfig,
  makeApplication,
  git,
} from "./support/integration-fixture.mjs";
import { OpenAIManagedExecutionDriver } from "../dist/execution/openai-managed.js";
import { LocalContentStore } from "../dist/content/local.js";
import { readState } from "../dist/state-store.js";
import { attachFault } from "../dist/fault.js";

for (const delivery of ["regular", "native-stack"])
  for (const outcome of ["complete", "lost-input"])
    test(`${delivery} managed ${outcome} preserves exact delivery and retry authority`, async () => {
      const root = mkdtempSync(join(tmpdir(), "factory-managed-app-"));
      const old = process.env.XDG_STATE_HOME;
      process.env.XDG_STATE_HOME = join(root, "state");
      try {
        const target = createTarget(root);
        const repository = `example/managed-${delivery}`;
        const cfg = factoryConfig(target.checkout, repository, delivery, 1);
        cfg.execution = {
          kind: "managed-agent",
          provider: "openai-agents",
          concurrency: 1,
          config: {
            model: "explicit-fixture-model",
            reasoningEffort: "low",
            containerSize: "small",
            apiKeyEnv: "FACTORY_UNUSED_TEST_KEY",
            timeoutSeconds: 10,
          },
        };
        cfg.policy.network = "off";
        cfg.policy.allowedSecretNames = [];
        const command = "test -s managed.txt";
        const item = {
          id: "managed",
          title: "Managed work",
          goal: "Write managed.txt",
          acceptance: ["managed.txt has the result"],
          nonGoals: ["No deployment"],
          citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
          dependencies: [],
          resources: [],
          ownedPaths: ["managed.txt"],
          validation: [
            { command, provenance: "source-declared", source: "OBJECTIVE" },
          ],
          brief: "Write managed.txt",
          sourceAssets: [],
          expectedOutputRoles: [],
          minimumAssetSets: 0,
          requiredLfsRoles: [],
        };
        const graph = { objective: 1, baseSha: target.baseSha, items: [item] };
        const remote = join(root, "hosted");
        mkdirSync(remote);
        let deleted = false;
        let bytes;
        let identity;
        let submissions = 0;
        const transport = {
          async json(method, path, body) {
            if (method === "POST" && path === "/agents/sessions") {
              identity = body.metadata.factory_attempt;
              const state = readState(repository, 1);
              assert.equal(
                state.work.managed.execution.data.phase,
                "create-submitted",
              );
              for (const file of body.environment.files) {
                const location = file.path.replace("/workspace", remote);
                mkdirSync(dirname(location), { recursive: true });
                writeFileSync(location, Buffer.from(file.data, "base64"));
              }
              for (const setup of body.environment.setup_commands)
                execFileSync("bash", [
                  "-c",
                  setup.command.replaceAll("/workspace", remote),
                ]);
              return {
                id: "session_fixture",
                environment: { id: "environment_fixture" },
              };
            }
            if (path === "/agents/environments/environment_fixture")
              return deleted ? null : { status: "connected" };
            if (method === "POST" && path.endsWith("/events")) {
              assert.equal(
                readState(repository, 1).work.managed.execution.data.phase,
                "input-submitted",
              );
              submissions++;
              assert.equal(body.events[0].input[0].role, "user");
              writeFileSync(
                join(remote, "repo", "managed.txt"),
                "managed bytes\n",
              );
              const script = readFileSync(
                join(remote, "factory-export.py"),
                "utf8",
              ).replaceAll("/workspace", remote);
              execFileSync("python3", ["-c", script]);
              bytes = readFileSync(
                join(remote, "outputs", "factory-result.tar"),
              );
              // The provider accepted the input but its response was lost.
              if (outcome === "lost-input")
                throw Object.assign(
                  new Error("Managed input acknowledgement was lost"),
                  { status: 503 },
                );
              return {};
            }
            if (method === "DELETE") {
              deleted = true;
              return {};
            }
            if (path.includes("/turns?"))
              return {
                data: [
                  {
                    id: "turn_fixture",
                    session_id: "session_fixture",
                    subagent_id: null,
                    status: "completed",
                    usage: null,
                  },
                ],
                has_more: false,
              };
            if (path.includes("/artifacts?"))
              return {
                data: [
                  {
                    id: "artifact_fixture",
                    session_id: "session_fixture",
                    environment_id: "environment_fixture",
                    turn_id: "turn_fixture",
                    path: "/workspace/outputs/factory-result.tar",
                    size_bytes: bytes.length,
                  },
                ],
                has_more: false,
              };
            if (path === "/agents/sessions/session_fixture")
              return { status: "idle" };
            throw new Error(`${method} ${path}`);
          },
          async content() {
            return new Response(bytes);
          },
        };
        const driver = new OpenAIManagedExecutionDriver({
          checkout: target.checkout,
          workRoot: join(root, "managed"),
          contentStore: new LocalContentStore(join(root, "content")),
          config: cfg.execution.config,
          transport,
        });
        const { application } = makeApplication({
          config: cfg,
          graph,
          objectiveBody: `## Acceptance\n- \`${command}\`\n\n## Final validation\n- \`${command}\`\n`,
          fakeRoot: join(root, "github"),
          actions: {},
          driver,
        });
        // A lost input response repeats the step, which reattaches to the
        // same session and finds the recorded turn instead of resubmitting.
        const state = await application.runObjective(1);
        assert.equal(state.work.managed.status, "done");
        assert.equal(state.finalValidation.passed, true);
        assert.equal(submissions, 1);
        assert.ok(identity);
        assert.equal(deleted, true);
        assert.equal(
          git(target.checkout, "show", `${state.integratedSha}:managed.txt`),
          "managed bytes",
        );
      } finally {
        if (old === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = old;
        rmSync(root, { recursive: true, force: true });
      }
    });

for (const delivery of ["regular", "native-stack"])
  test(`${delivery} reattach keeps the coding slot and failure cleanup cancels an unsettled worker`, async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-managed-sweep-"));
    const old = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      const target = createTarget(root);
      const repository = `example/managed-sweep-${delivery}`;
      const cfg = factoryConfig(target.checkout, repository, delivery, 1);
      cfg.execution = {
        kind: "managed-agent",
        provider: "openai-agents",
        concurrency: 1,
        config: {
          model: "explicit-fixture-model",
          reasoningEffort: "low",
          containerSize: "small",
          apiKeyEnv: "FACTORY_UNUSED_TEST_KEY",
          timeoutSeconds: 10,
        },
      };
      cfg.policy.network = "off";
      cfg.policy.allowedSecretNames = [];
      const command = "test -s managed.txt";
      const item = {
        id: "managed",
        title: "Managed work",
        goal: "Write managed.txt",
        acceptance: ["managed.txt has the result"],
        nonGoals: ["No deployment"],
        citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
        dependencies: [],
        resources: [],
        ownedPaths: ["managed.txt"],
        validation: [
          { command, provenance: "source-declared", source: "OBJECTIVE" },
        ],
        brief: "Write managed.txt",
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
      };
      const calls = [];
      const reservations = [];
      // A remote worker whose outcome stays unresolved: it reports "failed"
      // with interrupted set, but its resources are still live.
      const driver = {
        async availableSlots() {
          return "unknown";
        },
        async start(request, context) {
          calls.push("start");
          const handle = {
            provider: "stub",
            identity: request.attemptId,
            data: { live: true },
          };
          context.checkpoint(handle);
          return handle;
        },
        async find(handle) {
          return handle;
        },
        async cancelUnrecorded() {},
        async observe() {
          calls.push("observe");
          return { state: "failed", interrupted: true, detail: "unresolved" };
        },
        async cancel() {
          calls.push("cancel");
        },
        async collect() {
          calls.push("collect");
          const work = readState(repository, 1).work.managed;
          reservations.push([work.phaseReservation, work.requestedPhase]);
          // As the driver classifies a lost response.
          if (reservations.length === 1)
            throw attachFault(new Error("provider response lost"), {
              kind: "transient",
              detail: "provider response lost",
              outcomeUnknown: false,
            });
          throw new Error("remote worker failed");
        },
      };
      const { application } = makeApplication({
        config: cfg,
        graph: { objective: 1, baseSha: target.baseSha, items: [item] },
        objectiveBody: `## Acceptance\n- \`${command}\`\n\n## Final validation\n- \`${command}\`\n`,
        fakeRoot: join(root, "github"),
        actions: {},
        driver,
      });
      await assert.rejects(application.runObjective(1), /remote worker failed/);
      // The interrupted step reattached instead of starting a second worker,
      // and held its coding slot while the remote worker ran.
      assert.equal(calls.filter((c) => c === "start").length, 1);
      assert.deepEqual(reservations, [
        ["coding", undefined],
        ["coding", undefined],
      ]);
      // The failed run's cleanup cancelled the unsettled worker.
      assert.ok(calls.includes("cancel"));
      assert.equal(
        readState(repository, 1).coordinator?.cancelError,
        undefined,
      );
    } finally {
      if (old === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = old;
      rmSync(root, { recursive: true, force: true });
    }
  });
