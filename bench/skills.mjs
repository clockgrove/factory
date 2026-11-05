#!/usr/bin/env node
/**
 * `node bench/skills.mjs [--plugin DIR] [--out bench/skills.json] [--check]`: record the
 * skills as versioned text. One entry per skill with its SHA-256, line and word counts,
 * and a digest over all of them; the scorecard carries the digest so every row names the
 * skills it ran on (PLAN.md: skills are versioned in the bench, one page each, and no line
 * is added without a scored Objective). `--check` exits 3 when the recorded digest differs
 * from the tree (a skill changed without a new record).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const SKILL_PAGE = { lines: 60, words: 700 };

export function recordSkills(pluginDir) {
  const dir = join(pluginDir, "skills");
  const skills = {};
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    skills[name] = { sha256: createHash("sha256").update(text).digest("hex"), lines: text.split("\n").length, words: text.split(/\s+/).filter(Boolean).length };
  }
  const digest = createHash("sha256").update(Object.entries(skills).map(([n, s]) => `${n}:${s.sha256}`).join("\n")).digest("hex").slice(0, 12);
  return { version: 1, digest, skills };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { plugin: { type: "string" }, out: { type: "string" }, check: { type: "boolean" } } });
  const plugin = resolve(values.plugin ?? join(import.meta.dirname, "..", "plugin"));
  const out = resolve(values.out ?? join(import.meta.dirname, "skills.json"));
  const rec = recordSkills(plugin);
  const over = Object.entries(rec.skills).filter(([, s]) => s.lines > SKILL_PAGE.lines || s.words > SKILL_PAGE.words);
  if (over.length) {
    process.stderr.write(`over the one-page cap (${SKILL_PAGE.lines} lines, ${SKILL_PAGE.words} words): ${over.map(([n, s]) => `${n} (${s.lines} lines, ${s.words} words)`).join(", ")}\n`);
    process.exit(2);
  }
  if (values.check) {
    const prev = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
    if (!prev || prev.digest !== rec.digest) {
      process.stderr.write(`skills changed since ${out} (${prev?.digest ?? "none"} → ${rec.digest}); record them with node bench/skills.mjs after a scored Objective\n`);
      process.exit(3);
    }
    process.stdout.write(`skills unchanged: ${rec.digest}\n`);
  } else {
    writeFileSync(out, `${JSON.stringify({ ...rec, recordedAt: new Date().toISOString() }, null, 2)}\n`);
    process.stdout.write(`${out}: ${Object.keys(rec.skills).length} skills, digest ${rec.digest}\n`);
  }
}
