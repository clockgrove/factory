// The graph reviewer judges validation with the network the installation
// gives it. The Claude prd run's hostnet case (sandbox.network host) planned
// its loopback `curl` in a QA item's validation, as the planner was told it
// could; plan review refused it twice because its Work Item standard said
// validation has no network, and the Objective held until its answers ran out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkPlan } from "../dist/planning/checks.js";
import {
  BaseFiles,
  buildFacts,
  commandInstructions,
  validationEnvironmentNote,
} from "../dist/planning/facts.js";
import {
  renderCompilationCall,
  renderGraphReviewCall,
} from "../dist/planning/prompts.js";
import { readShown } from "../dist/shown.js";
import { tempDir } from "./helpers.mjs";

/** Each sandbox.network as steps.ts `planningFacts` hands it to buildFacts. */
const MODES = {
  off: { hostNetwork: false, lockfileResolution: false },
  "package-install": { hostNetwork: false, lockfileResolution: true },
  host: { hostNetwork: true, lockfileResolution: true },
};

const CI_ONLY = ["npm audit"];

function git(directory, ...args) {
  const run = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

function repository() {
  const checkout = tempDir("factory-review-network-");
  git(checkout, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(checkout, "README.md"), "# Ready\n");
  git(checkout, "add", ".");
  git(
    checkout,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  return { checkout, base: git(checkout, "rev-parse", "HEAD") };
}

/** The planner's and the graph reviewer's prompts under one sandbox.network. */
async function prompts({ checkout, base }, mode) {
  const shown = readShown(
    "<h2>Goal</h2>\n<p>Serve a readiness file.</p>\n<h2>Acceptance</h2>\n<ul>\n<li><code>curl -sf http://127.0.0.1:18650/ready</code> succeeds on the integrated result.</li>\n</ul>",
    { sources: true },
  );
  const built = await buildFacts({
    objective: 4,
    shown,
    base,
    checkout,
    ciOnlyCommands: CI_ONLY,
    ...MODES[mode],
  });
  assert.ok(built.facts, JSON.stringify(built.problems));
  const { facts } = built;
  // The CI-only and environment notes reach the planner as a JSON string in
  // its data; the Work Item standard is its prompt's own text.
  const instructions = await commandInstructions(facts, checkout);
  return {
    planner: renderCompilationCall({
      facts,
      data: { instructions },
      revising: false,
      lookups: { open: false, bodies: [] },
    }).prompt,
    instructions,
    reviewer: renderGraphReviewCall({
      facts,
      draft: { items: [] },
      evidence: [],
      decisions: [],
      finalCommands: [],
      controllerCapabilities: {},
    }).prompt,
  };
}

const HARNESS =
  "A service the Objective says the host runs is already running: a request to it is not a service launch, needs no startup, shutdown or readiness harness, and proves its criterion by running as written. A service the plan's own commands start is a service launch, which still needs its finite harness.";
const HOST_SANDBOX = `"sandbox":"read-only host, private HOME and /tmp, no host socket files (Unix sockets bound to a path); TCP to the host's network, its loopback services included, is not blocked"`;

test("the graph reviewer is told validation's network: the host's under sandbox.network host, none otherwise", async () => {
  const target = repository();

  const host = (await prompts(target, "host")).reviewer;
  assert.ok(
    host.includes(
      "Validation has the host's network (sandbox.network host), including services on its loopback, so a command that reaches the network may run in it.",
    ),
  );
  assert.ok(
    host.includes(
      `Validation environment (differs from hosted CI): {"network":"the host's network (sandbox.network host)",`,
    ),
  );
  assert.doesNotMatch(host, /no network/);
  // The Codex prd run's hostnet case: the graph reviewer twice asked for a
  // harness to start the host's service, and the planner then read the
  // sandbox's "no host sockets" as no reaching it and held the curl for the
  // operator (#2121). Under host the sandbox entry says TCP to the host's
  // loopback is open, and a request to a host service is no service launch,
  // while a service the plan starts still needs its harness (#2135).
  assert.ok(host.includes(HOST_SANDBOX));
  assert.doesNotMatch(host, /no host sockets|runtime Unix sockets/);
  assert.ok(host.includes(HARNESS));
  // The commands check still flags a bare persistent service launch.
  assert.ok(
    host.includes(
      "Flag a bare persistent service launch used as validation even when its brief promises managed startup/shutdown; executable lifecycle proof needs a finite harness.",
    ),
  );
  for (const resolves of [true, false])
    assert.ok(
      validationEnvironmentNote(true, resolves).includes(
        "its loopback services included, is not blocked",
      ),
    );

  for (const mode of ["off", "package-install"]) {
    const reviewer = (await prompts(target, mode)).reviewer;
    assert.ok(
      reviewer.includes(
        `"sandbox":"read-only host, private HOME and /tmp, no host sockets"`,
      ),
      mode,
    );
    assert.doesNotMatch(
      reviewer,
      /loopback services included|service the Objective says the host runs|plan's own commands start/,
      mode,
    );
    assert.ok(
      reviewer.includes(
        "A script that runs a network tool (an init, install, fetch or audit) fails in validation, which has no network: never select one.",
      ),
      mode,
    );
    assert.doesNotMatch(reviewer, /host's network/, mode);
  }
  // Only package-install gives the install a network; under off it runs
  // offline from the package store (validate.ts).
  assert.ok(
    (await prompts(target, "package-install")).reviewer.includes(
      `Validation environment (differs from hosted CI): {"network":"none except the exact script-disabled package install, which runs first",`,
    ),
  );
  const off = (await prompts(target, "off")).reviewer;
  assert.ok(
    off.includes(
      `Validation environment (differs from hosted CI): {"network":"none, the exact script-disabled package install included: it runs first, offline, from the package store",`,
    ),
  );
  assert.doesNotMatch(off, /none except the exact/);
});

test("the planner's CI-only note and check say validation runs offline only when it does", async () => {
  const target = repository();
  const { instructions: host, planner } = await prompts(target, "host");
  assert.ok(planner.includes(HARNESS));
  assert.ok(planner.includes(JSON.stringify(HOST_SANDBOX).slice(1, -1)));
  assert.doesNotMatch(planner, /validation runs offline/);
  assert.ok(host.includes(HOST_SANDBOX));
  // Under host, the planner read "validation runs offline" right after the
  // environment note said TCP to the host is open (#2135).
  assert.ok(
    host.includes(
      `The installation runs these commands only in CI, so never use one as a validation command: ${JSON.stringify(CI_ONLY)}.`,
    ),
  );
  assert.doesNotMatch(host, /offline|need network/);
  for (const mode of ["off", "package-install"])
    assert.ok(
      (await prompts(target, mode)).instructions.includes(
        `These commands need network and run only in CI; validation runs offline, so never use one as a validation command: ${JSON.stringify(CI_ONLY)}.`,
      ),
      mode,
    );

  const findings = async (hostNetwork) =>
    (
      await checkPlan(
        {
          base: target.base,
          items: [
            {
              kind: "work",
              id: "Ready",
              title: "Serve the readiness file",
              goal: "Serve the readiness file.",
              acceptance: ["The readiness file is served."],
              nonGoals: ["No other files."],
              citations: [{ path: "OBJECTIVE" }],
              dependencies: [],
              ownedPaths: ["ready.txt"],
              validation: [{ command: "npm audit" }],
              brief: "Serve the readiness file.",
              priority: 1,
            },
          ],
          coverage: [],
          finalCommands: [],
          decisions: [],
        },
        {
          objective: 4,
          body: "",
          blocks: [],
          base: target.base,
          sources: [],
          packageCommands: [],
          ciOnlyCommands: CI_ONLY,
          ...(hostNetwork ? { hostNetwork: true } : {}),
          checkNames: [],
          integratedCheckNames: [],
          fixedScripts: [],
          coverageObligations: [],
          playbook: "",
          localAssetRoots: [],
          lfsRules: [],
        },
        new BaseFiles(target.checkout, target.base),
      )
    ).filter((finding) => /marks CI-only/.test(finding.message));
  const [onHost, ...moreOnHost] = await findings(true);
  assert.equal(moreOnHost.length, 0);
  assert.equal(onHost?.itemId, "Ready");
  assert.match(onHost.message, /marks CI-only: it runs only in CI\./);
  assert.doesNotMatch(onHost.message, /offline/);
  const [off] = await findings(false);
  assert.match(off?.message, /it needs network and validation runs offline/);
});
