# Binary module fixture

Node 20+, no dependencies. The corpus materializer decodes the checked-in base64 into actual assets/answer.wasm bytes.
The executable fixture contains a genuine valid eight-byte WebAssembly module, not a path-only profile stub.

```sh
npm run generate
npm test
```

scripts/module.mjs owns the non-LFS binary. Baseline has no exports; the Objective adds answer().
Keep under 1024 bytes. This fixture does not qualify arbitrary large-file transfer or Git LFS.
