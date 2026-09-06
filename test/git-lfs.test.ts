import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertLocalLfsAvailable, inspectPinnedLfs, materializeLocalLfsAssets,
  normalizePinnedLfsFacts, parseLfsPointer,
} from "../src/repository-profiles/git-lfs.js";
import { normalizeRepositoryFacts } from "../src/repository-profiles/index.js";

const roots: string[] = [];
const bytes = Buffer.from([0, 1, 2, 255, 128, 10]);
const oid = createHash("sha256").update(bytes).digest("hex");
const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`;
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "filter.lfs.clean=cat", "-c", "filter.lfs.required=false", ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "factory-lfs-test-"));
  roots.push(root);
  const repository = join(root, "source");
  const destination = join(root, "pinned");
  const bin = join(root, "bin");
  await Promise.all([mkdir(repository), mkdir(destination), mkdir(bin)]);
  await writeFile(join(bin, "git-lfs"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  git(repository, ["init"]);
  await writeFile(join(repository, "asset.bin"), pointer);
  await writeFile(join(repository, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  git(repository, ["add", ".gitattributes", "asset.bin"]);
  git(repository, ["commit", "-m", "pinned fixture"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  const objectDir = join(repository, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4));
  await mkdir(objectDir, { recursive: true });
  const object = join(objectDir, oid);
  await writeFile(object, bytes);
  await writeFile(join(destination, "asset.bin"), pointer);
  return { repository, destination, baseSha, object, root };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("pinned LFS detection and local hydration", () => {
  it("accepts canonical and legacy pointers and rejects malformed or extension transforms", () => {
    expect(parseLfsPointer(Buffer.from(pointer))).toEqual({ oid, size: bytes.length });
    expect(parseLfsPointer(Buffer.from(pointer.replace("git-lfs.github.com", "hawser.github.com")))).toEqual({ oid, size: bytes.length });
    expect(parseLfsPointer(bytes)).toBeNull();
    for (const invalid of [pointer.replace(/\n/g, "\r\n"), pointer.trimEnd(), pointer.replace("size 6", "size 9007199254740992"), pointer.replace("oid sha256:", "ext-0-test value\noid sha256:"), pointer.replace("spec/v1", "spec/v2")])
      expect(() => parseLfsPointer(Buffer.from(invalid))).toThrow();
  });
  it("reads exact commit objects despite modified working-tree attributes and pointer", async () => {
    const f = await fixture();
    await writeFile(join(f.repository, "asset.bin"), "modified working tree");
    await writeFile(join(f.repository, ".gitattributes"), "*.bin filter=untrusted\n");
    const facts = await inspectPinnedLfs(f.repository, f.baseSha);
    expect(facts).toMatchObject({ baseSha: f.baseSha, attributes: true, requiredTools: ["git-lfs"], assets: [{ path: "asset.bin", oid, size: bytes.length, mode: "100644" }] });
    expect(facts.assets[0]!.pointerBlobOid).toBe(git(f.repository, ["rev-parse", `${f.baseSha}:asset.bin`]));
    const normalized = normalizeRepositoryFacts({ files: [{ path: "asset.bin" }], lfs: facts });
    expect(normalized.files[0]).toMatchObject({ size: bytes.length, binary: true });
    expect(normalized.lfs).toEqual(facts);
    expect(() => normalizeRepositoryFacts({ files: [], lfs: facts })).toThrow(/unobserved/);
  });
  it("verifies full cached SHA256 before hydrating and never changes source pointers or index", async () => {
    const f = await fixture();
    const config = await readFile(join(f.repository, ".git", "config"));
    const index = await readFile(join(f.repository, ".git", "index"));
    await expect(assertLocalLfsAvailable(f.repository, f.baseSha)).resolves.toMatchObject({ requiredTools: ["git-lfs"] });
    await materializeLocalLfsAssets(f.repository, f.destination, f.baseSha);
    expect(await readFile(join(f.destination, "asset.bin"))).toEqual(bytes);
    expect(await readFile(join(f.repository, "asset.bin"), "utf8")).toBe(pointer);
    expect(await readFile(join(f.repository, ".git", "config"))).toEqual(config);
    expect(await readFile(join(f.repository, ".git", "index"))).toEqual(index);
  });
  it("does not hydrate missing, corrupted or symlinked cache objects", async () => {
    const f = await fixture();
    await writeFile(f.object, Buffer.from([9, 9, 9, 9, 9, 9]));
    await expect(materializeLocalLfsAssets(f.repository, f.destination, f.baseSha)).rejects.toThrow(/digest/);
    expect(await readFile(join(f.destination, "asset.bin"), "utf8")).toBe(pointer);
    await rm(f.object);
    await expect(assertLocalLfsAvailable(f.repository, f.baseSha)).rejects.toThrow(/missing or unsafe/);
    const external = join(f.root, "external");
    await writeFile(external, bytes);
    await symlink(external, f.object);
    await expect(assertLocalLfsAvailable(f.repository, f.baseSha)).rejects.toThrow(/missing or unsafe/);
  });
  it("refuses changed or symlinked destinations and requires an executable tool", async () => {
    const f = await fixture();
    await writeFile(join(f.destination, "asset.bin"), "user changes");
    await expect(materializeLocalLfsAssets(f.repository, f.destination, f.baseSha)).rejects.toThrow(/differs/);
    await rm(join(f.destination, "asset.bin"));
    await symlink(join(f.repository, "asset.bin"), join(f.destination, "asset.bin"));
    await expect(materializeLocalLfsAssets(f.repository, f.destination, f.baseSha)).rejects.toThrow(/regular/);
    await chmod(join(f.root, "bin", "git-lfs"), 0o600);
    // Preserve Git's actual executable but deliberately omit all LFS providers.
    await symlink(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(f.root, "bin", "git"));
    vi.stubEnv("PATH", join(f.root, "bin"));
    await expect(assertLocalLfsAvailable(f.repository, f.baseSha)).rejects.toThrow(/install Git LFS/);
  });
  it("rejects forged facts, traversal, duplicate paths and aggregate overflow", async () => {
    const f = await fixture();
    const facts = await inspectPinnedLfs(f.repository, f.baseSha);
    expect(() => normalizePinnedLfsFacts({ ...facts, requiredTools: [] })).toThrow();
    expect(() => normalizePinnedLfsFacts({ ...facts, assets: [facts.assets[0]!, facts.assets[0]!] })).toThrow();
    expect(() => normalizePinnedLfsFacts({ ...facts, assets: [{ ...facts.assets[0]!, path: "../escape" }] })).toThrow();
    expect(() => normalizePinnedLfsFacts({ ...facts, assets: ["a", "b", "c"].map((path) => ({ ...facts.assets[0]!, path, size: 100 * 1024 * 1024 })) })).toThrow(/aggregate/);
  });
});
