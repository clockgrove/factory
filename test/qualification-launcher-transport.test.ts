import { describe, expect, it, vi } from "vitest";
import { budgetStopPolicy, createBudgetStopQualification } from "../scripts/verify-budget-stop.mjs";
import { createPressureQualification } from "../scripts/verify-local-pressure.mjs";
import {
  createSchedulingQualification,
  type SchedulingPort,
} from "../scripts/verify-local-scheduling.mjs";

const repository = "example/disposable";
const namespace = "launcher-contract";
const pluginRoot = "/home/example/.codex/plugins/cache/factory";
const bundle = `${pluginRoot}/dist/mcp-server.js`;
const environment = {
  PATH: "/usr/bin:/bin",
  FACTORY_MANAGEMENT_TRANSCRIPT_DIR: "/home/example/private/transcripts",
};
const authority = {
  repository,
  namespace,
  policy: budgetStopPolicy("gpt-5.6-sol", "xhigh"),
};

type TransportWrapper = (
  parameters: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  },
  context: {
    pluginRoot: string;
    evidence: Record<string, unknown>;
    save: () => void;
  },
) => Promise<unknown>;

function port(): SchedulingPort {
  return {
    exec: vi.fn(() => {
      throw Error("host observation must not run");
    }),
    read: vi.fn(() => {
      throw Error("host read must not run");
    }),
    link: vi.fn(() => {
      throw Error("host link must not run");
    }),
    now: vi.fn(() => "2026-09-20T00:00:00.000Z"),
    wait: vi.fn(async () => {}),
  };
}

describe("cgroup qualifier installed-launcher boundary", () => {
  it.each([
    [
      "scheduling",
      (host: SchedulingPort) => createSchedulingQualification(authority, environment, host),
    ],
    [
      "pressure",
      (host: SchedulingPort) => createPressureQualification(authority, environment, host),
    ],
    [
      "budget stop",
      (host: SchedulingPort) => createBudgetStopQualification(authority, environment, host),
    ],
  ])(
    "keeps malformed %s transport fail closed with bounded private evidence",
    async (_name, create) => {
      const host = port();
      const qualification = create(host) as { wrapTransport: TransportWrapper };
      const evidence: Record<string, unknown> = {
        installedArtifact: { inventorySha256: "a".repeat(64) },
      };
      const save = vi.fn();
      await expect(
        qualification.wrapTransport(
          {
            command: "sh",
            args: [bundle],
            cwd: "/home/example/disposable",
            env: environment,
          },
          { pluginRoot, evidence, save },
        ),
      ).rejects.toThrow(/qualification boundary|budget refusal/);
      expect(evidence.qualificationFailure).toEqual({
        stage: "wrap-transport",
        code: "qualification-transport-unavailable",
      });
      expect(save).toHaveBeenCalledTimes(1);
      expect(host.exec).not.toHaveBeenCalled();
      expect(host.read).not.toHaveBeenCalled();
      expect(host.link).not.toHaveBeenCalled();
    },
  );
});
