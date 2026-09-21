import { readFileSync, readdirSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertPackageDocumentation,
  operatorDocumentation,
} from "../scripts/package-documentation.mjs";

const root = new URL("../", import.meta.url);

function fixture() {
  const paths = [
    "README.md",
    "SECURITY.md",
    "SUPPORT.md",
    "CHANGELOG.md",
    ...operatorDocumentation,
  ];
  const documents: Record<string, string> = Object.fromEntries(paths.map((path) => [path, ""]));
  return { paths, documents };
}

describe("distributed operator documentation", () => {
  it("includes only the explicit operator docs and resolves links in the configured package", () => {
    const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
      files: string[];
    };
    expect(manifest.files.filter((path) => path.startsWith("docs/"))).toEqual([
      "docs/setup/",
      "docs/CREDENTIALS.md",
      "docs/CODEX-APP-SERVER-SESSIONS.md",
      "docs/LARGE-FILES.md",
      "docs/OBJECTIVE-ASSETS.md",
      "docs/HOST-SCHEDULING.md",
      "docs/THREAT-MODEL.md",
      "docs/OPERATING-REFERENCE.md",
    ]);
    const expand = (path: string): string[] => {
      const url = new URL(path, root);
      return statSync(url).isDirectory()
        ? readdirSync(url).flatMap((entry) => expand(`${path.replace(/\/$/, "")}/${entry}`))
        : [path];
    };
    const paths = [
      ...new Set(["README.md", "LICENSE", "package.json", ...manifest.files.flatMap(expand)]),
    ];
    const documents = Object.fromEntries(
      paths
        .filter((path) => path.endsWith(".md"))
        .map((path) => [path, readFileSync(new URL(path, root), "utf8")]),
    );
    expect(() => assertPackageDocumentation(paths, documents)).not.toThrow();
  });

  it("fails closed before installing a prepublication candidate", () => {
    const guide = readFileSync(new URL("docs/setup/local.md", root), "utf8");
    const procedure = guide.match(
      /### Prepublication candidate qualification \(maintainers\)[\s\S]*?```bash\n([\s\S]*?)\n```/,
    )?.[1];
    expect(procedure).toBeDefined();
    const commands = procedure!;
    const cleanTree = 'test -z "$(git status --porcelain --untracked-files=all)"';
    const tarballDigest = 'test "$observed_tarball_sha256" = "$tarball_sha256"';
    const freshRoot = 'test ! -e "$qualification_root"';
    const install =
      'npm_config_cache="$npm_cache" npm install --global --prefix "$npm_prefix" --ignore-scripts=false --no-audit --no-fund "$candidate_root/release/$tarball_file"';
    const archive =
      'node "$candidate_root/scripts/plugin-package.mjs" archive --source "$candidate_root" --commit "$source_commit" --output "$plugin_archive"';
    const marketplace =
      'CODEX_HOME="$codex_home" "$codex_cli" plugin marketplace add "$plugin_snapshot" --json';

    expect(commands).toContain("set -euo pipefail");
    expect(commands).toContain("m.tarball.sha256");
    expect(commands).toContain(
      'observed_tarball_sha256="$(sha256sum -- "$candidate_root/release/$tarball_file")"',
    );
    expect(commands).toContain(cleanTree);
    expect(commands).not.toContain("git status --porcelain --untracked-files=no");
    expect(commands).toContain(tarballDigest);
    expect(commands).toContain(
      'qualification_parent="${FACTORY_QUALIFICATION_PARENT:-/home/kirk/Codex/factory-initial-beta}"',
    );
    expect(commands).toContain(freshRoot);
    expect(commands).toContain('npm_prefix="$qualification_root/npm"');
    expect(commands).toContain('codex_home="$qualification_root/codex-home"');
    expect(commands).toContain(install);
    expect(commands).not.toContain('npm install --global "$candidate_root/release/$tarball_file"');
    expect(commands.indexOf(cleanTree)).toBeLessThan(commands.indexOf(freshRoot));
    expect(commands.indexOf(tarballDigest)).toBeLessThan(commands.indexOf(freshRoot));
    expect(commands.indexOf(freshRoot)).toBeLessThan(commands.indexOf(install));
    expect(commands).toContain('mkdir "$qualification_root"');
    expect(commands).not.toContain('mkdir -p "$qualification_root"');
    expect(commands).not.toContain('plugin_snapshot="$(mktemp -d)"');
    expect(commands).toContain(
      'plugin_archive="$qualification_root/factory-plugin-$source_commit.tar"',
    );
    expect(commands).toContain('plugin_snapshot="$qualification_root/plugin-marketplace"');
    expect(commands).toContain(archive);
    expect(commands).not.toContain(
      'git archive --format=tar --output="$plugin_archive" "$source_commit"',
    );
    expect(commands).toContain(marketplace);
    expect(commands).not.toContain('codex plugin marketplace add "$candidate_root"');
    expect(commands.indexOf(archive)).toBeLessThan(commands.indexOf(marketplace));

    const codexCommands = commands
      .split("\n")
      .filter((line) => /"\$codex_cli" plugin (?:marketplace add|add|list) /.test(line));
    expect(codexCommands).toHaveLength(3);
    expect(
      codexCommands.every((line) => line.startsWith('CODEX_HOME="$codex_home" "$codex_cli"')),
    ).toBe(true);
    expect(commands).toContain(
      'test "$(PATH="$qualification_path" command -v factory)" = "$factory_cli"',
    );
    expect(commands).toContain(
      'controller_launcher_identity="sha256:$observed_factory_bundle_sha256"',
    );
    expect(commands).toContain(
      'plugin_archive_sha256="$(sha256sum -- "$plugin_archive" | cut -d\' \' -f1)"',
    );
    expect(commands).toContain(
      'test "$(sha256sum -- "$installed_plugin_root/dist/mcp-server.js" | cut -d\' \' -f1)" = "$expected_mcp_bundle_sha256"',
    );
    expect(commands).toContain(
      'case "$installed_plugin_root/" in ("$codex_home/plugins/cache/clockgrove-factory/factory/"*) ;; (*) exit 1;; esac',
    );
    const addReceiptAuthority = commands
      .split("\n")
      .find((line) => line.startsWith('installed_plugin_root="$(node -e'));
    expect(addReceiptAuthority).toContain("p.installedPath");
    expect(addReceiptAuthority).toContain("codex-plugin-add.json");
    expect(addReceiptAuthority).not.toContain("codex-plugin-list.json");
    expect(commands.indexOf('codex-plugin-add.json"')).toBeLessThan(
      commands.indexOf('installed_plugin_root="$(node -e'),
    );
    const listReceiptAuthority = commands
      .split("\n")
      .find((line) => line.startsWith('listed_plugin_source="$(node -e'));
    expect(listReceiptAuthority).toContain("p[0].source.path");
    expect(listReceiptAuthority).toContain("codex-plugin-list.json");
    expect(listReceiptAuthority).not.toContain("p.installedPath");
    expect(commands.indexOf('codex-plugin-list.json"')).toBeLessThan(
      commands.indexOf('listed_plugin_source="$(node -e'),
    );
    expect(commands).toContain(
      'test "$listed_plugin_source" = "$(realpath -- "$plugin_snapshot")"',
    );
    expect(commands).toContain(
      'install_identity_receipt="$qualification_root/install-identities.txt"',
    );
    expect(commands).toContain(
      "printf 'controllerLauncherIdentity=%s\\n' \"$controller_launcher_identity\"",
    );
    expect(guide).toContain(
      "They do not\nchange the default Codex home, its installed plugins or caches, or an active repository controller's\npinned launcher.",
    );
  });

  it("documents an exact installed lifecycle qualification without exposing a control API", () => {
    const guide = readFileSync(new URL("docs/HOST-SCHEDULING.md", root), "utf8");
    expect(guide).toContain("scripts/verify-installed-controller-lifecycle.mjs");
    expect(guide).toContain(
      "The shared receipt validator binds the exact clean source commit,\nrelease tarball, npm CLI, plugin archive and snapshot",
    );
    expect(guide).toContain("A source or development worktree is rejected mechanically");
    expect(guide).toContain('FACTORY_QUALIFICATION_INSTALL_RECEIPT="$install_receipt"');
    expect(guide).toContain(
      'FACTORY_LIFECYCLE_ACK="$repository:$unit:install-start,install-uninstall,busy,killed-owner,cleanup"',
    );
    expect(guide).toContain("kernel-authoritative FLOCK waiting evidence");
    expect(guide).toContain("production lock file descriptor, device, and inode");
    expect(guide).toContain("matching pending `FLOCK` entry in\n`/proc/locks`");
    expect(guide).toContain("`locks_lock_inode_wait` kernel wait channel");
    expect(guide).toContain("without deleting or replacing the production\nlock inode");
    expect(guide).toContain("no CLI or MCP operation");
    expect(guide).toContain("performs no automatic unit cleanup");
    expect(guide).toContain("The stdout pass receipt is\nsafe to attach to the issue");
    expect(guide).toContain("local paths stay in that file");
  });

  it("documents the installed primary-quota stop race without live GitHub transport", () => {
    const guide = readFileSync(new URL("docs/HOST-SCHEDULING.md", root), "utf8");
    expect(guide).toContain("scripts/verify-installed-controller-quota-stop.mjs");
    expect(guide).toContain("does not spend GitHub quota or\nchange GitHub state");
    expect(guide).toContain("never calls the upstream fetch");
    expect(guide).toContain("non-secret fixture token");
    expect(guide).toContain("`DropInPaths` remains\nempty");
    expect(guide).toContain("Every validated stage is written and fsynced");
    expect(guide).toContain(
      'FACTORY_QUOTA_STOP_ACK="$repository:$unit:installed-primary-quota-explicit-stop:no-github-transport"',
    );
    expect(guide).toContain("Mixed server,\npermission, malformed-reset");
  });

  it.each([
    "docs/release-evidence/private-observation.json",
    "docs/IMPLEMENTATION-HANDOFF.md",
    "docs/DELIVERY-PLAN.md",
    "docs/setup/private-notes.md",
  ])("rejects an unexpected packaged document %s", (path) => {
    const f = fixture();
    f.paths.push(path);
    f.documents[path] = "";
    expect(() => assertPackageDocumentation(f.paths, f.documents)).toThrow(
      "non-operator documentation",
    );
  });

  it("rejects missing required operator guidance", () => {
    const f = fixture();
    expect(() =>
      assertPackageDocumentation(
        f.paths.filter((path) => path !== "docs/setup/unattended.md"),
        f.documents,
      ),
    ).toThrow("missing operator documentation docs/setup/unattended.md");
  });

  it("checks actual Markdown bytes, including a document added outside docs", () => {
    const f = fixture();
    f.paths.push("skills/director/SKILL.md");
    expect(() => assertPackageDocumentation(f.paths, f.documents)).toThrow(
      "Markdown was not inspected: skills/director/SKILL.md",
    );
  });

  it("permits anchors, query strings, encoded paths, images and reference links", () => {
    const f = fixture();
    f.paths.push("assets/operator guide.png");
    f.documents["README.md"] = [
      "[Setup](docs/setup/local.md?source=package#quick-start)",
      "![Guide](assets/operator%20guide.png)",
      "[Image](<assets/operator guide.png>)",
      "[Help][support]",
      "[support]: SUPPORT.md#help",
      "[Here](#safety)",
      "[Status](https://github.com/clockgrove/factory/blob/main/docs/CONFORMANCE.md)",
      "[Website](//github.com/clockgrove/factory)",
      "[Contact](mailto:maintainer@example.com)",
    ].join("\n");
    f.documents["docs/setup/local.md"] = "[Home](../../README.md)";
    expect(() => assertPackageDocumentation(f.paths, f.documents)).not.toThrow();
  });

  it.each([
    "[Status](docs/CONFORMANCE.md)",
    "[Plan][plan]\n[plan]: docs/DELIVERY-PLAN.md",
    "![Missing](assets/missing.png)",
    "[Outside](../README.md)",
    "[Outside](%2e%2e/README.md)",
    "[Absolute](/README.md)",
    "[Backslash](docs%5csetup%5clocal.md)",
  ])("rejects missing or escaping local targets: %s", (markdown) => {
    const f = fixture();
    f.documents["README.md"] = markdown;
    expect(() => assertPackageDocumentation(f.paths, f.documents)).toThrow("no packaged target");
  });
});
