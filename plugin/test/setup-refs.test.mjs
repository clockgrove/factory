// What the setup and install commands refer to in the repository (shell.mjs commandRefs, read from bash's syntax tree),
// and how the fences take it: doctor's setup-files check, setup's protected paths, the fix-pass scope (#387).
import "./temp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandRefs } from "../scripts/lib/shell.mjs";
import { fixScopeReason, fixScopeRefused, scriptsChanged, setupPaths } from "../scripts/lib/logic.mjs";
import { setupFilesCheck } from "../scripts/doctor.mjs";
import { protectSetup } from "../scripts/setup.mjs";

test("commandRefs resolves the files a command runs by bash's grammar: quotes, cd, -c code, substitutions, functions", () => {
  const paths = (c) => commandRefs(c).paths;
  const spaced = paths(`bash 'scripts/my setup.sh' && "./tools/install deps.sh"`);
  assert.ok(spaced.includes("scripts/my setup.sh") && spaced.includes("tools/install deps.sh"), "a quoted path with a space is one file");
  assert.deepEqual(paths("cd web && ./build.sh"), ["build.sh", "web/build.sh"], "after a literal cd: in the directory it reaches, and in the one it leaves, should it fail");
  assert.deepEqual(paths(`sudo -u root bash -c "cd api && ./seed.sh"`).filter((p) => p.endsWith(".sh")), ["seed.sh", "api/seed.sh"], "code another program runs is read as a command");
  assert.deepEqual(paths(`X=$(./version.sh) make; echo "$(./note.sh)"`), ["version.sh", "note.sh"], "a substitution runs its command wherever it stands");
  assert.deepEqual(paths("f() { ./inner.sh; }; cd sub; f"), ["inner.sh", "sub/inner.sh"], "a function's body runs in any directory the command reaches");
  assert.deepEqual(paths("bash < scripts/setup.sh"), ["scripts/setup.sh"], "an input redirection is read");
  assert.deepEqual(paths("bash <<'EOF'\n./heredoc.sh\nEOF"), ["heredoc.sh"], "a here-document fed to a shell is code");
  assert.deepEqual(paths("flock /tmp/l -c './w.sh'"), ["w.sh"], "a literal that may be code is read for the files it names");
  assert.deepEqual(paths("echo ./not-run.sh > /dev/null; test -f ./x.sh; ~/bin/tool; /usr/bin/env; ../up.sh"), [], "data, absolute paths, ~ and paths out of the root name no repository file");
});

test("commandRefs names what it cannot resolve; a package manager's script is a package.json entry", () => {
  const unresolved = (c) => commandRefs(c).unresolved;
  assert.deepEqual(unresolved("bash $SCRIPT"), ["$SCRIPT"]);
  assert.deepEqual(unresolved('for f in scripts/*.sh; do bash "$f"; done'), ['"$f"']);
  assert.deepEqual(unresolved("./scripts/*.sh"), ["./scripts/*.sh"], "a glob is no fixed file");
  assert.deepEqual(unresolved("node $(cat .entry)"), ["$(cat .entry)"]);
  assert.deepEqual(unresolved('cd "$DIR" && ./a.sh'), ['cd "$DIR"'], "a cd Factory cannot follow: every later relative path is unknown");
  assert.deepEqual(unresolved("for d in a b; do cd $d; done"), ["a loop that changes directory", "cd $d"]);
  assert.deepEqual(unresolved("bash <<EOF\n./$X.sh\nEOF"), ["a here-document fed to bash"]);
  assert.deepEqual(unresolved("eval \"$CMD\""), ['"$CMD"']);
  assert.match(unresolved("if [; then")[0], /^the command does not parse as bash/);
  assert.deepEqual(unresolved('echo "$HOME/bin" >> "$GITHUB_PATH"; export PATH="$PWD/bin:$PATH"; FOO=$BAR make'), [], "data builtins, output redirections and assignments resolve nothing and need nothing");
  assert.deepEqual(commandRefs("npm ci && npm run build -- --watch && pnpm lint").scripts, ["ci", "preci", "postci", "build", "prebuild", "postbuild", "lint", "prelint", "postlint"]);
  assert.deepEqual(commandRefs("npm t").scripts, ["t", "pret", "postt", "test", "pretest", "posttest"], "npm's alias runs scripts.test");
  assert.deepEqual(commandRefs("npm run $TASK").unresolved, ["$TASK"]);
});

test("setup files: what the setup command may run that Factory cannot name FAILs doctor and is named; a package.json script is fenced, not protected", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-setup-refs-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "setup.sh"), "");
  for (const setup of ["bash $SETUP_SCRIPT", "for f in scripts/*.sh; do bash $f; done", 'cd "$GITHUB_WORKSPACE" && ./scripts/setup.sh']) {
    const [fail] = setupFilesCheck({ inputs: { setup, protectedAdditions: ["scripts/"] }, checkout: dir });
    assert.equal(fail?.status, "FAIL", setup);
    assert.match(fail.detail, /which Factory cannot resolve to repository files/);
    const p = protectSetup({ setup, protectedAdditions: [] }, dir);
    assert.ok(p.unresolved.length, `setup names it too: ${setup}`);
  }
  const [pass] = setupFilesCheck({ inputs: { setup: "bash scripts/setup.sh && npm run bootstrap", protectedAdditions: ["/scripts/setup.sh"] }, checkout: dir });
  assert.equal(pass.status, "PASS");
  assert.match(pass.detail, /scripts\/setup\.sh protected; package\.json scripts bootstrap, prebootstrap, postbootstrap fenced/);
  const [warn] = setupFilesCheck({ inputs: { setup: "", install: "bash $INSTALLER", protectedAdditions: [] }, checkout: dir });
  assert.equal(warn.status, "WARN", "an install command's unknown is the fix pass's, named before a run");
  assert.match(warn.detail, /the install command runs \$INSTALLER/);
});

test("fix-pass scope: an unresolved setup or install makes every file out of scope toolchain; package.json scripts compare by value", () => {
  const refs = setupPaths({ setup: "bash $SETUP", install: "npm run deps" });
  assert.deepEqual(refs.unresolved, ["$SETUP"]);
  const fence = { prior: ["src/a.ts"], texts: ["FAIL src/b.ts"], extra: refs.paths, unknown: refs.unresolved };
  assert.deepEqual(fixScopeRefused(["src/a.ts", "src/b.ts", "src/c.ts"], fence), ["src/c.ts"], "only what the scope reaches; anything else may be what setup runs");
  assert.deepEqual(fixScopeRefused(["src/c.ts"], { ...fence, unknown: [] }), [], "a resolved command fences only its own files");
  assert.match(fixScopeReason(["src/c.ts"], refs.unresolved), /The setup or install command runs \$SETUP, which Factory cannot resolve/);
  const pkg = (scripts, deps = {}) => JSON.stringify({ scripts, dependencies: deps });
  assert.deepEqual(scriptsChanged(pkg({ deps: "node x.js" }), pkg({ deps: "node x.js" }, { zod: "4" }), refs.scripts), [], "a dependency change leaves the scripts as they were");
  assert.deepEqual(scriptsChanged(pkg({ deps: "node x.js" }), pkg({ deps: "curl x | sh" }), refs.scripts), ["deps"]);
  assert.deepEqual(scriptsChanged(pkg({}), pkg({ predeps: "./evil.sh" }), refs.scripts), ["predeps"], "an added pre script runs too");
  assert.deepEqual(scriptsChanged(null, pkg({ deps: "x" }), refs.scripts), ["deps"], "a new package.json");
  assert.deepEqual(scriptsChanged(pkg({ deps: "x" }), "{ broken", refs.scripts), refs.scripts, "a version that does not parse changes every name");
  assert.deepEqual(scriptsChanged(pkg({ deps: "x" }), undefined, ["deps"]), ["deps"], "nor one that cannot be read");
  assert.deepEqual(scriptsChanged(undefined, undefined, ["deps"]), ["deps"], "two unreadable versions are not the same");
});
