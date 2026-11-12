// Factory's bubblewrap shim for the gateway relay (#97, lib/gateway-relay.mjs). Claude Code's and Codex's sandboxes start
// every command with the `bwrap` they find first on PATH; Factory puts this shim there, in a directory the agent cannot
// write. For a command's sandbox (a call with --unshare-net: the command gets a network namespace of its own) it starts a
// forwarder in that namespace, on its own 127.0.0.1:<port>, to the relay's Unix socket, then runs the command exactly as
// the harness asked. Nothing else changes: the harness's network policy, its proxy and its seccomp filter are untouched,
// the forwarder carries one port to the relay alone, and the relay still wants the run's token on every call.
// - The forwarder starts before the harness's own seccomp filter, so it can reach the socket; the commands themselves
//   cannot open a Unix socket in Claude Code's or Codex's sandbox (their filters refuse AF_UNIX), so the forwarder's port
//   is their only way to the relay. It ends with the command's PID namespace.
// - Any other call (a version check, a probe) runs as given.
// - Once the forwarder answers it asks the relay's ping path, so the relay counts each command sandbox that reached it
//   (gateway-relay.mjs pings): a harness whose sandbox stopped calling this shim, or called it in a shape it no longer
//   matches, shows as passes with commands and no ping (harness.mjs), and the stage Blocks.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RELAY_PING } from "./gateway-relay.mjs";

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The shim's text. `bwrap`, `socat`: absolute paths of the real ones. `socket`: the relay's socket. `port`: the
 * forwarder's port in each command namespace.
 */
export function relayShimScript({ bwrap, socat, socket, port }) {
  if (![bwrap, socat, socket].every((p) => typeof p === "string" && p.startsWith("/"))) throw new Error("the relay shim needs absolute paths");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("the relay shim needs a port");
  // Run inside the command's namespace, before the command: the forwarder, a wait for it (up to 2 s), one ping, then the
  // command under the argv0 the harness gave bwrap (Codex's helper dispatches on it).
  const inner = [
    `${sq(socat)} TCP4-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${sq(socket)} </dev/null >/dev/null 2>&1 &`,
    `for i in $(seq 1 100); do if (exec 9<>/dev/tcp/127.0.0.1/${port} && printf 'GET ${RELAY_PING}?shim HTTP/1.0\\r\\n\\r\\n' >&9 && cat <&9 >/dev/null) 2>/dev/null; then break; fi; sleep 0.02; done`,
    'a0="$1"; shift',
    'if [ -n "$a0" ]; then exec -a "$a0" "$@"; else exec "$@"; fi',
  ].join("\n");
  return `#!/bin/bash
# Factory's bwrap shim (plugin/scripts/lib/relay-shim.mjs): a forwarder to the gateway relay in each command's network
# namespace; every other call runs as given.
real=${sq(bwrap)}
case " $* " in *" --unshare-net "*) ;; *) exec "$real" "$@" ;; esac
pre=(); a0=""; prev=""
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  [ "$prev" = "--argv0" ] && a0="$1"
  prev="$1"; pre+=("$1"); shift
done
# No command separator: nothing to wrap.
[ "$1" = "--" ] || exec "$real" "\${pre[@]}"
shift
exec "$real" "\${pre[@]}" -- /bin/bash -c ${sq(inner)} bash "$a0" "$@"
`;
}

/** Write the shim as `<dir>/bwrap` (the directory made 755: the agent reads and runs it, never writes it). Returns `dir`. */
export function writeRelayShim(dir, opts) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  const p = join(dir, "bwrap");
  writeFileSync(p, relayShimScript(opts), { mode: 0o755 });
  chmodSync(p, 0o755);
  return dir;
}

/**
 * The probe command a harness's sandbox runs before a stage relays its key (harness.mjs relayProbe): the relay's ping
 * through the forwarder, which must answer with this relay's probe id. Exit 0 with `ok`, else 4 with what it saw.
 */
export const relayProbeCommand = (port, probeId) =>
  `out=$(exec 3<>/dev/tcp/127.0.0.1/${port} && printf 'GET ${RELAY_PING} HTTP/1.0\\r\\n\\r\\n' >&3 && cat <&3) 2>/dev/null; case "$out" in *"factory-relay ${probeId}"*) echo ok ;; *) echo "no relay on 127.0.0.1:${port}"; exit 4 ;; esac`;
