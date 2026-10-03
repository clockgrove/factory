import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { availableParallelism, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  factoryConfigDigest,
  hostSchedulingDefaults,
  liveCapacity,
  resolveCapacity,
  validateConfig,
} from "../dist/config.js";
import { defaultAutonomy, resolveAutonomy } from "../dist/index.js";
import {
  bindTarget,
  createTarget,
  factoryConfig,
} from "./support/integration-fixture.mjs";

const GiB = 1024 ** 3;
const light = { cpu: 0.5, memoryMiB: 512 };

test("host defaults keep OS headroom and size each phase from the remaining capacity", () => {
  const shapes = [
    {
      host: { cpus: 4, memoryBytes: 8 * GiB },
      concurrency: 1,
      scheduling: {
        cpu: 2,
        memoryMiB: 4096,
        reviewConcurrency: 2,
        validationConcurrency: 1,
        phases: {
          coding: { cpu: 2, memoryMiB: 2048 },
          validation: { cpu: 2, memoryMiB: 4096 },
          review: light,
          delivery: light,
        },
      },
    },
    {
      host: { cpus: 24, memoryBytes: 45 * GiB },
      concurrency: 11,
      scheduling: {
        cpu: 22,
        memoryMiB: 41984,
        reviewConcurrency: 22,
        validationConcurrency: 5,
        phases: {
          coding: { cpu: 2, memoryMiB: 2048 },
          validation: { cpu: 4, memoryMiB: 4096 },
          review: light,
          delivery: light,
        },
      },
    },
    {
      host: { cpus: 64, memoryBytes: 256 * GiB },
      concurrency: 31,
      scheduling: {
        cpu: 62,
        memoryMiB: 258048,
        reviewConcurrency: 62,
        validationConcurrency: 15,
        phases: {
          coding: { cpu: 2, memoryMiB: 2048 },
          validation: { cpu: 4, memoryMiB: 4096 },
          review: light,
          delivery: light,
        },
      },
    },
  ];
  for (const { host, ...expected } of shapes)
    assert.deepEqual(hostSchedulingDefaults(host), expected, host.cpus);
});

test("host defaults stay admissible on a host smaller than the headroom", () => {
  const { concurrency, scheduling } = hostSchedulingDefaults({
    cpus: 1,
    memoryBytes: 2 * GiB,
  });
  assert.equal(concurrency, 1);
  assert.equal(scheduling.validationConcurrency, 1);
  for (const phase of Object.values(scheduling.phases)) {
    assert.ok(phase.cpu > 0 && phase.cpu <= scheduling.cpu);
    assert.ok(phase.memoryMiB > 0 && phase.memoryMiB <= scheduling.memoryMiB);
  }
});

test("memory, not CPU, bounds workers on a CPU-rich host", () => {
  const { concurrency, scheduling } = hostSchedulingDefaults({
    cpus: 32,
    memoryBytes: 16 * GiB,
  });
  assert.equal(scheduling.memoryMiB, 12288);
  assert.equal(concurrency, 6);
  assert.equal(scheduling.validationConcurrency, 3);
});

test("omitted concurrency resolves from the host, and the declared config digest does not follow the host", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-host-sized-"));
  try {
    const target = createTarget(root);
    const { execution, ...rest } = factoryConfig(
      target.checkout,
      "example/host-sized",
    );
    const { concurrency: _explicit, ...sizedExecution } = execution;
    const host = hostSchedulingDefaults({
      cpus: availableParallelism(),
      memoryBytes: totalmem(),
    });
    const sized = validateConfig({ ...rest, execution: sizedExecution });
    assert.equal(sized.execution.concurrency, undefined);
    assert.deepEqual(resolveCapacity(sized), {
      concurrency: host.concurrency,
      scheduling: host.scheduling,
      hostSized: { concurrency: true, scheduling: true },
    });
    const explicit = validateConfig({
      ...rest,
      execution: { ...sizedExecution, concurrency: 3 },
    });
    assert.deepEqual(resolveCapacity(explicit), { concurrency: 3 });
    // A different host changes the resolved capacity, never the declared digest.
    const digest = factoryConfigDigest(sized);
    const { availableParallelism: cpus, totalmem: memory } = os;
    try {
      os.availableParallelism = () => 4;
      os.totalmem = () => 8 * GiB;
      syncBuiltinESMExports();
      assert.equal(resolveCapacity(sized).concurrency, 1);
      assert.equal(factoryConfigDigest(sized), digest);
    } finally {
      os.availableParallelism = cpus;
      os.totalmem = memory;
      syncBuiltinESMExports();
    }
    assert.throws(
      () =>
        validateConfig({
          ...rest,
          execution: { ...sizedExecution, concurrency: 0 },
        }),
      /positive integer, or omitted/,
    );
    // Autonomy limits do not bind plans or runs; every other choice does.
    assert.equal(
      factoryConfigDigest(
        validateConfig({
          ...rest,
          execution: { ...sizedExecution, concurrency: 3 },
          autonomy: { allowances: { implementationRepairs: 5 } },
        }),
      ),
      factoryConfigDigest(explicit),
    );
    assert.notEqual(factoryConfigDigest(sized), factoryConfigDigest(explicit));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install writes concurrency only when the operator passes --concurrency", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-host-install-"));
  try {
    const target = createTarget(root);
    bindTarget(target.checkout, "example/host-install");
    const install = (name, ...extra) => {
      const configPath = join(root, name, "factory.json");
      const output = execFileSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "../dist/cli.js"),
          "install",
          "--repository",
          "example/host-install",
          "--checkout",
          target.checkout,
          ...extra,
          "--config",
          configPath,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, XDG_STATE_HOME: join(root, name, "state") },
        },
      );
      return { output, config: JSON.parse(readFileSync(configPath, "utf8")) };
    };
    const sized = install("sized");
    assert.equal(sized.config.execution.concurrency, undefined);
    assert.equal(sized.config.scheduling, undefined);
    assert.match(sized.output, /sized from the host at run time/);
    const explicit = install("explicit", "--concurrency", "2");
    assert.equal(explicit.config.execution.concurrency, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("autonomy defaults are bounded and on; the config section overrides them field by field", () => {
  assert.deepEqual(resolveAutonomy(), defaultAutonomy);
  assert.deepEqual(defaultAutonomy.allowances, {
    planningRevisions: 1,
    implementationRepairs: 2,
    resultRereviews: 1,
  });
  const custom = resolveAutonomy({
    allowances: { implementationRepairs: 4 },
    repairClasses: ["implementation"],
    requiredEnvironment: ["FIXTURE_TOKEN"],
  });
  assert.deepEqual(custom.allowances, {
    planningRevisions: 1,
    implementationRepairs: 4,
    resultRereviews: 1,
  });
  assert.deepEqual(custom.repairClasses, ["implementation"]);
  assert.deepEqual(custom.repairPolicy, defaultAutonomy.repairPolicy);
  assert.throws(
    () => resolveAutonomy({ allowances: { implementationRepairs: -1 } }),
    /nonnegative integer/,
  );
  assert.throws(() => resolveAutonomy({ actor: "x" }), /Unsupported autonomy/);
  assert.throws(
    () => resolveAutonomy({ repairClasses: ["anything"] }),
    /unsupported repair classes/,
  );
});

test("live capacity takes the smaller of stored and current host values only where the host sized them", () => {
  const large = hostSchedulingDefaults({ cpus: 64, memoryBytes: 256 * GiB });
  const small = hostSchedulingDefaults({ cpus: 4, memoryBytes: 8 * GiB });
  const { availableParallelism: cpus, totalmem: memory } = os;
  try {
    os.availableParallelism = () => 4;
    os.totalmem = () => 8 * GiB;
    syncBuiltinESMExports();
    assert.deepEqual(
      liveCapacity({
        concurrency: large.concurrency,
        scheduling: large.scheduling,
        hostSized: { concurrency: true, scheduling: true },
      }),
      { concurrency: small.concurrency, scheduling: small.scheduling },
    );
    // Declared scheduling stays as declared even when the worker ceiling was host-sized.
    const declared = { cpu: 40, memoryMiB: 100_000, reviewConcurrency: 9 };
    assert.deepEqual(
      liveCapacity({
        concurrency: large.concurrency,
        scheduling: declared,
        hostSized: { concurrency: true },
      }),
      { concurrency: small.concurrency, scheduling: declared },
    );
    const stored = { concurrency: 30, scheduling: declared };
    assert.equal(liveCapacity(stored), stored);
  } finally {
    os.availableParallelism = cpus;
    os.totalmem = memory;
    syncBuiltinESMExports();
  }
});
