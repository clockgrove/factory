# Typed cart fixture

Requires Node 20+ and TypeScript 5.7.3 on PATH (declared development dependency).
Provision tooling before an offline evaluation; the fixture does not authorize downloads.

```sh
npm run typecheck
npm test
```

The test command compiles actual TypeScript into disposable .compiled output and executes it.
The baseline deliberately has no discount feature. The human Objective defines the new behavior.
