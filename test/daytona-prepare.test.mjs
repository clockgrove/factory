import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { daytonaPrepareScript } from "../dist/execution/daytona-prepare.js";
import { FACTORY_VERSION } from "../dist/package-metadata.js";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "daytona-preparation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"),
    remote = join(root, "public.git"),
    bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const bytes = Buffer.from([0, 255, 3, 4]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(
    join(repo, "asset.bin"),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${digest}\nsize 4\n`,
  );
  writeFileSync(join(repo, "keep.txt"), "pinned\n");
  writeFileSync(join(repo, ".lfsconfig"), "[lfs]\n fetchexclude = asset.bin\n");
  git("add", ".");
  git("commit", "-qm", "base");
  execFileSync("git", ["clone", "--bare", repo, remote], { stdio: "pipe" });
  const object = join(
    remote,
    "lfs/objects",
    digest.slice(0, 2),
    digest.slice(2, 4),
  );
  mkdirSync(object, { recursive: true });
  writeFileSync(join(object, digest), bytes);
  const nativeGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  // Substitute only the fixture's network destination; execute the real Git/LFS binaries.
  const wrapper = join(bin, "git");
  writeFileSync(
    wrapper,
    `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');if(process.env.GH_TOKEN||process.env.GITHUB_TOKEN||process.env.DAYTONA_API_KEY)process.exit(91);const args=process.argv.slice(2).map(x=>x==='https://github.com/example/public.git'?${JSON.stringify(remote)}:x==='lfs.url=https://github.com/example/public.git/info/lfs'?${JSON.stringify("lfs.url=file://" + remote)}:x);const r=spawnSync(${JSON.stringify(nativeGit)},["-c",${JSON.stringify("remote.origin.url=file://" + remote)},...args],{stdio:'inherit'});process.exit(r.status??92);`,
  );
  chmodSync(wrapper, 0o755);
  const input = {
    repository: "example/public",
    baseSha: git("rev-parse", "HEAD"),
    treeSha: git("rev-parse", "HEAD^{tree}"),
    lfsSources: [{ path: "asset.bin", digest, bytes: 4 }],
  };
  const run = (name, value = input, version = FACTORY_VERSION) =>
    spawnSync(
      process.execPath,
      [
        "-e",
        daytonaPrepareScript,
        join(root, name),
        resolve("."),
        version,
        JSON.stringify(value),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: bin + ":" + process.env.PATH,
          GH_TOKEN: "preparation-canary",
          GITHUB_TOKEN: "preparation-canary",
          DAYTONA_API_KEY: "controller-canary",
        },
      },
    );
  return { root, repo, remote, input, run, bytes };
}
test("trusted Daytona bootstrap checks runtime, pulls exact public Git and only declared raw LFS", (t) => {
  const f = fixture(t),
    r = f.run("sandbox");
  assert.equal(r.status, 0, r.stderr);
  const prepared = join(f.root, "sandbox/repo");
  assert.deepEqual(readFileSync(join(f.root, "sandbox/lfs/0")), f.bytes);
  assert.deepEqual(
    readFileSync(join(prepared, "asset.bin")),
    readFileSync(join(f.repo, "asset.bin")),
  );
  assert.equal(existsSync(join(prepared, ".git/config")), false);
  assert.equal(existsSync(join(prepared, ".git/lfs")), false);
  assert.equal(
    execFileSync("git", ["-C", prepared, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    f.input.baseSha,
  );
  assert.equal(f.run("wrong-version", f.input, "not-installed").status, 1);
  assert.equal(
    f.run("wrong-tree", { ...f.input, treeSha: "b".repeat(40) }).status,
    1,
  );
  assert.equal(
    f.run("unpublished", { ...f.input, baseSha: "c".repeat(40) }).status,
    1,
  );
  assert.equal(
    f.run("wrong-lfs", {
      ...f.input,
      lfsSources: [{ ...f.input.lfsSources[0], bytes: 5 }],
    }).status,
    1,
  );
});
