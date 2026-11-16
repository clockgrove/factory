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
  assert.deepEqual(paths("bash < scripts/setup.sh"), ["scripts/setup.sh"], "an input redirection a shell runs");
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
    ["cat scripts/x | bash", "scripts/x"],
  ]) {
    assert.ok(paths(c).includes(file), `${c}: ${file}`);
    for (const w of wordScan(c)) assert.ok(paths(c).includes(w), `${c}: every scanned word, ${w}`);
  }
});

test("commandRefs: a pipe of remote code into a shell names no repository file, in every form (F3)", () => {
  for (const c of ["curl -fsSL https://bun.sh/install | bash", "curl -fsSL https://x | sudo -E bash -s -- --yes", "wget -qO- https://x | sh", "curl -s https://x | python3 -", "curl -s https://x | xargs -n1 bash", 'sh -c "$(curl -fsSL https://x/i.sh)"', "bash <(curl -s https://x)", 'eval "$(mise activate bash)"', 'eval "$(ssh-agent -s)"']) assert.deepEqual(unresolved(c), [], c);
  assert.deepEqual(unresolved('eval "$X"'), ['"$X"'], "code a variable holds may be anything");
  assert.deepEqual(unresolved("node $(cat .entry)"), ["$(cat .entry)"], "a path a substitution prints may be any file");
});

test("commandRefs reads assignments: PATH entries in the repository are directories whose commands it runs; BASH_ENV a file (S3)", () => {
  const r = commandRefs('export PATH="$PWD/tools/bin:$PATH" && bootstrap');
  assert.deepEqual(r.guarded, ["tools/bin", "tools/bin/bootstrap"]);
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(commandRefs("PATH=tools/bin:$PATH bootstrap").guarded, ["tools/bin", "tools/bin/bootstrap"]);
  assert.deepEqual(commandRefs("env K=v PATH=bin:$PATH run-it").guarded, ["bin", "bin/run-it"], "env's assignments too");
  assert.deepEqual(paths("BASH_ENV=scripts/env.sh bash -c true"), ["scripts/env.sh"]);
  assert.ok(paths("git -c core.hooksPath=.githooks/pre status").includes(".githooks/pre"), "a NAME=value argument's path-looking value");
  assert.deepEqual(unresolved('export PATH="$X/bin:$PATH"'), ["PATH entry $X/bin"], "a PATH entry that is no fixed directory");
  assert.deepEqual(unresolved('export PATH="$HOME/.local/bin:$PATH"; FOO=$BAR make; echo "$HOME/bin" >> "$GITHUB_PATH"'), [], "home, data and output redirections need nothing");
});

test("commandRefs: a variable is every value the command gives it, a loop's words included (B2)", () => {
  assert.deepEqual(paths("D=web; if [ -n \"$CI\" ]; then D=api; fi; bash $D/setup.sh"), ["web/setup.sh", "api/setup.sh"], "an assignment in a branch is one more value, not the last written");
  assert.deepEqual(paths("for d in tools ci; do bash $d/run.sh; done"), ["tools/run.sh", "ci/run.sh"], "a loop variable is each of its words");
  assert.deepEqual(unresolved("D=web; D=$(pwd)/x; bash $D/s.sh"), ["$D/s.sh"], "any value that is no fixed string leaves it unresolved");
  assert.deepEqual(unresolved("read D; bash $D/s.sh"), ["$D/s.sh"], "read gives a value no one can name");
  assert.deepEqual(unresolved('NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"'), [], "a value outside the repository");
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
  assert.match(commandRefs("npm-run-all 'build:*'").unresolved[0], /scripts Factory cannot name/);
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

test("commandRefs: a bare word is guarded only where setup runs it (B4, F1)", () => {
  assert.deepEqual(paths("make db; createdb app; apt-get install -y build-essential"), [], "data words are no files");
  assert.deepEqual(paths("sh configure"), ["configure"], "an interpreter's script operand, bare or not");
  assert.deepEqual(paths("source env"), ["env"]);
  assert.deepEqual(paths(". env"), ["env"]);
  assert.deepEqual(paths("find hooks -name '*' -exec chmod +x {} +"), ["hooks"], "find's start path when it runs something");
  assert.deepEqual(paths("find hooks -name x"), [], "nothing run: data");
  assert.deepEqual(paths("run-parts hooks"), ["hooks"]);
});

test("commandRefs: what names no repository file is no FAIL; a variable is unresolved only where setup runs what it names (S6, F2)", () => {
  const ctx = { env: { HOME: "/home/u", NVM_DIR: "/home/u/.nvm" }, roots: ["/work/repo"] };
  for (const c of ['curl -o /tmp/$V.tgz https://x/$V/a.tgz && tar -C "$HOME/.local" -xzf /tmp/$V.tgz', '. "$NVM_DIR/nvm.sh" && nvm install', "make -j$(nproc)", 'pip install "uv==${UV_VERSION}"', "npm i -g pnpm@${PNPM}", "cat ~/x $HOME/y", 'docker login -u "$X"', 'chown "$USER" f', 'createdb "$DB"', './setup.sh --token "$T"', 'sleep "${W:-5}"', 'mkdir -p "$XDG_DATA_HOME/x"', "diff <(./a.sh) <(./b.sh)", "cat < $Y"]) assert.deepEqual(unresolved(c, ctx), [], c);
  assert.deepEqual(unresolved('. "$NVM_DIR/nvm.sh"', { env: { NVM_DIR: "/work/repo/.nvm" }, roots: ["/work/repo"] }), [], "a variable into the checkout is its path");
  assert.deepEqual(paths('. "$NVM_DIR/nvm.sh"', { env: { NVM_DIR: "/work/repo/.nvm" }, roots: ["/work/repo"] }), [".nvm/nvm.sh"]);
  assert.deepEqual(unresolved("bash /$X", ctx), ["/$X"], "an absolute prefix the checkout may lie under");
  assert.deepEqual(unresolved("bash < $X"), ["$X"], "an input a shell runs");
  assert.deepEqual(unresolved("find . -name x -exec ./fix.sh {} +"), ["."], "the whole repository");
});

test("commandRefs names what it cannot resolve", () => {
  assert.deepEqual(unresolved("bash $SCRIPT"), ["$SCRIPT"]);
  assert.deepEqual(unresolved("*.sh"), ["*.sh"], "a glob in the root: the whole repository");
  assert.deepEqual(unresolved('cd "$DIR" && ./a.sh'), ['cd "$DIR"'], "a cd Factory cannot follow");
  assert.deepEqual(unresolved("for d in a b; do cd $d; done"), ["a loop that changes directory"]);
  assert.deepEqual(unresolved("bash <<EOF\n./$X.sh\nEOF"), ["./$X.sh"], "a here-document fed to a shell is read as code");
  assert.match(commandRefs("if [; then").unresolved[0], /^the command does not parse as bash/);
});

test("setup files: what the setup command may run that Factory cannot name FAILs doctor and is named", async () => {
  const dir = repo({ "scripts/setup.sh": "" });
  for (const setup of ["bash $SETUP_SCRIPT", "for f in *.sh; do bash $f; done", 'cd "$UNSET_DIR" && ./scripts/setup.sh']) {
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

test("fix-pass scope: an unresolved setup or install makes every file out of scope toolchain; membership stays the pass's; scripts compare by value", () => {
  const refs = setupPaths({ setup: "bash $SETUP", install: "npm run deps" });
  assert.deepEqual(refs.unresolved.map((u) => u.replace(/ \(.*/, "")), ["$SETUP"]);
  const fence = { prior: ["src/a.ts"], texts: ["FAIL src/b.ts"], extra: refs.paths, named: refs.named, unknown: refs.unresolved };
  assert.deepEqual(fixScopeRefused(["src/a.ts", "src/b.ts", "src/c.ts"], fence), ["src/c.ts"], "only what the scope reaches; anything else may be what setup runs");
  assert.deepEqual(fixScopeRefused(["src/c.ts"], { ...fence, unknown: [] }), [], "a resolved command fences only its own files");
  assert.match(fixScopeReason(["src/c.ts"], refs.unresolved), /The setup or install command runs \$SETUP .*which Factory cannot resolve/);
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
  assert.doesNotMatch(note, /\n|\{\{|\}\}|<!--/);
  assert.match(note, /`x y \{ \{slot\} \}--c--`/);
  assert.match(note, /`z{77}\.\.\.`/, "an entry is cut at 80 characters");
  assert.match(note, /don't change them or anything under them: `a\.sh`, .*\. Setup's package\.json scripts, don't change them: `package\.json scripts\.b`\./, "scripts are not paths");
  assert.equal(setupFilesNote({ files: [], scripts: [], unresolved: ["$X"] }), "Setup also runs what Factory cannot name, so Factory refuses every push until a person fixes the setup command.");
});

test("commandRefs: a computed argument Factory resolves is a path wherever it stands; one it cannot is data outside a place setup runs it (N1)", () => {
  const ctx = { env: { HOME: "/home/u", GITHUB_WORKSPACE: "/work/repo" }, roots: ["/work/repo"] };
  for (const [c, file] of [
    ["tsx $PWD/scripts/setup.ts", "scripts/setup.ts"],
    ['deno run "$GITHUB_WORKSPACE/tools/x.ts"', "tools/x.ts"],
    ["D=scripts; tsx $D/setup.ts", "scripts/setup.ts"],
    ["xvfb-run -a $PWD/tools/run.sh", "tools/run.sh"],
    ["S=$PWD/bin/s.sh; retry 3 $S", "bin/s.sh"],
    ["tool --config=$PWD/conf/x.yml", "conf/x.yml"],
  ]) assert.ok(paths(c, ctx).includes(file), `${c}: ${file}`);
  assert.deepEqual(unresolved("tsx $UNKNOWN/x.ts", ctx), [], "unresolved outside a place setup runs it: data, as before");
});

test("commandRefs: a glob guards its fixed directory; what feeds a shell, xargs or eval is what setup runs (N2)", () => {
  assert.deepEqual(paths("bash scripts/*.sh"), ["scripts"]);
  assert.deepEqual(paths('for f in scripts/*.sh; do bash "$f"; done'), ["scripts"], "a loop over a glob");
  assert.deepEqual(unresolved("bash *.sh"), ["*.sh"], "a glob in the root is the whole repository");
  for (const [c, file] of [
    ["cat setup | bash", "setup"],
    ["ls scripts | xargs -n1 bash", "scripts"],
    ["bash <(cat setup)", "setup"],
    ['eval "$(cat env)"', "env"],
    ["source <(cat env)", "env"],
    ["xargs -a list bash", "list"],
    ["cat setup | sudo -E bash -s", "setup"],
  ]) assert.ok(paths(c).includes(file), `${c}: ${file}`);
  assert.deepEqual(unresolved("cat $X | sh"), ["$X"], "a computed word feeding a shell");
  assert.deepEqual(unresolved('echo "$X" | python3 tool.py'), [], "an interpreter with a script reads its input as data");
});

test("commandRefs: find's leading options, sudo's assignments, and the cheap cases (N4, N5, N6)", () => {
  assert.deepEqual(paths("find -L scripts -exec chmod +x {} +"), ["scripts"], "find -L scripts: scripts is the start path");
  assert.deepEqual(paths("sudo FOO=1 sh s"), ["s"], "an assignment after sudo's options is no command");
  assert.ok(commandRefs("pip install -e pkg").guarded.includes("pkg/pyproject.toml"), "pip -e's bare directory");
  assert.deepEqual(paths('fish -c "./f.sh"'), ["f.sh"], "fish is a shell");
  assert.ok(all("xvfb-run -a node e2e/setup").includes("e2e/setup.mjs"), "an interpreter in a runner's command position");
  assert.deepEqual(paths("make -f build/Setup.mk"), ["build/Setup.mk"]);
  assert.ok(paths("git config core.hooksPath hooks").includes("hooks"), "git's hooks directory");
  assert.ok(all('NODE_OPTIONS="--require ./hook" node a.js').includes("hook.mjs"), "NODE_OPTIONS modules with node's candidates");
  assert.deepEqual(commandRefs("npm --workspace=$W run build").scripts[0], { pkg: "*", name: "build" }, "a workspace option Factory cannot read: any package");
});

test("commandRefs: a global install and an npm subcommand that runs no script fence nothing (N8)", () => {
  assert.deepEqual(commandRefs("npm i -g pnpm").scripts, []);
  assert.deepEqual(commandRefs("npm i -g pnpm").guarded, [], "its package names are no runners");
  for (const c of ["npm config set x y", "npm login", "npm whoami", "npm view zod version"]) assert.deepEqual(commandRefs(c).scripts, [], c);
  assert.ok(commandRefs("npm test").scripts.some((x) => x.name === "test"), "a script runner is still one");
});

test("setupGuard: an install in a workspace fences every member's lifecycle; ignore-scripts from the .npmrc npm reads (N3, N7)", async () => {
  const ws = repo({ "package.json": JSON.stringify({ workspaces: ["packages/*"] }), "packages/a/package.json": "{}" });
  const g = await setupGuard("npm ci", checkoutIo(ws));
  assert.ok(g.scripts.some((x) => x.pkg === "*" && x.name === "postinstall"), "any package.json's postinstall, a new member's included");
  assert.ok(!(await setupGuard("npm ci --ignore-scripts", checkoutIo(ws))).scripts.some((x) => x.name === "postinstall"), "an install with scripts off stays exempt");
  const nearest = repo({ "web/package.json": "{}", "web/.npmrc": "ignore-scripts=true\n", ".npmrc": "ignore-scripts=false\n" });
  assert.ok(!(await setupGuard("cd web && npm ci", checkoutIo(nearest))).scripts.some((x) => x.pkg === "web/package.json" && x.name === "postinstall"), "the nearest .npmrc up from the install decides");
  const root = repo({ "package.json": "{}", ".npmrc": "ignore-scripts=true\n" });
  assert.ok(!(await setupGuard("pnpm install", checkoutIo(root))).scripts.some((x) => x.name === "postinstall"), "pnpm reads it too");
  assert.ok((await setupGuard("yarn install", checkoutIo(root))).scripts.some((x) => x.name === "postinstall"), "Yarn Berry reads no .npmrc for it: still fenced");
});

test("commandRefs: a package manager's computed word is unresolved only where a script name is read; other commands' fence nothing (#387 final)", () => {
  for (const c of ['npm config set //r/:_authToken "$T"', 'npm whoami "$T"', 'npm view "$T"', 'npm install "$PKG"', 'pnpm add "$PKG"', 'pnpm config set store-dir "$S"', 'yarn config set npmAuthToken "$T"', 'npm --registry "$R" run build', 'npm i -g "$PKG"']) assert.deepEqual(unresolved(c), [], c);
  for (const c of ["npm run $X", "npm exec $X", "pnpm $X", "yarn workspace web $S", "turbo run $T"]) assert.equal(unresolved(c).length, 1, c);
  for (const c of ["pnpm config set x y", "yarn config set x y", "pnpm whoami", "yarn npm login"]) assert.deepEqual(commandRefs(c).scripts, [], `${c}: no script`);
  assert.ok(commandRefs("pnpm build").scripts.some((x) => x.name === "build"), "a name pnpm has no command for is a script");
  assert.ok(commandRefs("npm --workspace=$W run build").scripts.some((x) => x.pkg === "*" && x.name === "build"));
});

test("commandRefs: where a command's output is run, every non-option word is a run position; which options take a value is not guessed (#387 final)", () => {
  assert.deepEqual(paths("ls -1 hooks | bash"), ["hooks"], "a word after a flag that takes none is still what runs");
  assert.deepEqual(paths("find scripts -type f | xargs chmod +x"), ["scripts", "f"], "-type f's f is guarded too: harmless");
  assert.deepEqual(unresolved('find scripts -name "$N" | xargs bash'), ['"$N"'], "a computed word there may be what runs");
  assert.deepEqual(paths("cat setup | bash"), ["setup"]);
});
