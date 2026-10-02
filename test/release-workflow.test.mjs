import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  archivePaths,
  releaseTree,
  retireTestScratch,
  tagProtection,
  testCounts,
  verifyProtection,
  verifyReleaseIntegrity,
} from "../scripts/release.mjs";

test("release retains the real Node child compile cache and removes only the test scratch", (t) => {
  const root = mkdtempSync("/tmp/factory-release-cache-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, "scratch");
  const output = join(root, "evidence");
  mkdirSync(scratch);
  mkdirSync(output);
  const module = join(root, "fixture.mjs");
  writeFileSync(module, "export const value = 42;\n");
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { enableCompileCache } from "node:module"; enableCompileCache(); await import(${JSON.stringify(module)});`,
    ],
    {
      // These are the relevant unchanged sanitized child variables; cache controls are absent.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: scratch },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const cache = join(scratch, "node-compile-cache");
  const cacheFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? cacheFiles(join(dir, entry.name))
        : [join(dir, entry.name)],
    );
  const before = cacheFiles(cache).map((path) => [
    path.slice(cache.length + 1),
    readFileSync(path),
  ]);
  assert.ok(before.length > 0, "Real imported module must create cache bytes");
  retireTestScratch(scratch, output);
  assert.equal(existsSync(scratch), false);
  for (const [path, bytes] of before)
    assert.deepEqual(
      readFileSync(join(output, "test-node-cache", path)),
      bytes,
    );
});

test("release refuses unexplained scratch and a cache symlink without modifying evidence", (t) => {
  const root = mkdtempSync("/tmp/factory-release-cache-refusal-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const kind of ["unexplained", "symlink"]) {
    const scratch = join(root, kind);
    const output = join(root, `${kind}-evidence`);
    mkdirSync(scratch);
    mkdirSync(output);
    const external = join(root, "external-cache");
    if (kind === "unexplained")
      writeFileSync(join(scratch, "unfinished-fixture"), "preserve me");
    else {
      mkdirSync(external);
      writeFileSync(join(external, "external.txt"), "external bytes");
      symlinkSync(external, join(scratch, "node-compile-cache"));
    }
    assert.throws(
      () => retireTestScratch(scratch, output),
      /retained scratch|not a symlink/,
    );
    assert.ok(existsSync(scratch));
    assert.deepEqual(readdirSync(output), []);
    if (kind === "symlink")
      assert.equal(
        readFileSync(join(external, "external.txt"), "utf8"),
        "external bytes",
      );
  }
});

test("release guard refuses broader scopes, bypass actors and missing deletion protection", () => {
  const expected = tagProtection("1.2.3");
  verifyProtection(
    { ...expected, rules: [...expected.rules].reverse() },
    expected,
  );
  for (const change of [
    { enforcement: "disabled" },
    { target: "branch" },
    { bypass_actors: [{ actor_id: 1 }] },
    { conditions: { ref_name: { include: ["refs/tags/*"], exclude: [] } } },
    { rules: [{ type: "update" }] },
  ])
    assert.throws(() => verifyProtection({ ...expected, ...change }, expected));
  assert.throws(() => tagProtection("1.2.3/other"));
});

test("installed gate rejects zero tests, skipped cases and incomplete test accounting", () => {
  const output =
    "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0";
  assert.equal(testCounts(output).tests, 2);
  for (const bad of [
    output.replace("# skipped 0", "# skipped 1"),
    output.replace("# pass 2", "# pass 1"),
    output.replace("# tests 2", "# tests 0"),
    output.replace("# todo 0", ""),
    `${output}\n# pass 2`,
  ])
    assert.throws(() => testCounts(bad));
});

test("archive gate rejects absolute paths and parent traversal", () => {
  assert.equal(
    archivePaths("package/README.md\npackage/dist/cli.js\n").length,
    2,
  );
  for (const bad of ["/tmp/file", "package/../file", "other/file", ""])
    assert.throws(() => archivePaths(bad));
});

function integrityFixture(t, beforeInstall = () => {}) {
  const root = mkdtempSync("/tmp/factory-release-integrity-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, "unpacked/package");
  mkdirSync(join(packageRoot, "node_modules/transitive"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    '{"name":"public-fixture"}\n',
  );
  writeFileSync(
    join(packageRoot, "node_modules/transitive/cli.js"),
    "original dependency\n",
  );
  writeFileSync(
    join(packageRoot, "node_modules/transitive/other.js"),
    "second dependency\n",
  );
  const archive = join(root, "fixture.tgz");
  execFileSync("tar", [
    "-czf",
    archive,
    "-C",
    join(root, "unpacked"),
    "package",
  ]);
  const archiveSha256 = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  const sums = `${archiveSha256}  fixture.tgz\n`;
  const checksum = join(root, "SHA256SUMS");
  writeFileSync(checksum, sums);
  const unpacked = releaseTree(packageRoot);
  const installed = join(root, "installed");
  cpSync(packageRoot, installed, { recursive: true });
  mkdirSync(join(installed, "node_modules/.bin"));
  symlinkSync(
    "../transitive/cli.js",
    join(installed, "node_modules/.bin/public-cli"),
  );
  // Actual npm bin permission normalization does not change file-byte equality.
  chmodSync(join(installed, "node_modules/transitive/cli.js"), 0o755);
  beforeInstall(installed);
  const installation = releaseTree(installed, true);
  return {
    root,
    archive,
    archiveSha256,
    checksum,
    sums,
    packageRoot,
    unpacked,
    installed,
    installation,
  };
}

test("release integrity retains original archive and complete trees with internal npm bin links", (t) => {
  const baseline = integrityFixture(t);
  assert.equal(verifyReleaseIntegrity(baseline), 3);
  assert.equal(verifyReleaseIntegrity(baseline), 3);
});

for (const [name, change] of [
  ["added", (root) => writeFileSync(join(root, "added.js"), "extra")],
  ["removed", (root) => rmSync(join(root, "package.json"))],
  [
    "mutated transitive dependency",
    (root) =>
      writeFileSync(join(root, "node_modules/transitive/other.js"), "changed"),
  ],
]) {
  test(`initial installed inventory refuses ${name} regular files`, (t) => {
    const baseline = integrityFixture(t, change);
    assert.throws(
      () => verifyReleaseIntegrity(baseline),
      /regular-file inventory differs/,
    );
  });
  test(`post-check installed inventory refuses ${name} regular files`, (t) => {
    const baseline = integrityFixture(t);
    verifyReleaseIntegrity(baseline);
    change(baseline.installed);
    assert.throws(
      () => verifyReleaseIntegrity(baseline),
      /Installed release tree changed/,
    );
    assert(existsSync(baseline.archive));
  });
}

for (const [name, change] of [
  [
    "both trees identically mutated",
    (b) => {
      for (const root of [b.installed, b.packageRoot])
        writeFileSync(join(root, "package.json"), "same changed bytes");
    },
  ],
  [
    "unpacked added file",
    (b) => writeFileSync(join(b.packageRoot, "added.js"), "extra"),
  ],
  ["archive changed", (b) => writeFileSync(b.archive, "new archive")],
  ["checksum changed", (b) => writeFileSync(b.checksum, "new checksum")],
  [
    "installed permissions changed",
    (b) => chmodSync(join(b.installed, "package.json"), 0o777),
  ],
  [
    "installed empty directory added",
    (b) => mkdirSync(join(b.installed, "extra")),
  ],
  [
    "bin link removed",
    (b) => rmSync(join(b.installed, "node_modules/.bin/public-cli")),
  ],
  [
    "bin link added",
    (b) =>
      symlinkSync(
        "../transitive/cli.js",
        join(b.installed, "node_modules/.bin/extra"),
      ),
  ],
  [
    "bin link retargeted",
    (b) => {
      const link = join(b.installed, "node_modules/.bin/public-cli");
      rmSync(link);
      symlinkSync("../transitive/other.js", link);
    },
  ],
  [
    "bin link broken",
    (b) => rmSync(join(b.installed, "node_modules/transitive/cli.js")),
  ],
  [
    "bin link escaping",
    (b) => {
      writeFileSync(join(b.root, "outside.js"), "outside");
      const link = join(b.installed, "node_modules/.bin/public-cli");
      rmSync(link);
      symlinkSync("../../../outside.js", link);
    },
  ],
  [
    "directory replaced by link",
    (b) => {
      const directory = join(b.installed, "node_modules/transitive");
      cpSync(directory, join(b.root, "outside"), { recursive: true });
      rmSync(directory, { recursive: true });
      symlinkSync(join(b.root, "outside"), directory);
    },
  ],
  [
    "archive replaced by link to same bytes",
    (b) => {
      cpSync(b.archive, join(b.root, "other.tgz"));
      rmSync(b.archive);
      symlinkSync("other.tgz", b.archive);
    },
  ],
]) {
  test(`release integrity refuses ${name} after a passing baseline`, (t) => {
    const baseline = integrityFixture(t);
    verifyReleaseIntegrity(baseline);
    change(baseline);
    assert.throws(() => verifyReleaseIntegrity(baseline));
    assert(existsSync(baseline.checksum));
  });
}

for (const tree of ["installed", "packageRoot"]) {
  for (const [name, bit] of [
    ["setuid", 0o4000],
    ["setgid", 0o2000],
    ["sticky", 0o1000],
  ]) {
    test(`release integrity refuses ${name} permission changes in ${tree}`, (t) => {
      const baseline = integrityFixture(t);
      verifyReleaseIntegrity(baseline);
      const file = join(baseline[tree], "package.json");
      chmodSync(file, 0o644 | bit);
      assert.equal(
        releaseTree(baseline[tree], tree === "installed").entries.find(
          (entry) => entry.path === "package.json",
        ).mode,
        0o644 | bit,
      );
      assert.throws(
        () => verifyReleaseIntegrity(baseline),
        /release tree changed/,
      );
      assert(existsSync(file));
    });
  }
}

test("release archive tree refuses links before installed checks", (t) => {
  const baseline = integrityFixture(t);
  symlinkSync("package.json", join(baseline.packageRoot, "alias"));
  assert.throws(
    () => releaseTree(baseline.packageRoot),
    /Unexpected release entry/,
  );
});

function publicFixture(t, corrupt, mutate, complete = false) {
  const root = mkdtempSync("/tmp/factory-release-test-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, "package");
  mkdirSync(pkg);
  const contents = {
    ".codex-plugin/plugin.json": JSON.stringify({ version: "1.2.3" }),
    "skills/director/SKILL.md": "Use Factory on a target repository.\n",
    "skills/setup/SKILL.md": "Bind the target configuration.\n",
  };
  for (const [path, bytes] of Object.entries(contents)) {
    mkdirSync(join(pkg, path, ".."), { recursive: true });
    writeFileSync(join(pkg, path), bytes);
  }
  const archive = join(root, "clockgrove-factory-1.2.3.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const archiveSha256 = sha(readFileSync(archive));
  const sums = `${archiveSha256}  clockgrove-factory-1.2.3.tgz\n`;
  const checksum = join(root, "SHA256SUMS");
  writeFileSync(checksum, sums);
  const checkout = join(root, "marketplace");
  mkdirSync(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git(
    "-c",
    "user.name=Factory Test",
    "-c",
    "user.email=factory@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const source = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const record = {
    status: "LOCAL CHECKS PASS",
    counts: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    tests: ["test/example.test.mjs"],
    testSources: [{ path: "test/example.test.mjs", sha256: "a".repeat(64) }],
    preflights: [{ name: "preflight.mjs", sha256: "b".repeat(64) }],
    installedFilesCompared: 3,
    bundled: [{ path: "node_modules/example", version: "1.0.0" }],
    repository: "clockgrove/factory",
    version: "1.2.3",
    archive: "clockgrove-factory-1.2.3.tgz",
    archiveSha256,
    archiveBytes: readFileSync(archive).length,
    checksumSha256: sha(Buffer.from(sums)),
    source,
    tree,
    rulesetId: 12,
    tagProtection: tagProtection("1.2.3"),
  };
  if (mutate === "guard")
    record.tagProtection.conditions.ref_name.include = ["refs/tags/*"];
  if (mutate === "counts") record.counts.skipped = 1;
  const acceptance = join(root, "acceptance.json");
  writeFileSync(acceptance, JSON.stringify(record));
  writeFileSync(
    join(root, "timing.json"),
    JSON.stringify({ startedUtc: new Date().toISOString() }),
  );
  const fingerprint =
    "https://github.com/clockgrove/factory/issues/1#issuecomment-2";
  const prefix = "repos/clockgrove/factory/";
  const assets = [record.archive, "SHA256SUMS"].map((name) => ({
    name,
    browser_download_url: `https://github.com/clockgrove/factory/releases/download/v1.2.3/${name}`,
  }));
  const replies = {
    [`${prefix}releases/tags/v1.2.3`]: {
      draft: false,
      tag_name: "v1.2.3",
      published_at: "2026-01-01T01:00:00Z",
      html_url: "https://github.com/clockgrove/factory/releases/tag/v1.2.3",
      assets,
    },
    [`${prefix}issues/comments/2`]: {
      html_url: fingerprint,
      created_at: "2026-01-01T00:00:00Z",
      body: [
        source,
        tree,
        archiveSha256,
        record.checksumSha256,
        String(record.archiveBytes),
        `Acceptance SHA256 ${sha(readFileSync(acceptance))}.`,
      ].join(" "),
    },
    [`${prefix}git/ref/tags/v1.2.3`]: {
      object: { type: "tag", sha: "annotated" },
    },
    [`${prefix}git/tags/annotated`]: {
      object: { type: "commit", sha: source },
    },
    [`${prefix}git/commits/${source}`]: { tree: { sha: tree } },
    [`${prefix}rulesets/12`]: record.tagProtection,
  };
  const bin = join(root, "bin");
  mkdirSync(bin);
  const callsFile = join(root, "gh-calls.jsonl");
  writeFileSync(callsFile, "");
  const issueUrl = "https://github.com/clockgrove/factory/issues/1";
  const projectItem = {
    id: "fixture-item",
    isArchived: false,
    content: {
      url: mutate === "completion-project" ? `${issueUrl}00` : issueUrl,
    },
    project: {
      id: "fixture-project",
      number: 2,
      owner: { login: "clockgrove" },
      field: {
        id: "fixture-status",
        options: [{ id: "fixture-done", name: "Done" }],
      },
    },
  };
  replies[`${prefix}issues/1`] = {
    html_url: issueUrl,
    state: "open",
    labels: [
      { name: mutate === "completion-target" ? "trunk" : "release-gate" },
    ],
  };
  const shim = (name, text) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${text}\n`);
    chmodSync(path, 0o755);
  };
  shim(
    "gh",
    `const fs=require('node:fs'); const replies=${JSON.stringify(replies)}; const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(args)+'\\n'); if(args[0]!=='api')process.exit(3);
    const route=args.find(a=>a.startsWith('repos/'));
    const method=args.includes('--method')?args[args.indexOf('--method')+1]:'GET';
    let result;
    if(args[1]==='graphql') {
      const query=args.find(a=>a.startsWith('query='));
      if(query.includes('mutation(')) {
        if(${JSON.stringify(mutate)}==='completion-update')process.exit(9);
        result={data:{updateProjectV2ItemFieldValue:{projectV2Item:{id:'fixture-item',fieldValueByName:{optionId:'fixture-done'}}}}};
      } else result={data:{node:${JSON.stringify(projectItem)}}};
    } else if(method==='POST'&&route===${JSON.stringify(`${prefix}issues/1/comments`)}) {
      const body=JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1])).body;
      result={html_url:${JSON.stringify(`${issueUrl}#issuecomment-3`)},issue_url:'https://api.github.com/repos/clockgrove/factory/issues/1',body};
    } else if(method==='PATCH'&&route===${JSON.stringify(`${prefix}issues/1`)}) {
      if(${JSON.stringify(mutate)}==='completion-close')process.exit(9);
      result={html_url:${JSON.stringify(issueUrl)},state:${JSON.stringify(mutate === "completion-close-ack" ? "open" : "closed")},state_reason:'completed'};
    } else result=replies[route];
    if(!result)process.exit(3); console.log(JSON.stringify(result));`,
  );
  shim(
    "curl",
    `const fs=require('node:fs'); const args=process.argv.slice(2); const name=args[args.indexOf('--output')-1].split('/').pop(); fs.copyFileSync(name==='SHA256SUMS'?${JSON.stringify(checksum)}:${JSON.stringify(archive)},args[args.indexOf('--output')+1]);`,
  );
  const plugin = {
    installed: true,
    enabled: true,
    version: "1.2.3",
    source: { ref: "v1.2.3", url: "https://github.com/clockgrove/factory.git" },
  };
  shim(
    "codex",
    `const fs=require('node:fs'); const home=process.env.CODEX_HOME; if(!home||!fs.statSync(home).isDirectory()||(fs.statSync(home).mode&0o777)!==0o700)process.exit(5); const args=process.argv.slice(2); let result; if(args[1]==='marketplace') result={installedRoot:${JSON.stringify(checkout)}}; else if(args[1]==='add')result={installedPath:${JSON.stringify(pkg)}}; else if(args[1]==='list')result={installed:[${JSON.stringify(plugin)}]}; else process.exit(4); console.log(JSON.stringify(result));`,
  );
  if (corrupt) writeFileSync(archive, "Changed public bytes");
  if (mutate === "acceptance") {
    record.preflights[0].sha256 = "c".repeat(64);
    writeFileSync(acceptance, JSON.stringify(record));
  }
  const output = join(root, "audit");
  const completionOutput = join(root, "completion");
  const acceptanceBefore = readFileSync(acceptance);
  const combined = complete === "combined";
  const auditResult = spawnSync(
    combined ? "/bin/sh" : process.execPath,
    combined
      ? [
          "-c",
          '"$1" "$2" audit --source "$3" --output "$4" --record "$5" --fingerprint "$6" && "$1" "$2" complete --source "$3" --output "$7" --record "$5" --audit-output "$4" --issue "$8" --project-item "$9"',
          "factory-release-audit-complete",
          process.execPath,
          resolve("scripts/release.mjs"),
          checkout,
          output,
          acceptance,
          fingerprint,
          completionOutput,
          mutate === "completion-issue" ? "2" : "1",
          "fixture-item",
        ]
      : [
          resolve("scripts/release.mjs"),
          "audit",
          "--source",
          checkout,
          "--output",
          output,
          "--record",
          acceptance,
          "--fingerprint",
          fingerprint,
        ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    },
  );
  const verification = join(output, "public-verification.json");
  const verificationBefore = existsSync(verification)
    ? readFileSync(verification)
    : undefined;
  let result = auditResult;
  if (complete === true) {
    if (mutate === "completion-acceptance") {
      const changed = JSON.parse(acceptanceBefore);
      changed.counts.tests = 0;
      writeFileSync(acceptance, JSON.stringify(changed));
    }
    if (mutate === "completion-receipt") {
      const receipt = JSON.parse(readFileSync(verification));
      receipt.source = "0".repeat(40);
      writeFileSync(verification, JSON.stringify(receipt));
    }
    if (mutate === "completion-audit") {
      const timing = JSON.parse(readFileSync(join(output, "timing.json")));
      timing.status = "FAILED";
      writeFileSync(join(output, "timing.json"), JSON.stringify(timing));
    }
    result = spawnSync(
      process.execPath,
      [
        resolve("scripts/release.mjs"),
        "complete",
        "--source",
        checkout,
        "--output",
        completionOutput,
        "--record",
        acceptance,
        "--audit-output",
        output,
        "--issue",
        mutate === "completion-issue" ? "2" : "1",
        "--project-item",
        "fixture-item",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
  }
  const calls = readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    result,
    auditResult,
    output,
    completionOutput,
    acceptance,
    acceptanceBefore,
    verification,
    verificationBefore,
    calls,
  };
}

test("independent audit verifies actual archive/plugin bytes and excludes timing from acceptance", (t) => {
  const { result, output, acceptance } = publicFixture(t, false);
  assert.equal(result.status, 0, result.stderr);
  const before = readFileSync(acceptance);
  assert.equal(
    JSON.parse(readFileSync(join(output, "public-verification.json"))).status,
    "PASS",
  );
  writeFileSync(join(output, "timing.json"), "Updated observation\n");
  assert(readFileSync(acceptance).equals(before));
});

test("changed public bytes fail before plugin installation and retain failure timing", (t) => {
  const { result, output } = publicFixture(t, true);
  assert.equal(result.status, 1);
  const timing = JSON.parse(readFileSync(join(output, "timing.json")));
  assert.equal(timing.status, "FAILED");
  assert(!timing.phases.some((phase) => phase.command[0] === "codex"));
});

test("changed acceptance is rejected even when all public artifact identities match", (t) => {
  const { result } = publicFixture(t, false, "acceptance");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Acceptance identity differs/);
});

test("sealed broader protection and skipped local checks cannot pass public audit", (t) => {
  for (const mutate of ["guard", "counts"]) {
    const { result, output } = publicFixture(t, false, mutate);
    assert.equal(result.status, 1);
    assert.equal(
      JSON.parse(readFileSync(join(output, "timing.json"))).status,
      "FAILED",
    );
  }
});

const mutations = (calls) =>
  calls.filter(
    (args) =>
      args.includes("--method") ||
      args.some((arg) => arg.startsWith("query=mutation(")),
  );

test("auditor completion reports verified facts and completes only the bound release tracking", (t) => {
  const {
    result,
    output,
    completionOutput,
    acceptance,
    acceptanceBefore,
    verification,
    verificationBefore,
    calls,
  } = publicFixture(t, false, undefined, true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(mutations(calls).length, 3);
  const body = JSON.parse(
    readFileSync(join(completionOutput, "completion-comment.json")),
  ).body;
  const record = JSON.parse(acceptanceBefore);
  for (const value of [
    record.source,
    record.tree,
    record.archiveSha256,
    "1 installed tests",
    "1 model-free preflights",
    "do not accept live Objectives or adopter pilots",
  ])
    assert(body.includes(value), value);
  const timing = JSON.parse(
    readFileSync(join(completionOutput, "timing.json")),
  );
  assert.equal(timing.status, "RELEASE COMPLETE");
  t.diagnostic(
    `Fixed completion: ${timing.elapsedSeconds.toFixed(3)}s in the local GitHub subprocess fixture; excludes real GitHub latency and agent delivery.`,
  );
  assert(timing.workflowElapsedSeconds >= timing.elapsedSeconds);
  assert.equal(
    timing.publicVerifiedUtc,
    JSON.parse(readFileSync(join(output, "timing.json"))).endedUtc,
  );
  assert(readFileSync(acceptance).equals(acceptanceBefore));
  assert(readFileSync(verification).equals(verificationBefore));
  assert(mutations(calls)[2].includes("option=fixture-done"));
});

test("completion refuses failed/mismatched evidence and wrong tracking targets before mutations", (t) => {
  for (const mutate of [
    "completion-acceptance",
    "completion-receipt",
    "completion-audit",
    "completion-issue",
    "completion-project",
    "completion-target",
  ]) {
    const { result, calls } = publicFixture(t, false, mutate, true);
    assert.equal(result.status, 1, mutate);
    assert.equal(mutations(calls).length, 0, mutate);
  }
  const { result, calls, output } = publicFixture(t, true, undefined, true);
  assert.equal(result.status, 1);
  assert.equal(mutations(calls).length, 0);
  assert.equal(
    JSON.parse(readFileSync(join(output, "timing.json"))).status,
    "FAILED",
  );
});

test("partial tracking failure preserves public PASS and names the outstanding operation", (t) => {
  for (const mutate of [
    "completion-close",
    "completion-close-ack",
    "completion-update",
  ]) {
    const {
      result,
      completionOutput,
      output,
      acceptance,
      acceptanceBefore,
      verification,
      verificationBefore,
      calls,
    } = publicFixture(t, false, mutate, true);
    assert.equal(result.status, 1, mutate);
    const expected =
      mutate === "completion-update"
        ? "Project Done update pending"
        : "issue closure pending";
    assert(result.stderr.includes(expected), result.stderr);
    const timing = JSON.parse(
      readFileSync(join(completionOutput, "timing.json")),
    );
    assert(timing.status.includes(`PUBLIC AUDIT PASS; ${expected}`));
    assert.equal(
      mutations(calls).length,
      mutate === "completion-update" ? 3 : 2,
    );
    assert.equal(
      JSON.parse(readFileSync(join(output, "timing.json"))).status,
      "INDEPENDENT PUBLIC AUDIT PASS",
    );
    assert(readFileSync(acceptance).equals(acceptanceBefore));
    assert(readFileSync(verification).equals(verificationBefore));
  }
});

test("one conditional auditor invocation verifies and completes without an intermediate process handoff", (t) => {
  const {
    result,
    output,
    completionOutput,
    acceptance,
    acceptanceBefore,
    calls,
  } = publicFixture(t, false, undefined, "combined");
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(readFileSync(join(output, "timing.json")));
  const completion = JSON.parse(
    readFileSync(join(completionOutput, "timing.json")),
  );
  assert.equal(audit.status, "INDEPENDENT PUBLIC AUDIT PASS");
  assert.equal(completion.status, "RELEASE COMPLETE");
  assert.equal(completion.publicVerifiedUtc, audit.endedUtc);
  assert(Date.parse(completion.startedUtc) >= Date.parse(audit.endedUtc));
  assert.equal(mutations(calls).length, 3);
  assert(readFileSync(acceptance).equals(acceptanceBefore));
  t.diagnostic(
    `Combined fixture: audit ${audit.elapsedSeconds.toFixed(3)}s; completion ${completion.elapsedSeconds.toFixed(3)}s; gap ${((Date.parse(completion.startedUtc) - Date.parse(audit.endedUtc)) / 1000).toFixed(3)}s. Local subprocess fixture only, not real GitHub latency.`,
  );
});

test("conditional auditor invocation stops on failed public audit before any completion", (t) => {
  const { result, output, completionOutput, calls } = publicFixture(
    t,
    true,
    undefined,
    "combined",
  );
  assert.equal(result.status, 1);
  assert.equal(
    JSON.parse(readFileSync(join(output, "timing.json"))).status,
    "FAILED",
  );
  assert(!existsSync(completionOutput));
  assert.equal(mutations(calls).length, 0);
});

test("conditional auditor invocation preserves public PASS and completed effects on tracking failure", (t) => {
  const {
    result,
    output,
    completionOutput,
    acceptance,
    acceptanceBefore,
    calls,
  } = publicFixture(t, false, "completion-update", "combined");
  assert.equal(result.status, 1);
  assert.equal(
    JSON.parse(readFileSync(join(output, "timing.json"))).status,
    "INDEPENDENT PUBLIC AUDIT PASS",
  );
  assert.equal(
    JSON.parse(readFileSync(join(output, "public-verification.json"))).status,
    "PASS",
  );
  assert.match(
    JSON.parse(readFileSync(join(completionOutput, "timing.json"))).status,
    /Project Done update pending/,
  );
  assert.equal(mutations(calls).length, 3);
  assert(readFileSync(acceptance).equals(acceptanceBefore));
});
