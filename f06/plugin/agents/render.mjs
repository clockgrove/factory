#!/usr/bin/env node
// Render agents/source.json into the three harness formats. Node 22, no dependencies.
//   node agents/render.mjs            writes claude/, codex/, copilot/ beside this file
// The model is pinned in every file and never passed at spawn time (Codex drops a
// spawn-time model for role agents). A null copilot model means Copilot's default:
// the file then carries no model line and no model-policy, since there is nothing to require.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { agents } = JSON.parse(readFileSync(join(here, "source.json"), "utf8"));

const yamlString = (s) => JSON.stringify(s);
const tomlString = (s) => JSON.stringify(s);
const tomlMultiline = (s) => `"""\n${s.replace(/\\/g, "\\\\").replace(/"""/g, '\\"""')}\n"""`;

function claude(a) {
  return [
    "---",
    `name: ${a.name}`,
    `description: ${yamlString(a.description)}`,
    `tools: ${a.tools.join(", ")}`,
    `model: ${a.models.claude}`,
    "---",
    "",
    a.instructions,
    "",
  ].join("\n");
}

function codex(a) {
  const m = a.models.codex;
  return [
    `name = ${tomlString(a.name)}`,
    `description = ${tomlString(a.description)}`,
    `developer_instructions = ${tomlMultiline(a.instructions)}`,
    `model = ${tomlString(m.model)}`,
    `model_reasoning_effort = ${tomlString(m.reasoning_effort)}`,
    "",
  ].join("\n");
}

// Copilot CLI tool names differ from Claude Code's; map and dedupe (assumption recorded in NOTES.md).
const copilotTool = { Read: "read", Edit: "edit", Write: "edit", Grep: "search", Glob: "search", Bash: "shell" };

function copilot(a) {
  const tools = [...new Set(a.tools.map((t) => copilotTool[t] ?? t.toLowerCase()))];
  const lines = [
    "---",
    `name: ${a.name}`,
    `description: ${yamlString(a.description)}`,
    `tools: [${tools.map(yamlString).join(", ")}]`,
  ];
  if (a.models.copilot) {
    lines.push(`model: ${a.models.copilot}`, "model-policy: required");
  }
  lines.push("---", "", a.instructions, "");
  return lines.join("\n");
}

const targets = [
  ["claude", (a) => `${a.name}.md`, claude],
  ["codex", (a) => `${a.name}.toml`, codex],
  ["copilot", (a) => `${a.name}.agent.md`, copilot],
];

for (const [dir, fileName, render] of targets) {
  mkdirSync(join(here, dir), { recursive: true });
  for (const a of agents) {
    const file = join(here, dir, fileName(a));
    writeFileSync(file, render(a));
    console.log(`wrote ${file}`);
  }
}
