import "./temp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalAppId, saveLocalAppId } from "../scripts/lib/app-id.mjs";

// Pendulum's App id on this machine (#564): the repository variable, read again with the gh login's token on a 403, and
// its readable local copy beside the local token, which setup, serve and doctor save for `pendulum report`.

const home = () => process.env.HOME;
const copyFile = () => join(home(), ".config", "pendulum", "repos", "o", "r.json");
const dropCopies = () => rmSync(join(home(), ".config", "pendulum", "repos"), { recursive: true, force: true });

test("the App id's local copy: readable, written by its owner alone, never through a link; an id that is no App id is refused", () => {
  try {
    assert.deepEqual(readLocalAppId("o/r"), { id: null, file: copyFile() });
    assert.deepEqual(saveLocalAppId("o/r", "5487746"), { file: copyFile(), saved: true });
    assert.deepEqual(JSON.parse(readFileSync(copyFile(), "utf8")), { appId: 5487746 });
    assert.equal(lstatSync(copyFile()).mode & 0o777, 0o644, "no secret: readable");
    assert.equal(lstatSync(join(copyFile(), "..")).mode & 0o777, 0o700);
    assert.deepEqual(saveLocalAppId("o/r", 5487746), { file: copyFile(), saved: false }, "the same id: nothing written");
    assert.deepEqual(readLocalAppId("o/r"), { id: 5487746, file: copyFile() });
    assert.throws(() => saveLocalAppId("o/r", "pendulum-app"), /is no GitHub App id/);
    assert.throws(() => saveLocalAppId("../r", 1), /must be OWNER\/NAME/);
    chmodSync(copyFile(), 0o664);
    assert.match(readLocalAppId("o/r").problem, /r\.json is writable by others \(mode 664\); chmod go-w /);
    assert.throws(() => saveLocalAppId("o/r", 7), /writable by others .*the App id was not saved/);
    // The owner's folder writable by others: the file in it could be swapped, so it is not read.
    chmodSync(copyFile(), 0o644);
    chmodSync(join(copyFile(), ".."), 0o777);
    assert.match(readLocalAppId("o/r").problem, /repos\/o is writable by others \(mode 777\)/);
    chmodSync(join(copyFile(), ".."), 0o700);
    // The file itself a link: never followed.
    rmSync(copyFile());
    const target = join(mkdtempSync(join(tmpdir(), "target-")), "r.json");
    writeFileSync(target, JSON.stringify({ appId: 99 }), { mode: 0o644 });
    symlinkSync(target, copyFile());
    assert.match(readLocalAppId("o/r").problem, /r\.json is a symbolic link/);
    // A link in place of the owner's folder: neither read nor written through.
    dropCopies();
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    writeFileSync(join(elsewhere, "r.json"), JSON.stringify({ appId: 99 }));
    mkdirSync(join(home(), ".config", "pendulum", "repos"), { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, join(home(), ".config", "pendulum", "repos", "o"));
    assert.match(readLocalAppId("o/r").problem, /repos\/o is a symbolic link/);
    assert.equal(readLocalAppId("o/r").id, null);
    assert.throws(() => saveLocalAppId("o/r", 7), /symbolic link/);
  } finally {
    dropCopies();
  }
});
