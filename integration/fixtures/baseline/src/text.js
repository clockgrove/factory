/** Collapse runs of whitespace to one space and trim the ends. */
export function squish(s) {
  return s.replace(/\s+/g, " ").trim();
}
