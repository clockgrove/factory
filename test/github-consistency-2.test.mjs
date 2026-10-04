import { defineConsistency } from "./support/github-consistency.mjs";

await defineConsistency(import.meta.filename);
