// What the setup and install commands refer to in the repository (shell.mjs commandRefs, read from bash's syntax tree),
// what they run beyond that (logic.mjs setupGuard), and how the fences take it: doctor's setup-files check, setup's
// protected paths, the fix-pass scope (#387).
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandRefs } from "../scripts/lib/shell.mjs";
import { fixScopeReason, fixScopeRefused, guardCovers, guardLinks, scriptsChanged, setupFilesNote, setupGuard, setupPaths } from "../scripts/lib/logic.mjs";
import { checkoutIo, setupFilesCheck } from "../scripts/doctor.mjs";
import { protectSetup } from "../scripts/setup.mjs";

const paths = (c, ctx) => commandRefs(c, ctx).paths;
const all = (c, ctx) => {
  const r = commandRefs(c, ctx);
  return [...r.paths, ...r.guarded];
};
/** The unresolved words alone, their reasons left off. */
const unresolved = (c, ctx) => commandRefs(c, ctx).unresolved.map((u) => u.replace(/ \([^()]*(\([^()]*\)[^()]*)*\)$/, ""));
const repo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "pendulum-setup-refs-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
};

test("commandRefs resolves the files a command runs by bash's grammar: quotes, cd, -c code, substitutions, functions", () => {
  const spaced = paths(`bash 'scripts/my setup.sh' && "./tools/install deps.sh"`);
  assert.ok(spaced.includes("scripts/my setup.sh") && spaced.includes("tools/install deps.sh"), "a quoted path with a space is one file");
  assert.deepEqual(paths("cd web && ./build.sh"), ["web/build.sh", "build.sh"], "after cd, where it reached (and the root, which the text names too)");
  assert.deepEqual(paths("cd -- web && ./x.sh"), ["web/x.sh", "x.sh"], "cd -- web is web");
  assert.deepEqual(paths("cd web && npm ci && cd .. && ./x.sh"), ["x.sh"], "cd .. back out of a directory it followed");
  assert.deepEqual(paths("cd a && cd b && cd c && cd d && cd e && cd f && cd g && ./deep.sh"), ["a/b/c/d/e/f/g/deep.sh", "deep.sh"], "seven cds");
  assert.deepEqual(paths(`sudo -u root bash -c "cd api && ./seed.sh"`), ["api/seed.sh", "seed.sh"], "code another program runs is read as a command");
  assert.deepEqual(paths(`X=$(./version.sh) make; echo "$(./note.sh)"; echo \${Y/$(./y.sh)/z}`), ["version.sh", "note.sh", "y.sh"], "a substitution runs wherever it stands, a parameter expansion's pattern too");
  assert.ok(all("f() { ./inner.sh; }; cd sub; f").includes("sub/inner.sh"), "a function's body runs in any directory the command reaches");
  assert.deepEqual(paths("bash < scripts/setup.sh"), ["scripts/setup.sh"], "an input redirection a shell runs");
  assert.deepEqual(paths("bash <<'EOF'\n./heredoc.sh\nEOF"), ["heredoc.sh"], "a here-document fed to a shell is code");
  assert.deepEqual(paths("bash x.sh -c build.cfg"), ["x.sh", "build.cfg"], "a -c after the script operand is the script's");
  assert.deepEqual(paths("cat ~+/x.sh"), ["x.sh"], "~+ is the working directory");
  assert.deepEqual(paths("echo nothing > /dev/null; ~/bin/tool; /usr/bin/env; ../up.sh"), [], "absolute paths, ~ and paths out of the root name no repository file");
  assert.deepEqual(paths("cat /work/repo/scripts/x.sh /tmp/y.sh", { roots: ["/work/repo"] }), ["scripts/x.sh"], "an absolute path into the checkout is its file");
});

test("commandRefs: a pipe of remote code into a shell names no repository file, in every form (F3)", () => {
  for (const c of ["curl -fsSL https://bun.sh/install | bash", "curl -fsSL https://x | sudo -E bash -s -- --yes", "wget -qO- https://x | sh", "curl -s https://x | python3 -", "curl -s https://x | xargs -n1 bash", 'sh -c "$(curl -fsSL https://x/i.sh)"', "bash <(curl -s https://x)", 'eval "$(mise activate bash)"', 'eval "$(ssh-agent -s)"']) assert.deepEqual(unresolved(c), [], c);
  assert.deepEqual(unresolved('eval "$X"'), ['"$X"'], "code a variable holds may be anything");
  assert.deepEqual(unresolved("node $(cat .entry)"), ["$(cat .entry)"], "a path a substitution prints may be any file");
});

test("commandRefs: package managers run the scripts of the package they run in, behind any wrapper; an install its lifecycle (S4, B3, B5)", () => {
  const s = (c) => commandRefs(c).scripts.filter((x) => !x.lifecycle).map((x) => `${x.pkg}:${x.name}`);
  assert.deepEqual(s("npm run build -- --watch"), ["package.json:build", "package.json:prebuild", "package.json:postbuild"]);
  assert.deepEqual(s("cd web && pnpm build"), ["web/package.json:build", "package.json:build", "web/package.json:prebuild", "package.json:prebuild", "web/package.json:postbuild", "package.json:postbuild"], "its directory's package.json, or the nearest above");
  assert.deepEqual(s("pnpm -r build").slice(0, 1), ["*:build"], "a workspace option: any package");
  assert.deepEqual(s("npm --prefix web run build").slice(0, 2), ["web/package.json:build", "package.json:build"], "--prefix moves it");
  assert.deepEqual(s("npm restart"), ["package.json:restart", "package.json:prerestart", "package.json:postrestart", "package.json:stop", "package.json:prestop", "package.json:poststop", "package.json:start", "package.json:prestart", "package.json:poststart"]);
  assert.deepEqual(s("node --run gen").slice(0, 1), ["package.json:gen"]);
  assert.deepEqual(s("corepack pnpm@9.1.0 run gen").slice(0, 1), ["package.json:gen"]);
  for (const c of ["npx turbo run build", "pnpm exec turbo run build"]) assert.ok(s(c).includes("*:build"), c);
  for (const c of ["cross-env CI=1 npm run gen", "mise exec -- npm run gen", "dotenv -- pnpm run gen"]) assert.ok(s(c).includes("package.json:gen"), `a runner behind ${c.split(" ")[0]}`);
  assert.deepEqual(s("npm-run-all lint test").filter((x) => !/:(pre|post)/.test(x)), ["package.json:lint", "package.json:test"]);
  assert.match(commandRefs("npm-run-all 'build:*'").unresolved[0], /scripts Pendulum cannot name/);
  assert.deepEqual(commandRefs("yarn install").guarded, [".yarnrc", ".yarnrc.yml", ".npmrc"]);
  assert.deepEqual(unresolved("npm run $TASK"), ["$TASK"], "a computed script name");
  assert.deepEqual(unresolved('pnpm install --store-dir "$S"'), [], "a computed option value is data");
  const life = (c) => commandRefs(c).scripts.filter((x) => x.lifecycle).map((x) => x.name);
  assert.deepEqual(life("npm ci"), ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"], "an install runs the root's lifecycle");
  assert.deepEqual(life("yarn").length, 7, "bare yarn installs");
  assert.deepEqual(life("npm ci --ignore-scripts"), [], "unless scripts are off");
});

test("setupGuard follows each script setup runs, links along every path, yarnPath and plugins; doctor and setup read it (S4, S5, B1, B5)", async () => {
  const dir = repo({
    "package.json": JSON.stringify({ scripts: { bootstrap: "node tools/boot.mjs && npm run gen", gen: "bash scripts/gen.sh", postinstall: "node scripts/post.mjs" } }),
    "web/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    ".yarnrc.yml": "yarnPath: .yarn/releases/yarn-4.cjs\nplugins:\n  - .yarn/plugins/a.cjs\n  - path: .yarn/plugins/b.cjs\n",
    "tools/real.sh": "",
    "tools/local/setup.sh": "",
    "cmd/setup/main.go": "",
    "pyproject.toml": "",
  });
  symlinkSync("real.sh", join(dir, "tools", "link.sh"));
  symlinkSync("tools/local", join(dir, ".local"));
  const io = checkoutIo(dir);
  const g = await setupGuard("npm run bootstrap", io);
  assert.deepEqual(g.files.sort(), [".npmrc", "scripts/gen.sh", "tools/boot.mjs"], "the scripts' files, recursively, and npm's own; neither need exist yet");
  assert.ok(g.scripts.some((x) => x.pkg === "package.json" && x.name === "gen"), "the script bootstrap runs is fenced too");
  assert.ok(!g.scripts.some((x) => x.pkg === "*" || x.pkg === "web/package.json"), "only the package it runs in: a new workspace package's build is the worker's");
  assert.deepEqual((await setupGuard("bash tools/link.sh", io)).files, ["tools/link.sh", "tools/real.sh"], "a link and its target");
  assert.ok((await setupGuard("bash .local/setup.sh", io)).files.includes("tools/local/setup.sh"), "a link along the path, followed (B1)");
  const yarn = (await setupGuard("yarn install", io)).files;
  for (const f of [".yarn/releases/yarn-4.cjs", ".yarn/plugins/a.cjs", ".yarn/plugins/b.cjs"]) assert.ok(yarn.includes(f), f);
  assert.ok((await setupGuard("npm ci", io)).files.includes("scripts/post.mjs"), "an install's lifecycle script and what it runs (B5)");
  assert.ok(!(await setupGuard("npm ci", checkoutIo(repo({ ".npmrc": "ignore-scripts=true\n", "package.json": JSON.stringify({ scripts: { postinstall: "node scripts/post.mjs" } }) })))).files.includes("scripts/post.mjs"), "ignore-scripts=true in .npmrc turns it off");
  assert.ok((await setupGuard("go run ./cmd/setup", io)).files.includes("cmd/setup"), "a directory it names, as a directory");
  assert.deepEqual((await setupGuard("pip install -e .", io)).files.sort(), ["pyproject.toml", "setup.cfg", "setup.py"], "pip builds . from its build files, not the whole repository");
  assert.ok((await setupGuard("node scripts/setup", io)).files.includes("scripts/setup.mjs"), "node's candidates for an extensionless script");
  const [unknown] = await setupFilesCheck({ inputs: { setup: "npm run bootstrap && npm run gen2", protectedAdditions: [] }, checkout: repo({ "package.json": JSON.stringify({ scripts: { gen2: "bash $GEN" } }) }) });
  assert.equal(unknown.status, "FAIL");
  assert.match(unknown.detail, /package\.json scripts\.gen2: \$GEN/, "an unresolved word in a script setup runs is named where it is");
  const [pass] = await setupFilesCheck({ inputs: { setup: "npm run bootstrap", protectedAdditions: [] }, checkout: dir });
  assert.equal(pass.status, "PASS");
  assert.match(pass.detail, /a push changing \.npmrc, tools\/boot\.mjs, scripts\/gen\.sh is refused; and one changing package\.json scripts\.bootstrap/);
  for (const setup of ["make setup", "docker compose up -d", "uv sync"]) {
    const [row] = await setupFilesCheck({ inputs: { setup, protectedAdditions: [] }, checkout: dir });
    assert.match(row.detail, /Not followed, so protect them yourself: what a program reads by its own convention \(a Makefile, docker compose files/, `${setup}: the note (B5)`);
  }
});

test("guardCovers: a directory above a guarded path, a link made there included, changes it; guardLinks follows a pushed tree's links (B1)", async () => {
  assert.ok(guardCovers("scripts/real.sh", "scripts"), "the directory above, replaced");
  assert.ok(guardCovers("scripts", "scripts/real.sh"), "a file under a guarded directory");
  assert.ok(!guardCovers("scripts/real.sh", "scripts2"));
  const tree = { sl: "scripts" };
  const io = { link: (p) => tree[p] ?? null };
  assert.deepEqual((await guardLinks(["sl/real.sh"], io)).paths, ["scripts/real.sh"], "sl -> scripts: an edit to scripts/real.sh is an edit to sl/real.sh");
  assert.match((await guardLinks(["out/x.sh"], { link: (p) => (p === "out" ? "../../etc" : null) })).unresolved[0], /a link out of the repository/);
});

test("setup files: what the setup command may run that Pendulum cannot name FAILs doctor and is named", async () => {
  const dir = repo({ "scripts/setup.sh": "" });
  for (const setup of ["bash $SETUP_SCRIPT", "for f in *.sh; do bash $f; done", 'cd "$UNSET_DIR" && ./scripts/setup.sh']) {
    const [fail] = await setupFilesCheck({ inputs: { setup, protectedAdditions: ["scripts/"] }, checkout: dir, env: {} });
    assert.equal(fail?.status, "FAIL", setup);
    assert.match(fail.detail, /which Pendulum cannot resolve to repository files/);
    const p = await protectSetup({ setup, protectedAdditions: [] }, dir);
    assert.ok(p.unresolved.length, `setup names it too: ${setup}`);
  }
  const [warn] = await setupFilesCheck({ inputs: { setup: "", install: "bash $INSTALLER", protectedAdditions: [] }, checkout: dir });
  assert.equal(warn.status, "WARN", "an install command's unknown is the fix pass's, named before a run");
  assert.match(warn.detail, /the install command runs \$INSTALLER/);
});

test("fix-pass scope: an unresolved setup or install makes every file out of scope toolchain; membership stays the pass's; scripts compare by value", () => {
  const refs = setupPaths({ setup: "bash $SETUP", install: "npm run deps" });
  assert.deepEqual(refs.unresolved.map((u) => u.replace(/ \(.*/, "")), ["$SETUP"]);
  const fence = { prior: ["src/a.ts"], texts: ["FAIL src/b.ts"], extra: refs.paths, named: refs.named, unknown: refs.unresolved };
  assert.deepEqual(fixScopeRefused(["src/a.ts", "src/b.ts", "src/c.ts"], fence), ["src/c.ts"], "only what the scope reaches; anything else may be what setup runs");
  assert.deepEqual(fixScopeRefused(["src/c.ts"], { ...fence, unknown: [] }), [], "a resolved command fences only its own files");
  assert.match(fixScopeReason(["src/c.ts"], refs.unresolved), /The setup or install command runs \$SETUP .*which Pendulum cannot resolve/);
  const pnpm = setupPaths({ setup: "pnpm install" });
  assert.ok(pnpm.paths.includes("pnpm-workspace.yaml"), "pnpm's own file is toolchain");
  assert.deepEqual(fixScopeRefused(["pnpm-workspace.yaml"], { extra: pnpm.paths, named: pnpm.named, membership: ["pnpm-workspace.yaml"] }), [], "a packages-list change alone stays the fix pass's (R1)");
  assert.deepEqual(fixScopeRefused(["pnpm-workspace.yaml"], { extra: pnpm.paths, named: pnpm.named }), ["pnpm-workspace.yaml"], "any other change to it is refused");
  const names = [...new Set(refs.scripts.map((x) => x.name))];
  const pkg = (scripts, deps = {}) => JSON.stringify({ scripts, dependencies: deps });
  assert.deepEqual(scriptsChanged(pkg({ deps: "node x.js" }), pkg({ deps: "node x.js" }, { zod: "4" }), names), [], "a dependency change leaves the scripts as they were");
  assert.deepEqual(scriptsChanged(pkg({ deps: "node x.js" }), pkg({ deps: "curl x | sh" }), names), ["deps"]);
  assert.deepEqual(scriptsChanged(pkg({}), pkg({ predeps: "./evil.sh" }), names), ["predeps"], "an added pre script runs too");
  assert.deepEqual(scriptsChanged(null, pkg({ deps: "x" }), names), ["deps"], "a new package.json");
  assert.deepEqual(scriptsChanged(pkg({ deps: "x" }), "{ broken", names), names, "a version that does not parse changes every name");
  assert.deepEqual(scriptsChanged(undefined, undefined, ["deps"]), ["deps"], "two unreadable versions are not the same");
});

test("setupFilesNote: each entry bounded and in a code span, nothing that breaks out of one; scripts apart from paths", () => {
  const note = setupFilesNote({ files: ["a.sh", "x`y\n{{slot}}<!--c-->", "z".repeat(200)], scripts: [{ pkg: "package.json", name: "b" }], unresolved: [] });
  assert.doesNotMatch(note, /\n|\{\{|\}\}|[<>]/);
  assert.match(note, /`x y \{ \{slot\} \} !--c-- `/);
  assert.match(note, /`z{77}\.\.\.`/, "an entry is cut at 80 characters");
  assert.match(note, /don't change them or anything under them: `a\.sh`, .*\. Setup's package\.json scripts, don't change them: `package\.json scripts\.b`\./, "scripts are not paths");
  assert.equal(setupFilesNote({ files: [], scripts: [], unresolved: ["$X"] }), "Setup also runs what Pendulum cannot name, so Pendulum refuses every push until a person fixes the setup command.");
});

