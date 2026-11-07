import assert from "node:assert/strict";
import { tolerantTest } from "./chrome.mjs";

/** Keep optional WebKit failures separate from every other native decoder's assertions. */
export async function testNativeDecoders(t, samples, decoders) {
  const subtest = tolerantTest(t.test.bind(t), (name) => name === "WebKit decoder");
  for (const { name, open } of decoders) {
    await subtest(`${name} decoder`, async (t) => {
      if (!samples.length) return t.skip("The encoder supports none of the tested AVIF dimensions");
      const decoder = await open();
      try {
        for (const { bytes, width, height } of samples) {
          const row = {
            expected: [width, height],
            ...(await decoder.decode(bytes, width, height)),
          };
          t.diagnostic(JSON.stringify(row));
          assert.deepEqual([row.width, row.height], row.expected);
          assert.ok(row.last[3] >= 250, `last column ${JSON.stringify(row)}`);
          assert.ok(row.bottom[3] >= 250, `last row ${JSON.stringify(row)}`);
          for (const pixel of [row.last, row.bottom])
            for (const [i, expected] of [80, 180, 220].entries()) {
              assert.ok(Math.abs(pixel[i] - expected) <= 12, `edge colour ${JSON.stringify(row)}`);
            }
        }
      } finally {
        await decoder.close?.();
      }
    });
  }
}
