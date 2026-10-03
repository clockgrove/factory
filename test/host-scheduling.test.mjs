import assert from "node:assert/strict";
import test from "node:test";
import { hostSchedulingDefaults } from "../dist/config.js";

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
