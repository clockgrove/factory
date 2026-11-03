import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const { BENCH_TREE_A, BENCH_TREE_B, BENCH_OUT, BENCH_OBJECTIVE } = process.env;
if (existsSync(join(BENCH_TREE_A, ".git"))) process.exit(3);
const a = readFileSync(join(BENCH_TREE_A, "f.txt"), "utf8"), b = readFileSync(join(BENCH_TREE_B, "f.txt"), "utf8");
const pick = a.includes("quoted") ? "A" : b.includes("quoted") ? "B" : "tie";
writeFileSync(BENCH_OUT, JSON.stringify({ judgeVersion: "stub 1", intent: pick, quality: "tie", reasons: readFileSync(BENCH_OBJECTIVE, "utf8").slice(0, 20) }));
