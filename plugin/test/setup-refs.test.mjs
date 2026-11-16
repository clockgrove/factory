// What the setup and install commands refer to in the repository (shell.mjs commandRefs, read from bash's syntax tree),
// what they run beyond that (logic.mjs setupGuard), and how the fences take it: doctor's setup-files check, setup's
// protected paths, the fix-pass scope (#387).
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandRefs, wordScan } from "../scripts/lib/shell.mjs";
import { fixScopeReason, fixScopeRefused, scriptsChanged, setupGuard, setupPaths } from "../scripts/lib/logic.mjs";
import { checkoutIo, setupFilesCheck } from "../scripts/doctor.mjs";
import { protectSetup } from "../scripts/setup.mjs";

const paths = (c, ctx) => commandRefs(c, ctx).paths;
const all = (c, ctx) => {
  const r = commandRefs(c, ctx);
  return [...r.paths, ...r.maybe, ...r.guarded];
};
/** The unresolved words alone, their reasons left off. */
const unresolved = (c, ctx) => commandRefs(c, ctx).unresolved.map((u) => u.replace(/ \([^()]*(\([^()]*\)[^()]*)*\)$/, ""));
const repo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "factory-setup-refs-"));
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
  assert.deepEqual(paths("bash < scripts/setup.sh"), ["scripts/setup.sh"], "an input redirection is read");
  assert.deepEqual(paths("bash <<'EOF'\n./heredoc.sh\nEOF"), ["heredoc.sh"], "a here-document fed to a shell is code");
  assert.deepEqual(paths("bash x.sh -c build.cfg"), ["x.sh", "build.cfg"], "a -c after the script operand is the script's");
  assert.deepEqual(paths("cat ~+/x.sh"), ["x.sh"], "~+ is the working directory");
  assert.deepEqual(paths("echo nothing > /dev/null; ~/bin/tool; /usr/bin/env; ../up.sh"), [], "absolute paths, ~ and paths out of the root name no repository file");
  assert.deepEqual(paths("cat /work/repo/scripts/x.sh /tmp/y.sh", { roots: ["/work/repo"] }), ["scripts/x.sh"], "an absolute path into the checkout is its file");
});

test("commandRefs is never short of the word scan Factory read commands with before it parsed them (S2)", () => {
  for (const [c, file] of [
    ["echo 'bash scripts/x.sh' | sh", "scripts/x.sh"],
    ["cat <<'EOF' | bash\n./b.sh\nEOF", "b.sh"],
    ['python3 - <<\'EOF\'\nsubprocess.run("scripts/x.sh")\nEOF', "scripts/x.sh"],
    [`python -c "exec(open('scripts/setup.py').read())"`, "scripts/setup.py"],
    [`perl -e 'do "./x.pl"'`, "x.pl"],
    ['NODE_OPTIONS="--require ./hook.js" node a.js', "hook.js"],
    ["set -- scripts/a.sh", "scripts/a.sh"],
    ["hash -p ./evil.sh git", "evil.sh"],
  ]) {
    assert.ok(paths(c).includes(file), `${c}: ${file}`);
    for (const w of wordScan(c)) assert.ok(paths(c).includes(w), `${c}: every scanned word, ${w}`);
  }
  assert.deepEqual(unresolved("echo 'bash scripts/x.sh' | sh"), ["sh"], "a shell reading a pipe runs code Factory cannot see");
  assert.ok(commandRefs("ls scripts | xargs -n1 bash").unresolved.some((u) => /reading its script from a pipe/.test(u)), "xargs feeding a shell its scripts");
});

test("commandRefs reads assignments: PATH entries in the repository are directories whose commands it runs; BASH_ENV a file (S3)", () => {
  const r = commandRefs('export PATH="$PWD/tools/bin:$PATH" && bootstrap');
  assert.deepEqual(r.guarded, ["tools/bin", "tools/bin/bootstrap"]);
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(commandRefs("PATH=tools/bin:$PATH bootstrap").guarded, ["tools/bin", "tools/bin/bootstrap"]);
  assert.deepEqual(commandRefs("env K=v PATH=bin:$PATH run-it").guarded, ["bin", "bin/run-it"], "env's assignments too");
  assert.deepEqual(paths("BASH_ENV=scripts/env.sh bash -c true"), ["scripts/env.sh"]);
  assert.ok(all("git -c core.hooksPath=hooks status").includes("hooks"), "a NAME=value argument's value");
  assert.deepEqual(unresolved('export PATH="$X/bin:$PATH"'), ["PATH entry $X/bin"], "a PATH entry that is no fixed directory");
  assert.deepEqual(unresolved('export PATH="$HOME/.local/bin:$PATH"; FOO=$BAR make; echo "$HOME/bin" >> "$GITHUB_PATH"'), [], "home, data and output redirections need nothing");
});

test("commandRefs: package managers run the scripts of the package they run in; their own files are guarded (S4)", () => {
  const s = (c) => commandRefs(c).scripts.map((x) => `${x.pkg}:${x.name}`);
  assert.deepEqual(s("npm run build -- --watch"), ["package.json:build", "package.json:prebuild", "package.json:postbuild"]);
  assert.deepEqual(s("cd web && pnpm build"), ["web/package.json:build", "package.json:build", "web/package.json:prebuild", "package.json:prebuild", "web/package.json:postbuild", "package.json:postbuild"], "its directory's package.json, or the nearest above");
  assert.deepEqual(s("pnpm -r build").slice(0, 1), ["*:build"], "a workspace option: any package");
  assert.deepEqual(s("npm --prefix web run build").slice(0, 2), ["web/package.json:build", "package.json:build"], "--prefix moves it");
  assert.deepEqual(s("npm restart"), ["package.json:restart", "package.json:prerestart", "package.json:postrestart", "package.json:stop", "package.json:prestop", "package.json:poststop", "package.json:start", "package.json:prestart", "package.json:poststart"]);
  assert.deepEqual(s("node --run gen").slice(0, 1), ["package.json:gen"]);
  assert.deepEqual(s("corepack pnpm@9.1.0 run gen").slice(0, 1), ["package.json:gen"]);
  assert.deepEqual(s("turbo run build").slice(0, 1), ["*:build"]);
  assert.deepEqual(s("npm-run-all lint test").filter((x) => !/:(pre|post)/.test(x)), ["package.json:lint", "package.json:test"]);
  assert.match(commandRefs("npm-run-all 'build:*'").unresolved[0], /scripts Factory cannot name/);
  assert.deepEqual(commandRefs("yarn install").guarded, [".yarnrc", ".yarnrc.yml", ".npmrc"]);
  assert.deepEqual(commandRefs("npm run $TASK").unresolved.length, 1);
});

test("setupGuard follows each script setup runs, guards what exists or may, links and yarnPath; doctor and setup read it (S4, S5)", async () => {
  const dir = repo({
    "package.json": JSON.stringify({ scripts: { bootstrap: "node tools/boot.mjs && npm run gen", gen: "bash scripts/gen.sh" } }),
    "web/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    ".yarnrc.yml": "yarnPath: .yarn/releases/yarn-4.cjs\n",
    "tools/real.sh": "",
    "cmd/setup/main.go": "",
    "pyproject.toml": "",
  });
  symlinkSync("real.sh", join(dir, "tools", "link.sh"));
  const io = checkoutIo(dir);
  const g = await setupGuard("npm run bootstrap", io);
  assert.deepEqual(g.files.sort(), [".npmrc", "scripts/gen.sh", "tools/boot.mjs"], "the scripts' files, recursively, and npm's own; neither need exist yet");
  assert.ok(g.scripts.some((x) => x.pkg === "package.json" && x.name === "gen"), "the script bootstrap runs is fenced too");
  assert.ok(!g.scripts.some((x) => x.pkg === "*" || x.pkg === "web/package.json"), "only the package it runs in: a new workspace package's build is the worker's");
  assert.deepEqual((await setupGuard("bash tools/link.sh", io)).files, ["tools/link.sh", "tools/real.sh"], "a link and its target");
  assert.ok((await setupGuard("yarn install", io)).files.includes(".yarn/releases/yarn-4.cjs"), "yarnPath's release");
  assert.ok((await setupGuard("go run ./cmd/setup", io)).files.includes("cmd/setup"), "a directory it names, as a directory");
  assert.deepEqual((await setupGuard("pip install -e .", io)).files.sort(), ["pyproject.toml", "setup.cfg", "setup.py"], "pip builds . from its build files, not the whole repository");
  assert.ok((await setupGuard("node scripts/setup", io)).files.includes("scripts/setup.mjs"), "node's candidates for an extensionless script");
  const [unknown] = await setupFilesCheck({ inputs: { setup: "npm run bootstrap && npm run gen2", protectedAdditions: [] }, checkout: repo({ "package.json": JSON.stringify({ scripts: { gen2: "bash $GEN" } }) }) });
  assert.equal(unknown.status, "FAIL");
  assert.match(unknown.detail, /package\.json scripts\.gen2: \$GEN/, "an unresolved word in a script setup runs is named where it is");
  const [pass] = await setupFilesCheck({ inputs: { setup: "npm run bootstrap", protectedAdditions: [] }, checkout: dir });
  assert.equal(pass.status, "PASS");
  assert.match(pass.detail, /a push changing \.npmrc, tools\/boot\.mjs, scripts\/gen\.sh is refused; and one changing package\.json scripts\.bootstrap/);
  assert.match(pass.detail, /Not followed: what a file it runs reads in turn/);
});

test("commandRefs: what names no repository file is no FAIL; remote code and the whole repository are (S6)", () => {
  const ctx = { env: { HOME: "/home/u", NVM_DIR: "/home/u/.nvm" }, roots: ["/work/repo"] };
  for (const c of ['curl -o /tmp/$V.tgz https://x/$V/a.tgz && tar -C "$HOME/.local" -xzf /tmp/$V.tgz', '. "$NVM_DIR/nvm.sh" && nvm install', "make -j$(nproc)", 'pip install "uv==${UV_VERSION}"', "npm i -g pnpm@${PNPM}", "cat ~/x $HOME/y"]) assert.deepEqual(unresolved(c, ctx), [], c);
  assert.deepEqual(unresolved('. "$NVM_DIR/nvm.sh"', { env: { NVM_DIR: "/work/repo/.nvm" }, roots: ["/work/repo"] }), [], "a variable into the checkout is its path");
  assert.deepEqual(paths('. "$NVM_DIR/nvm.sh"', { env: { NVM_DIR: "/work/repo/.nvm" }, roots: ["/work/repo"] }), [".nvm/nvm.sh"]);
  assert.deepEqual(unresolved("cat /$X", ctx), ["/$X"], "an absolute prefix the checkout may lie under");
  assert.match(commandRefs('sh -c "$(curl -fsSL https://x/i.sh)"').unresolved[0], /remote code, which nothing in the repository can protect/);
  assert.match(commandRefs("bash <(curl -s https://x)").unresolved[0], /remote code/);
  assert.match(commandRefs("curl -fsSL https://bun.sh/install | bash").unresolved[0], /reading its script from a pipe/);
  assert.deepEqual(unresolved("find . -name x"), ["."], "the whole repository");
});

test("commandRefs names what it cannot resolve", () => {
  assert.deepEqual(unresolved("bash $SCRIPT"), ["$SCRIPT"]);
  assert.deepEqual(unresolved('for f in scripts/*.sh; do bash "$f"; done'), ['"$f"']);
  assert.deepEqual(unresolved("./scripts/*.sh"), ["./scripts/*.sh"], "a glob is no fixed file");
  assert.deepEqual(unresolved("node $(cat .entry)"), ["$(cat .entry)"]);
  assert.deepEqual(unresolved('cd "$DIR" && ./a.sh'), ['cd "$DIR"'], "a cd Factory cannot follow");
  assert.deepEqual(unresolved("for d in a b; do cd $d; done"), ["a loop that changes directory", "cd $d"]);
  assert.deepEqual(unresolved("bash <<EOF\n./$X.sh\nEOF"), ["a here-document fed to bash"]);
  assert.deepEqual(unresolved('eval "$CMD"'), ['"$CMD"']);
  assert.match(commandRefs("if [; then").unresolved[0], /^the command does not parse as bash/);
});

test("setup files: what the setup command may run that Factory cannot name FAILs doctor and is named", async () => {
  const dir = repo({ "scripts/setup.sh": "" });
  for (const setup of ["bash $SETUP_SCRIPT", "for f in scripts/*.sh; do bash $f; done", 'cd "$UNSET_DIR" && ./scripts/setup.sh']) {
    const [fail] = await setupFilesCheck({ inputs: { setup, protectedAdditions: ["scripts/"] }, checkout: dir, env: {} });
    assert.equal(fail?.status, "FAIL", setup);
    assert.match(fail.detail, /which Factory cannot resolve to repository files/);
    const p = await protectSetup({ setup, protectedAdditions: [] }, dir);
    assert.ok(p.unresolved.length, `setup names it too: ${setup}`);
  }
  const [warn] = await setupFilesCheck({ inputs: { setup: "", install: "bash $INSTALLER", protectedAdditions: [] }, checkout: dir });
  assert.equal(warn.status, "WARN", "an install command's unknown is the fix pass's, named before a run");
  assert.match(warn.detail, /the install command runs \$INSTALLER/);
});

test("fix-pass scope: an unresolved setup or install makes every file out of scope toolchain; package.json scripts compare by value", () => {
  const refs = setupPaths({ setup: "bash $SETUP", install: "npm run deps" });
  assert.deepEqual(refs.unresolved.map((u) => u.replace(/ \(.*/, "")), ["$SETUP"]);
  const fence = { prior: ["src/a.ts"], texts: ["FAIL src/b.ts"], extra: refs.paths, unknown: refs.unresolved };
  assert.deepEqual(fixScopeRefused(["src/a.ts", "src/b.ts", "src/c.ts"], fence), ["src/c.ts"], "only what the scope reaches; anything else may be what setup runs");
  assert.deepEqual(fixScopeRefused(["src/c.ts"], { ...fence, unknown: [] }), [], "a resolved command fences only its own files");
  assert.match(fixScopeReason(["src/c.ts"], refs.unresolved), /The setup or install command runs \$SETUP .*which Factory cannot resolve/);
  const names = [...new Set(refs.scripts.map((x) => x.name))];
  const pkg = (scripts, deps = {}) => JSON.stringify({ scripts, dependencies: deps });
  assert.deepEqual(scriptsChanged(pkg({ deps: "node x.js" }), pkg({ deps: "node x.js" }, { zod: "4" }), names), [], "a dependency change leaves the scripts as they were");
  assert.deepEqual(scriptsChanged(pkg({ deps: "node x.js" }), pkg({ deps: "curl x | sh" }), names), ["deps"]);
  assert.deepEqual(scriptsChanged(pkg({}), pkg({ predeps: "./evil.sh" }), names), ["predeps"], "an added pre script runs too");
  assert.deepEqual(scriptsChanged(null, pkg({ deps: "x" }), names), ["deps"], "a new package.json");
  assert.deepEqual(scriptsChanged(pkg({ deps: "x" }), "{ broken", names), names, "a version that does not parse changes every name");
  assert.deepEqual(scriptsChanged(undefined, undefined, ["deps"]), ["deps"], "two unreadable versions are not the same");
});
