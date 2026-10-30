// The integration suite's lanes share one run directory and, in a wave, one
// moment. Two things collided there:
// - #2190: per-issue files were named by issue number alone (run.1.out), and
//   issue numbers restart in every repository, so lane C's crash-case output
//   sat in the file lane M's Objective #1 would have used.
// - #2191: every case queues at once, and GitHub refuses concurrent changes to
//   one Project ("temporary conflict"): 45 of 101 qualification logs had one.
// gh is a stub here: it records each Project change's start and end.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SUITE = join(import.meta.dirname, "..", "integration");
const CONFLICT =
  "GraphQL: Your attempt to move this item created a temporary conflict. Please try again. (addProjectV2ItemById)";

// A `gh` that takes only Project changes, each 0.1 s long. With GH_STUB_FAIL
// set, each distinct change fails once with that message first; with
// GH_STUB_ALWAYS set, every one fails with it and its arguments.
const GH = `#!/bin/bash
case "$1 $2" in "project item-add"|"project item-edit"|"project item-archive") ;; *) echo "unexpected: gh $*" >&2; exit 9 ;; esac
echo "start $$ $2" >>"$GH_STUB_DIR/calls"
sleep 0.1
key=$(printf '%s' "$*" | md5sum | cut -c1-12)
if [ -n "\${GH_STUB_ALWAYS:-}" ]; then echo "end $$" >>"$GH_STUB_DIR/calls"; echo "$GH_STUB_ALWAYS: $*" >&2; exit 1; fi
if [ -n "\${GH_STUB_FAIL:-}" ] && [ ! -e "$GH_STUB_DIR/failed.$key" ]; then
  : >"$GH_STUB_DIR/failed.$key"; echo "end $$" >>"$GH_STUB_DIR/calls"; echo "$GH_STUB_FAIL" >&2; exit 1
fi
echo "end $$" >>"$GH_STUB_DIR/calls"
[ "$2" != item-add ] || echo "ITEM_$$"
`;

/** A run directory with installations M and X on Project PVT_m (repositories m and c), C and H on PVT_c (repository c). */
function run() {
  const dir = mkdtempSync(join(tmpdir(), "factory-suite-lanes-"));
  const stub = join(dir, "stub");
  mkdirSync(stub);
  writeFileSync(join(stub, "gh"), GH);
  chmodSync(join(stub, "gh"), 0o755);
  const lanes = {
    M: ["example-org/fd-20261028-181930-ab12-m", "m"],
    X: ["example-org/fd-20261028-181930-ab12-c", "m"],
    C: ["example-org/fd-20261028-181930-ab12-c", "c"],
    H: ["example-org/fd-20261028-181930-ab12-c", "c"],
  };
  for (const [inst, [repo, project]] of Object.entries(lanes)) {
    const cfg = join(dir, `config-${inst}.json`);
    writeFileSync(
      cfg,
      JSON.stringify({ queue: { projectId: `PVT_${project}` } }),
    );
    mkdirSync(join(dir, "inst", inst), { recursive: true });
    writeFileSync(
      join(dir, "inst", inst, "env"),
      `INST=${inst}\nREPO=${repo}\nOWNER=${repo.split("/")[0]}\nNAME=${repo.split("/")[1]}\nCUR_CFG=${cfg}\n`,
    );
    writeFileSync(
      join(dir, `project.${inst}.json`),
      JSON.stringify({
        id: `PVT_${project}`,
        number: project === "m" ? 1 : 2,
        owner: { login: "example-org" },
        field: { id: "FIELD", options: [{ id: "OPT_Q", name: "Queued" }] },
      }),
    );
  }
  return { dir, stub };
}

function suite({ dir, stub }, script, env = {}, timeout = 60000) {
  return spawnSync(
    "bash",
    [
      "-c",
      `source "$SUITE/lib/common.sh"; source "$SUITE/lib/gh.sh"; ${script}`,
    ],
    {
      encoding: "utf8",
      timeout,
      env: {
        ...process.env,
        PATH: `${stub}:${process.env.PATH}`,
        SUITE,
        RUN_DIR: dir,
        GH_STUB_DIR: stub,
        PROJECT_PAUSE: "0",
        ...env,
      },
    },
  );
}

function calls({ stub }) {
  const f = join(stub, "calls");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : [];
}

/** Changes that ran at the same time: a start before the previous change's end. */
function overlaps(lines) {
  const out = [];
  let open = null;
  for (const line of lines) {
    const [what, pid] = line.split(" ");
    if (what === "start") {
      if (open) out.push(`${pid} started during ${open}`);
      open = pid;
    } else if (open === pid) open = null;
  }
  return out;
}

test("issue keys name the repository: lanes on two repositories never share an issue's files, installations on one do (#2190)", () => {
  const r = run();
  const p = suite(
    r,
    'for i in M C H; do (inst $i; echo "$i $(issue_key 1)"); done',
  );
  assert.equal(p.status, 0, p.stderr);
  const keys = Object.fromEntries(
    p.stdout
      .trim()
      .split("\n")
      .map((l) => l.split(" ")),
  );
  assert.equal(keys.M, "example-org_fd-20261028-181930-ab12-m.1");
  assert.equal(keys.C, "example-org_fd-20261028-181930-ab12-c.1");
  assert.notEqual(keys.M, keys.C);
  assert.equal(keys.H, keys.C);
});

test("queueing issue #1 on two lanes at once keeps each lane's error in its own file (#2190)", () => {
  const r = run();
  // gh_retry's pauses are the stub's business here, not the test's.
  const p = suite(
    r,
    "sleep() { :; }; (inst M; queue_issue 1) & (inst C; queue_issue 1) & wait",
    { GH_STUB_ALWAYS: "HTTP 502" },
  );
  assert.equal(p.status, 0, p.stderr);
  const errs = readdirSync(r.dir).filter((f) => f.startsWith("enqueue."));
  assert.deepEqual(errs.sort(), [
    "enqueue.example-org_fd-20261028-181930-ab12-c.1.err",
    "enqueue.example-org_fd-20261028-181930-ab12-m.1.err",
  ]);
  for (const [file, repo] of [
    [errs[0], "ab12-c/issues/1"],
    [errs[1], "ab12-m/issues/1"],
  ]) {
    const text = readFileSync(join(r.dir, file), "utf8");
    assert.match(text, /HTTP 502/);
    assert.ok(text.includes(repo), `${file}: ${text}`);
  }
});

test("a wave's concurrent queueing on one Project never overlaps its changes (#2191)", () => {
  const r = run();
  // Four cases on installation M and four on X, both on Project PVT_m.
  const p = suite(
    r,
    "for n in 1 2 3 4; do (inst M; queue_issue $n) & (inst X; queue_issue 1$n) & done; wait",
  );
  assert.equal(p.status, 0, p.stderr);
  const lines = calls(r);
  assert.equal(lines.filter((l) => l.startsWith("start")).length, 16);
  assert.deepEqual(overlaps(lines), []);
  const journal = readFileSync(join(r.dir, "journal"), "utf8");
  assert.equal((journal.match(/queued #/g) ?? []).length, 8);
});

test("a Project's lock holds back only its own changes", () => {
  const r = run();
  // Project PVT_m's lock is held throughout: a change on PVT_c still runs.
  const p = suite(
    r,
    'exec 9>"$RUN_DIR/project.PVT_m.lock"; flock 9; inst C; project_write item-archive 2 --owner example-org --id ITEM && echo changed',
    {},
    10000,
  );
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.trim(), "changed");
});

test("a Project conflict is tried again under the lock, never a queueing failure (#2191)", () => {
  const r = run();
  const p = suite(r, "inst M; queue_issue 3", { GH_STUB_FAIL: CONFLICT });
  assert.equal(p.status, 0, p.stderr);
  const lines = calls(r).filter((l) => l.startsWith("start"));
  // The add and the edit each refused once, then done.
  assert.equal(lines.length, 4);
  const journal = readFileSync(join(r.dir, "journal"), "utf8");
  assert.match(journal, /Project conflict on 'gh project item-add' \(try 1\)/);
  assert.match(journal, /Project conflict on 'gh project item-edit' \(try 1\)/);
  assert.match(journal, /queued #3/);
  assert.doesNotMatch(journal, /queueing #3 failed/);
});

test("any other refusal is not a conflict: project_write fails at once with gh's error", () => {
  const r = run();
  const p = suite(
    r,
    "inst M; project_write item-archive 1 --owner example-org --id ITEM",
    { GH_STUB_ALWAYS: "HTTP 401: Bad credentials" },
  );
  assert.equal(p.status, 1);
  assert.match(p.stderr, /HTTP 401: Bad credentials/);
  assert.equal(calls(r).filter((l) => l.startsWith("start")).length, 1);
});

test("a conflict that lasts gives up after five tries with gh's error", () => {
  const r = run();
  const p = suite(
    r,
    "inst M; project_write item-archive 1 --owner example-org --id ITEM",
    { GH_STUB_ALWAYS: CONFLICT },
  );
  assert.equal(p.status, 1);
  assert.match(p.stderr, /temporary conflict/);
  assert.doesNotMatch(p.stderr, /trying again/);
  assert.equal(calls(r).filter((l) => l.startsWith("start")).length, 5);
});
