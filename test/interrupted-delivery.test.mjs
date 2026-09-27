import assert from "node:assert/strict";
import test from "node:test";
import { runRegularGraph } from "../dist/delivery/regular-runner.js";

for (const published of [false, true]) {
  for (const peerStep of [undefined, "execute", "validate", "approve-asset"]) {
    for (const peerFirst of peerStep ? [false, true] : [false]) {
      test(`interrupted regular delivery refuses without replay (PR known: ${published}, peer: ${peerStep}, peer first: ${peerFirst})`, async () => {
        const work = {
          status: "running",
          step: "deliver",
          attempt: "original-attempt",
          baseSha: "original-base",
          changeRef: "validated-result",
          treeSha: "validated-tree",
          validation: { commands: [] },
          ...(published ? { pullRequest: 42 } : {}),
        };
        const peer = {
          status: "running",
          step: peerStep,
          baseSha: "peer-base",
          changeRef: "peer-result",
          treeSha: "peer-tree",
          execution: { id: "original-peer-handle" },
          selectedAssetSet: "original-selected-set",
        };
        const items = [{ id: "work" }];
        if (peerStep) {
          if (peerFirst) items.unshift({ id: "peer" });
          else items.push({ id: "peer" });
        }
        const state = {
          runId: "original-run",
          baseSha: "original-base",
          graph: { items },
          work: { work, ...(peerStep ? { peer } : {}) },
        };
        const before = structuredClone(state);
        let calls = 0;
        const forbidden = new Proxy(
          {},
          {
            get() {
              calls++;
              throw new Error("unexpected external operation");
            },
          },
        );
        const active = new Map();
        await assert.rejects(
          runRegularGraph({
            config: {},
            objective: 1,
            objectiveBody: "original objective",
            root: "unused",
            state,
            driver: forbidden,
            delivery: forbidden,
            contentStore: forbidden,
            github: forbidden,
            planningModel: forbidden,
            save: () => {
              calls++;
            },
            active,
            cancelled: () => false,
          }),
          /ambiguous active state at deliver; operator direction required; interrupted regular delivery cannot be resumed automatically/,
        );
        assert.deepEqual(state, before);
        assert.equal(calls, 0);
        assert.equal(active.size, 0);
      });
    }
  }
}
