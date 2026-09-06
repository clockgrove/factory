import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FactoryApplicationService } from "../src/application/services.js";
import { buildReplayReport } from "../src/application/replay.js";
import { pinAdmissionSnapshot } from "../src/replay/index.js";
import { readSuppliedReplayFile } from "../src/replay/file.js";
import {
  MAX_SUPPLIED_REPLAY_BYTES,
  parseSuppliedReplaySnapshots,
  SUPPLIED_REPLAY_ERROR,
} from "../src/replay/supplied.js";
import {
  replayObjective,
  suppliedReplayInput,
  suppliedReplaySnapshot,
  unreproducedReplaySnapshot,
} from "./fixtures/supplied-replay.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("supplied replay application boundary", () => {
  function application() {
    const read = vi.fn(async () => replayObjective());
    const service = new FactoryApplicationService({
      owner: "o",
      repo: "r",
      reader: { readObjective: read },
      store: new Proxy({} as NonNullable<ConstructorParameters<typeof FactoryApplicationService>[0]["store"]>, {
        get() {
          throw new Error("replay reached the mutation store");
        },
      }),
    });
    return { service, read };
  }

  it("preserves the exact receipt-only report when no snapshots or an empty array is supplied", async () => {
    const { service } = application();
    const expected = buildReplayReport({ repository: "o/r", snapshot: replayObjective() });
    expect(await service.replay(7)).toEqual(expected);
    expect(await service.replay(7, [])).toEqual(expected);
  });

  it("recomputes supplied inputs without claiming historical provenance or execution authority", async () => {
    const { service, read } = application();
    const report = await service.inspect("replay", 7, undefined, [suppliedReplaySnapshot()]);
    expect(report).toMatchObject({
      writeFree: true,
      run: { availability: "unavailable" },
      schedulerSimulation: {
        availability: "observed",
        source: "caller-supplied",
        historicalInputsAuthenticated: false,
        executionAuthority: false,
        allReproduced: true,
        snapshotCount: 1,
      },
      simulations: [{ reproduced: true, mismatches: [] }],
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("returns digest-valid non-reproduction as a simulation result", async () => {
    const { service } = application();
    expect(await service.replay(7, [unreproducedReplaySnapshot()])).toMatchObject({
      schedulerSimulation: { allReproduced: false },
      simulations: [{ reproduced: false, mismatches: [{ workItem: 8 }] }],
    });
  });

  it.each([
    null,
    {},
    [null],
    Array.from({ length: 9 }, suppliedReplaySnapshot),
    [{ ...suppliedReplaySnapshot(), capturedAt: "not-a-date" }],
    [{ ...suppliedReplaySnapshot(), policyDigest: "0".repeat(64) }],
    [{ ...suppliedReplaySnapshot(), snapshotDigest: "0".repeat(64) }],
    [pinAdmissionSnapshot({ ...suppliedReplayInput(), objective: 99 })],
    [{ ...suppliedReplaySnapshot(), input: { ...suppliedReplayInput(), leaseValid: "true" } }],
    [{ ...suppliedReplaySnapshot(), privateData: "private request payload" }],
  ].map((value) => ({ value })))("rejects malformed or mismatched input before reading GitHub", async ({ value }) => {
    const { service, read } = application();
    await expect(service.replay(7, value)).rejects.toThrow(SUPPLIED_REPLAY_ERROR);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects duplicate and out-of-domain expected decisions even with valid digests", () => {
    const snapshot = suppliedReplaySnapshot();
    const admitted = snapshot.expected.admissions[0]!;
    for (const admissions of [[admitted, admitted], [{ ...admitted, workItem: 999 }]]) {
      const duplicate = pinAdmissionSnapshot(suppliedReplayInput(), undefined, {
        admissions,
        queued: [],
      });
      expect(() => parseSuppliedReplaySnapshots([duplicate], 7)).toThrow(SUPPLIED_REPLAY_ERROR);
    }
  });

  it("suppresses secret-bearing invalid protocol, backend, capacity and unknown payloads", () => {
    const secret = `ghp_${"a".repeat(30)}`;
    for (const input of [
      [{ ...suppliedReplaySnapshot(), protocol: secret }],
      [{ ...suppliedReplaySnapshot(), credential: secret }],
      [{ ...suppliedReplaySnapshot(), input: { ...suppliedReplayInput(), capacity: { byBackend: { [secret]: -1 } } } }],
      [{ ...suppliedReplaySnapshot(), input: { ...suppliedReplayInput(), workItems: [{ backends: [{ id: secret }] }] } }],
    ]) {
      expect(() => parseSuppliedReplaySnapshots(input, 7)).toThrow(SUPPLIED_REPLAY_ERROR);
      try {
        parseSuppliedReplaySnapshots(input, 7);
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
  });

  it("bounds bytes, depth and non-JSON objects before recursive schema or digest work", () => {
    let deep: unknown = null;
    for (let i = 0; i < 40; i++) deep = [deep];
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const getter = vi.fn(() => "private");
    const accessor = Object.defineProperty({}, "input", { enumerable: true, get: getter });
    for (const input of [["x".repeat(MAX_SUPPLIED_REPLAY_BYTES)], deep, cycle, [accessor]]) {
      expect(() => parseSuppliedReplaySnapshots(input, 7)).toThrow(SUPPLIED_REPLAY_ERROR);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not silently accept replay inputs on another operation", async () => {
    const { service, read } = application();
    await expect(service.inspect("status", 7, undefined, [])).rejects.toThrow("only by replay");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("bounded replay JSON file", () => {
  async function paths() {
    const directory = await mkdtemp(join(tmpdir(), "factory-replay-input-"));
    directories.push(directory);
    return { directory, file: join(directory, "snapshots.json") };
  }

  it("reads the same validated collection as the application/MCP input", async () => {
    const { file } = await paths();
    const snapshots = [suppliedReplaySnapshot(), unreproducedReplaySnapshot()];
    await writeFile(file, JSON.stringify(snapshots));
    expect(await readSuppliedReplayFile(file, 7)).toEqual(parseSuppliedReplaySnapshots(snapshots, 7));
  });

  it("rejects oversized, missing, malformed UTF-8/JSON, directory and symlink inputs safely", async () => {
    const { directory, file } = await paths();
    await expect(readSuppliedReplayFile(file, 7)).rejects.toThrow(SUPPLIED_REPLAY_ERROR);
    await expect(readSuppliedReplayFile(directory, 7)).rejects.toThrow(SUPPLIED_REPLAY_ERROR);
    for (const content of [Buffer.from([0xff]), Buffer.from('{"private":"secret"')]) {
      await writeFile(file, content);
      await expect(readSuppliedReplayFile(file, 7)).rejects.toThrow(SUPPLIED_REPLAY_ERROR);
    }
    await truncate(file, MAX_SUPPLIED_REPLAY_BYTES + 1);
    await expect(readSuppliedReplayFile(file, 7)).rejects.toThrow(SUPPLIED_REPLAY_ERROR);
    await writeFile(file, "[]");
    const link = join(directory, "link.json");
    await symlink(file, link);
    await expect(readSuppliedReplayFile(link, 7)).rejects.toThrow(SUPPLIED_REPLAY_ERROR);
    await expect(readSuppliedReplayFile("/dev/null", 7)).rejects.toThrow(SUPPLIED_REPLAY_ERROR);
  });
});
