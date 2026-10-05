import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const cli = join(root, "dist", "cli.js");

/** The markdown an agent or operator reads: docs, skills, and the top-level guides. */
function documents() {
  const files = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "SECURITY.md"];
  const walk = (directory) => {
    for (const name of readdirSync(join(root, directory))) {
      const path = join(directory, name);
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (name.endsWith(".md")) files.push(path);
    }
  };
  walk("docs");
  walk("skills");
  return files.map((path) => ({
    path,
    text: readFileSync(join(root, path), "utf8"),
  }));
}

/** Command lines inside fenced blocks and inline code spans that start with `factory`. */
function factoryCommands(text) {
  const spans = [];
  for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g))
    spans.push(...block[1].split("\n"));
  for (const span of text.matchAll(/`([^`\n]+)`/g)) spans.push(span[1]);
  return spans
    .map((line) => line.trim().replace(/^[$>]\s*/, ""))
    .filter((line) => /^factory\s+[a-z]/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""));
}

const help = spawnSync(process.execPath, [cli, "--help"], {
  encoding: "utf8",
}).stdout;
const commandLines = help
  .split("\n")
  .filter((line) => /^ {2}[a-z]/.test(line))
  .map((line) => line.trim());
const commands = new Set([
  "help",
  ...commandLines.flatMap((line) =>
    line
      .split(/\s+/)[0]
      .split("|")
      .map((name) => name.trim()),
  ),
]);
const flags = new Set(help.match(/--[a-z][a-z-]*/g));

test("the CLI help lists the commands the docs rely on", () => {
  for (const name of [
    "setup",
    "run",
    "queue",
    "status",
    "decide",
    "retry",
    "repair",
    "propose-amendment",
    "diagnostics",
  ])
    assert.ok(commands.has(name), `factory ${name} missing from --help`);
});

test("docs and skills name no removed command", () => {
  const removed =
    /\bfactory (intake|decide-result|rereview|install|readiness|plan|logs|captures|analyze)\b|supervisor install|\bdecide-result\b/;
  for (const { path, text } of documents()) {
    for (const [index, line] of text.split("\n").entries()) {
      assert.doesNotMatch(
        line,
        removed,
        `${path}:${index + 1} names a removed command`,
      );
    }
  }
});

test("every factory command and option in docs and skills exists", () => {
  let checked = 0;
  for (const { path, text } of documents()) {
    for (const command of factoryCommands(text)) {
      checked++;
      const [, name] = command.split(/\s+/);
      const words = name.split("|");
      for (const word of words)
        assert.ok(
          commands.has(word),
          `${path}: \`${command}\` names unknown command ${word}`,
        );
      for (const flag of command.match(/--[a-z][a-z-]*/g) ?? [])
        assert.ok(
          flags.has(flag),
          `${path}: \`${command}\` uses unknown ${flag}`,
        );
    }
  }
  assert.ok(checked > 40, `only ${checked} factory commands found in the docs`);
});
