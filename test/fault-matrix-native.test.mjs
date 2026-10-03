import { defineMatrix } from "./support/fault-matrix.mjs";

// Known failures: Factory bugs the recovery redesign (#515) must fix. Each is
// a `todo` with its diagnosis; remove an entry when its case passes.
const known = {};

defineMatrix("native-stack", known);
