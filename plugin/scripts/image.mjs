#!/usr/bin/env node
// Factory's image build (mode: image): the sandbox image every stage of a cloud-sandbox adopter starts from.
//   node scripts/image.mjs --repo OWNER/NAME --checkout DIR [--manual]
// DIR is the job's checkout of the default branch's head. A fresh sandbox from the vendor's base image gets a clone of
// that head (from a git bundle: no credential is ever in the sandbox, and origin is the plain https URL), runs the
// repository's own setup command there as CI would, installs the dependency store with the same command the worker
// uses and the three harness CLIs, and is kept as a snapshot: the sandbox stays, stopped, tagged with the repository
// id, the head and the snapshot (the vendor's proof). The GitHub record is a marker comment the Factory App writes on
// its image issue, with a token minted for that alone (issues: write on this repository); images beyond the newest
// two are destroyed, found from the vendor's listing only. Runs on a push to the default branch (until today's builds
// pass image_daily_minutes), on the nightly pass (its own `nightly` wake, armed only when a build is owed; GitHub's
// nightly cron is the backstop), or by hand on the default branch's head. The build sandbox gets
// no secret: the vendor's credentials and the App key stay in this process, whose environment keeps none.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openSandbox } from "./lib/adapters/sandbox.mjs";
import { installCommand, runnerFileEnv } from "./lib/checkout.mjs";
import { mintInstallationToken } from "./lib/app-token.mjs";
import { getRepo, onDefaultBranch, repoOf, rest } from "./lib/github.mjs";
import { CLI } from "./lib/harness.mjs";
import { IMAGE_DIR, NIGHTLY_CRON, imageDecision, imagePaths, imageWaits, imageTags, currentBuild, listImages, prunableImages, recordImage, staleImages, todaysBuildMs, vendorImages, verifiedRecords } from "./lib/image.mjs";
import { SECRET_INPUTS, log, mask, parseArgs, resolveInputs, setOutput } from "./lib/inputs.mjs";
import { parseWake, setSelf, wakeHop } from "./lib/logic.mjs";
import { armOwnWake } from "./dispatch.mjs";

/** The build sandbox's limits: setup that takes longer than this is not an image build. */
const BUILD_MS = 40 * 60_000;
const VCPUS = 2;
/** Every secret this process reads, gone from the environment once read (the vendor SDK runs in this process). */
export const SECRET_ENV = new Set([...[...SECRET_INPUTS].map((n) => `FACTORY_INPUT_${n.toUpperCase()}`), "FACTORY_INPUT_VERCEL_TEAM_ID", "FACTORY_INPUT_VERCEL_PROJECT_ID", "FACTORY_APP_PRIVATE_KEY", "FACTORY_APP_TOKEN", "FACTORY_SECOND_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "VERCEL_TOKEN", "VERCEL_OIDC_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_RUNTIME_TOKEN"]);

/** Factory's directory in the image, owned by the default user. */
const PREPARE = `sudo install -d -m 755 -o "$(id -u)" -g "$(id -g)" ${IMAGE_DIR}`;
/** git-lfs and gh, from the base's apt (every vendor base Factory uses is Ubuntu); each must answer --version. */
export const BASE_PACKAGES = "set -euo pipefail; export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq git-lfs gh libcap2-bin >/dev/null; git lfs version; gh --version | head -1";
/** Clone the bundle at `sha` on `branch`, origin the plain URL, no credential anywhere in the git config. */
const CLONE = [
  'set -euo pipefail; git clone -q --no-checkout "$BUNDLE" "$CHECKOUT"; cd "$CHECKOUT"',
  'git checkout -q -B "$BRANCH" "$SHA"; git remote set-url origin "$URL"; git update-ref "refs/remotes/origin/$BRANCH" "$SHA"',
  'git branch -q --set-upstream-to="origin/$BRANCH"; rm -f "$BUNDLE"',
].join("; ");
/** Fails when the clone could reach the remote with a credential, or origin is anything but the plain URL. */
const NO_CREDENTIALS = 'cd "$CHECKOUT"; ! git config --get-regexp "^(http\\..*extraheader|credential\\..*|url\\..*insteadof)$" && test "$(git remote get-url origin)" = "$URL" && ! test -e "$HOME/.git-credentials"';
/**
 * Privilege and configuration every stage would inherit from setup (root, the default branch's script), read as root:
 * taken before setup and after the harness CLIs, and any difference fails the build. Hashed whole: sudoers, the
 * preload list, the system and the default user's git config, the clone's git config and hooks (Factory's own git acts
 * on them), /etc/environment, PAM, the harnesses' system config, and every setuid or setgid file. Listed: file
 * capabilities. Accounts are read for what grants privilege (uid 0, the privileged groups' members, accounts with a
 * password or an empty one), not hashed, so a package that adds its own system user (postgres) passes.
 * Needs USER_HOME and CHECKOUT in the environment.
 */
export const PRIVILEGED = [
  'h() { for f in "$@"; do [ -e "$f" ] && sha256sum "$f"; done; }',
  'hd() { for d in "$@"; do [ -d "$d" ] && find "$d" -xdev -type f -exec sha256sum {} +; done; }',
  'h /etc/sudoers /etc/ld.so.preload /etc/gitconfig /etc/environment "$USER_HOME/.gitconfig" "$USER_HOME/.config/git/config" "$CHECKOUT/.git/config"',
  'hd /etc/sudoers.d /etc/claude-code /etc/codex /etc/pam.d /etc/security "$CHECKOUT/.git/hooks"',
  "awk -F: '$3==0 {print \"uid0 \" $1}' /etc/passwd",
  "awk -F: '$1 ~ /^(root|sudo|admin|wheel|adm|shadow|disk|docker|lxd)$/ {print \"group \" $1 \":\" $4}' /etc/group",
  "awk -F: '$2 == \"\" {print \"no-password \" $1} $2 != \"\" && $2 !~ /^[!*]/ {print \"password \" $1}' /etc/shadow",
  "find / -xdev -type f -perm /6000 -exec sha256sum {} + 2>/dev/null",
  "find / -xdev -type f -print0 2>/dev/null | xargs -0 getcap 2>/dev/null",
  "true",
].join("\n");

/** Lines in `after` not in `before`, and lines gone: what changed in the privileged configuration. */
export const privilegedChanges = (before, after) => {
  const a = new Set(before.split("\n").filter(Boolean));
  const b = new Set(after.split("\n").filter(Boolean));
  return [...[...b].filter((l) => !a.has(l)).map((l) => `+ ${l}`), ...[...a].filter((l) => !b.has(l)).map((l) => `- ${l}`)];
};

/** The file a change line names: a hash line's path, or a getcap line's; null for an account line. */
export const changePath = (change) => /^[+-] [0-9a-f]{64} {2}(\/.+)$/.exec(change)?.[1] ?? /^[+-] (\/\S+) cap_/.exec(change)?.[1] ?? null;

/**
 * Files a package may bring with it, so a change to them is setup installing software, not setup granting privilege:
 * setuid or setgid programs, file capabilities, PAM and limits files. Never sudoers, the preload list, git config or
 * hooks, /etc/environment or the harnesses' config, and never an account.
 */
export const packageMayOwn = (path, { home, checkout }) =>
  !!path && !/^\/etc\/(sudoers|ld\.so\.preload$|gitconfig$|environment$|claude-code\/|codex\/)/.test(path) && !path.startsWith(`${home}/`) && !path.startsWith(`${checkout}/`);

/**
 * The changes no installed package explains: drops the ones on a file `packageMayOwn` allows whose path `clean` holds
 * (owned by a dpkg package that `dpkg --verify` finds unmodified), the new line and the old line alike.
 */
export const unexplainedChanges = (changes, clean, where) => changes.filter((c) => !(packageMayOwn(changePath(c), where) && clean.has(changePath(c))));

/** As root, with paths as arguments: prints each one an installed dpkg package owns and `dpkg --verify` finds unmodified. */
export const PACKAGE_CLEAN = [
  'for p in "$@"; do',
  '  pkg=$(dpkg -S -- "$p" 2>/dev/null | grep -v "^diversion by" | head -1 | cut -d: -f1)',
  '  [ -n "$pkg" ] && dpkg-query -W -f="\\${Status}" -- "$pkg" 2>/dev/null | grep -q "install ok installed" || continue',
  '  dpkg --verify -- "$pkg" 2>/dev/null | grep -qF " $p" && continue',
  '  printf "%s\\n" "$p"',
  "done",
].join("\n");

/**
 * Build the image: create from `base`, clone, setup, install, the harness CLIs, then snapshot (the sandbox stays,
 * stopped, as the vendor's record). Returns the snapshot and its source sandbox; throws with `buildMs` and the step that
 * failed, the sandbox destroyed. Command output goes to the job log only.
 */
export async function buildImage({ adapter, base, bundle, repo, branch, sha, setup, install, harnessVersion, tags }) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const { checkout, envFile } = imagePaths(repo);
  let id = null;
  try {
    ({ id } = await adapter.create({ image: base, vcpus: VCPUS, timeoutMs: BUILD_MS, tags, network: "all" }));
    log(`image: sandbox ${id} from ${base} in ${elapsed()} ms`);
    const step = async (name, argv, opts = {}) => {
      const t = Date.now();
      let out = "";
      const r = await adapter.run(id, { argv, timeoutMs: Math.max(1000, BUILD_MS - elapsed()), ...opts, onStdout: (s) => ((out += s), opts.quiet || process.stdout.write(s)), onStderr: (s) => process.stdout.write(s) });
      log(`image: ${name} exit ${r.exitCode} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
      if (r.exitCode !== 0) throw Object.assign(new Error(`${name} exited ${r.exitCode}${r.timedOut ? " (time limit)" : ""}`), { step: name });
      return out;
    };
    await step("prepare", ["bash", "-c", PREPARE]);
    const home = (await step("home", ["bash", "-c", 'printf %s "$HOME"'], { quiet: true })).trim();
    const privileged = { USER_HOME: home, CHECKOUT: checkout };
    const git = { BUNDLE: `${IMAGE_DIR}/repo.bundle`, CHECKOUT: checkout, BRANCH: branch, SHA: sha, URL: `https://github.com/${repo.full}.git` };
    const files = { GITHUB_ENV: `${IMAGE_DIR}/github-env`, GITHUB_PATH: `${IMAGE_DIR}/github-path` };
    await adapter.writeFiles(id, [
      { path: git.BUNDLE, content: bundle },
      { path: files.GITHUB_ENV, content: "" },
      { path: files.GITHUB_PATH, content: "" },
    ]);
    await step("clone", ["bash", "-c", CLONE], { env: git });
    // Tools every stage needs that the vendor's base lacks, so no stage installs them at start; before the privileged
    // baseline, so what their packages configure is the base's.
    await step("base packages", ["bash", "-c", BASE_PACKAGES], { user: "root" });
    const privilegedBefore = await step("privileged config before setup", ["bash", "-c", PRIVILEGED], { user: "root", env: privileged, quiet: true });
    // The setup command as a CI step runs it: CI set, and GITHUB_ENV / GITHUB_PATH files whose additions every later
    // step (and every stage, from envFile) gets.
    let setupEnv = {};
    if (setup) {
      await step("setup", ["bash", "-c", setup], { cwd: checkout, env: { CI: "true", ...files } });
      const local = mkdtempSync(join(tmpdir(), "factory-image-"));
      try {
        const copies = { GITHUB_ENV: join(local, "env"), GITHUB_PATH: join(local, "path") };
        writeFileSync(copies.GITHUB_ENV, (await adapter.readFile(id, files.GITHUB_ENV)) ?? "");
        writeFileSync(copies.GITHUB_PATH, (await adapter.readFile(id, files.GITHUB_PATH)) ?? "");
        const path = (await step("path", ["bash", "-c", 'printf %s "$PATH"'])).trim();
        setupEnv = runnerFileEnv({ ...copies, PATH: path });
      } finally {
        rmSync(local, { recursive: true, force: true });
      }
    }
    if (install) await step("install", ["bash", "-c", install], { cwd: checkout, env: { CI: "true", ...setupEnv } });
    const pkgs = Object.values(CLI).map((c) => `${c.pkg}@${harnessVersion || "latest"}`);
    // As on the runner (action.yml): Claude Code's postinstall puts its native binary in place, and npm 11 runs install
    // scripts only for packages allowed by name (npm 10, on node:22, ignores the flag and runs them all, as on the
    // runner). Each CLI must then answer --version, or the build fails.
    await step("harness CLIs", ["npm", "install", "-g", "--no-audit", "--no-fund", `--allow-scripts=${CLI.claude.pkg}`, ...pkgs], { user: "root" });
    const versions = await step("harness versions", ["bash", "-c", `set -o pipefail; ${Object.values(CLI).map((c) => `${c.bin} --version | head -1`).join(" && ")}`]);
    const all = privilegedChanges(privilegedBefore, await step("privileged config after setup", ["bash", "-c", PRIVILEGED], { user: "root", env: privileged, quiet: true }));
    const where = { home, checkout };
    const candidates = [...new Set(all.map(changePath).filter((p) => packageMayOwn(p, where)))];
    const clean = new Set(candidates.length ? (await step("privileged files from packages", ["bash", "-c", PACKAGE_CLEAN, "factory-package-clean", ...candidates], { user: "root", quiet: true })).split("\n").filter(Boolean) : []);
    const changed = unexplainedChanges(all, clean, where);
    if (all.length > changed.length) log(`image: setup installed packages that bring privileged files (dpkg-owned, unmodified): ${[...clean].join(", ")}`);
    if (changed.length) {
      log(`image: setup changed system-wide privilege or harness configuration, which every stage would inherit:\n${changed.join("\n")}`);
      throw Object.assign(new Error("setup changed privileged configuration"), { step: "privileged config" });
    }
    await adapter.writeFiles(id, [{ path: envFile, content: `${JSON.stringify(setupEnv)}\n`, mode: 0o600 }]);
    await step("no credentials", ["bash", "-c", NO_CREDENTIALS], { env: git });
    const snap = await adapter.snapshot(id);
    const source = id;
    id = null;
    return { ...snap, source, envNames: Object.keys(setupEnv), versions: versions.trim().split("\n"), buildMs: elapsed(), usd: snap.usage?.usd ?? null };
  } catch (e) {
    throw Object.assign(e, { buildMs: elapsed() });
  } finally {
    if (id) await adapter.destroy(id).catch((e) => log(`image: destroying ${id} failed (${e.code ?? e.message})`));
  }
}

/**
 * Which kind of build this event asks for, or null: a push to the default branch, the nightly pass (the nightly cron, or
 * a `nightly` wake's tick), a manual run. A `nightly` wake's hop (its deadline still ahead) is `hop`: it builds nothing
 * and arms the deadline again.
 */
export function imageTrigger(eventName, payload, defaultBranch, now = Date.now()) {
  if (eventName === "push") return payload?.ref === `refs/heads/${defaultBranch}` ? "merge" : null;
  if (eventName === "schedule") return payload?.schedule === NIGHTLY_CRON ? "nightly" : null;
  if (eventName === "workflow_dispatch") {
    const wake = payload?.inputs?.image === "true" ? null : parseWake(payload?.inputs?.wake);
    if (wake?.kind === "nightly") return wakeHop(wake, now) ? "hop" : "nightly";
    return "manual";
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = resolveInputs({ args });
  for (const k of Object.keys(process.env)) if (SECRET_ENV.has(k)) delete process.env[k];
  if (!inputs.repo) throw new Error("--repo OWNER/NAME (or GITHUB_REPOSITORY) is required");
  if (!inputs.sandbox) throw new Error("mode image needs the sandbox input (for example `vercel`)");
  const checkout = args.checkout || process.env.GITHUB_WORKSPACE;
  if (!checkout) throw new Error("--checkout DIR (the default branch's checkout) is required");
  const repo = repoOf(inputs.repo);
  const token = inputs.githubToken;
  const done = (exit, reason = "") => {
    log(`${exit}${reason ? `: ${reason}` : ""}`);
    setOutput("exit", exit);
    setOutput("reason", reason);
  };
  const summary = (text) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);

  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const repoData = await getRepo(repo, { token });
  const branch = repoData.default_branch;
  const trigger = args.manual === "true" ? "manual" : imageTrigger(eventName, payload, branch);
  if (!trigger) return done("skipped", `no image build on ${eventName || "this event"}`);
  // Its own next run (workflow-template.yml `image-wake`): GitHub's nightly cron is only the backstop.
  const arm = (waits) => armOwnWake("image", waits, { repo, payload: { ...payload, repository: payload.repository ?? { private: repoData.private } }, eventName, token, readRepo: async () => repoData });
  if (trigger === "hop") {
    await arm(imageWaits({ hop: parseWake(payload.inputs.wake) }));
    return done("skipped", "the nightly pass is not due yet; its wake sleeps on");
  }
  const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (trigger === "merge" && process.env.GITHUB_SHA && head !== process.env.GITHUB_SHA) throw new Error(`the checkout is at ${head}, not the pushed head ${process.env.GITHUB_SHA}`);
  // Only merged code becomes the image: by hand, exactly the default branch's head now; otherwise a commit on it.
  const tip = (await rest(`repos/${repo.full}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, { token }))?.object?.sha;
  if (trigger === "manual" ? head !== tip : head !== tip && !(await onDefaultBranch(repo, head, { token }))) {
    done("refused", `${head.slice(0, 7)} is not ${trigger === "manual" ? "the head" : "on the history"} of ${branch} (${String(tip).slice(0, 7)}); only merged code becomes the image`);
    process.exitCode = 1;
    return;
  }

  // The App's token for the record alone: issues write on this repository. The key is gone from memory once minted.
  const minted = await mintInstallationToken({ appId: inputs.appId, privateKey: inputs.appPrivateKey, owner: repo.owner, repo: repo.name, permissions: { issues: "write" } });
  inputs.appPrivateKey = "";
  mask(minted.token);
  setSelf(`${minted.appSlug}[bot]`);
  const app = { token: minted.token };
  const adapter = await openSandbox(inputs.sandbox, { VERCEL_TOKEN: inputs.vercelToken, VERCEL_TEAM_ID: inputs.vercelTeamId, VERCEL_PROJECT_ID: inputs.vercelProjectId });
  inputs.vercelToken = "";
  const repoId = String(process.env.GITHUB_REPOSITORY_ID || repoData.id);
  // Factory's own record (its App's comment) is trusted for minutes; a snapshot in it counts only where the vendor's
  // listing in Factory's project confirms it (lib/image.mjs).
  const [{ builds }, vendor] = await Promise.all([listImages(repo, app), vendorImages(adapter, repoId)]);
  const verified = verifiedRecords(builds, vendor.images, adapter.name);
  const todayMs = todaysBuildMs(builds);
  const current = await currentBuild(adapter, repo, verified, { token });
  const decision = imageDecision({ trigger, refresh: inputs.imageRefresh, head, current, lastAttemptAt: builds[0]?.builtAt ?? null, todayMs, dailyMinutes: inputs.imageDailyMinutes });
  if (decision.skip) {
    summary(`### Factory sandbox image\n\nSkipped: ${decision.skip}. Today's builds: ${(todayMs / 60_000).toFixed(1)} min.`);
    await arm(imageWaits({ trigger, decision }));
    return done("skipped", decision.skip);
  }
  if (decision.note) log(`image: ${decision.note}`);

  // One build at a time (the job's concurrency group), so a sandbox with the repository's tag that is not a finished
  // image is a crashed or cancelled build's.
  for (const s of vendor.others) {
    log(`image: destroying ${s.id}, left by an earlier build (${s.state})`);
    await adapter.destroy(s.id);
  }
  // Room for the build: images no stage needs go first (older than the current one, but any a stage may still be
  // starting from), as the sweep would destroy them. The vendor's storage quota counts them all.
  for (const i of prunableImages(vendor.images, current, verified)) {
    await adapter.destroy(i.source).then(() => log(`image: destroyed superseded image ${i.source} (${i.snapshot}) before the build`), (e) => log(`image: destroying ${i.source} failed (${e.code ?? e.message})`));
  }
  const tmp = mkdtempSync(join(tmpdir(), "factory-bundle-"));
  let bundle;
  try {
    execFileSync("git", ["-C", checkout, "bundle", "create", join(tmp, "repo.bundle"), "HEAD"], { stdio: ["ignore", "ignore", "inherit"] });
    bundle = readFileSync(join(tmp, "repo.bundle"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const base = adapter.baseImage(inputs.nodeVersion);
  log(`image: building ${repo.full}@${head.slice(0, 7)} (${trigger}) from ${base}; bundle ${(bundle.length / 1e6).toFixed(1)} MB`);
  const builtAt = new Date().toISOString();
  // The build's output is the repository's: no workflow command in it is honoured while it streams.
  const stopToken = randomBytes(16).toString("hex");
  process.stdout.write(`::stop-commands::${stopToken}\n`);
  let built;
  let failure = null;
  try {
    built = await buildImage({ adapter, base, bundle, repo, branch, sha: head, setup: inputs.setup, install: installCommand(checkout, inputs.install), harnessVersion: inputs.harnessVersion, tags: imageTags(repoId, head) });
  } catch (e) {
    failure = e;
  } finally {
    process.stdout.write(`\n::${stopToken}::\n`);
  }
  if (failure) {
    const e = failure;
    log(`image: the build failed at ${e.step ?? "a vendor call"} (${e.code ?? "error"}): ${String(e.message).slice(0, 500)}`);
    await recordImage(repo, { vendor: inputs.sandbox, snapshot: null, sha: head, builtAt, buildMs: e.buildMs ?? 0 }, app).catch((x) => log(`image: recording the failure failed (${x.message.slice(0, 120)})`));
    summary(`### Factory sandbox image\n\nThe build of \`${head.slice(0, 7)}\` failed at **${e.step ?? "a vendor call"}** after ${((e.buildMs ?? 0) / 1000).toFixed(0)} s.`);
    await arm(imageWaits({ trigger, failed: true }));
    done("failed", `image build failed at ${e.step ?? "a vendor call"} (${e.code ?? "error"})`);
    process.exitCode = 1;
    return;
  }
  const rec = { vendor: inputs.sandbox, snapshot: built.snapshot, source: built.source, sha: head, builtAt, buildMs: built.buildMs, sizeBytes: built.sizeBytes, usd: built.usd };
  let issue;
  try {
    issue = await recordImage(repo, rec, app);
  } catch (e) {
    // An image with no record is one no stage finds: it goes, with its snapshot.
    log(`image: recording the build failed (${e.status ?? e.message.slice(0, 120)}); destroying ${built.source}`);
    await adapter.destroy(built.source).catch((x) => log(`image: destroying ${built.source} failed (${x.code ?? x.message})`));
    done("failed", `the image could not be recorded (${e.status ?? "error"})`);
    process.exitCode = 1;
    return;
  }
  // Older images beyond the newest two, from the vendor's listing in this project (never from GitHub's records): each
  // goes with its snapshot. A stage that read the previous one a moment ago still finds it.
  const listed = (await vendorImages(adapter, repoId)).images;
  const stale = staleImages(listed, built.source);
  for (const i of stale) {
    await adapter.destroy(i.source).then(() => log(`image: destroyed superseded image ${i.source} (${i.snapshot})`), (e) => log(`image: destroying ${i.source} failed (${e.code ?? e.message})`));
  }
  // The image before this one stays while a stage may still be starting from it; the sweep's wake takes it then.
  await arm(imageWaits({ trigger, built: true, olderImage: listed.some((i) => i.source !== built.source && !stale.includes(i)) }));
  const today = todayMs + built.buildMs;
  const gb = built.sizeBytes === null ? "?" : (built.sizeBytes / 1e9).toFixed(2);
  log(`image: ${built.snapshot} from ${head.slice(0, 7)} in ${(built.buildMs / 1000).toFixed(1)} s; ${gb} GB (${built.usdPerMonth === null ? "?" : `$${built.usdPerMonth}`}/month stored); build sandbox $${built.usd ?? "?"}; today's builds ${(today / 60_000).toFixed(1)} min`);
  log(`image: setup exported ${built.envNames.length ? built.envNames.join(", ") : "nothing"}; harness CLIs: ${built.versions.join(" | ")}`);
  setOutput("snapshot", built.snapshot);
  setOutput("build_ms", String(built.buildMs));
  summary(
    `### Factory sandbox image\n\n| | |\n| --- | --- |\n| Head | \`${head.slice(0, 7)}\` (${trigger}) |\n| Snapshot | \`${built.snapshot}\` from \`${base}\` |\n| Build | ${(built.buildMs / 1000).toFixed(1)} s, sandbox $${built.usd ?? "?"} |\n| Today's builds | ${(today / 60_000).toFixed(1)} min (merges stop at ${inputs.imageDailyMinutes}) |\n| Stored | ${gb} GB, $${built.usdPerMonth ?? "?"}/month |\n\nRecorded on Factory's image issue #${issue}.`,
  );
  done("built");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[factory] image failed: ${e.message}\n`);
    process.exit(1);
  });
}
