import { KNOWN } from "./support/fault-known.mjs";
import { defineMatrix } from "./support/fault-matrix.mjs";

await defineMatrix("native-stack", KNOWN["native-stack"], 2);
