import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { main as schedulingMain } from "../scripts/verify-local-scheduling.mjs";
import { main as pressureMain } from "../scripts/verify-local-pressure.mjs";
import { main as nativeRefreshMain } from "../scripts/verify-native-refresh-objective.mjs";
import { main as nativeFallbackMain } from "../scripts/verify-native-fallback-objective.mjs";

const common = {
  FACTORY_LIVE_OBJECTIVE_PREFLIGHT: "1",
  FACTORY_LIVE_OBJECTIVE_REPOSITORY: "example/disposable",
  FACTORY_LIVE_OBJECTIVE_NAMESPACE: "authority-fixture",
  FACTORY_LIVE_OBJECTIVE_MAX_MODEL_TOKENS: "250000",
};

describe("Phase 4 retained-install runner boundary", () => {
  it.each([
    {
      name: "local scheduling",
      main: schedulingMain,
      env: { ...common, FACTORY_LIVE_LOCAL_SCHEDULING: "1" },
      path: "scripts/verify-local-scheduling.mjs",
    },
    {
      name: "local pressure",
      main: pressureMain,
      env: { ...common, FACTORY_LIVE_LOCAL_PRESSURE: "1" },
      path: "scripts/verify-local-pressure.mjs",
    },
    {
      name: "native refresh",
      main: nativeRefreshMain,
      env: { ...common, FACTORY_LIVE_NATIVE_REFRESH_OBJECTIVE: "1" },
      path: "scripts/verify-native-refresh-objective.mjs",
    },
    {
      name: "native fallback",
      main: nativeFallbackMain,
      env: { ...common, FACTORY_LIVE_NATIVE_FALLBACK_OBJECTIVE: "1" },
      path: "scripts/verify-native-fallback-objective.mjs",
    },
  ])(
    "binds $name source through the shared retained-install runner",
    async ({ main, env, path }) => {
      const run = vi.fn<(qualification: Record<string, unknown>) => Promise<void>>(async () => {});
      await main(env, run);
      expect(run).toHaveBeenCalledOnce();
      const qualification = run.mock.calls[0]?.[0] as { harnessPaths?: string[] };
      expect(qualification.harnessPaths).toContain(path);
    },
  );

  it.each([
    ["verify-live-objective.mjs", "const token =\n    process.env.GITHUB_TOKEN"],
    ["verify-local-faults.mjs", 'const token = command("gh", ["auth", "token"]'],
  ])("authenticates %s before GitHub, controller, or provider work", (file, firstExternalUse) => {
    const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), "utf8");
    const authority = source.indexOf("installedQualificationAuthority(process.env");
    const external = source.indexOf(firstExternalUse);
    expect(authority).toBeGreaterThan(-1);
    expect(external).toBeGreaterThan(authority);
    expect(source).toContain("qualificationRuntimeEnvironment(process.env");
    expect(source).toContain("installedCandidate");
  });
});
