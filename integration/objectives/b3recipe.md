## Goal

Add a first-line comment `// drill-migrated {{ID}}` to every file under `src/` whose name starts with `dotPath` or `dotWords` (and to no other file). Leave the rest of each file unchanged.

## Acceptance

- Each `src/dotPath*.js` and `src/dotWords*.js` file starts with the line `// drill-migrated {{ID}}`, and no other file has it.
- `npm test`

## Adaptive workflow

enabled

## Workflow recipe

```json
{
  "selector": "repository-migration",
  "arguments": { "selectors": ["src/"], "maxChildren": 2, "maxFilesPerChild": 3 }
}
```
