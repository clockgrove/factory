import { ProviderTurnGuard } from "../../dist/provider-turn.js";

const collect = async () => {
  await new Promise(setImmediate);
  for (let pass = 0; pass < 3; pass++) global.gc();
  return process.memoryUsage().arrayBuffers;
};
const turn = new ProviderTurnGuard(60_000);
const count = 5_000;
const bytes = 16_384;
const before = await collect();
try {
  for (let index = 0; index < count; index++) {
    // Exercise both settled values and original rejections without retaining
    // provider payloads in the fixture itself or a diagnostic stream.
    try {
      await turn.race(
        index % 2 === 0
          ? Promise.resolve(Buffer.alloc(bytes))
          : Promise.reject(Buffer.alloc(bytes)),
      );
    } catch {}
    turn.progress();
  }
  const afterWaits = await collect();
  turn.finish();
  const afterFinish = await collect();
  console.log(
    JSON.stringify({
      count,
      bytes,
      before,
      afterWaits,
      afterFinish,
      guardStillReferenced: turn.signal.aborted === false,
    }),
  );
} finally {
  turn.finish();
}
