import { KNOWN } from "./support/fault-known.mjs";
import { defineMatrix } from "./support/fault-matrix.mjs";

await defineMatrix("regular", KNOWN.regular, 1);
