// Isolated even when run with a bare `node --test`, not only via npm test.
import "./isolate-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderResultReviewCall } from "../dist/compiler/model.js";
import { prepareCompilationRequest } from "../dist/compiler/planning.js";
import { graphDigest } from "../dist/graph-amendments.js";
import { LocalContentStore } from "../dist/content/local.js";
import { addWorktree, removeWorktree } from "../dist/process.js";
import { reviewAcceptance } from "../dist/result-review.js";
import { finalizeObjective } from "../dist/runner/finalization.js";
import { validateCheckout, validateTree } from "../dist/validation.js";

test("final review receives actual fresh integrated checkout provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-final-provenance-"));
  const checkout = join(root, "target");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Integration");
    git("config", "user.email", "integration@example.invalid");
    writeFileSync(join(checkout, ".gitignore"), "node_modules/\n");
    writeFileSync(
      join(checkout, "README.md"),
      "# Contract\nValidate the integrated candidate in a fresh checkout.\n",
    );
    git("add", ".");
    git("commit", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
    git("checkout", "-b", "implementation");
    writeFileSync(join(checkout, "result.txt"), "reviewed result\n");
    git("add", ".");
    git("commit", "-m", "result");
    git("checkout", "main");
    git("merge", "--no-ff", "implementation", "-m", "integrate");
    const commit = git("rev-parse", "HEAD");
    const treeSha = git("rev-parse", "HEAD^{tree}");
    const validationRoot = join(root, "objective", "final-validation");
    const oldWorktree = join(validationRoot, "worktree");
    await addWorktree(checkout, oldWorktree, baseSha);
    mkdirSync(join(oldWorktree, "node_modules"));
    writeFileSync(
      join(oldWorktree, "node_modules", "old"),
      "ignored stale dependency\n",
    );
    const setup = `${process.execPath} -e 'const fs=require("node:fs"); if(fs.existsSync("node_modules")) throw Error("not fresh"); fs.mkdirSync("node_modules"); fs.writeFileSync("node_modules/ready", "prepared");'`;
    const check = `${process.execPath} -e 'const fs=require("node:fs"); if(fs.readFileSync("node_modules/ready","utf8")!=="prepared" || fs.readFileSync("result.txt","utf8")!=="reviewed result\\n") throw Error("wrong preparation or candidate");'`;
    const body =
      "## Sources\n- README.md\n\n## Acceptance\n- Validate the integrated candidate in a fresh checkout.\n";
    const request = prepareCompilationRequest({
      objective: 1,
      body,
      baseSha,
      checkout,
    });
    const item = {
      id: "final",
      kind: "aggregate",
      title: "Final proof",
      goal: "Check current final candidate",
      dependencies: [],
      children: [],
      ownedPaths: [],
      inputSources: [],
      acceptance: [],
      validation: [],
      nonGoals: [],
    };
    const graph = {
      objective: 1,
      baseSha,
      brief: "",
      items: [item],
      coverage: request.coverageObligations.map((x) => ({
        ...x,
        itemId: item.id,
        proof: { kind: "final-review" },
        environment: {
          kind: "local",
          readiness: "available",
          probe: "",
          prerequisites: [],
          preparedBy: "",
        },
      })),
    };
    const state = {
      schemaVersion: 7,
      configDigest: "f".repeat(64),
      repository: "integration/final-provenance",
      objective: 1,
      runId: "final-provenance",
      graph,
      planGraphDigest: graphDigest(graph),
      publicationContract: "exact-request-v1",
      objectiveBodyDigest: "b".repeat(64),
      approvedPlaybookPin: null,
      approvedPlaybookAdmission: {
        approvedPlaybookPin: null,
        configDigest: "f".repeat(64),
        graphDigest: graphDigest(graph),
        packetDigest: "c".repeat(64),
        reviewDigest: "d".repeat(64),
        sourcePacketDigest: "e".repeat(64),
      },
      baseSha,
      integratedSha: commit,
      work: {
        final: {
          status: "done",
          githubClosure: "complete",
          executionBaseSha: commit,
          baseSha: commit,
          changeRef: commit,
          treeSha,
          integratedSha: commit,
          validation: { treeSha, commands: [] },
        },
      },
      coordinator: { mode: "running", phase: "final-validate" },
      objectiveCommands: [setup, check],
    };
    let captured;
    const model = {
      reviewResult: async (request) => {
        captured = request;
        const rendered = renderResultReviewCall(request);
        assert.ok(rendered.prompt.includes("fresh-detached-worktree"));
        throw new Error("stop after real final review capture");
      },
    };
    // Remote default-head inspection is outside this local preparation test.
    // The real final validation and review producers still execute below.
    const step = async (_state, name, run) =>
      name === "final-head"
        ? false
        : run({
            progress() {},
            previousInvalid: () => undefined,
            invalid() {},
            paid: (run) => run(),
          });
    await assert.rejects(
      finalizeObjective({
        config: { repository: state.repository, checkout },
        objective: 1,
        issue: { body },
        state,
        graph,
        objectiveDirectory: join(root, "objective"),
        root,
        diagnostics: {
          emit() {},
          emitStream() {},
          modelObserver: () => () => {},
          span: async (_event, run) => run(),
        },
        github: { defaultBranch: async () => "main" },
        planningModel: model,
        contentStore: new LocalContentStore(join(root, "content")),
        save() {},
        objectiveStep: step,
        stopIfCancelled() {},
        cancellationRequested: () => false,
        objectiveSignal: () => new AbortController().signal,
        objectivePause: () => undefined,
      }),
      /stop after real final review capture/,
    );
    const observation = JSON.parse(
      captured.reviewPacket.evidence.find(
        (x) => x.path === "Validator worktree observation",
      ).content,
    );
    assert.equal(observation.treeSha, treeSha);
    assert.deepEqual(observation.checkoutPreparation, {
      kind: "fresh-detached-worktree",
      commitSha: commit,
      commandSequence: "after-checkout-creation",
      afterIntegrationSha: commit,
    });
    assert.deepEqual(
      captured.commands.map((x) => x.command),
      [setup, check],
    );
    assert.ok(
      captured.commands.every((x) => x.treeSha === treeSha && x.passed),
    );
    assert.equal(existsSync(oldWorktree), false);
    const baselineState = structuredClone(state);
    baselineState.baseSha = commit;
    baselineState.graph.baseSha = commit;
    baselineState.graph.items[0].kind = "qa";
    baselineState.planGraphDigest = graphDigest(baselineState.graph);
    baselineState.approvedPlaybookAdmission.graphDigest =
      baselineState.planGraphDigest;
    delete baselineState.integratedSha;
    delete baselineState.work.final.integratedSha;
    await assert.rejects(
      finalizeObjective({
        config: { repository: state.repository, checkout },
        objective: 1,
        issue: { body },
        state: baselineState,
        graph: baselineState.graph,
        objectiveDirectory: join(root, "baseline-objective"),
        root,
        diagnostics: {
          emit() {},
          emitStream() {},
          modelObserver: () => () => {},
          span: async (_event, run) => run(),
        },
        github: { defaultBranch: async () => "main" },
        planningModel: model,
        contentStore: new LocalContentStore(join(root, "content")),
        save() {},
        objectiveStep: step,
        stopIfCancelled() {},
        cancellationRequested: () => false,
        objectiveSignal: () => new AbortController().signal,
        objectivePause: () => undefined,
      }),
      /stop after real final review capture/,
    );
    const baselineObservation = JSON.parse(
      captured.reviewPacket.evidence.find(
        (x) => x.path === "Validator worktree observation",
      ).content,
    );
    assert.equal(
      baselineObservation.checkoutPreparation.afterIntegrationSha,
      undefined,
    );
    assert.equal(
      JSON.parse(captured.observations).candidateBasis,
      "pinned-baseline",
    );
    const evidence = await validateTree(
      checkout,
      join(root, "ordinary-validation"),
      commit,
      treeSha,
      [],
    );
    assert.equal(
      evidence.worktreeObservation.checkoutPreparation.afterIntegrationSha,
      undefined,
    );
    // Validation commands get the accepted base, since the checkout's
    // remote-tracking branches are never refreshed (#1664).
    const based = await validateTree(
      checkout,
      join(root, "based-validation"),
      commit,
      treeSha,
      [
        `test "$FACTORY_BASE_SHA" = ${baseSha} && git merge-base --is-ancestor "$FACTORY_BASE_SHA" HEAD`,
      ],
      undefined,
      undefined,
      [],
      undefined,
      baseSha,
    );
    assert.equal(based.commands[0].passed, true);
    const generic = join(root, "generic");
    await addWorktree(checkout, generic, commit);
    const genericEvidence = await validateCheckout(
      generic,
      root,
      commit,
      treeSha,
      [],
    );
    assert.equal(
      genericEvidence.worktreeObservation.checkoutPreparation,
      undefined,
    );
    await removeWorktree(checkout, generic);
    const review = (evidence, reviewPhase = "objective-review") =>
      reviewAcceptance({
        model,
        reviewPhase,
        checkout,
        baseSha,
        commit,
        evidence,
        criteria: ["Observe provenance"],
        sources: [],
      });
    const mismatch = structuredClone(evidence);
    git(
      "commit",
      "--allow-empty",
      "-m",
      "different commit with identical tree",
    );
    mismatch.worktreeObservation.checkoutPreparation.commitSha = git(
      "rev-parse",
      "HEAD",
    );
    assert.equal(git("rev-parse", "HEAD^{tree}"), treeSha);
    await assert.rejects(review(mismatch), /checkout preparation differs/);
    const wrongPhase = structuredClone(evidence);
    wrongPhase.worktreeObservation.checkoutPreparation.afterIntegrationSha =
      commit;
    await assert.rejects(
      review(wrongPhase, "result-review"),
      /requires final Objective review/,
    );
    const historical = structuredClone(evidence);
    delete historical.worktreeObservation.checkoutPreparation;
    model.reviewResult = async (request) => {
      const observed = JSON.parse(
        request.reviewPacket.evidence.find(
          (x) => x.path === "Validator worktree observation",
        ).content,
      );
      assert.equal(observed.checkoutPreparation, undefined);
      throw new Error("historical preparation remains unknown");
    };
    await assert.rejects(
      review(historical),
      /historical preparation remains unknown/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
