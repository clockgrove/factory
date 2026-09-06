# Visual status fixture

Node 20+, no dependencies. Deterministic SVG is the actual visual artifact.

```sh
npm run render
npm test
```

Mechanical assertions cover serialized output only. Inspect visual/status.svg at 160 by 48 for readability and clipping.
The baseline has only ready; the Objective adds paused with a shape and text cue, not color alone.
