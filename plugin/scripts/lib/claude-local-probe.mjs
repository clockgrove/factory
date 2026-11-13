// Claude Code's sandbox in local mode, probed before every start and by doctor --local, as Codex's and Copilot's are
// (harness.mjs claudeLocalCheck). Claude Code has no command that runs one command in its sandbox, so the probe is a
// Claude Code session against a stand-in for the Anthropic Messages API on the loopback of the sandbox it runs in
// (anthropicProbeModel: no network, no bill) that asks for one Bash call: the driver (claudeProbeDriver), which proves
// the stage's toolchain and runs CONFINEMENT_PROBE beside a decoy, then leaves its result in a file.
import http from "node:http";
import { decoyLaunch, PROBE_MARKER } from "./codex-runner.mjs";
import { PROBE_PERSIST, toolchainRules } from "./copilot-runner.mjs";

/** The file the driver leaves its result in, in the stage's temp directory: its exit code, then its last line. */
export const CLAUDE_PROBE_RESULT = ".factory-claude-probe";

/** A shell word for `s`: single-quoted. */
const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * The command the probe's model asks Claude Code to run, from its environment (FACTORY_CLAUDE_PROBE), in its sandbox:
 * refuses to go on without its script or decoy (an empty one would pass unchecked); proves the stage's toolchain
 * (toolchainRules); tries a file in each of `persist` (Factory checks from outside that none was made: Claude Code's
 * sandbox puts a throwaway tmpfs over the home, where a write lands and is gone); then runs CONFINEMENT_PROBE with no
 * home rule. Its result goes to `result` by path: an exit code and a last line, a pass being 0 and PROBE_PASS.
 */
export const claudeProbeDriver = ({ gitConfig, host, marker, result, tmp, persist = [], toolchain = null }) =>
  [
    `out() { printf '%s\\n%s\\n' "$1" "$2" > ${sq(result)}; exit 0; }`,
    `[ -n "$FACTORY_PROBE_SCRIPT" ] || out 4 "the probe script is missing"`,
    `[ -n "$FACTORY_PROBE_DECOY" ] || out 4 "the probe's decoy is missing"`,
    ...toolchainRules(toolchain),
    ...persist.map((d) => `true >> ${sq(`${d}/${PROBE_PERSIST}`)} 2>/dev/null`),
    `r=0; o=$(sh -c "$FACTORY_PROBE_SCRIPT" sh "" ${sq(gitConfig)} ${sq(tmp)} ${sq(host)} ${sq(marker)} "$FACTORY_PROBE_DECOY") || r=$?`,
    `out "$r" "$(printf '%s\\n' "$o" | tail -n 1)"`,
  ].join("\n");

/** The probe's launch: CONFINEMENT_PROBE's decoy, then Claude Code with the decoy's pid in its environment. */
export const CLAUDE_DECOY_LAUNCH = decoyLaunch('FACTORY_PROBE_DECOY=$d claude "$@"');

/**
 * A stand-in for the Anthropic Messages API on this machine's (or the sandbox's) loopback. The first request that
 * offers the Bash tool gets one Bash call, `sh -c "$FACTORY_CLAUDE_PROBE"`; every other request ends the turn.
 * Nothing leaves the machine and nothing is billed. Returns {env, close, toolOutput}: the variables Claude Code needs
 * (a stand-in key, never a real one), and what it answered for the call (for the log only).
 */
export async function anthropicProbeModel() {
  let toolOutput = "";
  const usage = { input_tokens: 1, output_tokens: 1 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      if (body.length < 4_000_000) body += c;
    });
    req.on("end", () => {
      let j = {};
      try {
        j = JSON.parse(body);
      } catch {
        // answered as a first request
      }
      if (req.url.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"input_tokens":1}');
      }
      const results = (Array.isArray(j.messages) ? j.messages : []).flatMap((m) => (Array.isArray(m?.content) ? m.content : [])).filter((c) => c?.type === "tool_result");
      if (results.length) {
        const c = results.at(-1).content;
        toolOutput = (typeof c === "string" ? c : JSON.stringify(c ?? "")).slice(0, 2000);
      }
      const call = !results.length && (j.tools || []).some((t) => t?.name === "Bash");
      const input = { command: 'sh -c "$FACTORY_CLAUDE_PROBE"', description: "Factory's sandbox probe" };
      if (!j.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: "msg_probe", type: "message", role: "assistant", model: j.model || "factory-probe", content: call ? [{ type: "tool_use", id: "toolu_probe", name: "Bash", input }] : [{ type: "text", text: "done" }], stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null, usage }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
      ev("message_start", { message: { id: "msg_probe", type: "message", role: "assistant", model: j.model || "factory-probe", content: [], stop_reason: null, stop_sequence: null, usage } });
      ev("content_block_start", { index: 0, content_block: call ? { type: "tool_use", id: "toolu_probe", name: "Bash", input: {} } : { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(input) } : { type: "text_delta", text: "done" } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-ant-factory-probe", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    toolOutput: () => toolOutput,
  };
}

export { PROBE_MARKER };
