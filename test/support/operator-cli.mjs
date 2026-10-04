// The operator's side of a test world: the real CLI (dist/cli.js) against the
// world's state, with the world's fake GitHub behind api.github.com. A suite
// that stops an Objective reads `factory status` here and runs the command it
// names, so a stop whose first line or command does not work fails the suite.
//
// The world's controller composes a scripted harness the CLI cannot name, so
// the CLI reads the same configuration with the production harness; a command
// only changes state, and nothing in a command starts a worker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gitTransportEnvironment } from "./github-http-fake.mjs";

const cli = join(import.meta.dirname, "..", "..", "dist", "cli.js");

/** The words the first line starts with, written out here so a wrong label in the source fails. */
const HEADLINE_LEAD = {
  "not-started": "Not started: ",
  planning: "Planning: ",
  "needs-decision": "Needs decision: ",
  running: "Running: ",
  waiting: "Waiting on ",
  complete: "Complete: ",
  failed: "Failed: ",
  cancelled: "Cancelled: ",
};

/** What an operator types for each placeholder a status command prints. */
const PLACEHOLDERS = {
  "accept|refuse": "accept",
  WHY: "Decided by the test operator",
  ANSWER: "Proceed",
};

/**
 * The operator for a world: `root` holds its state (`root/state`), `config` is
 * the controller's configuration, `fake` the running GitHub fake.
 */
export function operatorFor({ root, config, fake, objective = 1 }) {
  const directory = join(root, "operator");
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const configPath = join(directory, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      execution: {
        ...config.execution,
        harness: {
          kind: "codex-sdk",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
        },
      },
    }),
  );
  // Octokit reads global fetch when it sends: send api.github.com here.
  const preload = join(directory, "preload.mjs");
  writeFileSync(
    preload,
    `const real = globalThis.fetch;
globalThis.fetch = (url, init) =>
  real(String(url).replace(/^https:\\/\\/api\\.github\\.com/, process.env.FACTORY_FAKE_API_URL), init);
`,
  );
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho test-token\n");
  chmodSync(join(bin, "gh"), 0o755);
  const environment = () => {
    const env = { ...process.env, ...gitTransportEnvironment(fake.gitUrl) };
    return {
      ...env,
      PATH: `${bin}:${env.PATH}`,
      XDG_STATE_HOME: join(root, "state"),
      FACTORY_FAKE_API_URL: fake.apiUrl,
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    };
  };
  const run = (args) => {
    const result = spawnSync(
      process.execPath,
      [cli, ...args, "--config", configPath],
      { encoding: "utf8", env: environment(), timeout: 120_000 },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  return {
    run,
    /**
     * `factory status` as the operator reads it, in both forms. Throws unless
     * the text leads with the headline and the exact command the document
     * carries (line 2 is blank when there is none).
     */
    status() {
      const json = run(["status", "--objective", String(objective), "--json"]);
      assert.equal(json.status, 0, `factory status --json: ${json.stderr}`);
      const document = JSON.parse(json.stdout);
      const text = run(["status", "--objective", String(objective)]);
      assert.equal(text.status, 0, `factory status: ${text.stderr}`);
      const lines = text.stdout.split("\n");
      const lead = HEADLINE_LEAD[document.phase];
      assert.ok(lead, `no headline wording for phase ${document.phase}`);
      assert.equal(lines[0], `${lead}${document.summary}`, "the first line");
      assert.equal(
        lines[1],
        document.action?.command ?? "",
        "the second line is the command",
      );
      return { document, lines };
    },
    /**
     * Run a command a status printed. Placeholders take the values above;
     * `fill` supplies the rest (`FILE`, `SET_ID`).
     */
    follow(text, fill = {}) {
      const [factory, ...words] = text.match(/"[^"]*"|\S+/g) ?? [];
      assert.equal(factory, "factory", `not a factory command: ${text}`);
      return run(
        words.map((word) => {
          const bare = word.replace(/^"|"$/g, "");
          return fill[bare] ?? PLACEHOLDERS[bare] ?? bare;
        }),
      );
    },
  };
}
