// The test helpers that give a test a loopback port of its own (ports.mjs).
import "./temp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { connect, createServer } from "node:net";
import { test } from "node:test";
import { refusingOrigin, reservePort, unhandedPort } from "./ports.mjs";

const PORTS = new URL("./ports.mjs", import.meta.url).href;
/** Whether another process can reserve `port` now. */
const otherReserves = (port) => spawnSync(process.execPath, ["--input-type=module", "-e", `import { reservePort } from ${JSON.stringify(PORTS)}; const h = await reservePort(${port}); console.log(h ? "got" : "held"); await h?.release();`], { encoding: "utf8" }).stdout.trim();

test("a port unhandedPort gives is free, below the kernel's own range, and no other process's until it is released", { skip: process.platform === "win32" }, async () => {
  const { port, release } = await unhandedPort();
  try {
    assert.ok(port >= 20000 && port < 32768, String(port));
    assert.equal(otherReserves(port), "held", "another run of the helper cannot take it");
    assert.equal(await reservePort(port), null, "nor this process again");
    // Free for the code under test to bind.
    const srv = createServer();
    await new Promise((resolve, reject) => srv.once("error", reject).listen(port, "127.0.0.1", resolve));
    await new Promise((r) => srv.close(r));
  } finally {
    await release();
  }
  assert.equal(otherReserves(port), "got", "released: another process reserves it");
});

test("a refusing origin refuses while held, and its close never waits on a connection made to the held port", { timeout: 10_000 }, async () => {
  const dead = await refusingOrigin();
  await assert.rejects(fetch(`${dead.origin}/x`), (e) => e.cause?.code === "ECONNREFUSED");
  const { port } = new URL(dead.origin);
  const stray = connect(Number(port), "127.0.0.1");
  stray.on("error", () => {});
  await new Promise((r) => stray.once("close", r));
  await dead.close();
});
