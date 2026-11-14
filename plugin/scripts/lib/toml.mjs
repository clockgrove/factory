// Manifests (Cargo.toml, pyproject.toml), read with the `smol-toml` library (vendored: plugin/vendor/smol-toml, pinned in
// tools/vendor). Values come back typed (a number, a boolean, a date), so a caller reading a list of strings sees any
// other value as not a string. A repeated key or table, or anything malformed, throws: the caller then treats the file
// as declaring nothing rather than guess.
import { parse } from "../../vendor/smol-toml/dist/index.js";

/** The document as plain objects (no inherited keys), or a throw. */
export function parseToml(text) {
  return parse(String(text));
}
