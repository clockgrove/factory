import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import snapshotSchema from "../../schemas/replay-snapshot.schema.json";
import policySchema from "../../schemas/run-policy.schema.json";
import { assertNoSecretMaterial } from "../protocol/limits.js";
import { replayAdmissions, type PinnedAdmissionSnapshot } from "./index.js";

export const MAX_SUPPLIED_REPLAY_SNAPSHOTS = 8;
export const MAX_SUPPLIED_REPLAY_BYTES = 1024 * 1024;
export const MAX_SUPPLIED_REPLAY_DEPTH = 32;
export const MAX_SUPPLIED_REPLAY_NODES = 100_000;
export const SUPPLIED_REPLAY_ERROR =
  "Supplied replay snapshots are invalid or exceed inspection bounds. Supply at most 8 credential-free snapshots (1 MiB total) with matching Objective, policy and snapshot digests. Raw input is suppressed.";

let validateSnapshot: ValidateFunction<PinnedAdmissionSnapshot> | undefined;
function snapshotValidator(): ValidateFunction<PinnedAdmissionSnapshot> {
  if (!validateSnapshot) {
    const ajv = new Ajv({ allErrors: false, strict: false });
    addFormats(ajv);
    ajv.addSchema(policySchema);
    validateSnapshot = ajv.compile<PinnedAdmissionSnapshot>(snapshotSchema);
  }
  return validateSnapshot;
}

/** Bound JSON traversal before serialization, schema validation or pure evaluation. */
function boundedJson(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > MAX_SUPPLIED_REPLAY_BYTES) throw new Error(SUPPLIED_REPLAY_ERROR);
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > MAX_SUPPLIED_REPLAY_NODES || depth > MAX_SUPPLIED_REPLAY_DEPTH) {
      throw new Error(SUPPLIED_REPLAY_ERROR);
    }
    if (item === null || typeof item === "boolean") {
      add(item === null ? 4 : item ? 4 : 5);
    } else if (typeof item === "number" && Number.isFinite(item)) {
      add(String(item).length);
    } else if (typeof item === "string") {
      if (item.length > MAX_SUPPLIED_REPLAY_BYTES) throw new Error(SUPPLIED_REPLAY_ERROR);
      add(Buffer.byteLength(JSON.stringify(item), "utf8"));
    } else if (typeof item === "object") {
      if (seen.has(item)) throw new Error(SUPPLIED_REPLAY_ERROR);
      seen.add(item);
      const array = Array.isArray(item);
      if (!array && Object.getPrototypeOf(item) !== Object.prototype) {
        throw new Error(SUPPLIED_REPLAY_ERROR);
      }
      // Reject accessors, symbols and hidden values rather than invoking user code
      // or silently discarding data at the application boundary.
      const keys = Reflect.ownKeys(item);
      if (keys.length > MAX_SUPPLIED_REPLAY_NODES) throw new Error(SUPPLIED_REPLAY_ERROR);
      if (array && keys.length !== item.length + 1) throw new Error(SUPPLIED_REPLAY_ERROR);
      add(2);
      let count = 0;
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string") throw new Error(SUPPLIED_REPLAY_ERROR);
        const property = Object.getOwnPropertyDescriptor(item, key)!;
        if (!property.enumerable || !("value" in property)) throw new Error(SUPPLIED_REPLAY_ERROR);
        if (array && key !== String(count)) throw new Error(SUPPLIED_REPLAY_ERROR);
        if (count++ > 0) add(1);
        if (!array) {
          if (key.length > MAX_SUPPLIED_REPLAY_BYTES) throw new Error(SUPPLIED_REPLAY_ERROR);
          add(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
        }
        visit(property.value, depth + 1);
      }
      seen.delete(item);
    } else {
      throw new Error(SUPPLIED_REPLAY_ERROR);
    }
  };
  visit(value, 0);
  return JSON.stringify(value);
}

/** Untrusted supplied simulations are never authenticated historical run inputs. */
export function parseSuppliedReplaySnapshots(
  value: unknown,
  objective: number,
): PinnedAdmissionSnapshot[] | undefined {
  if (value === undefined) return undefined;
  try {
    if (!Array.isArray(value) || value.length > MAX_SUPPLIED_REPLAY_SNAPSHOTS) {
      throw new Error(SUPPLIED_REPLAY_ERROR);
    }
    const snapshots: unknown[] = JSON.parse(boundedJson(value));
    assertNoSecretMaterial(snapshots, "supplied replay snapshots");
    const validSnapshot = snapshotValidator();
    const validated = snapshots.map((snapshot) => {
      if (!validSnapshot(snapshot) || snapshot.input.objective !== objective) {
        throw new Error(SUPPLIED_REPLAY_ERROR);
      }
      const workItems = new Set(snapshot.input.workItems.map((item) => item.number));
      const expectedItems = [
        ...snapshot.expected.admissions,
        ...snapshot.expected.queued,
      ].map((item) => item.workItem);
      if (
        new Set(expectedItems).size !== expectedItems.length ||
        expectedItems.some((number) => !workItems.has(number))
      ) {
        throw new Error(SUPPLIED_REPLAY_ERROR);
      }
      // The existing pure implementation owns normalization and digest semantics.
      // A valid, digest-bound non-reproduction is a result, not invalid input.
      replayAdmissions(snapshot);
      return snapshot;
    });
    return validated;
  } catch {
    throw new Error(SUPPLIED_REPLAY_ERROR);
  }
}
