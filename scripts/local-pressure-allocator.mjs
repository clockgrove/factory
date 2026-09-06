/** Real allocation only in the explicitly owned, kernel-capped qualification service. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// Deliberately standalone: this allocator never loads Factory, SDKs, credentials or telemetry.
export async function allocatePressure() {
  const mb = 1048576;
  const membership = readFileSync("/proc/self/cgroup", "utf8").trim();
  assert.match(
    membership,
    /^0::\/[A-Za-z0-9_.@:/-]+\/factorypressure[a-f0-9]{64}\.slice\/clockgrove-factory-qualification-[a-f0-9]{64}\.service$/,
  );
  const group = `/sys/fs/cgroup${membership.slice(3)}`;
  const parent = dirname(group);
  const read = (name) => readFileSync(name, "utf8").trim();
  assert.equal(read(`${group}/memory.max`), String(3840 * mb));
  assert.equal(read(`${group}/memory.swap.max`), "0");
  const [quota, period] = read(`${group}/cpu.max`).split(/\s+/).map(Number);
  assert.equal(quota / period, 0.25);
  assert.equal(read(`${parent}/memory.max`), String(4096 * mb));
  assert.equal(read(`${parent}/memory.swap.max`), "0");
  const started = Date.now();
  const buffers = [];
  const safety = (nextBytes = 0) => {
    assert.ok(
      Number(read(`${parent}/memory.current`)) + nextBytes < 3968 * mb,
      "owned slice safety margin exhausted",
    );
    const free = /^MemFree:\s+(\d+) kB$/m.exec(read("/proc/meminfo"));
    assert.ok(free && Number(free[1]) * 1024 >= 2048 * mb, "host safety margin exhausted");
  };
  // Independent of the observer, exit at 90 seconds; systemd imposes a second 120s boundary.
  const deadline = setTimeout(() => process.exit(0), 90000);
  try {
    for (let bytes = 0; bytes < 3584 * mb; bytes += 64 * mb) {
      assert.ok(Date.now() - started < 60000, "allocation ramp deadline exceeded");
      safety(64 * mb);
      buffers.push(Buffer.alloc(64 * mb, 0x5a));
      await sleep(200);
    }
    // Keep every page reachable until the observed one-shot stop or the independent deadline.
    while (Date.now() - started < 90000) {
      safety();
      assert.equal(buffers[0][0], 0x5a);
      await sleep(1000);
    }
  } finally {
    clearTimeout(deadline);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await allocatePressure();
  } catch {
    process.exitCode = 2;
  }
}
