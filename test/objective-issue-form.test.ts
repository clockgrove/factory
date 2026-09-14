import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const path = fileURLToPath(new URL("../assets/templates/github/objective.yml", import.meta.url));

describe("human Objective issue form", () => {
  it("is valid YAML with the fields needed to compile a bounded Objective", () => {
    const document = parseDocument(readFileSync(path, "utf8"));
    expect(document.errors).toEqual([]);

    const form = document.toJS() as {
      name?: string;
      description?: string;
      title?: string;
      labels?: string[];
      body?: Array<{
        type?: string;
        id?: string;
        attributes?: { label?: string; value?: string; options?: Array<{ required?: boolean }> };
        validations?: { required?: boolean };
      }>;
    };

    expect(form.name).toBe("Factory Objective");
    expect(form.description).toMatch(/product outcome/);
    expect(form.title).toBe("Objective: ");
    expect(form.labels).toBeUndefined();
    expect(Array.isArray(form.body)).toBe(true);

    const introduction = form.body?.find((entry) => entry.type === "markdown")?.attributes?.value;
    expect(introduction).toContain(
      "Factory adds the `factory:objective` discovery label only after an authenticated activation or recovery request.",
    );
    expect(introduction).toContain("Factory can discover this issue");

    const fields = new Map(
      form.body?.filter((entry) => entry.id).map((entry) => [entry.id, entry]) ?? [],
    );
    expect([...fields.keys()]).toEqual([
      "outcome",
      "experience",
      "acceptance",
      "boundaries",
      "authority",
      "sources",
      "unknowns",
      "acknowledgement",
    ]);
    for (const id of ["outcome", "experience", "acceptance", "boundaries", "authority"]) {
      expect(fields.get(id)?.type).toBe("textarea");
      expect(fields.get(id)?.validations?.required).toBe(true);
    }
    expect(fields.get("sources")?.validations?.required).not.toBe(true);
    expect(fields.get("unknowns")?.validations?.required).not.toBe(true);
    expect(fields.get("acknowledgement")?.type).toBe("checkboxes");
    expect(fields.get("acknowledgement")?.attributes?.options).toSatisfy(
      (options: Array<{ required?: boolean }>) =>
        options.length === 2 && options.every((option) => option.required === true),
    );
  });
});
