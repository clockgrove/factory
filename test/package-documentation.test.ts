import { readFileSync, readdirSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertPackageDocumentation,
  operatorDocumentation,
} from "../scripts/package-documentation.mjs";

const root = new URL("../", import.meta.url);

function fixture() {
  const paths = ["README.md", "SECURITY.md", "SUPPORT.md", "CHANGELOG.md", ...operatorDocumentation];
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
      "docs/HOST-SCHEDULING.md",
      "docs/THREAT-MODEL.md",
    ]);
    const expand = (path: string): string[] => {
      const url = new URL(path, root);
      return statSync(url).isDirectory()
        ? readdirSync(url).flatMap((entry) => expand(`${path.replace(/\/$/, "")}/${entry}`))
        : [path];
    };
    const paths = [...new Set([
      "README.md", "LICENSE", "package.json", ...manifest.files.flatMap(expand),
    ])];
    const documents = Object.fromEntries(
      paths.filter((path) => path.endsWith(".md")).map((path) => [
        path, readFileSync(new URL(path, root), "utf8"),
      ]),
    );
    expect(() => assertPackageDocumentation(paths, documents)).not.toThrow();
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
    expect(() => assertPackageDocumentation(
      f.paths.filter((path) => path !== "docs/setup/unattended.md"), f.documents,
    )).toThrow("missing operator documentation docs/setup/unattended.md");
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
    expect(() => assertPackageDocumentation(f.paths, f.documents)).toThrow(
      "no packaged target",
    );
  });

});
