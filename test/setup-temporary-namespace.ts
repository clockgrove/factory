import { afterAll } from "vitest";
import { enterTemporaryNamespace } from "./helpers/temporary-namespace.js";

// Setup files run before each test file. Independent workers and repeated runs
// must not share the user's bounded pending-transfer or content caches.
const namespace = enterTemporaryNamespace();
afterAll(() => namespace.restore());
