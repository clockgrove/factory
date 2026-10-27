#!/usr/bin/env node
// The scope case's roles among a plan's Work Items (integration/cases/prd.sh).
//
//   node scope-roles.mjs ITEMS     prints "BASE TOP SOLO", or an empty line
//                                  when the plan doesn't fit
//
// ITEMS is p_items' output: one "ID KIND DEP,DEP" line per item ("-" for no
// dependencies). The plan fits when it has exactly three work items, one (top)
// depending on another (base) and the third (solo) independent of both, and
// every other item is a read-only node: QA, or an aggregate that only settles
// once its children have (Factory's plan check makes an aggregate depend on its
// children, and neither kind runs a worker or delivers a PR, so neither changes
// which items hold or merge).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const READ_ONLY = new Set(["qa", "aggregate"]);

/** [base, top, solo] from p_items' lines, or undefined when the plan doesn't fit. */
export function scopeRoles(text) {
  const rows = text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => row[0]);
  const deps = new Map(
    rows
      .filter(([, kind]) => kind === "work")
      .map(([id, , dep]) => [id, !dep || dep === "-" ? [] : dep.split(",")]),
  );
  const tops = [...deps].filter(([, d]) => d.length).map(([id]) => id);
  const bases = [...new Set(tops.flatMap((id) => deps.get(id)))].sort();
  const solos = [...deps]
    .filter(([id, d]) => !d.length && !bases.includes(id))
    .map(([id]) => id);
  const fits =
    deps.size === 3 &&
    tops.length === 1 &&
    bases.length === 1 &&
    solos.length === 1 &&
    rows.every(([, kind]) => kind === "work" || READ_ONLY.has(kind));
  return fits ? [bases[0], tops[0], solos[0]] : undefined;
}

// Run as a command, also through a symlinked suite path: Node resolves the
// main module's symlinks for import.meta.url but not for argv[1].
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const roles = scopeRoles(process.argv[2] ?? "");
  console.log(roles ? roles.join(" ") : "");
}
