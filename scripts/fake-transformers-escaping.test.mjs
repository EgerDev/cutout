import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { pageEnvInit, workerPrelude } from "./fake-transformers.mjs";

test("fake environment values cannot inject code into external worker or init scripts", () => {
  const payload = '</script><script>globalThis.injected = true</script>"\\\r\n\u2028\u2029';
  for (const build of [pageEnvInit, workerPrelude]) {
    const source = build({ deviceMemory: payload, adapter: false });
    // These builders are evaluated as JavaScript, never interpolated into HTML script tags.
    const sandbox = { navigator: {}, performance };
    vm.runInNewContext(source, sandbox);
    assert.equal(sandbox.navigator.deviceMemory, payload);
    assert.equal(sandbox.injected, undefined);
  }
});
