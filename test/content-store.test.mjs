import assert from "node:assert/strict";
import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { LocalContentStore } from "../dist/content/local.js";

test("disk content survives storage and materialization, and corruption is refused", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "factory-content-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source.bin");
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  writeFileSync(source, bytes);
  const store = new LocalContentStore(join(root, "objects"));
  const ref = await store.put(Readable.toWeb(createReadStream(source)), {
    mediaType: "application/octet-stream",
  });
  await store.verify(ref);
  const copy = join(root, "copy.bin");
  await store.materialize(ref, copy);
  assert.equal(ref.bytes, bytes.length);
  assert.deepEqual(readFileSync(copy), bytes);
  writeFileSync(
    join(root, "objects", ref.digest.slice(0, 2), ref.digest),
    "corrupted",
  );
  await assert.rejects(store.verify(ref), /digest verification/);
});
