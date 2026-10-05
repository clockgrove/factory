import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateTarget } from "../dist/config.js";
import { createApplication } from "../dist/application.js";
import { RegularDelivery } from "../dist/delivery/regular.js";
import {
  createTarget,
  factoryConfig,
  git,
} from "./support/integration-fixture.mjs";

const repository = "example/bound-target";
const url = `https://github.com/${repository}.git`;

function target(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-target-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createTarget(root);
  git(fixture.checkout, "remote", "set-url", "origin", url);
  return { root, ...fixture };
}

test("binding accepts standard GitHub HTTPS/SSH URLs and same-target push overrides", (t) => {
  const { checkout } = target(t);
  for (const remote of [
    url,
    "https://github.com/EXAMPLE/BOUND-TARGET",
    "https://github.com/example/bound-target.git/",
    "git@github.com:example/bound-target.git",
    "ssh://git@github.com/example/bound-target.git",
    "ssh://git@github.com:22/example/bound-target.git",
    "ssh://git@ssh.github.com:443/example/bound-target.git",
  ]) {
    git(checkout, "remote", "set-url", "origin", remote);
    assert.doesNotThrow(() => validateTarget(repository, checkout), remote);
  }
  git(checkout, "config", "--add", "remote.origin.pushurl", url);
  git(
    checkout,
    "config",
    "--add",
    "remote.origin.pushurl",
    "git@github.com:example/bound-target.git",
  );
  assert.doesNotThrow(() => validateTarget(repository, checkout));
});

test("binding rejects missing, local, spoofed and mismatched fetch origins without leaking URLs", (t) => {
  const { checkout, origin } = target(t);
  for (const remote of [
    origin,
    `file://${origin}`,
    "https://github.com/other/repository.git",
    "https://notgithub.com/example/bound-target.git",
    "https://github.com.evil.invalid/example/bound-target.git",
    "https://evil.invalid/github.com/example/bound-target.git",
    "git@evil.invalid:github.com/example/bound-target.git",
    "https://github.com:444/example/bound-target.git",
    "https://github.com/example/bound-target.git?token=private-marker",
    "https://private-marker@evil.invalid/example/bound-target.git",
  ]) {
    git(checkout, "remote", "set-url", "origin", remote);
    assert.throws(
      () => validateTarget(repository, checkout),
      (error) => {
        assert.match(error.message, /Origin fetch/);
        assert.ok(!error.message.includes("private-marker"));
        assert.ok(!error.message.includes(origin));
        return true;
      },
    );
  }
  git(checkout, "remote", "remove", "origin");
  assert.throws(
    () => validateTarget(repository, checkout),
    /Cannot resolve origin fetch/,
  );
});

test("binding checks every effective push destination and Git URL rewrites", (t) => {
  const { checkout, origin } = target(t);
  for (const override of [origin, "https://github.com/other/repository.git"]) {
    git(checkout, "config", "remote.origin.pushurl", override);
    assert.throws(() => validateTarget(repository, checkout), /Origin push/);
  }
  git(checkout, "config", "remote.origin.pushurl", url);
  git(checkout, "config", "--add", "remote.origin.pushurl", origin);
  assert.throws(() => validateTarget(repository, checkout), /Origin push/);
  git(checkout, "config", "--unset-all", "remote.origin.pushurl");
  git(checkout, "config", `url.${origin}.pushInsteadOf`, url);
  assert.throws(() => validateTarget(repository, checkout), /Origin push/);
  git(checkout, "config", "--unset-all", `url.${origin}.pushInsteadOf`);
  git(checkout, "config", `url.${origin}.insteadOf`, url);
  assert.throws(() => validateTarget(repository, checkout), /Origin fetch/);
  git(checkout, "config", "--unset-all", `url.${origin}.insteadOf`);
  git(checkout, "remote", "set-url", "origin", "fixture:bound-target");
  git(checkout, "config", `url.${url}.insteadOf`, "fixture:bound-target");
  assert.doesNotThrow(() => validateTarget(repository, checkout));
});

test("binding retains Factory self-target refusal through fetch and push aliases", (t) => {
  const { checkout } = target(t);
  assert.throws(
    () => validateTarget("clockgrove/factory", checkout),
    /Factory repository/,
  );
  for (const key of ["remote.origin.url", "remote.origin.pushurl"]) {
    git(checkout, "config", key, "git@github.com:clockgrove/factory.git");
    assert.throws(
      () => validateTarget(repository, checkout),
      /Factory repository/,
    );
    git(checkout, "config", key, url);
  }
});

test("binding refuses custom LFS routing but preserves ordinary LFS policy", (t) => {
  const { checkout } = target(t);
  for (const [key, value] of [
    ["lfs.url", "https://private-marker@elsewhere.invalid/store"],
    ["lfs.pushurl", "https://github.com/other/repository.git/info/lfs"],
    [
      "remote.origin.lfsurl",
      "https://github.com/other/repository.git/info/lfs",
    ],
    [
      "remote.origin.lfspushurl",
      "https://github.com/other/repository.git/info/lfs",
    ],
    ["remote.lfsdefault", "upstream"],
    ["remote.lfspushdefault", "upstream"],
    ["lfs.remote.autodetect", "true"],
    ["lfs.remote.searchall", "true"],
    ["lfs.standalonetransferagent", "custom"],
    ["lfs.customtransfer.custom.path", "/private-marker"],
    ["lfs.transfer.enablehrefrewrite", "true"],
  ]) {
    git(checkout, "config", key, value);
    assert.throws(
      () => validateTarget(repository, checkout),
      (error) => {
        assert.match(
          error.message,
          /Custom LFS routing.*origin's default GitHub LFS endpoint/,
        );
        assert.ok(!error.message.includes("private-marker"));
        return true;
      },
    );
    git(checkout, "config", "--unset-all", key);
  }
  git(checkout, "config", "lfs.remote.autodetect", "false");
  git(checkout, "config", "lfs.remote.searchall", "off");
  git(checkout, "config", "remote.lfsdefault", "origin");
  git(checkout, "config", "lfs.storage", join(checkout, ".git", "lfs"));
  writeFileSync(join(checkout, ".lfsconfig"), "[lfs]\nlocksverify = false\n");
  assert.doesNotThrow(() => validateTarget(repository, checkout));
});

test("binding inspects working, index and committed .lfsconfig and refuses malformed config", (t) => {
  const { checkout } = target(t);
  const path = join(checkout, ".lfsconfig");
  writeFileSync(path, "[lfs]\npushurl = https://elsewhere.invalid/store\n");
  assert.throws(
    () => validateTarget(repository, checkout),
    /Custom LFS routing/,
  );
  const nested = join(checkout, "nested");
  mkdirSync(nested);
  assert.throws(() => validateTarget(repository, nested), /Custom LFS routing/);
  git(checkout, "add", ".lfsconfig");
  rmSync(path);
  assert.throws(
    () => validateTarget(repository, checkout),
    /Custom LFS routing/,
  );
  git(
    checkout,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "LFS config",
  );
  git(checkout, "rm", "--cached", ".lfsconfig");
  assert.throws(
    () => validateTarget(repository, checkout),
    /Custom LFS routing/,
  );
  writeFileSync(path, "[lfs]\nlocksverify = false\n");
  assert.throws(
    () => validateTarget(repository, checkout),
    /Custom LFS routing/,
  );
  writeFileSync(path, "[broken private-marker\n");
  assert.throws(
    () => validateTarget(repository, checkout),
    (error) => {
      assert.match(error.message, /Cannot inspect LFS routing/);
      assert.ok(!error.message.includes("private-marker"));
      return true;
    },
  );
});

test("binding follows included LFS configuration without exposing included values", (t) => {
  const { checkout } = target(t);
  writeFileSync(
    join(checkout, ".lfsconfig"),
    "[include]\npath = ./routing.config\n",
  );
  writeFileSync(
    join(checkout, "routing.config"),
    "[lfs]\nurl = https://private-marker@elsewhere.invalid/store\n",
  );
  assert.throws(
    () => validateTarget(repository, checkout),
    (error) => {
      assert.match(error.message, /Custom LFS routing/);
      assert.ok(!error.message.includes("private-marker"));
      return true;
    },
  );
});

test("misbound target stops before planning, worker dispatch or publication", async (t) => {
  const { root, checkout, origin } = target(t);
  const config = factoryConfig(checkout, repository);
  let calls = 0;
  const unexpected = () => {
    calls++;
    throw new Error("external operation reached");
  };
  const app = createApplication(config, {
    planningModel: { generateStructured: unexpected },
    github: { objective: unexpected },
    driver: { start: unexpected },
    delivery: { publish: unexpected },
  });
  for (const key of ["remote.origin.url", "remote.origin.pushurl"]) {
    git(checkout, "config", key, origin);
    await assert.rejects(app.planObjective(1), /Origin (fetch|push)/);
    await assert.rejects(app.runObjective(1), /Origin (fetch|push)/);
    git(checkout, "config", key, url);
  }
  assert.equal(calls, 0);
  assert.equal(
    git(origin, "for-each-ref", "--format=%(refname)", "refs/heads"),
    "refs/heads/main",
  );
  assert.equal(existsSync(join(root, "controller.lock")), false);
});

test("aligned GitHub binding publishes exact Git objects through the offline transport boundary", async (t) => {
  const { checkout, origin, baseSha } = target(t);
  // Register the real bare transport before assigning its canonical identity.
  git(checkout, "remote", "set-url", "origin", origin);
  factoryConfig(checkout, repository);
  const before = readFileSync(join(checkout, ".git", "config"), "utf8");
  validateTarget(repository, checkout);
  let published;
  const gateway = {
    defaultBranch: () => "main",
    findOpenPullRequest: async () => undefined,
    publish: async (request) => {
      published = request;
      assert.equal(
        git(origin, "rev-parse", `refs/heads/${request.branch}`),
        baseSha,
      );
      return { number: 1, branch: request.branch, headSha: baseSha };
    },
  };
  const treeSha = git(checkout, "rev-parse", "HEAD^{tree}");
  const result = await new RegularDelivery(checkout, gateway).publish({
    branch: "factory/bound",
    baseSha,
    changeRef: baseSha,
    treeSha,
    lfs: true,
    item: { id: "one", title: "Bound result" },
  });
  assert.equal(result.headSha, baseSha);
  assert.equal(published.treeSha, treeSha);
  assert.equal(readFileSync(join(checkout, ".git", "config"), "utf8"), before);
  assert.equal(git(checkout, "remote", "get-url", "origin"), url);
});
