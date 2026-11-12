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
 * bubblewrap's options by how many values each takes (bubblewrap 0.11): the shim walks the options to the command's
 * separator by these, so an option's value that reads `--` or `--unshare-net` is never taken for one. An option it does
 * not know (a newer bubblewrap's) leaves the call as given: no forwarder, which the probes catch.
 */
const BWRAP_ARITY = {
  0: ["--help", "--version", "--unshare-all", "--share-net", "--unshare-user", "--unshare-user-try", "--unshare-ipc", "--unshare-pid", "--unshare-net", "--unshare-uts", "--unshare-cgroup", "--unshare-cgroup-try", "--clearenv", "--new-session", "--die-with-parent", "--as-pid-1", "--disable-userns", "--assert-userns-disabled"],
  1: ["--args", "--argv0", "--userns", "--userns2", "--pidns", "--uid", "--gid", "--hostname", "--chdir", "--unsetenv", "--lock-file", "--sync-fd", "--remount-ro", "--overlay-src", "--tmp-overlay", "--ro-overlay", "--exec-label", "--file-label", "--proc", "--dev", "--tmpfs", "--mqueue", "--dir", "--seccomp", "--add-seccomp-fd", "--block-fd", "--userns-block-fd", "--info-fd", "--json-status-fd", "--cap-add", "--cap-drop", "--perms", "--size", "--level-prefix"],
  2: ["--setenv", "--bind", "--bind-try", "--dev-bind", "--dev-bind-try", "--ro-bind", "--ro-bind-try", "--bind-fd", "--ro-bind-fd", "--file", "--bind-data", "--ro-bind-data", "--symlink", "--chmod"],
  3: ["--overlay"],
};

/**
 * The forwarder, a bash script of its own run inside the command's namespace before the command: `bash -p -c
 * RELAY_FORWARDER bash <socket> <port> <socat> <argv0> <command...>` starts socat on the namespace's 127.0.0.1:<port>
 * to the socket, waits for it (up to 2 s) and pings the relay, then runs the command under `argv0` (Codex's helper
 * dispatches on it; empty: the command's own). Its arguments are values, never script text; builtins and absolute paths
 * only, and `-p` reads no BASH_ENV.
 */
export const RELAY_FORWARDER = [
  's="$1"; p="$2"; x="$3"; a0="$4"; shift 4',
  '"$x" "TCP4-LISTEN:$p,bind=127.0.0.1,fork,reuseaddr" "UNIX-CONNECT:$s" </dev/null >/dev/null 2>&1 &',
  `for ((i = 0; i < 100; i++)); do if (exec 9<>"/dev/tcp/127.0.0.1/$p" && printf 'GET ${RELAY_PING}?shim HTTP/1.0\\r\\n\\r\\n' >&9 && while read -r -u 9 _; do :; done) 2>/dev/null; then break; fi; /bin/sleep 0.02; done`,
  'if [ -n "$a0" ]; then exec -a "$a0" "$@"; else exec "$@"; fi',
].join("\n");

/**
 * The shim's text. `bwrap`, `socat`: absolute paths of the real ones. `socket`: the relay's socket. `port`: the
 * forwarder's port in each command namespace. bash with `-p` (no BASH_ENV or ENV is read), builtins only.
 */
export function relayShimScript({ bwrap, socat, socket, port }) {
  if (![bwrap, socat, socket].every((p) => typeof p === "string" && p.startsWith("/"))) throw new Error("the relay shim needs absolute paths");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("the relay shim needs a port");
  const arity = Object.entries(BWRAP_ARITY).map(([n, opts]) => `    ${opts.join("|")}) n=${n} ;;`).join("\n");
  return `#!/bin/bash -p
# Factory's bwrap shim (plugin/scripts/lib/relay-shim.mjs): a forwarder to the gateway relay in each command's network
# namespace; every other call runs as given.
real=${sq(bwrap)}
args=("$@"); i=0; net=""; a0=""; sep=-1
while [ "$i" -lt "\${#args[@]}" ]; do
  o="\${args[$i]}"
  if [ "$o" = "--" ]; then sep=$i; break; fi
  case "$o" in
${arity}
    --*) exec "$real" "$@" ;;
    *) sep=-2; break ;;
  esac
  [ "$o" = "--unshare-net" ] && net=1
  [ "$o" = "--argv0" ] && a0="\${args[$((i + 1))]}"
  i=$((i + n + 1))
done
# A command sandbox (its own network namespace, by an option before the separator) gets the forwarder; nothing else.
if [ -z "$net" ] || [ "$sep" -lt 0 ]; then exec "$real" "$@"; fi
exec "$real" "\${args[@]:0:$sep}" -- /bin/bash -p -c ${sq(RELAY_FORWARDER)} bash ${sq(socket)} ${port} ${sq(socat)} "$a0" "\${args[@]:$((sep + 1))}"
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
