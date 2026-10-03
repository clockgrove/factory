import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import {
  createTarget,
  factoryConfig,
  readEvents,
  writeDescriptor,
} from "./support/integration-fixture.mjs";

// A regular delivery interrupted at publication or merge resumes on restart:
// the step is repeated, so each item still gets exactly one PR and one merge,
// its worker and result review are not repeated, and a concurrent peer item
// is unaffected wherever it was when the controller died.

const run = promisify(execFile);
const controller = join(import.meta.dirname, "support", "crash-controller.mjs");
const objective = 1;

function item(id, validation) {
  return {
    id,
    title: `Implement ${id}`,
    goal: `Create ${id}.txt`,
    acceptance: [`${id}.txt has the scripted result`],
    nonGoals: ["No deployment"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
    dependencies: [],
    ownedPaths: [`${id}.txt`],
    resources: [],
    validation: [
      {
        command: validation,
        provenance: "source-declared",
        source: "OBJECTIVE",
      },
    ],
    brief: `Make only the ${id} fixture change.`,
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
}

// Where the independent peer item is held while "work" is delivered:
// not present, inside its worker, or inside its validation command.
async function interrupt(boundary, peer) {
  const root = mkdtempSync(join(tmpdir(), `factory-interrupt-`));
  try {
    const target = createTarget(root);
    const barrier = join(root, "peer-barrier");
    const check = (id) => `test "$(cat ${id}.txt)" = ${id}`;
    const peerCheck =
      peer === "validate"
        ? `while [ ! -e ${barrier} ]; do sleep 0.05; done; ${check("peer")}`
        : check("peer");
    const items = [item("work", check("work"))];
    const commands = [check("work")];
    if (peer) {
      items.push(item("peer", peerCheck));
      commands.push(peerCheck);
    }
    const finalCommands = peer
      ? [check("work"), check("peer")]
      : [check("work")];
    const fakeRoot = join(root, "fake");
    const repository = `example/interrupt-${boundary.method}-${boundary.when}-${peer ?? "none"}`;
    const descriptor = {
      config: factoryConfig(target.checkout, repository),
      graph: { objective, baseSha: target.baseSha, items },
      objectiveBody: `# Deterministic Objective\n\n## Acceptance\n${commands.map((c) => `- \`${c}\``).join("\n")}\n\n## Final validation\n${finalCommands.map((c) => `- \`${c}\``).join("\n")}\n`,
      fakeRoot,
      actions: {
        work: { files: [{ path: "work.txt", text: "work\n" }] },
        peer: {
          files: [{ path: "peer.txt", text: "peer\n" }],
          ...(peer === "execute" ? { barrier } : {}),
        },
      },
    };
    const env = { ...process.env, XDG_STATE_HOME: join(root, "state") };
    const descriptorPath = join(root, "descriptor.json");
    const invoke = async () => {
      const { stdout } = await run(
        process.execPath,
        [controller, descriptorPath, String(objective)],
        { env, cwd: join(import.meta.dirname, ".."), timeout: 120_000 },
      );
      return JSON.parse(stdout.trim().split("\n").at(-1));
    };
    // The peer is held, so the first publish or merge belongs to "work".
    writeDescriptor(descriptorPath, {
      ...descriptor,
      crashAt: { target: "github", ...boundary },
    });
    const crashed = await invoke().then(
      (result) => ({ result }),
      (error) => ({ signal: error.signal }),
    );
    assert.equal(
      crashed.signal,
      "SIGKILL",
      `boundary was never reached: ${JSON.stringify(crashed.result)}`,
    );
    const remote = JSON.parse(
      readFileSync(join(fakeRoot, "github.json"), "utf8"),
    );
    const before = {
      pullRequests: Object.values(remote.pullRequests).map(
        (pull) => pull.branch,
      ),
      merged: Object.values(remote.pullRequests).filter(
        (pull) => pull.state === "merged",
      ).length,
    };
    // Release the peer. A validation command the dead controller started
    // keeps running until then; restart only once it has exited, as an
    // operator would after the old process tree is gone.
    writeFileSync(barrier, "released\n");
    const snapshot = JSON.parse(
      readFileSync(
        join(
          root,
          "state",
          "clockgrove-factory",
          "repositories",
          repository,
          "objectives",
          String(objective),
          "state.json",
        ),
        "utf8",
      ),
    );
    for (const { pid } of snapshot.coordinator?.processes ?? [])
      while (alive(pid))
        await new Promise((resolve) => setTimeout(resolve, 20));
    writeDescriptor(descriptorPath, descriptor);
    const result = await invoke();
    const starts = readEvents(join(fakeRoot, "harness.ndjson")).filter(
      (event) => event.type === "start",
    );
    const reviews = readEvents(join(fakeRoot, "planning.ndjson")).filter(
      (event) => event.type === "result-review",
    );
    const github = JSON.parse(
      readFileSync(join(fakeRoot, "github.json"), "utf8"),
    );
    const perItem = (id) => ({
      workers: starts.filter((event) => event.item === id).length,
      reviews: reviews.filter((event) =>
        event.criteria.includes(`${id}.txt has the scripted result`),
      ).length,
      pullRequests: Object.values(github.pullRequests).filter(
        (pull) => pull.branch === `factory/objective-${objective}/${id}`,
      ).length,
      merges: github.events.filter(
        (event) =>
          event.type === "merge" &&
          github.pullRequests[event.number].branch ===
            `factory/objective-${objective}/${id}`,
      ).length,
    });
    return {
      before,
      result,
      work: perItem("work"),
      ...(peer ? { peer: perItem("peer") } : {}),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function alive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

const once = { workers: 1, reviews: 1, pullRequests: 1, merges: 1 };
// What GitHub holds at each boundary when the controller dies.
const boundaries = [
  { method: "publish", when: "before", pullRequests: [], merged: 0 },
  { method: "publish", when: "after", pullRequests: ["work"], merged: 0 },
  { method: "merge", when: "before", pullRequests: ["work"], merged: 0 },
  { method: "merge", when: "after", pullRequests: ["work"], merged: 1 },
];

describe("interrupted regular delivery resumes", { concurrency: 6 }, () => {
  for (const { method, when, pullRequests, merged } of boundaries)
    for (const peer of [undefined, "execute", "validate"]) {
      const known = method === "merge" ? "PR known" : "PR not recorded";
      test(`crash ${when} ${method} (${known}, peer: ${peer ?? "none"})`, async () => {
        const outcome = await interrupt({ method, when }, peer);
        assert.deepEqual(outcome.before, {
          pullRequests: pullRequests.map(
            (id) => `factory/objective-${objective}/${id}`,
          ),
          merged,
        });
        assert.equal(
          outcome.result.outcome,
          "completed",
          JSON.stringify(outcome.result),
        );
        assert.equal(outcome.result.finalValidation, true);
        assert.equal(outcome.result.objectiveClosed, true);
        assert.equal(outcome.result.pullRequests, peer ? 2 : 1);
        assert.equal(outcome.result.mergeEvents, peer ? 2 : 1);
        assert.deepEqual(outcome.work, once);
        if (peer) assert.deepEqual(outcome.peer, once);
      });
    }
});
