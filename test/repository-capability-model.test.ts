import { describe, expect, it } from "vitest";

import {
  bindDeferredCapabilityGraph,
  validateCapabilityGraphBindings,
  type DeferredCapabilityAdapter,
} from "../src/repository-capabilities/model.js";

const adapter = (id = "example/tool"): DeferredCapabilityAdapter => ({
  id,
  rootAuthorityPaths: [`${id}/root.lock`],
  generationAuthorityPaths: [`${id}/recipes`],
  operation: (command) =>
    command.startsWith(`${id}:`) ? { kind: "check", key: command.slice(id.length + 1) } : null,
});

describe("deferred repository capability model", () => {
  it("binds a fan-out and join to one typed provider generation", () => {
    const items = [
      {
        id: "root",
        dependsOn: [],
        scope: ["example/tool/root.lock"],
        validationCommands: ["example/tool:root"],
      },
      {
        id: "left",
        dependsOn: ["root"],
        scope: ["left/"],
        validationCommands: ["example/tool:left"],
      },
      {
        id: "right",
        dependsOn: ["root"],
        scope: ["right/"],
        validationCommands: ["example/tool:right"],
      },
      {
        id: "join",
        dependsOn: ["left", "right"],
        scope: ["join/"],
        validationCommands: ["example/tool:join"],
      },
    ];
    const bindings = bindDeferredCapabilityGraph(items, [adapter()], () => true);
    const bound = items.map((item) => ({
      ...item,
      repositoryCapabilities: bindings.get(item.id)!,
    }));
    expect(bindings.get("root")?.provides[0]?.operations.map((operation) => operation.key)).toEqual(
      ["join", "left", "right", "root"],
    );
    expect(bindings.get("left")?.requires[0]).toMatchObject({
      providerWorkItem: "root",
      generation: "example/tool/root",
      activation: "integrated-base",
    });
    expect(() => validateCapabilityGraphBindings(bound, [adapter()])).not.toThrow();
  });

  it("supports independent technology-neutral capability islands", () => {
    const first = adapter("first");
    const second = adapter("second");
    const items = [
      { id: "a", dependsOn: [], scope: ["first/root.lock"], validationCommands: ["first:a"] },
      { id: "b", dependsOn: ["a"], scope: ["b/"], validationCommands: ["first:b"] },
      { id: "c", dependsOn: [], scope: ["second/root.lock"], validationCommands: ["second:c"] },
      { id: "d", dependsOn: ["c"], scope: ["d/"], validationCommands: ["second:d"] },
    ];
    const bindings = bindDeferredCapabilityGraph(items, [first, second], () => true);
    expect(bindings.get("b")?.requires[0]?.providerWorkItem).toBe("a");
    expect(bindings.get("d")?.requires[0]?.providerWorkItem).toBe("c");
  });

  it("creates a later generation without letting the mutator self-authorize", () => {
    const items = [
      {
        id: "root",
        dependsOn: [],
        scope: ["example/tool/root.lock"],
        validationCommands: ["example/tool:base"],
      },
      {
        id: "mutate",
        dependsOn: ["root"],
        scope: ["example/tool/recipes"],
        validationCommands: ["example/tool:base", "example/tool:new"],
      },
      {
        id: "consumer",
        dependsOn: ["mutate"],
        scope: ["src/"],
        validationCommands: ["example/tool:new"],
      },
    ];
    const bindings = bindDeferredCapabilityGraph(items, [adapter()], () => true);
    expect(bindings.get("mutate")?.requires[0]).toMatchObject({
      providerWorkItem: "root",
      activation: "integrated-base",
    });
    expect(bindings.get("consumer")?.requires[0]).toMatchObject({
      providerWorkItem: "mutate",
      generation: "example/tool/mutate",
    });
    expect(bindings.get("mutate")?.provides[0]?.operations).toEqual([
      { kind: "check", key: "new" },
    ]);
  });

  it("rejects a consumer dominated by ambiguous providers", () => {
    const items = [
      {
        id: "one",
        dependsOn: [],
        scope: ["example/tool/root.lock"],
        validationCommands: ["example/tool:one"],
      },
      {
        id: "two",
        dependsOn: [],
        scope: ["example/tool/root.lock"],
        validationCommands: ["example/tool:two"],
      },
      {
        id: "join",
        dependsOn: ["one", "two"],
        scope: ["src/"],
        validationCommands: ["example/tool:join"],
      },
    ];
    expect(() => bindDeferredCapabilityGraph(items, [adapter()], () => true)).toThrow(
      /2 dependency-root providers/,
    );
  });

  it("rejects tampered provider ancestry and generation identity", () => {
    const items = [
      {
        id: "root",
        dependsOn: [],
        scope: ["example/tool/root.lock"],
        validationCommands: ["example/tool:root"],
      },
      {
        id: "child",
        dependsOn: ["root"],
        scope: ["src/"],
        validationCommands: ["example/tool:child"],
      },
    ];
    const bindings = bindDeferredCapabilityGraph(items, [adapter()], () => true);
    const bound = items.map((item) => ({
      ...item,
      repositoryCapabilities: bindings.get(item.id)!,
    }));
    bound[1]!.repositoryCapabilities!.requires[0]!.generation = "example/tool/tampered";
    expect(() => validateCapabilityGraphBindings(bound, [adapter()])).toThrow(
      /canonical host derivation/,
    );
  });

  it("rejects a coordinated provision and requirement tamper", () => {
    const items = [
      {
        id: "root",
        dependsOn: [],
        scope: ["example/tool/root.lock"],
        validationCommands: ["example/tool:root"],
      },
      {
        id: "child",
        dependsOn: ["root"],
        scope: ["src/"],
        validationCommands: ["example/tool:child"],
      },
    ];
    const bindings = bindDeferredCapabilityGraph(items, [adapter()], () => true);
    const bound = items.map((item) => ({
      ...item,
      repositoryCapabilities: structuredClone(bindings.get(item.id)!),
    }));
    bound[0]!.repositoryCapabilities.provides[0]!.operations[1]!.key = "tampered";
    bound[1]!.repositoryCapabilities.requires[0]!.operation.key = "tampered";
    expect(() => validateCapabilityGraphBindings(bound, [adapter()])).toThrow(
      /canonical host derivation/,
    );
  });

  it("does not infer a later generation from write scope without an explicit operation", () => {
    const items = [
      {
        id: "root",
        dependsOn: [],
        scope: ["example/tool/root.lock"],
        validationCommands: ["example/tool:base"],
      },
      {
        id: "may-edit",
        dependsOn: ["root"],
        scope: ["example/tool/recipes"],
        validationCommands: ["example/tool:base"],
      },
      {
        id: "consumer",
        dependsOn: ["may-edit"],
        scope: ["src/"],
        validationCommands: ["example/tool:new"],
      },
    ];
    const bindings = bindDeferredCapabilityGraph(items, [adapter()], () => true);
    expect(bindings.get("consumer")?.requires[0]).toMatchObject({
      providerWorkItem: "root",
      generation: "example/tool/root",
    });
    expect(bindings.get("may-edit")?.provides).toEqual([]);
  });

  it("does not let authority scope alone turn a dependency root into a provider", () => {
    const items = [
      {
        id: "root",
        dependsOn: [],
        scope: ["example/tool/root.lock"],
        validationCommands: ["node:test"],
      },
      {
        id: "consumer",
        dependsOn: ["root"],
        scope: ["src/"],
        validationCommands: ["example/tool:check"],
      },
    ];
    expect(() => bindDeferredCapabilityGraph(items, [adapter()], () => true)).toThrow(
      /0 dependency-root providers/,
    );
  });
});
