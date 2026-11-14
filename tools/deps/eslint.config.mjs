// ESLint over plugin/, bench/ and tools/: correctness rules only, no style and no formatting. Each rule catches code
// that throws or misbehaves at run time while unit tests stay green (they stub what they call). Run it with
// `npm run lint --prefix tools/deps`; the Quality workflow runs the same.
import globals from "globals";

// A local that hides an import: `import { startedAt }` and, inside a function, `const startedAt = Date.now()`, so a
// later `startedAt()` throws "is not a function". Core no-shadow has no option to limit it to imports, and on its own it
// flags every closure that reuses a module-level name.
const noShadowedImport = {
  meta: { type: "problem", messages: { hidden: "'{{name}}' hides the import on line {{line}}; rename the local." } },
  create(context) {
    return {
      "Program:exit"(node) {
        const scope = context.sourceCode.getScope(node);
        const module = scope.childScopes.find((s) => s.type === "module") ?? scope;
        const imports = new Map(module.variables.filter((v) => v.defs.some((d) => d.type === "ImportBinding")).map((v) => [v.name, v.defs[0].name.loc.start.line]));
        if (!imports.size) return;
        const visit = (s) => {
          for (const v of s.variables) if (imports.has(v.name) && v.defs.length) context.report({ node: v.defs[0].name, messageId: "hidden", data: { name: v.name, line: imports.get(v.name) } });
          s.childScopes.forEach(visit);
        };
        module.childScopes.forEach(visit);
      },
    };
  },
};

export default [
  { ignores: ["plugin/vendor/**", "**/node_modules/**"] },
  {
    files: ["**/*.mjs", "plugin/bin/factory"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
    // Directives name rules this config leaves off on purpose; an unused one is no fault.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: { factory: { rules: { "no-shadowed-import": noShadowedImport } } },
    rules: {
      "factory/no-shadowed-import": "error",
      "no-undef": "error",
      // variables: false still reports a read in the binding's own scope before it is set, a parameter default that
      // names itself among them; it skips closures that read a module constant declared further down, which run later.
      "no-use-before-define": ["error", { functions: false, classes: false, variables: false }],
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-self-assign": "error",
      // The rest of eslint:recommended that flags a crash or a certain bug; its style and hygiene rules stay off.
      "constructor-super": "error",
      "for-direction": "error",
      "getter-return": "error",
      "no-async-promise-executor": "error",
      "no-case-declarations": "error",
      "no-class-assign": "error",
      "no-compare-neg-zero": "error",
      "no-const-assign": "error",
      "no-constant-binary-expression": "error",
      "no-constant-condition": "error",
      "no-delete-var": "error",
      "no-dupe-args": "error",
      "no-dupe-class-members": "error",
      "no-dupe-else-if": "error",
      "no-duplicate-case": "error",
      "no-empty-character-class": "error",
      "no-empty-pattern": "error",
      "no-ex-assign": "error",
      "no-fallthrough": "error",
      "no-func-assign": "error",
      "no-global-assign": "error",
      "no-import-assign": "error",
      "no-invalid-regexp": "error",
      "no-loss-of-precision": "error",
      "no-misleading-character-class": "error",
      "no-new-native-nonconstructor": "error",
      "no-obj-calls": "error",
      "no-redeclare": "error",
      "no-setter-return": "error",
      "no-shadow-restricted-names": "error",
      "no-sparse-arrays": "error",
      "no-this-before-super": "error",
      "no-unassigned-vars": "error",
      "no-unexpected-multiline": "error",
      "no-unsafe-finally": "error",
      "no-unsafe-negation": "error",
      "no-unsafe-optional-chaining": "error",
      "no-useless-backreference": "error",
      "require-yield": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
    },
  },
];
