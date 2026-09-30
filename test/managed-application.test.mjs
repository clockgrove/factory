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

for (const delivery of ["regular", "native-stack"])
  test(`${delivery} runs managed exact bytes through independent validation and ordinary delivery`, async () => {
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
            bytes = readFileSync(join(remote, "outputs", "factory-result.tar"));
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
