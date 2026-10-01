// Contributor release procedure. No Factory runtime or provider operations.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const repository = "clockgrove/factory";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

export function tagProtection(version) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  return {
    name: `Immutable Factory v${version} release tag`,
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: { include: [`refs/tags/v${version}`], exclude: [] },
    },
    rules: [{ type: "update" }, { type: "deletion" }],
  };
}

export function verifyProtection(actual, expected) {
  for (const key of [
    "name",
    "target",
    "enforcement",
    "bypass_actors",
    "conditions",
  ])
    assert.deepEqual(
      actual[key],
      expected[key],
      `Tag protection differs: ${key}`,
    );
  assert.deepEqual(actual.rules.map((rule) => rule.type).sort(), [
    "deletion",
    "update",
  ]);
  assert.equal(actual.rules.length, 2);
}

export function testCounts(output) {
  const result = {};
  for (const name of [
    "tests",
    "pass",
    "fail",
    "cancelled",
    "skipped",
    "todo",
  ]) {
    const matches = [
      ...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm")),
    ];
    assert.equal(matches.length, 1, `Missing or ambiguous test count: ${name}`);
    result[name] = Number(matches[0][1]);
  }
  assert(
    result.tests > 0 && result.tests === result.pass,
    "Not all installed tests passed",
  );
  for (const name of ["fail", "cancelled", "skipped", "todo"])
    assert.equal(result[name], 0, name);
  return result;
}

export function archivePaths(list) {
  const paths = list.trim().split("\n");
  assert(paths.length > 0);
  for (const path of paths)
    assert(
      path.startsWith("package/") && !path.split("/").includes(".."),
      `Unsafe archive path: ${path}`,
    );
  return paths;
}

function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { values: options, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      source: { type: "string", default: process.cwd() },
      output: { type: "string" },
      ci: { type: "string" },
      review: { type: "string" },
      issue: { type: "string" },
      test: { type: "string", multiple: true },
      "test-tool": { type: "string", multiple: true },
      preflight: { type: "string", multiple: true },
      publish: { type: "boolean", default: false },
      record: { type: "string" },
      codex: { type: "string", default: "codex" },
      fingerprint: { type: "string" },
    },
  });
  const mode = positionals[0];
  assert(
    ["release", "audit"].includes(mode) && positionals.length === 1,
    "Usage: node scripts/release.mjs release|audit --output /absolute/fresh-directory [options]",
  );
  assert(
    options.output && isAbsolute(options.output),
    "Output must be a fresh absolute directory",
  );
  const output = resolve(options.output);
  assert(
    !existsSync(output),
    "Output already exists; preserve it and diagnose before a new attempt",
  );
  mkdirSync(output, { mode: 0o700 });
  const started = new Date().toISOString();
  const clock = performance.now();
  const phases = [];
  let commandSeconds = 0;
  let commandIndex = 0;
  const source = realpathSync(options.source);
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  const environment = {
    ...process.env,
    NODE_COMPILE_CACHE: join(output, "node-cache"),
  };
  const run = (args, settings = {}) => {
    const start = performance.now();
    const result = spawnSync(args[0], args.slice(1), {
      cwd: settings.cwd ?? source,
      env: settings.env ?? environment,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: settings.timeout ?? 300_000,
    });
    const seconds = (performance.now() - start) / 1000;
    commandSeconds += seconds;
    const index = ++commandIndex;
    writeFileSync(
      join(output, `${index}.log`),
      `${result.stdout ?? ""}${result.stderr ?? ""}`,
      { flag: "wx" },
    );
    phases.push({
      command: args,
      startedUtc: new Date(Date.now() - seconds * 1000).toISOString(),
      seconds,
      exitCode: result.status,
    });
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      `${args[0]} failed; see ${output}/${index}.log`,
    );
    return result.stdout.trim();
  };
  const api = (...args) => JSON.parse(run(["gh", "api", ...args]));
  const git = (...args) => run(["git", ...args]);
  const frozen = () => {
    assert.equal(
      git("status", "--porcelain"),
      "",
      "Source checkout must remain clean",
    );
    return {
      source: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
    };
  };
  let status = "FAILED";
  try {
    let record;
    if (mode === "release") {
      assert(
        options.ci && options.review,
        "Exact-candidate CI and independent review references are required",
      );
      assert.match(
        options.review,
        /^https:\/\/github\.com\/clockgrove\/factory\/(pull|issues)\/\d+(?:#.*)?$/,
      );
      assert(
        options.test?.length,
        "Select whole committed installed test files; no test-name filters",
      );
      assert(
        options.preflight?.length,
        "Supply the reviewed model-free preflights required for this candidate/scenario",
      );
      assert(!options.record, "Release creates its own acceptance record");
      assert(
        !output.startsWith(`${source}${sep}`),
        "Evidence must be outside the source checkout",
      );
      assert(
        [
          `https://github.com/${repository}.git`,
          `git@github.com:${repository}.git`,
        ].includes(git("remote", "get-url", "origin")),
      );
      const identity = frozen();
      const manifest = json(join(source, "package.json"));
      const version = manifest.version;
      const protection = tagProtection(version);
      assert.equal(
        json(join(source, ".codex-plugin/plugin.json")).version,
        version,
      );
      assert.equal(
        json(join(source, ".agents/plugins/marketplace.json")).plugins[0].source
          .ref,
        `v${version}`,
      );
      if (options.publish) {
        assert(
          options.issue && /^\d+$/.test(options.issue),
          "Publication needs its existing acceptance issue",
        );
        assert.equal(
          git("ls-remote", "--tags", "origin", `refs/tags/v${version}`),
          "",
          "Tag already exists; never republish",
        );
      }
      const ci = JSON.parse(
        run([
          "gh",
          "run",
          "view",
          options.ci,
          "--repo",
          repository,
          "--json",
          "status,conclusion,headSha,name,url",
        ]),
      );
      assert(
        ci.status === "completed" &&
          ci.conclusion === "success" &&
          ci.headSha === identity.source &&
          ci.name === "Quality",
        "CI must pass on this exact source",
      );
      // The independently reviewed source and packaged prose supply the semantic guidance check.
      // The script checks their identity, not editorial phrases or historical issue numbers.
      run(["npm", "ci"]);
      run(["npm", "run", "build"]);
      const artifacts = join(output, "artifacts");
      mkdirSync(artifacts);
      const packed = JSON.parse(
        run(["npm", "pack", "--json", "--pack-destination", artifacts]),
      );
      assert.equal(packed.length, 1);
      assert.equal(packed[0].version, version);
      const name = `clockgrove-factory-${version}.tgz`;
      assert.equal(packed[0].filename, name);
      const archive = join(artifacts, name);
      const archiveSha256 = digest(readFileSync(archive));
      const sums = `${archiveSha256}  ${name}\n`;
      writeFileSync(join(artifacts, "SHA256SUMS"), sums, { flag: "wx" });
      archivePaths(run(["tar", "-tzf", archive]));
      const extracted = join(output, "unpacked");
      mkdirSync(extracted);
      run([
        "tar",
        "-xzf",
        archive,
        "--directory",
        extracted,
        "--no-same-owner",
      ]);
      const packageRoot = join(extracted, "package");
      const prefix = join(output, "prefix");
      const cache = join(output, "empty-cache");
      mkdirSync(prefix);
      mkdirSync(cache);
      run([
        "npm",
        "install",
        "--offline",
        "--prefix",
        prefix,
        "--cache",
        cache,
        archive,
      ]);
      const installed = join(prefix, "node_modules/@clockgrove/factory");
      let compared = 0;
      for (const path of files(packageRoot)) {
        const rel = relative(packageRoot, path);
        assert(
          readFileSync(path).equals(readFileSync(join(installed, rel))),
          `Installed byte mismatch: ${rel}`,
        );
        compared++;
      }
      const guidance = [
        "package.json",
        ".codex-plugin/plugin.json",
        "README.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "skills/director/SKILL.md",
        "skills/setup/SKILL.md",
        "assets/factory-mark.svg",
        ...manifest.files.filter((path) => path.startsWith("docs/")),
      ];
      for (const path of guidance)
        assert(
          readFileSync(join(installed, path)).equals(
            readFileSync(join(source, path)),
          ),
          `Archived source mismatch: ${path}`,
        );
      const lock = json(join(source, "package-lock.json")).packages;
      const notices = readFileSync(
        join(installed, "THIRD_PARTY_NOTICES.md"),
        "utf8",
      );
      const bundled = [];
      for (const path of files(join(installed, "node_modules"))) {
        if (!path.endsWith(`${sep}package.json`)) continue;
        const key = relative(installed, dirname(path));
        if (
          !/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(
            key,
          )
        )
          continue;
        assert(lock[key], `Bundled dependency absent from lock: ${key}`);
        const dependency = json(path);
        assert.equal(
          dependency.version,
          lock[key].version,
          `Bundled version: ${key}`,
        );
        const installName = key.split("node_modules/").at(-1);
        assert(
          notices.includes(`| \`${installName}\` | ${dependency.version} |`),
          `Missing notice: ${key}`,
        );
        bundled.push({ path: key, version: dependency.version });
      }
      assert(bundled.length > 0, "No bundled dependencies checked");
      for (const name of manifest.bundledDependencies ??
        manifest.bundleDependencies ??
        [])
        assert(
          bundled.some((entry) => entry.path === `node_modules/${name}`),
          `Missing bundled root: ${name}`,
        );
      run([join(prefix, "node_modules/.bin/factory"), "help"]);
      const stage = join(output, "installed-checks");
      mkdirSync(stage);
      symlinkSync(join(installed, "dist"), join(stage, "dist"));
      symlinkSync(join(installed, "node_modules"), join(stage, "node_modules"));
      // Both production modules and dependencies resolve from the installed package.
      const fixturePaths = git("ls-files", "test/support", "test/fixtures")
        .split("\n")
        .filter(Boolean);
      const selections = [...new Set([...options.test, ...fixturePaths])];
      const testSources = [];
      for (const path of selections) {
        assert(
          path.startsWith("test/") && !path.split("/").includes(".."),
          `Invalid committed test path: ${path}`,
        );
        const bytes = readFileSync(join(source, path));
        assert.equal(
          git("hash-object", "--no-filters", path),
          git("rev-parse", `${identity.source}:${path}`),
          `Test differs from source: ${path}`,
        );
        mkdirSync(dirname(join(stage, path)), { recursive: true });
        writeFileSync(join(stage, path), bytes);
        testSources.push({ path, sha256: digest(bytes) });
      }
      const preload = join(output, "no-network.mjs");
      writeFileSync(
        preload,
        'globalThis.fetch = async () => { throw new Error("Release model-free checks attempted network"); };\n',
      );
      // Keep Unix socket test paths short and host compile cache outside fixture roots.
      const testTmp = mkdtempSync("/tmp/fr-");
      const testToolRoot = join(output, "test-tools");
      mkdirSync(testToolRoot);
      const testTools = [];
      for (const name of options["test-tool"] ?? []) {
        assert.match(name, /^(?:@[\w.-]+\/)?[\w.-]+$/);
        const key = `node_modules/${name}`;
        assert(
          lock[key]?.dev === true,
          `Test tool must be locked dev-only: ${name}`,
        );
        const path = join(source, key);
        const bytes = readFileSync(join(path, "package.json"));
        assert.equal(JSON.parse(bytes).version, lock[key].version);
        mkdirSync(dirname(join(testToolRoot, name)), { recursive: true });
        symlinkSync(path, join(testToolRoot, name));
        testTools.push({
          name,
          version: lock[key].version,
          packageSha256: digest(bytes),
        });
      }
      const testEnvironment = {
        ...environment,
        TMPDIR: testTmp,
        NODE_PATH: testToolRoot,
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(),
      };
      const tested = run(
        [
          process.execPath,
          "--test",
          "--test-reporter=tap",
          "--test-concurrency=1",
          ...options.test,
        ],
        { cwd: stage, env: testEnvironment },
      );
      const counts = testCounts(tested);
      assert.deepEqual(
        readdirSync(testTmp),
        [],
        `Tests retained scratch; preserve ${testTmp} for diagnosis`,
      );
      rmdirSync(testTmp);
      const preflights = [];
      for (const path of options.preflight) {
        const absolute = resolve(source, path);
        const bytes = readFileSync(absolute);
        const workspace = join(output, `preflight-${preflights.length + 1}`);
        run([process.execPath, absolute, installed, workspace], {
          env: { ...testEnvironment, TMPDIR: "/tmp" },
        });
        assert.equal(
          digest(readFileSync(absolute)),
          digest(bytes),
          "Preflight source changed during execution",
        );
        preflights.push({
          name: relative(source, absolute),
          sha256: digest(bytes),
        });
      }
      assert.deepEqual(frozen(), identity);
      record = {
        ...identity,
        repository,
        version,
        archive: name,
        archiveSha256,
        archiveBytes: statSync(archive).size,
        checksumSha256: digest(Buffer.from(sums)),
        ci: ci.url,
        independentSourceReview: options.review,
        installedFilesCompared: compared,
        bundled,
        tests: options.test,
        testSources,
        testTools,
        counts,
        preflights,
        tagProtection: protection,
        status: "LOCAL CHECKS PASS",
      };
      if (options.publish) {
        assert(
          options.issue && /^\d+$/.test(options.issue),
          "Publication needs its existing acceptance issue",
        );
        assert.equal(api(`repos/${repository}`).full_name, repository);
        const matches = api(`repos/${repository}/rulesets`).filter(
          (rule) => rule.name === protection.name,
        );
        assert(matches.length <= 1);
        let rule;
        if (matches.length)
          rule = api(`repos/${repository}/rulesets/${matches[0].id}`);
        else {
          const proposal = join(output, "tag-protection.json");
          save(proposal, protection);
          rule = api(
            "--method",
            "POST",
            `repos/${repository}/rulesets`,
            "--input",
            proposal,
          );
        }
        verifyProtection(
          api(`repos/${repository}/rulesets/${rule.id}`),
          protection,
        );
        record.rulesetId = rule.id;
      }
      // Seal exactly once. No timing or mutable ledger is part of this identity.
      save(join(output, "acceptance.json"), record);
      if (options.publish) {
        const fingerprint = `Expected v${version} before publication: source ${identity.source}, tree ${identity.tree}; ${name}: ${record.archiveBytes} bytes, SHA256 ${archiveSha256}; SHA256SUMS SHA256 ${record.checksumSha256}. Acceptance SHA256 ${digest(readFileSync(join(output, "acceptance.json")))}. Independent public verification pending.`;
        const body = join(output, "fingerprint.md");
        writeFileSync(body, fingerprint);
        run([
          "gh",
          "issue",
          "comment",
          options.issue,
          "--repo",
          repository,
          "--body-file",
          body,
        ]);
        git(
          "tag",
          "-a",
          `v${version}`,
          identity.source,
          "-m",
          `Factory v${version}`,
        );
        git("push", "origin", `refs/tags/v${version}`);
        run([
          "gh",
          "release",
          "create",
          `v${version}`,
          archive,
          join(artifacts, "SHA256SUMS"),
          "--repo",
          repository,
          "--verify-tag",
          "--title",
          `Factory v${version}`,
          "--notes-file",
          body,
        ]);
        verifyProtection(
          api(`repos/${repository}/rulesets/${record.rulesetId}`),
          protection,
        );
      }
      status = options.publish
        ? "PUBLISHED; independent public audit required"
        : "LOCAL BASELINE PASS; no publication";
    } else {
      assert(
        options.record &&
          options.fingerprint &&
          !options.publish &&
          !options.ci &&
          !options.test &&
          !options.preflight,
        "Audit takes the sealed acceptance record, prepublication comment URL and a fresh output",
      );
      record = json(options.record);
      assert.equal(record.repository, repository);
      assert.equal(
        record.status,
        "LOCAL CHECKS PASS",
        "Sealed local acceptance is required",
      );
      assert(
        record.counts?.tests > 0 && record.counts.tests === record.counts.pass,
      );
      for (const name of ["fail", "cancelled", "skipped", "todo"])
        assert.equal(record.counts[name], 0, name);
      assert(record.tests?.length > 0 && record.preflights?.length > 0);
      for (const path of record.tests)
        assert(
          record.testSources.some(
            (entry) =>
              entry.path === path && /^[a-f0-9]{64}$/.test(entry.sha256),
          ),
        );
      for (const preflight of record.preflights)
        assert(preflight.name && /^[a-f0-9]{64}$/.test(preflight.sha256));
      assert(record.installedFilesCompared > 0 && record.bundled?.length > 0);
      const expectedProtection = tagProtection(record.version);
      verifyProtection(record.tagProtection, expectedProtection);
      assert(
        record.rulesetId,
        "Acceptance must include actual publication tag protection",
      );
      const release = api(
        `repos/${repository}/releases/tags/v${record.version}`,
      );
      assert(!release.draft && release.tag_name === `v${record.version}`);
      assert.match(
        options.fingerprint,
        /^https:\/\/github\.com\/clockgrove\/factory\/(issues|pull)\/\d+#issuecomment-\d+$/,
      );
      const comment = api(
        `repos/${repository}/issues/comments/${options.fingerprint.split("issuecomment-")[1]}`,
      );
      assert.equal(comment.html_url, options.fingerprint);
      const acceptanceDigest = digest(readFileSync(options.record));
      assert.equal(
        comment.body.match(/\bAcceptance SHA256 ([a-f0-9]{64})\./)?.[1],
        acceptanceDigest,
        "Acceptance identity differs from the prepublication fingerprint",
      );
      assert(
        comment.created_at < release.published_at,
        "Fingerprint was not recorded before publication",
      );
      for (const value of [
        record.source,
        record.tree,
        record.archiveSha256,
        record.checksumSha256,
        String(record.archiveBytes),
      ])
        assert(
          comment.body.includes(value),
          "Public fingerprint does not bind this artifact",
        );
      const assets = new Map(
        release.assets.map((asset) => [asset.name, asset]),
      );
      for (const name of [record.archive, "SHA256SUMS"]) {
        const expectedUrl = `https://github.com/${repository}/releases/download/v${record.version}/${name}`;
        assert.equal(assets.get(name)?.browser_download_url, expectedUrl);
        run([
          "curl",
          "-q",
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          expectedUrl,
          "--output",
          join(output, name),
        ]);
      }
      assert.equal(
        digest(readFileSync(join(output, record.archive))),
        record.archiveSha256,
      );
      assert.equal(
        statSync(join(output, record.archive)).size,
        record.archiveBytes,
      );
      assert.equal(
        digest(readFileSync(join(output, "SHA256SUMS"))),
        record.checksumSha256,
      );
      assert.equal(
        readFileSync(join(output, "SHA256SUMS"), "utf8"),
        `${record.archiveSha256}  ${record.archive}\n`,
      );
      const ref = api(`repos/${repository}/git/ref/tags/v${record.version}`);
      assert.equal(ref.object.type, "tag");
      const tag = api(`repos/${repository}/git/tags/${ref.object.sha}`);
      assert.equal(tag.object.type, "commit");
      assert.equal(tag.object.sha, record.source);
      assert.equal(
        api(`repos/${repository}/git/commits/${record.source}`).tree.sha,
        record.tree,
      );
      verifyProtection(
        api(`repos/${repository}/rulesets/${record.rulesetId}`),
        expectedProtection,
      );
      const pluginEnvironment = {
        ...environment,
        CODEX_HOME: join(output, "plugin-home"),
      };
      mkdirSync(pluginEnvironment.CODEX_HOME, { mode: 0o700 });
      const marketplace = JSON.parse(
        run(
          [
            options.codex,
            "plugin",
            "marketplace",
            "add",
            repository,
            "--ref",
            `v${record.version}`,
            "--json",
          ],
          { env: pluginEnvironment },
        ),
      );
      const plugin = JSON.parse(
        run([options.codex, "plugin", "add", "factory@clockgrove", "--json"], {
          env: pluginEnvironment,
        }),
      );
      const listing = JSON.parse(
        run([options.codex, "plugin", "list", "--json"], {
          env: pluginEnvironment,
        }),
      );
      assert.equal(listing.installed.length, 1);
      const enabled = listing.installed[0];
      assert(enabled.installed && enabled.enabled);
      assert.equal(enabled.version, record.version);
      assert.equal(enabled.source.ref, `v${record.version}`);
      assert.equal(enabled.source.url, `https://github.com/${repository}.git`);
      assert.equal(
        run(["git", "-C", marketplace.installedRoot, "rev-parse", "HEAD"]),
        record.source,
      );
      const extracted = join(output, "unpacked");
      mkdirSync(extracted);
      archivePaths(run(["tar", "-tzf", join(output, record.archive)]));
      run([
        "tar",
        "-xzf",
        join(output, record.archive),
        "--directory",
        extracted,
        "--no-same-owner",
      ]);
      for (const path of [
        ".codex-plugin/plugin.json",
        "skills/director/SKILL.md",
        "skills/setup/SKILL.md",
      ])
        assert(
          readFileSync(join(extracted, "package", path)).equals(
            readFileSync(join(plugin.installedPath, path)),
          ),
          `Public plugin byte mismatch: ${path}`,
        );
      save(join(output, "public-verification.json"), {
        status: "PASS",
        release: release.html_url,
        fingerprint: comment.html_url,
        acceptanceSha256: digest(readFileSync(options.record)),
        source: record.source,
        tree: record.tree,
        archiveSha256: record.archiveSha256,
        tagObject: ref.object.sha,
        rulesetId: record.rulesetId,
      });
      status = "INDEPENDENT PUBLIC AUDIT PASS";
    }
    console.log(`${status}: ${output}`);
  } finally {
    const elapsedSeconds = (performance.now() - clock) / 1000;
    save(join(output, "timing.json"), {
      status,
      startedUtc: started,
      endedUtc: new Date().toISOString(),
      elapsedSeconds,
      commandSeconds,
      outsideCommandSeconds: elapsedSeconds - commandSeconds,
      phases,
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
