// Loopback addresses for tests that must not share a port with whatever else runs on this machine: other test files of
// this suite, run at once, and other checkouts' suites. A port a test closes and only then hands on can be taken in
// between by any process that asks the kernel for one.
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomInt } from "node:crypto";

/**
 * An origin on this machine's loopback that refuses connections for as long as it is held: a port kept bound on
 * 127.0.0.1 (no other process can take it), called at another loopback address, where nothing listens. `close` frees it.
 * A connection another process makes to the held port itself is dropped at once, so `close` never waits on one.
 */
export async function refusingOrigin() {
  const holder = createServer((socket) => socket.destroy());
  await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.42.0.1:${holder.address().port}`, close: () => new Promise((r) => holder.close(r)) };
}

/**
 * Where the ports the kernel hands out on its own (a listen(0), an outgoing connection) begin: Linux's range, never above
 * 32768 (Linux's default start; macOS's range starts at 49152).
 */
function ephemeralLow() {
  try {
    return Math.min(32768, Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 32768);
  } catch {
    return 32768;
  }
}

/**
 * A free loopback port, from 20000 up to the kernel's ephemeral range, for a listener the code under test binds by
 * number on this machine's own network: no listen(0) or outgoing connection of any process is handed a port there, so
 * only a listener that names this very number could take it before the code under test does.
 */
export async function unhandedPort() {
  const low = ephemeralLow();
  if (low <= 20000) throw new Error(`this machine hands out ports from ${low}: no port below its range is left for the test`);
  for (let tries = 0; tries < 50; tries++) {
    const port = randomInt(20000, low);
    const probe = createServer();
    const free = await new Promise((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (free) {
      await new Promise((r) => probe.close(r));
      return port;
    }
  }
  throw new Error(`no free loopback port between 20000 and ${low}`);
}
