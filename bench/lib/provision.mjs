// Path fix for lib/judge.mjs, which is kept unchanged from Factory 0.5's
// bench: the one export it needs from the 0.5 provisioning module, which
// otherwise pulled in the 0.5 build (dist/). Copied verbatim.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** SHA-256 over a directory's files (relative path and content, in path order): a build's identity. */
export function treeDigest(dir) {
  const hash = createHash("sha256");
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const file = join(at, name);
      const stat = statSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) {
        hash.update(`${relative(dir, file)}\0`);
        hash.update(readFileSync(file));
        hash.update("\0");
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}
