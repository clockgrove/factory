import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installedQualificationAuthority,
  qualificationRuntimeEnvironment,
} from "../scripts/qualification-install-identity.mjs";
import {
  cleanupQualificationInstallFixtures,
  createQualificationInstallFixture,
  writeQualificationFixtureFile,
} from "./helpers/qualification-install.js";

const fixture = createQualificationInstallFixture;
const write = writeQualificationFixtureFile;

afterEach(() => {
  cleanupQualificationInstallFixtures();
});

describe("retained qualification install authority", () => {
  it("binds the source, tarball, npm install, plugin archive, isolated listing, and cache", () => {
    const value = fixture();
    const listPlugins = vi.fn(() => value.listed);
    const authority = installedQualificationAuthority(
      { FACTORY_QUALIFICATION_INSTALL_RECEIPT: value.installReceipt },
      { sourceRoot: value.source, committedPaths: ["scripts/harness.mjs"], listPlugins },
    );
    expect(authority).toMatchObject({
      installedFactoryRoot: value.installedFactoryRoot,
      installedPluginRoot: value.installedPluginRoot,
      codexHome: value.codexHome,
      codexCli: value.codexCli,
      candidateVersion: value.version,
    });
    expect(listPlugins).toHaveBeenCalledWith(value.codexCli, value.codexHome, expect.any(Object));
    expect(authority.committedQualificationFiles).toHaveLength(2);
  });

  it("disables repository fsmonitor and Git redirects for every authority read", () => {
    const value = fixture();
    const fsmonitorMarker = join(value.root, "authority-fsmonitor-ran");
    const fsmonitor = join(value.root, "authority-fsmonitor.sh");
    write(fsmonitor, `#!/bin/sh\ntouch ${fsmonitorMarker}\nexit 0\n`, 0o700);
    execFileSync("/usr/bin/git", ["config", "core.fsmonitor", fsmonitor], {
      cwd: value.source,
    });
    const argumentLog = join(value.root, "authority-git-arguments.txt");
    const gitWrapper = join(value.root, "authority-git-wrapper.sh");
    write(
      gitWrapper,
      `#!/bin/sh\nprintf '%s ' "$@" >> ${argumentLog}\nprintf '\\n' >> ${argumentLog}\nexec /usr/bin/git "$@"\n`,
      0o700,
    );
    installedQualificationAuthority(
      { FACTORY_QUALIFICATION_INSTALL_RECEIPT: value.installReceipt },
      {
        sourceRoot: value.source,
        committedPaths: ["scripts/harness.mjs"],
        listPlugins: () => value.listed,
        gitCommand: gitWrapper,
        gitEnvironment: {
          HOME: value.root,
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    expect(existsSync(fsmonitorMarker)).toBe(false);
    const invocations = readFileSync(argumentLog, "utf8").trim().split("\n");
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation).toContain("http.followRedirects=false");
      expect(invocation).toContain("core.fsmonitor=false");
      expect(invocation).toContain("core.hooksPath=/dev/null");
    }
  });

  it("fails before the isolated plugin query when receipt-selected bytes drift", () => {
    const value = fixture();
    const listPlugins = vi.fn(() => value.listed);
    write(join(value.installedFactoryRoot, "dist/factory.js"), "substituted\n", 0o700);
    expect(() =>
      installedQualificationAuthority(
        { FACTORY_QUALIFICATION_INSTALL_RECEIPT: value.installReceipt },
        { sourceRoot: value.source, committedPaths: ["scripts/harness.mjs"], listPlugins },
      ),
    ).toThrow();
    expect(listPlugins).not.toHaveBeenCalled();
  });

  it.each([
    [
      "installed plugin substitution",
      (value: ReturnType<typeof fixture>) => {
        write(join(value.installedPluginRoot, "dist/mcp-server.js"), "substituted\n", 0o700);
      },
    ],
    [
      "retained npm tarball drift",
      (value: ReturnType<typeof fixture>) => {
        writeFileSync(value.tarball, "substituted tarball\n");
      },
    ],
    [
      "installed bundle inventory drift",
      (value: ReturnType<typeof fixture>) => {
        write(join(value.installedFactoryRoot, "dist/bundle-inventory.json"), "{}\n");
      },
    ],
    [
      "installed Factory bundle drift",
      (value: ReturnType<typeof fixture>) => {
        write(join(value.installedFactoryRoot, "dist/factory.js"), "substituted\n", 0o700);
      },
    ],
    [
      "installed MCP launcher content drift",
      (value: ReturnType<typeof fixture>) => {
        write(join(value.installedPluginRoot, "bin/factory-mcp"), "#!/bin/sh\nexit 9\n", 0o700);
      },
    ],
    [
      "installed MCP launcher symlink",
      (value: ReturnType<typeof fixture>) => {
        const launcher = join(value.installedPluginRoot, "bin/factory-mcp");
        const target = join(value.installedPluginRoot, "bin/factory-mcp-target");
        write(target, readFileSync(launcher, "utf8"), 0o700);
        rmSync(launcher);
        symlinkSync("factory-mcp-target", launcher);
      },
    ],
    [
      "plugin archive drift",
      (value: ReturnType<typeof fixture>) => {
        writeFileSync(value.pluginArchive, "substituted archive\n");
      },
    ],
    [
      "plugin snapshot drift",
      (value: ReturnType<typeof fixture>) => {
        write(join(value.listedPluginSource, "plugin.json"), '{"name":"other"}\n');
      },
    ],
    [
      "receipt tampering",
      (value: ReturnType<typeof fixture>) => {
        writeFileSync(
          value.installReceipt,
          `${readFileSync(value.installReceipt, "utf8")}version=other\n`,
          { mode: 0o600 },
        );
      },
    ],
    [
      "wrong receipt permissions",
      (value: ReturnType<typeof fixture>) => {
        chmodSync(value.installReceipt, 0o644);
      },
    ],
    [
      "receipt symlink",
      (value: ReturnType<typeof fixture>) => {
        const target = join(value.root, "retained-receipt.txt");
        renameSync(value.installReceipt, target);
        symlinkSync(target, value.installReceipt);
      },
    ],
    [
      "source mismatch",
      (value: ReturnType<typeof fixture>) => {
        writeFileSync(
          value.installReceipt,
          readFileSync(value.installReceipt, "utf8").replace(
            /^sourceCommit=.*$/m,
            `sourceCommit=${"0".repeat(40)}`,
          ),
          { mode: 0o600 },
        );
      },
    ],
    [
      "candidate CODEX_HOME substitution",
      (value: ReturnType<typeof fixture>) => {
        const other = join(value.root, "other-codex-home");
        mkdirSync(other, { mode: 0o700 });
        writeFileSync(
          value.installReceipt,
          readFileSync(value.installReceipt, "utf8").replace(
            /^codexHome=.*$/m,
            `codexHome=${other}`,
          ),
          { mode: 0o600 },
        );
      },
    ],
    [
      "uncommitted harness",
      (value: ReturnType<typeof fixture>) => {
        write(join(value.source, "scripts/harness.mjs"), "export const harness = false;\n");
      },
    ],
  ] as const)("rejects %s before querying the isolated plugin install", (_name, mutate) => {
    const value = fixture();
    const listPlugins = vi.fn(() => value.listed);
    mutate(value);
    expect(() =>
      installedQualificationAuthority(
        { FACTORY_QUALIFICATION_INSTALL_RECEIPT: value.installReceipt },
        { sourceRoot: value.source, committedPaths: ["scripts/harness.mjs"], listPlugins },
      ),
    ).toThrow();
    expect(listPlugins).not.toHaveBeenCalled();
  });

  it("rejects a changed isolated plugin listing before qualifier mutation", () => {
    const value = fixture();
    const listPlugins = vi.fn(() => ({
      installed: value.listed.installed.map((entry) => ({
        ...entry,
        version: "2.0.26",
      })),
    }));
    expect(() =>
      installedQualificationAuthority(
        { FACTORY_QUALIFICATION_INSTALL_RECEIPT: value.installReceipt },
        { sourceRoot: value.source, committedPaths: ["scripts/harness.mjs"], listPlugins },
      ),
    ).toThrow();
    expect(listPlugins).toHaveBeenCalledOnce();
  });

  it("rejects foreign ownership authority before querying plugins", () => {
    const value = fixture();
    const listPlugins = vi.fn(() => value.listed);
    expect(() =>
      installedQualificationAuthority(
        { FACTORY_QUALIFICATION_INSTALL_RECEIPT: value.installReceipt },
        {
          uid: (process.getuid?.() ?? 0) + 1,
          sourceRoot: value.source,
          committedPaths: ["scripts/harness.mjs"],
          listPlugins,
        },
      ),
    ).toThrow("owner differs");
    expect(listPlugins).not.toHaveBeenCalled();
  });

  it("selects the isolated candidate when the default cache contains another Factory version", () => {
    const value = fixture();
    const defaultHome = mkdtempSync(join(tmpdir(), "factory-runtime-home-"));
    chmodSync(defaultHome, 0o700);
    const defaultCodexHome = join(defaultHome, ".codex");
    const otherVersion = join(defaultCodexHome, "plugins/cache/clockgrove-factory/factory/2.0.26");
    mkdirSync(otherVersion, {
      recursive: true,
    });
    write(join(otherVersion, "package.json"), '{"version":"2.0.26"}\n');
    const observedEnvironments: NodeJS.ProcessEnv[] = [];
    const listPlugins = vi.fn(
      (_codexCli: string, selectedCodexHome: string, childEnvironment: NodeJS.ProcessEnv) => {
        expect(selectedCodexHome).toBe(value.codexHome);
        observedEnvironments.push(childEnvironment);
        return value.listed;
      },
    );
    const authority = installedQualificationAuthority(
      {
        HOME: defaultHome,
        CODEX_HOME: defaultCodexHome,
        FACTORY_QUALIFICATION_INSTALL_RECEIPT: value.installReceipt,
      },
      { sourceRoot: value.source, committedPaths: ["scripts/harness.mjs"], listPlugins },
    );
    expect(authority.installedPluginRoot).toBe(value.installedPluginRoot);
    expect(listPlugins).toHaveBeenCalledOnce();
    expect(observedEnvironments).toHaveLength(1);
    const observed = observedEnvironments.at(0);
    expect(observed?.CODEX_HOME).toBe(value.codexHome);
    expect(observed).not.toHaveProperty("FACTORY_QUALIFICATION_INSTALL_RECEIPT");

    const runtime = qualificationRuntimeEnvironment(
      {
        PATH: "/usr/bin:/bin",
        CODEX_HOME: defaultCodexHome,
        FACTORY_QUALIFICATION_INSTALL_RECEIPT: "/private/receipt",
      },
      { linuxHome: defaultHome },
    );
    expect(runtime.CODEX_HOME).toBe(defaultCodexHome);
    expect(runtime).not.toHaveProperty("FACTORY_QUALIFICATION_INSTALL_RECEIPT");
  });

  it("preserves validated private transcripts without changing provider or artifact authority", () => {
    const value = fixture();
    const runtimeHome = join(value.root, "runtime-home");
    const runtimeCodexHome = join(runtimeHome, ".codex");
    const checkout = join(value.root, "target-checkout");
    const transcripts = join(value.root, "management-transcripts");
    for (const directory of [runtimeHome, runtimeCodexHome, checkout, transcripts])
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    const runtime = qualificationRuntimeEnvironment(
      {
        PATH: "/usr/bin:/bin",
        CODEX_HOME: runtimeCodexHome,
        FACTORY_QUALIFICATION_INSTALL_RECEIPT: value.installReceipt,
        FACTORY_MANAGEMENT_TRANSCRIPT_DIR: transcripts,
      },
      {
        linuxHome: runtimeHome,
        repositoryRoot: checkout,
        requireManagementTranscripts: true,
      },
    );
    expect(runtime).toMatchObject({
      HOME: runtimeHome,
      CODEX_HOME: runtimeCodexHome,
      FACTORY_MANAGEMENT_TRANSCRIPT_DIR: transcripts,
    });
    expect(runtime).not.toHaveProperty("FACTORY_QUALIFICATION_INSTALL_RECEIPT");
  });

  it("requires transcript recording before a managed qualification child can start", () => {
    const value = fixture();
    const runtimeHome = join(value.root, "runtime-home");
    const checkout = join(value.root, "target-checkout");
    mkdirSync(join(runtimeHome, ".codex"), { recursive: true, mode: 0o700 });
    mkdirSync(checkout, { mode: 0o700 });
    expect(() =>
      qualificationRuntimeEnvironment(
        {},
        { linuxHome: runtimeHome, repositoryRoot: checkout, requireManagementTranscripts: true },
      ),
    ).toThrow(/FACTORY_MANAGEMENT_TRANSCRIPT_DIR is required/);
  });

  it.each([
    "relative",
    "symlinked",
    "repository-contained",
    "non-private",
    "mismatched-owner",
  ] as const)("rejects %s transcript authority before child launch", (kind) => {
    const value = fixture();
    const runtimeHome = join(value.root, "runtime-home");
    const checkout = join(value.root, "target-checkout");
    const privateDirectory = join(value.root, "management-transcripts");
    mkdirSync(join(runtimeHome, ".codex"), { recursive: true, mode: 0o700 });
    mkdirSync(checkout, { mode: 0o700 });
    mkdirSync(privateDirectory, { mode: 0o700 });
    let transcriptDirectory = privateDirectory;
    let uid = process.getuid?.() ?? 0;
    if (kind === "relative") transcriptDirectory = "management-transcripts";
    if (kind === "symlinked") {
      transcriptDirectory = join(value.root, "redirected-transcripts");
      symlinkSync(privateDirectory, transcriptDirectory);
    }
    if (kind === "repository-contained") {
      transcriptDirectory = join(checkout, "transcripts");
      mkdirSync(transcriptDirectory, { mode: 0o700 });
    }
    if (kind === "non-private") chmodSync(privateDirectory, 0o750);
    if (kind === "mismatched-owner") uid += 1;
    expect(() =>
      qualificationRuntimeEnvironment(
        { FACTORY_MANAGEMENT_TRANSCRIPT_DIR: transcriptDirectory },
        {
          linuxHome: runtimeHome,
          repositoryRoot: checkout,
          requireManagementTranscripts: true,
          uid,
        },
      ),
    ).toThrow();
  });
});
