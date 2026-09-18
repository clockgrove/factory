import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main as liveObjectiveMain } from "../scripts/verify-live-objective.mjs";
import {
  localFaultHarnessPaths,
  runQualification as runFaultQualification,
} from "../scripts/verify-local-faults.mjs";
import { main as schedulingMain } from "../scripts/verify-local-scheduling.mjs";
import { main as pressureMain } from "../scripts/verify-local-pressure.mjs";
import { main as nativeRefreshMain } from "../scripts/verify-native-refresh-objective.mjs";
import { main as nativeFallbackMain } from "../scripts/verify-native-fallback-objective.mjs";
import {
  cleanupQualificationInstallFixtures,
  createQualificationInstallFixture,
  writeQualificationFixtureFile,
} from "./helpers/qualification-install.js";

const sharedHarnessPaths = [
  "scripts/verify-live-objective.mjs",
  "scripts/qualification-model-accounting.mjs",
  "scripts/qualification-receipts.mjs",
  "scripts/qualification-merge-proof.mjs",
];
const common = {
  FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1",
  FACTORY_LIVE_OBJECTIVE_REPOSITORY: "example/disposable",
  FACTORY_LIVE_OBJECTIVE_NAMESPACE: "authority-fixture",
  FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "250000",
};

type InstallFixture = ReturnType<typeof createQualificationInstallFixture>;
type Runner = (
  env: Record<string, string | undefined>,
  run: (qualification: Record<string, unknown>) => Promise<void>,
) => Promise<void>;

const drifts = [
  {
    name: "retained Factory bundle drift",
    error: /installed factory\.js byte count differs/,
    mutate: (fixture: InstallFixture, _runnerPath: string) =>
      writeQualificationFixtureFile(
        join(fixture.installedFactoryRoot, "dist/factory.js"),
        "substituted\n",
        0o700,
      ),
    list: (fixture: InstallFixture) => fixture.listed,
  },
  {
    name: "committed runner drift",
    error: /qualification source must be clean/,
    mutate: (fixture: InstallFixture, runnerPath: string) =>
      writeQualificationFixtureFile(
        join(fixture.source, runnerPath),
        "export const drift = true;\n",
      ),
    list: (fixture: InstallFixture) => fixture.listed,
  },
  {
    name: "isolated plugin listing drift",
    error: /requested plugin root differs from installed receipt/,
    mutate: (_fixture: InstallFixture, _runnerPath: string) => {},
    list: (fixture: InstallFixture) => ({
      installed: fixture.listed.installed.map((entry) => ({ ...entry, version: "other" })),
    }),
  },
] as const;

afterEach(cleanupQualificationInstallFixtures);

describe("Phase 4 retained-install runner boundary", () => {
  it.each([
    {
      name: "local scheduling",
      main: schedulingMain as Runner,
      env: { ...common, FACTORY_LIVE_LOCAL_SCHEDULING: "1" },
      path: "scripts/verify-local-scheduling.mjs",
    },
    {
      name: "local pressure",
      main: pressureMain as Runner,
      env: { ...common, FACTORY_LIVE_LOCAL_PRESSURE: "1" },
      path: "scripts/verify-local-pressure.mjs",
    },
    {
      name: "native refresh",
      main: nativeRefreshMain as Runner,
      env: { ...common, FACTORY_LIVE_NATIVE_REFRESH_OBJECTIVE: "1" },
      path: "scripts/verify-native-refresh-objective.mjs",
    },
    {
      name: "native fallback",
      main: nativeFallbackMain as Runner,
      env: { ...common, FACTORY_LIVE_NATIVE_FALLBACK_OBJECTIVE: "1" },
      path: "scripts/verify-native-fallback-objective.mjs",
    },
  ])("rejects retained-install drift in $name before live work", async ({ main, env, path }) => {
    for (const drift of drifts) {
      const externalUse = vi.fn();
      await expect(
        main(env, async (qualification) => {
          const harnessPaths = [
            ...sharedHarnessPaths,
            ...((qualification.harnessPaths as string[] | undefined) ?? []),
          ];
          const fixture = createQualificationInstallFixture({ harnessPaths });
          drift.mutate(fixture, path);
          await liveObjectiveMain(qualification, {
            env: {
              ...env,
              FACTORY_QUALIFICATION_INSTALL_RECEIPT: fixture.installReceipt,
            },
            candidateSourceRoot: fixture.source,
            installAuthorityOptions: { listPlugins: () => drift.list(fixture) },
          });
          externalUse();
        }),
      ).rejects.toThrow(drift.error);
      expect(externalUse, drift.name).not.toHaveBeenCalled();
    }
  });

  it("rejects every retained-install drift in the shared live Objective runner", async () => {
    for (const drift of drifts) {
      const externalUse = vi.fn();
      const fixture = createQualificationInstallFixture({ harnessPaths: sharedHarnessPaths });
      drift.mutate(fixture, "scripts/verify-live-objective.mjs");
      await expect(
        liveObjectiveMain(
          {},
          {
            env: {
              ...common,
              FACTORY_QUALIFICATION_INSTALL_RECEIPT: fixture.installReceipt,
            },
            candidateSourceRoot: fixture.source,
            installAuthorityOptions: { listPlugins: () => drift.list(fixture) },
          },
        ).then(externalUse),
      ).rejects.toThrow(drift.error);
      expect(externalUse, drift.name).not.toHaveBeenCalled();
    }
  });

  it("rejects every retained-install drift in the local fault runner", async () => {
    for (const drift of drifts) {
      const externalUse = vi.fn();
      const fixture = createQualificationInstallFixture({ harnessPaths: localFaultHarnessPaths });
      drift.mutate(fixture, "scripts/verify-local-faults.mjs");
      const progress = { stage: vi.fn(), phase: vi.fn(), failure: vi.fn() };
      await expect(
        runFaultQualification(
          progress,
          {
            FACTORY_LOCAL_FAULTS: "1",
            FACTORY_QUALIFICATION_INSTALL_RECEIPT: fixture.installReceipt,
          },
          {
            candidateSourceRoot: fixture.source,
            installAuthorityOptions: { listPlugins: () => drift.list(fixture) },
          },
        ).then(externalUse),
      ).rejects.toThrow(drift.error);
      expect(progress.stage).toHaveBeenCalledWith("installed-identity");
      expect(externalUse, drift.name).not.toHaveBeenCalled();
    }
  });
});
