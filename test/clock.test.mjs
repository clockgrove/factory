import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const probe = `
import { now, sleep } from "./dist/clock.js";
const startReal = Date.now();
const start = now();
const aborted = new AbortController();
aborted.abort();
const cancelled = await sleep(60_000, aborted.signal).then(() => false, () => true);
await sleep(10_000);
process.stdout.write(JSON.stringify({ real: Date.now() - startReal, logical: now() - start, cancelled }));
`;

function run(env) {
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, ...env },
      encoding: "utf8",
    }),
  );
}

test("FACTORY_TIME_SCALE compresses logical waits and honours abort", () => {
  const result = run({ FACTORY_TIME_SCALE: "100" });
  assert.equal(result.cancelled, true);
  assert.ok(result.logical >= 10_000, `logical ${result.logical} ms`);
  assert.ok(result.real < 5_000, `real ${result.real} ms`);
});

test("processes sharing FACTORY_TIME_ORIGIN share one timeline", () => {
  const origin = String(Date.now() - 1_000);
  const stamp = (env) =>
    Number(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import { now } from "./dist/clock.js"; process.stdout.write(String(now()));',
        ],
        {
          cwd: new URL("..", import.meta.url),
          env: { ...process.env, FACTORY_TIME_SCALE: "100", ...env },
          encoding: "utf8",
        },
      ),
    );
  // A second of real time since the origin is 100 logical seconds.
  assert.ok(stamp({ FACTORY_TIME_ORIGIN: origin }) - Date.now() >= 90_000);
});
